import type { ConnectionOptions, RequestOptions } from './types.js';
import type { CreateFileRequest, DriveFile, FileDrive, MainFileDrive, OpenFileStoreOptions, ReadFileRequest, WorkingFileDrive } from './types.js';
import { checkAbort, databaseError, MemDriveError, nativeOptions, nativeRequest, operationOptions, requireInput } from './errors.js';
export type * from './types.js';
export { MemDriveError } from './errors.js';

type Handle = ReturnType<ConnectionOptions['client']['collection']>;
type Client = ConnectionOptions['client'];

const main = 'main';
const prefix = 'fork-';
const formatTag = 'memdrive.format';
// Development stores can be recreated after an incompatible layout change.
const format = 'files-v0';
const encoder = new TextEncoder();
const maxDocumentBytes = 5 * 1024 * 1024;
const fileIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const indexes = {
    kind: { type: 'keyword' },
    path: { type: 'keyword' },
    fileName: { type: 'keyword' },
    ancestorPaths: { type: 'keyword' },
    changed: { type: 'boolean' },
} as const;

const clients = new WeakMap<Client, Map<string, Store>>();
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
    && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const quote = (value: string) => JSON.stringify(value);
const keysOnly = (value: unknown, keys: string[]): value is Record<string, unknown> =>
    isObject(value) && Object.keys(value).every(key => keys.includes(key));
const validName = (name: unknown, maxLength = 52): name is string =>
    typeof name === 'string' && name.length >= 3 && name.length <= maxLength && /^[A-Za-z0-9_-]+$/.test(name);
const validFileId = (value: unknown): value is string => typeof value === 'string' && fileIdPattern.test(value);
const validPath = (value: unknown): value is string => typeof value === 'string' && value.startsWith('/')
    && !/[\\\p{Cc}\p{Surrogate}]/u.test(value) && encoder.encode(value).length <= 4096
    && value.slice(1).split('/').every(part => part !== '' && part !== '.' && part !== '..');
const originalId = (fileId: string) => `file:${fileId}`;

function validateConnection(options: unknown, keys: string[]): asserts options is ConnectionOptions {
    requireInput(keysOnly(options, keys) && options.client !== null && typeof options.client === 'object'
        && 'collection' in options.client && typeof options.client.collection === 'function',
    'Provide a LambdaDB client and documented file store options.');
    requireInput(validName(options.name), 'Store name must be 3–52 letters, digits, underscores or hyphens.');
}

function requirePath(path: unknown): asserts path is string {
    requireInput(validPath(path), 'File path must be an absolute slash-separated path of at most 4096 UTF-8 bytes without empty, dot or dot-dot components, backslashes or control characters.');
}

async function remote<T>(operation: () => Promise<T>, message: string, signal?: AbortSignal, codes: Record<number, string> = {}) {
    try { return await nativeRequest(operation, signal); }
    catch (cause) {
        const error = databaseError(cause, message);
        if (error.status !== undefined && codes[error.status] !== undefined) error.code = codes[error.status]!;
        throw error;
    }
}

function fileFromResponse(response: unknown, name: string, request: ReadFileRequest): DriveFile | null {
    if (!isObject(response) || response.isDocsInline === false || !Array.isArray(response.docs) || response.docs.length > 1)
        throw new MemDriveError('INVALID_RESULT', 'File read returned an invalid or ambiguous result.');
    if (response.docs.length === 0) return null;
    const hit: unknown = response.docs[0];
    const doc = isObject(hit) && hit.collection === name ? hit.doc : undefined;
    if (!isObject(doc) || doc.kind !== 'file' || !validFileId(doc.fileId) || doc.id !== originalId(doc.fileId)
        || !validPath(doc.path) || typeof doc.content !== 'string' || /\p{Surrogate}/u.test(doc.content)
        || (request.fileId === undefined ? doc.path !== request.path : doc.fileId !== request.fileId))
        throw new MemDriveError('INVALID_RESULT', 'File read returned an invalid original.');
    return { fileId: doc.fileId, path: doc.path, content: doc.content };
}

