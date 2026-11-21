import type { ConnectionOptions, CreateFileRequest, CreateFileStoreOptions, DriveFile, FileDrive, FileSearchHit,
    FileStoreDescription, MainFileDrive, OpenFileStoreOptions, ReadFileRequest, RequestOptions, SearchFilesRequest,
    WorkingFileDrive } from './types.js';
import { checkAbort, databaseError, MemDriveError, nativeOptions, nativeRequest, operationOptions, requireInput } from './errors.js';
import { keysOnly, parseStore, storeConfiguration } from './config.js';
import { bytes, decodeFile, fileRecords, originalId, resultDocs, validFileId, validPath } from './records.js';
import { searchQuery, validateReranking } from './search.js';
import { fileLister } from './list.js';
export type * from './types.js';
export { MemDriveError } from './errors.js';

type Handle = ReturnType<ConnectionOptions['client']['collection']>;
type Client = ConnectionOptions['client'];

const main = 'main';
const prefix = 'fork-';
const clients = new WeakMap<Client, Map<string, Store>>();
const requestMaxBytes = 6_029_312;
const maximumInputBytes = 300_000;
const maximumRequestDocuments = 1000;
const writeBatchLimit = 100;
const validName = (name: unknown, maxLength = 52): name is string =>
    typeof name === 'string' && name.length >= 3 && name.length <= maxLength && /^[A-Za-z0-9_-]+$/.test(name);
const validForkName = (name: unknown): name is string => validName(name, 52 - prefix.length) && name !== main;
function validateConnection(options: unknown, keys: string[]): asserts options is ConnectionOptions {
    requireInput(keysOnly(options, keys) && options.client !== null && typeof options.client === 'object'
        && 'collection' in options.client && typeof options.client.collection === 'function',
    'Provide a LambdaDB client and documented file store options.');
    requireInput(validName(options.name), 'Store name must be 3–52 letters, digits, underscores or hyphens.');
}

async function remote<T>(operation: () => Promise<T>, message: string, signal?: AbortSignal, codes: Record<number, string> = {}) {
    try { return await nativeRequest(operation, signal); }
    catch (cause) {
        const error = databaseError(cause, message);
        if (error.status !== undefined && codes[error.status] !== undefined) error.code = codes[error.status]!;
        throw error;
    }
}

const branchRead = (branch: string) => ({
    ref: { kind: 'branch' as const, name: branch }, consistentRead: true, includeVectors: false,
});
const kindClause = { queryString: { query: '"file"', defaultField: 'kind' }, occur: 'filter' };
const pathClause = (path: string) => ({ queryString: { query: JSON.stringify(path), defaultField: 'path' } });

function pathQuery(paths: string[]) {
    return { bool: [
        kindClause,
        paths.length === 1 ? { ...pathClause(paths[0]!), occur: 'filter' }
            : { bool: paths.map(path => ({ ...pathClause(path), occur: 'should' })), occur: 'filter' },
    ] };
}

type FileRecords = Awaited<ReturnType<typeof fileRecords>>;
type WriteRecord = FileRecords['docs'][number];
function writeBatches(records: FileRecords[], branch: string): WriteRecord[][] {
    const envelope = bytes({ docs: [], branch });
    const batches: WriteRecord[][] = [];
    let batch: WriteRecord[] = [];
    let inputBytes = 0, wireBytes = envelope;
    const flush = () => {
        if (batch.length) batches.push(batch);
        batch = []; inputBytes = 0; wireBytes = envelope;
    };
    const fits = (docs: WriteRecord[]) => batch.length + docs.length <= maximumRequestDocuments
        && inputBytes + docs.reduce((sum, doc) => sum + doc.inputBytes, 0) <= maximumInputBytes
        && wireBytes + docs.reduce((sum, doc) => sum + doc.wireBytes, 0) <= requestMaxBytes;
    const append = (docs: WriteRecord[]) => {
        batch.push(...docs);
        for (const doc of docs) {
            inputBytes += doc.inputBytes;
            wireBytes += doc.wireBytes;
        }
    };
    for (const { docs } of records) {
        if (!fits(docs)) flush();
        if (fits(docs)) append(docs);
        else {
            // Keep each ordinary file together. For a large file, stage its
            // chunks first and include the original only in the final request.
            for (const doc of docs) {
                const next = [doc];
                if (!fits(next)) flush();
                requireInput(fits(next), 'A file record exceeds the limit for a native write.');
                append(next);
            }
        }
    }
    flush();
    return batches;
}

