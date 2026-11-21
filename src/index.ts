import type { CheckpointFileDrive, CheckpointSelection, ConnectionOptions, CreateFileStoreOptions, ForkSelection, DriveFile, FileDrive, FileSearchHit,
    FileStoreDescription, MainFileDrive, OpenFileStoreOptions, ReadFileRequest, RequestOptions, SearchFilesRequest,
    WorkingFileDrive } from './types.js';
import { checkAbort, databaseError, MemDriveError, mutationOptions, nativeOptions, nativeRequest, operationOptions, requireInput } from './errors.js';
import { keysOnly, parseStore, storeConfiguration } from './config.js';
import { decodeFile, resultDocs, validFileId, validPath } from './records.js';
import { branchRef, fetchOriginals, pathQuery, viewRead, type Handle, type ViewRef } from './storage-reads.js';
import { workingWriter, writeBatchLimit } from './writes.js';
import { searchQuery, validateReranking } from './search.js';
import { fileLister } from './list.js';
import { createRef } from './refs.js';
export type * from './types.js';
export { MemDriveError } from './errors.js';

type Client = ConnectionOptions['client'];

const main = 'main';
const forkPrefix = 'fork-';
const checkpointPrefix = 'checkpoint-';
const clients = new WeakMap<Client, Map<string, Store>>();
const validName = (name: unknown, maxLength = 52): name is string =>
    typeof name === 'string' && name.length >= 3 && name.length <= maxLength && /^[A-Za-z0-9_-]+$/.test(name);