type Store = ReturnType<typeof store>;
function store(handle: Handle, name: string) {
    const forks = new Map<string, WorkingFileDrive>();

    function reader(branch: string) {
        return async (request: ReadFileRequest, options?: RequestOptions) => {
            const { signal } = operationOptions(options);
            checkAbort(signal);
            requireInput(keysOnly(request, ['fileId', 'path']) && Object.keys(request).length === 1,
                'Read requires exactly one of fileId or path.');
            const settings = { ref: { kind: 'branch' as const, name: branch }, consistentRead: true, includeVectors: false };
            let response;
            let selector: ReadFileRequest;
            if (Object.hasOwn(request, 'fileId')) {
                const { fileId } = request;
                requireInput(validFileId(fileId), 'Provide a fileId returned by MemDrive.');
                selector = { fileId };
                response = await remote(() => handle.docs.fetch({ ids: [originalId(fileId)], ...settings }, nativeOptions(signal)),
                    'Could not read the file by ID.', signal);
            } else {
                const { path } = request;
                requirePath(path);
                selector = { path };
                response = await remote(() => handle.query({ size: 2, ...settings, query: { bool: [
                    { queryString: { query: quote('file'), defaultField: 'kind' }, occur: 'filter' },
                    { queryString: { query: quote(path), defaultField: 'path' }, occur: 'filter' },
                ] } }, nativeOptions(signal)), 'Could not read the file by path.', signal);
            }
            checkAbort(signal);
            return fileFromResponse(response, name, selector);
        };
    }

    function working(fork: string): WorkingFileDrive {
        const existing = forks.get(fork);
        if (existing) return existing;
        const branch = prefix + fork;
        const read = reader(branch);
        let writes = Promise.resolve();
        const unconfirmed = new Map<string, string>();
        const drive: WorkingFileDrive = Object.freeze({
            name, at: Object.freeze({ kind: 'fork' as const, name: fork }), read,
            async write(request: CreateFileRequest, options?: RequestOptions) {
                const { signal } = operationOptions(options);
                checkAbort(signal);
                requireInput(keysOnly(request, ['op', 'path', 'content']) && request.op === 'create',
                    'Write requires a create operation with path and original text.');
                const { path, content } = request;
                requirePath(path);
                requireInput(typeof content === 'string' && !/\p{Surrogate}/u.test(content), 'File content must be UTF-8 text.');
                const fileId = globalThis.crypto.randomUUID();
                const parts = path.slice(1).split('/');
                const fileName = parts.pop()!;
                const ancestorPaths = ['/'];
                let ancestor = '/';
                for (const part of parts) {
                    ancestor += part + '/';
                    ancestorPaths.push(ancestor);
                }
                const doc = { id: originalId(fileId), kind: 'file', fileId, path, fileName, ancestorPaths, content, changed: true };
                requireInput(encoder.encode(JSON.stringify(doc)).length <= maxDocumentBytes, 'File record exceeds the native 5 MiB document limit.');

                const write = writes.then(async () => {
                    if (await read({ path }, { signal })) {
                        unconfirmed.delete(path);
                        throw new MemDriveError('PATH_EXISTS', 'A file already exists at this path.');
                    }
                    const pendingId = unconfirmed.get(path);
                    if (pendingId)
                        throw new MemDriveError('WRITE_UNCONFIRMED', 'An earlier create at this path is still unconfirmed.',
                            { details: { fileId: pendingId, path } });
                    checkAbort(signal);
                    const uncertain = (cause?: unknown) => {
                        unconfirmed.set(path, fileId);
                        return new MemDriveError('WRITE_UNCONFIRMED', 'The create may have been accepted. Inspect the file by ID or path.',
                            { cause, details: { fileId, path } });
                    };
                    try {
                        await nativeRequest(() => handle.docs.upsert({ docs: [doc], branch }, nativeOptions(signal)), signal);
                    } catch (cause) {
                        const error = databaseError(cause, 'The file create was rejected.');
                        if ([400, 401, 403, 404, 413, 422, 429].includes(error.status ?? 0)) throw error;
                        throw uncertain(cause);
                    }
                    const visible = await read({ path }, { signal }).catch(cause => { throw uncertain(cause); });
                    if (!visible || visible.fileId !== fileId || visible.content !== content) throw uncertain();
                    return visible;
                });
                writes = write.then(() => undefined, () => undefined);
                return write;
            },
        });
        forks.set(fork, drive);
        return drive;
    }

    const mainView = Object.freeze({
        name, at: Object.freeze({ kind: 'main' as const }), read: reader(main),
        async fork(request: { name: string }, options?: RequestOptions) {
            const { signal } = operationOptions(options);
            checkAbort(signal);
            requireInput(keysOnly(request, ['name']) && validName(request.name, 52 - prefix.length) && request.name !== main,
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

export async function create(options: ConnectionOptions, requestOptions?: RequestOptions): Promise<MainFileDrive> {
    const { signal } = operationOptions(requestOptions);
    checkAbort(signal);
    validateConnection(options, ['client', 'name']);
    const { client, name } = options;
    requireInput(typeof client.createCollection === 'function', 'Client must support collection creation.');
    await remote(() => client.createCollection({ collectionName: name, indexConfigs: indexes, tags: { [formatTag]: format } },
        nativeOptions(signal)), 'Could not create the file store.', signal, { 409: 'STORE_EXISTS' });
    checkAbort(signal);
    const stores = storesFor(client);
    const created = stores.get(name) ?? store(client.collection(name), name);
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
        requireInput(keysOnly(at, ['fork']) && validName(at.fork, 52 - prefix.length) && at.fork !== main,
            'Select a working fork by its name.');
        fork = at.fork;
    }
    const stores = storesFor(client);
    let selected = stores.get(name);
    if (!selected) {
        const handle = client.collection(name);
        const response = await remote(() => handle.get(nativeOptions(signal)), 'Could not inspect the file store.', signal, { 404: 'STORE_NOT_FOUND' });
        checkAbort(signal);
        const collection = response?.collection;
        if (collection?.collectionName !== name || collection.tags?.[formatTag] !== format
            || collection.defaultBranchName !== main || !Object.entries(indexes).every(([field, config]) =>
                collection.indexConfigs?.[field]?.type === config.type))
            throw new MemDriveError('INCOMPATIBLE_STORE', 'The collection is not a compatible MemDrive file store.');
        selected = stores.get(name) ?? store(handle, name);
        stores.set(name, selected);
    }
    return fork === undefined ? selected.main : selected.openFork(fork, signal);
}

export const MemDrive = Object.freeze({ create, open });