type Store = ReturnType<typeof store>;
function store(handle: Handle, description: FileStoreDescription) {
    const { name, metadataSchema } = description;
    const forks = new Map<string, WorkingFileDrive>();

    async function describe(options?: RequestOptions) {
        const { signal } = operationOptions(options);
        checkAbort(signal);
        return structuredClone(description);
    }

    async function fetchFiles(branch: string, fileIds: string[], signal?: AbortSignal) {
        const response = await remote(() => handle.docs.fetch({ ids: fileIds.map(originalId), ...branchRead(branch) }, nativeOptions(signal)),
            'Could not read file originals.', signal);
        checkAbort(signal);
        const files = new Map<string, DriveFile>();
        const expected = new Set(fileIds);
        for (const doc of resultDocs(response, name, fileIds.length)) {
            const file = decodeFile(doc, metadataSchema);
            if (!expected.has(file.fileId) || files.has(file.fileId))
                throw new MemDriveError('INVALID_RESULT', 'Read returned unexpected or duplicate file originals.');
            files.set(file.fileId, file);
        }
        return files;
    }

    function reader(branch: string) {
        function read(request: ReadFileRequest, options?: RequestOptions): Promise<DriveFile | null>;
        function read(request: { paths: string[] }, options?: RequestOptions): Promise<DriveFile[]>;
        async function read(request: ReadFileRequest | { paths: string[] }, options?: RequestOptions) {
            const { signal } = operationOptions(options);
            checkAbort(signal);
            requireInput(keysOnly(request, ['fileId', 'path', 'paths']) && Object.keys(request).length === 1,
                'Read requires exactly one of fileId, path or paths.');
            if ('fileId' in request) {
                const fileId = request.fileId;
                requireInput(validFileId(fileId), 'Provide a fileId returned by MemDrive.');
                return (await fetchFiles(branch, [fileId], signal)).get(fileId) ?? null;
            }
            const multi = 'paths' in request;
            const value = multi ? request.paths : [request.path];
            requireInput(Array.isArray(value) && value.length >= 1 && value.length <= writeBatchLimit && [...value].every(validPath)
                && new Set(value).size === value.length, 'Provide 1–100 distinct valid absolute file paths.');
            const paths: string[] = [...value];
            const response = await remote(() => handle.query({ size: paths.length * 2, ...branchRead(branch), query: pathQuery(paths) },
                nativeOptions(signal)), 'Could not read files by path.', signal);
            checkAbort(signal);
            const expected = new Set(paths), files = new Map<string, DriveFile>();
            for (const doc of resultDocs(response, name, paths.length)) {
                const file = decodeFile(doc, metadataSchema);
                if (!expected.has(file.path) || files.has(file.path))
                    throw new MemDriveError('INVALID_RESULT', 'Read returned unexpected or duplicate paths.');
                files.set(file.path, file);
            }
            return multi ? paths.flatMap(path => files.has(path) ? [files.get(path)!] : []) : files.get(paths[0]!) ?? null;
        }
        return read;
    }

    function searcher(branch: string) {
        return async (request: SearchFilesRequest, options?: RequestOptions) => {
            const { signal } = operationOptions(options);
            checkAbort(signal);
            const body = searchQuery(request, metadataSchema);
            const response = await remote(() => handle.query({ ...body, ...branchRead(branch),
                fields: { include: ['id', 'kind', 'fileId', 'path', 'modifiedAt', 'content', 'start', 'end'] } },
            nativeOptions(signal)), 'File search failed.', signal);
            checkAbort(signal);
            const docs = resultDocs(response, name, body.size!);
            const reranked = validateReranking(response, body);
            const fileIds = new Set<string>(), chunkIds = new Set<string>();
            const chunks = docs.map(doc => {
                if (doc.kind !== 'chunk' || !validFileId(doc.fileId) || typeof doc.id !== 'string'
                    || !doc.id.startsWith(`chunk:${doc.fileId}:`) || chunkIds.has(doc.id) || !validPath(doc.path)
                    || typeof doc.content !== 'string' || !doc.content.trim() || /\p{Surrogate}/u.test(doc.content))
                    throw new MemDriveError('INVALID_RESULT', 'Search returned an invalid or duplicate chunk.');
                fileIds.add(doc.fileId);
                chunkIds.add(doc.id);
                return { fileId: doc.fileId, path: doc.path, modifiedAt: doc.modifiedAt, content: doc.content,
                    start: doc.start, end: doc.end };
            });
            if (!chunks.length) return { hits: [], reranked };
            const files = await fetchFiles(branch, [...fileIds], signal);
            const hits: FileSearchHit[] = [];
            for (const chunk of chunks) {
                const file = files.get(chunk.fileId);
                // An orphan or stale chunk must not expose body text from another file or revision.
                if (!file || file.path !== chunk.path || file.modifiedAt !== chunk.modifiedAt) continue;
                const { start, end } = chunk;
                const verified = typeof start === 'number' && typeof end === 'number'
                    && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= file.content.length
                    && file.content.slice(start, end) === chunk.content;
                hits.push({ ...file, content: chunk.content, ...(verified ? { range: { start, end } } : {}) });
            }
            return { hits, reranked };
        };
    }

    function working(fork: string): WorkingFileDrive {
        const existing = forks.get(fork);
        if (existing) return existing;
        const branch = prefix + fork;
        let writes = Promise.resolve();
        const unconfirmed = new Map<string, string>();

        function write(request: CreateFileRequest, options?: RequestOptions): Promise<DriveFile>;
        function write(request: CreateFileRequest[], options?: RequestOptions): Promise<DriveFile[]>;
        async function write(request: CreateFileRequest | CreateFileRequest[], options?: RequestOptions) {
            const { signal } = operationOptions(options);
            checkAbort(signal);
            const multi = Array.isArray(request);
            const operations = multi ? [...request] : [request];
            requireInput(operations.length >= 1 && operations.length <= writeBatchLimit,
                'Submit 1–100 file create operations.');
            const prepared = Promise.all(operations.map(operation => fileRecords(operation, metadataSchema)));
            // Validation and hashing begin immediately. Attach the queue now so overlapping writes keep call order.
            void prepared.catch(() => {});
            const write = writes.then(async () => {
                checkAbort(signal);
                const records = await prepared;
                const paths = records.map(record => record.file.path);
                const expectedPaths = new Set(paths);
                requireInput(expectedPaths.size === paths.length, 'Create paths must be distinct within one write.');
                const batches = writeBatches(records, branch);
                const response = await remote(() => handle.query({ size: 2 * paths.length, ...branchRead(branch),
                    query: pathQuery(paths), fields: { include: ['id', 'kind', 'fileId', 'path'] } }, nativeOptions(signal)),
                'Could not check create destinations.', signal);
                checkAbort(signal);
                const occupied = new Set<string>();
                for (const doc of resultDocs(response, name, 2 * paths.length)) {
                    if (doc.kind !== 'file' || !validFileId(doc.fileId) || doc.id !== originalId(doc.fileId)
                        || typeof doc.path !== 'string' || !expectedPaths.has(doc.path) || occupied.has(doc.path))
                        throw new MemDriveError('INVALID_RESULT', 'Destination lookup returned an unexpected or duplicate file.');
                    occupied.add(doc.path);
                    unconfirmed.delete(doc.path);
                }
                if (occupied.size) throw new MemDriveError('PATH_EXISTS', 'A file already exists at a requested path.',
                    { details: { paths: [...occupied] } });
                for (const path of paths) {
                    const fileId = unconfirmed.get(path);
                    if (fileId) throw new MemDriveError('WRITE_UNCONFIRMED', 'An earlier create at this path is still unconfirmed.',
                        { details: { fileId, path } });
                }

                const completed: DriveFile[] = [];
                const staged = new Map<string, string>();
                const filesById = new Map(records.map(({ file }) => [file.fileId, file]));
                const details = () => ({
                    completedFileIds: completed.map(file => file.fileId),
                    incompleteTargets: [...staged].map(([fileId, path]) => ({ fileId, path })),
                });
                for (const batch of batches) {
                    const docs = batch.map(record => record.doc);
                    const ids = new Set(docs.map(doc => doc.id));
                    const targets = [...new Map(docs.map(({ fileId, path }) => [fileId, { fileId, path }])).values()];
                    const uncertain = (cause: unknown) => {
                        for (const { kind, fileId, path } of docs) if (kind === 'file') unconfirmed.set(path, fileId);
                        return new MemDriveError('WRITE_UNCONFIRMED', 'The create may have been accepted. Inspect the files on this fork.', {
                            cause, details: { ...(targets.length === 1 ? targets[0] : {}), targets, ...details() },
                        });
                    };
                    try { checkAbort(signal); }
                    catch (cause) {
                        throw new MemDriveError('ABORTED', 'Write aborted before the next request.', { cause, details: details() });
                    }
                    try {
                        await nativeRequest(() => handle.docs.upsert({ docs, branch }, nativeOptions(signal)), signal);
                    } catch (cause) {
                        const error = databaseError(cause, 'The file create was rejected.');
                        if ([400, 401, 403, 404, 413, 422, 429].includes(error.status ?? 0)) {
                            if (completed.length || staged.size) {
                                const partial = new MemDriveError(error.code, error.message, { cause: error, details: details() });
                                partial.status = error.status;
                                throw partial;
                            }
                            throw error;
                        }
                        throw uncertain(cause);
                    }
                    try {
                        const confirmation = await nativeRequest(() => handle.docs.fetch({ ids: [...ids], ...branchRead(branch),
                            fields: { include: ['id'] } }, nativeOptions(signal)), signal);
                        checkAbort(signal);
                        const found = resultDocs(confirmation, name, ids.size);
                        if (found.some(doc => typeof doc.id !== 'string' || !ids.delete(doc.id)) || ids.size)
                            throw new MemDriveError('INVALID_RESULT', 'The original and its complete chunk set were not confirmed.');
                    } catch (cause) {
                        throw uncertain(cause);
                    }
                    for (const { fileId, kind, path } of docs) {
                        if (kind === 'file') {
                            staged.delete(fileId);
                            completed.push(filesById.get(fileId)!);
                        } else staged.set(fileId, path);
                    }
                }
                return multi ? completed : completed[0]!;
            });
            writes = write.then(() => undefined, () => undefined);
            return write;
        }
        const drive: WorkingFileDrive = Object.freeze({
            name, at: Object.freeze({ kind: 'fork' as const, name: fork }), read: reader(branch), search: searcher(branch),
            list: fileLister(handle, name, branch, metadataSchema), describe, write,
        });
        forks.set(fork, drive);
        return drive;
    }

    const mainView = Object.freeze({
        name, at: Object.freeze({ kind: 'main' as const }), read: reader(main), search: searcher(main),
        list: fileLister(handle, name, main, metadataSchema), describe,
        async fork(request: { name: string }, options?: RequestOptions) {
            const { signal } = operationOptions(options);
            checkAbort(signal);
            requireInput(keysOnly(request, ['name']) && validForkName(request.name),
                'Fork name must be 3–47 letters, digits, underscores or hyphens and cannot be main.');
            const fork = request.name;
            const branch = prefix + fork;
            const result = await remote(() => handle.branches.create({ branchName: branch, source: { kind: 'branch', name: main } },
                nativeOptions(signal)), 'Could not create the working fork.', signal, { 409: 'BRANCH_CONFLICT' });
            checkAbort(signal);
            if (result?.branch?.name !== branch) throw new MemDriveError('INVALID_RESULT', 'Fork creation returned an invalid branch.');
            return working(fork);
        },
    }) satisfies MainFileDrive;

    return {
        main: mainView,
        async openFork(fork: string, signal?: AbortSignal) {
            const cached = forks.get(fork);
            if (cached) return cached;
            const response = await remote(() => handle.branches.list(nativeOptions(signal)), 'Could not find the working fork.', signal);
            checkAbort(signal);
            if (!Array.isArray(response?.branches) || !response.branches.every(branch => typeof branch?.name === 'string'))
                throw new MemDriveError('INVALID_RESULT', 'Fork lookup returned invalid branches.');
            if (!response.branches.some(branch => branch.name === prefix + fork))
                throw new MemDriveError('BRANCH_NOT_FOUND', 'The working fork does not exist.');
            return working(fork);
        },
    };
}