const validForkName = (name: unknown): name is string => validName(name, 52 - forkPrefix.length) && name !== main;
const validCheckpointName = (name: unknown): name is string => validName(name, 52 - checkpointPrefix.length);
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
    const checkpoints = new Map<string, CheckpointFileDrive>();
    const pendingRefs = new Set<string>();

    async function describe(options?: RequestOptions) {
        const { signal } = operationOptions(options);
        checkAbort(signal);
        return structuredClone(description);
    }

    function reader(ref: ViewRef) {
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
                const doc = (await fetchOriginals(handle, name, ref, [fileId], signal)).get(fileId);
                return doc?.kind === 'file' ? decodeFile(doc, metadataSchema) : null;
            }
            const multi = 'paths' in request;
            const value = multi ? request.paths : [request.path];
            requireInput(Array.isArray(value) && value.length >= 1 && value.length <= writeBatchLimit && [...value].every(validPath)
                && new Set(value).size === value.length, 'Provide 1–100 distinct valid absolute file paths.');
            const paths: string[] = [...value];
            const response = await remote(() => handle.query({ size: paths.length * 2, ...viewRead(ref), query: pathQuery(paths) },
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

    function searcher(ref: ViewRef) {
        return async (request: SearchFilesRequest, options?: RequestOptions) => {
            const { signal } = operationOptions(options);
            checkAbort(signal);
            const body = searchQuery(request, metadataSchema);
            const response = await remote(() => handle.query({ ...body, ...viewRead(ref),
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
            const originals = await fetchOriginals(handle, name, ref, [...fileIds], signal);
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

    function view(ref: ViewRef, enqueueRef?: <T>(operation: () => Promise<T>, signal?: AbortSignal) => Promise<T>) {
        return {
            name, read: reader(ref), search: searcher(ref), list: fileLister(handle, name, ref, metadataSchema), describe,
            async fork(request: { name: string }, options?: RequestOptions) {
                const { signal } = operationOptions(options);
                checkAbort(signal);
                requireInput(keysOnly(request, ['name']) && validForkName(request.name),
                    'Fork name must be 3–47 letters, digits, underscores or hyphens and cannot be main.');
                const fork = request.name;
                const branchName = forkPrefix + fork;
                const create = async () => {
                    await createRef(pendingRefs, { kind: 'fork', name: fork }, signal,
                        () => handle.branches.create({ branchName, source: ref }, mutationOptions(signal)),
                        response => response?.branch?.name === branchName);
                    return working(fork);
                };
                return enqueueRef ? enqueueRef(create, signal) : create();
            },
            async checkpoint(request: { name: string }, options?: RequestOptions) {
                const { signal } = operationOptions(options);
                checkAbort(signal);
                requireInput(keysOnly(request, ['name']) && validCheckpointName(request.name),
                    'Checkpoint name must be 3–41 letters, digits, underscores or hyphens.');
                const checkpoint = request.name;
                const tagName = checkpointPrefix + checkpoint;
                const create = async () => {
                    await createRef(pendingRefs, { kind: 'checkpoint', name: checkpoint, branchSource: ref.kind === 'branch' }, signal,
                        () => handle.tags.create({ tagName, source: ref }, mutationOptions(signal)),
                        response => validTag(response?.tag, tagName));
                    return pinned(checkpoint);
                };
                return enqueueRef ? enqueueRef(create, signal) : create();
            },
        };
    }

    function validTag(tag: unknown, tagName: string) {
        return typeof tag === 'object' && tag !== null && 'name' in tag && tag.name === tagName
            && 'snapshotId' in tag && typeof tag.snapshotId === 'string' && tag.snapshotId.length > 0;
    }

    function working(fork: string): WorkingFileDrive {
        const existing = forks.get(fork);
        if (existing) return existing;
        const branch = forkPrefix + fork;
        const { enqueueRef, ...writer } = workingWriter(handle, name, branch, metadataSchema);
        const drive: WorkingFileDrive = Object.freeze({
            ...view(branchRef(branch), enqueueRef), at: Object.freeze({ kind: 'fork' as const, name: fork }), ...writer,
        });
        forks.set(fork, drive);
        return drive;
    }

    function pinned(checkpoint: string): CheckpointFileDrive {
        const existing = checkpoints.get(checkpoint);
        if (existing) return existing;
        const drive: CheckpointFileDrive = Object.freeze({
            ...view({ kind: 'tag', name: checkpointPrefix + checkpoint }),
            at: Object.freeze({ kind: 'checkpoint' as const, name: checkpoint }),
        });
        checkpoints.set(checkpoint, drive);
        return drive;
    }

    const mainView: MainFileDrive = Object.freeze({
        ...view(branchRef(main)), at: Object.freeze({ kind: 'main' as const }),
    });

    return {
        main: mainView,
        async openFork(fork: string, signal?: AbortSignal) {
            const cached = forks.get(fork);
            if (cached) return cached;
            const response = await remote(() => handle.branches.list(nativeOptions(signal)), 'Could not find the working fork.', signal);
            checkAbort(signal);
            if (!Array.isArray(response?.branches) || !response.branches.every(branch => typeof branch?.name === 'string'))
                throw new MemDriveError('INVALID_RESULT', 'Fork lookup returned invalid branches.');
            if (!response.branches.some(branch => branch.name === forkPrefix + fork))
                throw new MemDriveError('BRANCH_NOT_FOUND', 'The working fork does not exist.');
            pendingRefs.delete(`fork:${fork}`);
            return working(fork);
        },
        async openCheckpoint(checkpoint: string, signal?: AbortSignal) {
            const cached = checkpoints.get(checkpoint);
            if (cached) return cached;
            const tagName = checkpointPrefix + checkpoint;
            const response = await remote(() => handle.tags.get(tagName, nativeOptions(signal)),
                'Could not inspect the named checkpoint.', signal, { 404: 'CHECKPOINT_NOT_FOUND' });
            checkAbort(signal);
            if (!validTag(response?.tag, tagName))
                throw new MemDriveError('INVALID_RESULT', 'Checkpoint lookup returned an invalid tag.');
            pendingRefs.delete(`checkpoint:${checkpoint}`);
            return pinned(checkpoint);
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
export function open(options: ConnectionOptions & { at: ForkSelection }, requestOptions?: RequestOptions): Promise<WorkingFileDrive>;
export function open(options: ConnectionOptions & { at: CheckpointSelection }, requestOptions?: RequestOptions): Promise<CheckpointFileDrive>;
export function open(options: OpenFileStoreOptions, requestOptions?: RequestOptions): Promise<FileDrive>;
export async function open(options: OpenFileStoreOptions, requestOptions?: RequestOptions): Promise<FileDrive> {
    const { signal } = operationOptions(requestOptions);
    checkAbort(signal);
    validateConnection(options, ['client', 'name', 'at']);
    const { client, name, at } = options;
    let fork: string | undefined;
    let checkpoint: string | undefined;
    if (at !== undefined) {
        requireInput(keysOnly(at, ['fork', 'checkpoint']) && Object.keys(at).length === 1,
            'Select exactly one working fork or checkpoint by name.');
        if ('fork' in at) {
            requireInput(validForkName(at.fork), 'Select a working fork by its name.');
            fork = at.fork;
        } else {
            requireInput(validCheckpointName(at.checkpoint), 'Select a checkpoint by its name.');
            checkpoint = at.checkpoint;
        }
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
    if (fork !== undefined) return selected.openFork(fork, signal);
    if (checkpoint !== undefined) return selected.openCheckpoint(checkpoint, signal);
    return selected.main;
}

export const MemDrive = Object.freeze({ create, open });
