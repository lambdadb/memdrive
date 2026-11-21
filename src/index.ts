import type { ConnectionOptions, CreateFileStoreOptions, DriveFile, FileDrive, FileSearchHit,
    FileStoreDescription, MainFileDrive, OpenFileStoreOptions, ReadFileRequest, RequestOptions, SearchFilesRequest,
    WorkingFileDrive } from './types.js';
import { checkAbort, databaseError, MemDriveError, nativeOptions, nativeRequest, operationOptions, requireInput } from './errors.js';
import { keysOnly, parseStore, storeConfiguration } from './config.js';
import { decodeFile, resultDocs, validFileId, validPath } from './records.js';
import { branchRead, fetchOriginals, pathQuery, type Handle } from './storage-reads.js';
import { workingWriter, writeBatchLimit } from './writes.js';
import { searchQuery, validateReranking } from './search.js';
import { fileLister } from './list.js';
export type * from './types.js';
export { MemDriveError } from './errors.js';

type Client = ConnectionOptions['client'];

const main = 'main';
const prefix = 'fork-';
const clients = new WeakMap<Client, Map<string, Store>>();
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

type Store = ReturnType<typeof store>;
function store(handle: Handle, description: FileStoreDescription) {
    const { name, metadataSchema } = description;
    const forks = new Map<string, WorkingFileDrive>();

    async function describe(options?: RequestOptions) {
        const { signal } = operationOptions(options);
        checkAbort(signal);
        return structuredClone(description);
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
                const doc = (await fetchOriginals(handle, name, branch, [fileId], signal)).get(fileId);
                return doc?.kind === 'file' ? decodeFile(doc, metadataSchema) : null;
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
                fields: { include: ['id', 'kind', 'fileId', 'path', 'modifiedAt', 'content', 'start', 'end', 'revision'] } },
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
                    start: doc.start, end: doc.end, revision: doc.revision };
            });
            if (!chunks.length) return { hits: [], reranked };
            const originals = await fetchOriginals(handle, name, branch, [...fileIds], signal);
            const files = new Map([...originals].flatMap(([id, doc]) => doc.kind === 'file' ? [[id, decodeFile(doc, metadataSchema)] as const] : []));
            const hits: FileSearchHit[] = [];
            for (const chunk of chunks) {
                const file = files.get(chunk.fileId);
                // An orphan or stale chunk must not expose body text from another file or revision.
                if (!file || file.path !== chunk.path || file.modifiedAt !== chunk.modifiedAt || originals.get(chunk.fileId)?.revision !== chunk.revision) continue;
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
        const drive: WorkingFileDrive = Object.freeze({
            name, at: Object.freeze({ kind: 'fork' as const, name: fork }), read: reader(branch), search: searcher(branch),
            list: fileLister(handle, name, branch, metadataSchema), describe,
            write: workingWriter(handle, name, branch, metadataSchema),
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