function storesFor(client: Client) {
    const existing = clients.get(client);
    if (existing) return existing;
    const stores = new Map<string, Store>();
    clients.set(client, stores);
    return stores;
}

export async function create(options: CreateFileStoreOptions, requestOptions?: RequestOptions): Promise<MainFileDrive> {
    const { signal } = operationOptions(requestOptions);
    checkAbort(signal);
    validateConnection(options, ['client', 'name', 'labels', 'textSearch', 'metadataSchema']);
    const { client, name } = options;
    requireInput(typeof client.createCollection === 'function', 'Client must support collection creation.');
    const { indexConfigs, tags, description } = storeConfiguration(options);
    await remote(() => client.createCollection({ collectionName: name, indexConfigs, tags },
        nativeOptions(signal)), 'Could not create the file store.', signal, { 409: 'STORE_EXISTS' });
    checkAbort(signal);
    const stores = storesFor(client);
    const created = stores.get(name) ?? store(client.collection(name), description);
    stores.set(name, created);
    return created.main;
}

export function open(options: ConnectionOptions & { at?: undefined }, requestOptions?: RequestOptions): Promise<MainFileDrive>;
export function open(options: ConnectionOptions & { at: { fork: string } }, requestOptions?: RequestOptions): Promise<WorkingFileDrive>;
export function open(options: OpenFileStoreOptions, requestOptions?: RequestOptions): Promise<FileDrive>;
export async function open(options: OpenFileStoreOptions, requestOptions?: RequestOptions): Promise<FileDrive> {
    const { signal } = operationOptions(requestOptions);
    checkAbort(signal);
    validateConnection(options, ['client', 'name', 'at']);
    const { client, name, at } = options;
    let fork: string | undefined;
    if (at !== undefined) {
        requireInput(keysOnly(at, ['fork']) && validForkName(at.fork),
            'Select a working fork by its name.');
        fork = at.fork;
    }
    const stores = storesFor(client);
    let selected = stores.get(name);
    if (!selected) {
        const handle = client.collection(name);
        const response = await remote(() => handle.get(nativeOptions(signal)), 'Could not inspect the file store.', signal, { 404: 'STORE_NOT_FOUND' });
        checkAbort(signal);
        const description = parseStore(response?.collection, name);
        selected = stores.get(name) ?? store(handle, description);
        stores.set(name, selected);
    }
    return fork === undefined ? selected.main : selected.openFork(fork, signal);
}

export const MemDrive = Object.freeze({ create, open });
