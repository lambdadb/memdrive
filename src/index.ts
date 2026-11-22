import type { CheckpointFileDrive, CheckpointSelection, ConnectionOptions, CreateExternalFileStoreOptions, CreateFileStoreOptions, EmbeddingMode, ForkSelection, FileDrive, FileListEntry, FileSearchHit,
    FileHistoryRequest, FileStoreDescription, MainFileDrive, MergeRequest, OpenFileStoreOptions, ReadFileRequest, RequestOptions, SearchExternalFilesRequest, SearchFilesRequest,
    WorkingFileDrive } from './types.js';
import { checkAbort, databaseError, MemDriveError, mutationOptions, nativeOptions, nativeRequest, operationOptions, requireInput } from './errors.js';
import { formatTag, keysOnly, parseStore, storeConfiguration, validRetention } from './config.js';
import { decodeFile, decodeFileEntry, resultDocs, validFileId, validPath } from './records.js';
import { branchRef, fetchOriginals, pathQuery, pinRef, readRef, viewRead, type Handle, type RefSource } from './storage-reads.js';
import { workingWriter, writeBatchLimit } from './writes.js';
import { searchQuery, validateReranking, vectorSearchQuery } from './search.js';
import { fileLister } from './list.js';
import { fileTextFinder } from './find-text.js';
import { textChunker } from './text-chunks.js';
import type { CreateFileRefRequest, DoclingChunker } from './types.js';
import { createRef, validateRefTime } from './refs.js';
import { rangeKeys, readRange, validateReadRange } from './read-range.js';
import type { DriveFile, FileReadPage, ReadFileRangeRequest } from './types.js';
import { deletingFormat, deleteReference, destroyStore, guardView, lifecycle } from './lifecycle.js';
import { publicationIdentity, validateMergeRequest } from './publication-log.js';
import { publication } from './publication.js';
export type * from './types.js';
export { MemDriveError } from './errors.js';
export { createFileTools, fileToolError, fileToolGuide } from './tools.js';
export type { FileToolDefinition, FileToolErrorResult, FileToolName, FileToolRefResult, FileTools } from './tools.js';

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
function store(client: Client, handle: Handle, description: FileStoreDescription<EmbeddingMode>, identity: Awaited<ReturnType<typeof publicationIdentity>>, backend?: DoclingChunker) {
    const { name, metadataSchema, embedding } = description;
    const gate = lifecycle({ client, name });
    let invalid = false;
    let pendingRetention: number | undefined;
    const refStates = new Map<string, { deleted: boolean; uncertain: boolean }>();
    function assertLive() {
        if (invalid) throw new MemDriveError('STORE_DELETED', 'This store handle has been invalidated by destruction.');
    }
    function assertRefAvailable(kind: string, ref: string) {
        if (refStates.get(`${kind}:${ref}`)?.uncertain)
            throw new MemDriveError('REF_DELETION_UNCONFIRMED', 'Fence outstanding requests and retry delete on the original reference handle.');
    }
    function guarded<T extends object>(value: T, state?: { deleted: boolean; uncertain: boolean }): T {
        return guardView(value, operation => gate.run(async () => {
            assertLive();
            if (state?.deleted) throw new MemDriveError('REF_DELETED', 'This reference handle has been deleted.');
            if (state?.uncertain) throw new MemDriveError('REF_DELETION_UNCONFIRMED', 'Retry deletion only after fencing outstanding requests.');
            return operation();
        }));
    }
    const dimensions = embedding.mode === 'external' ? embedding.dimensions : undefined;
    const chunker = 'chunking' in description && description.chunking ? textChunker(description.chunking, backend) : undefined;
    if (!chunker && backend) throw new MemDriveError('INCOMPATIBLE_STORE', 'This store does not support configured structured chunking.');
    const decodeRead = dimensions === undefined ? decodeFile : decodeFileEntry;
    const forks = new Map<string, WorkingFileDrive<EmbeddingMode>>();
    const checkpoints = new Map<string, CheckpointFileDrive<EmbeddingMode>>();
    const pendingRefs = new Set<string>();
    const writers = new Map<string, ReturnType<typeof workingWriter>>();
    function writerFor(branch: string) {
        const existing = writers.get(branch);
        if (existing) return existing;
        const writer = workingWriter(handle, name, branch, metadataSchema, dimensions, chunker);
        writers.set(branch, writer);
        return writer;
    }
    const publishing = publication(client, handle, identity, metadataSchema, writerFor, dimensions,
        () => gate.soleOperation() && !invalid && pendingRetention === undefined && pendingRefs.size === 0
            && ![...refStates.values()].some(state => state.uncertain));

    async function assertDeleteSafe(signal?: AbortSignal, retry?: { uncertain: boolean }) {
        if (pendingRetention !== undefined) throw new MemDriveError('CONFIGURATION_UNCONFIRMED', 'Settle the pending retention configuration before deleting resources.');
        if (pendingRefs.size) throw new MemDriveError('REF_CREATION_UNCONFIRMED', 'Resolve unconfirmed reference creation before deleting.');
        if ([...refStates.values()].some(state => state !== retry && state.uncertain))
            throw new MemDriveError('REF_DELETION_UNCONFIRMED', 'Settle unconfirmed reference deletion before deleting other resources.');
        await publishing.assertIdle(signal);
        for (const writer of writers.values()) await writer.enqueueRef(async () => undefined, signal);
    }

    async function listRefs(kind: 'fork' | 'checkpoint', options?: RequestOptions) {
        const { signal } = operationOptions(options);
        const entries = kind === 'fork'
            ? (await remote(() => handle.branches.list(nativeOptions(signal)), 'Could not list forks.', signal))?.branches
            : (await remote(() => handle.tags.list(nativeOptions(signal)), 'Could not list checkpoints.', signal))?.tags;
        checkAbort(signal);
        const seen = new Set<string>();
        if (!Array.isArray(entries) || !entries.every(entry => {
            if (typeof entry?.name !== 'string' || seen.has(entry.name)) return false;
            seen.add(entry.name);
            return true;
        })) throw new MemDriveError('INVALID_RESULT', 'Reference listing returned invalid or duplicate names.');
        const prefix = kind === 'fork' ? forkPrefix : checkpointPrefix;
        const valid = kind === 'fork' ? validForkName : validCheckpointName;
        return entries.flatMap(({ name }) => name.startsWith(prefix) && valid(name.slice(prefix.length))
            ? [{ name: name.slice(prefix.length) }] : []).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    }

    function refDeletion(kind: 'fork' | 'checkpoint', ref: string, state: { deleted: boolean; uncertain: boolean }) {
        return async (options?: RequestOptions) => {
            const { signal } = operationOptions(options);
            checkAbort(signal);
            return gate.exclusive(async () => {
                assertLive();
                if (state.deleted) return;
                await assertDeleteSafe(signal, state);
                await deleteReference(() => kind === 'fork'
                    ? handle.branches.delete(forkPrefix + ref, mutationOptions(signal))
                    : handle.tags.delete(checkpointPrefix + ref, mutationOptions(signal)), async () => {
                    try {
                        await nativeRequest<unknown>(() => kind === 'fork'
                            ? handle.branches.get(forkPrefix + ref, nativeOptions(signal))
                            : handle.tags.get(checkpointPrefix + ref, nativeOptions(signal)), signal);
                    } catch (cause) {
                        if (databaseError(cause, 'Could not confirm reference deletion.').status === 404) return;
                        throw cause;
                    }
                    throw new MemDriveError('INVALID_RESULT', 'The deleted reference is still present.');
                }, () => { state.uncertain = true; }, signal);
                state.deleted = true;
                state.uncertain = false;
                refStates.delete(`${kind}:${ref}`);
                if (kind === 'fork') { forks.delete(ref); writers.delete(forkPrefix + ref); }
                else checkpoints.delete(ref);
            });
        };
    }

    async function describe(options?: RequestOptions) {
        const { signal } = operationOptions(options);
        checkAbort(signal);
        return structuredClone(description);
    }

    function reader(source: RefSource, at: FileDrive['at']) {
        function read(request: ReadFileRangeRequest, options?: RequestOptions): Promise<FileReadPage | null>;
        function read(request: ReadFileRequest, options?: RequestOptions): Promise<FileListEntry | null>;
        function read(request: { paths: string[] }, options?: RequestOptions): Promise<FileListEntry[]>;
        async function read(request: ReadFileRequest | ReadFileRangeRequest | { paths: string[] }, options?: RequestOptions) {
            const { signal } = operationOptions(options);
            checkAbort(signal);
            requireInput(keysOnly(request, ['fileId', 'path', 'paths', ...rangeKeys])
                && ['fileId', 'path', 'paths'].filter(key => Object.hasOwn(request, key)).length === 1,
            'Read requires exactly one of fileId, path or paths.');
            const ranged = rangeKeys.some(key => Object.hasOwn(request, key));
            if (ranged) {
                requireInput(dimensions === undefined && !('paths' in request), 'Ranged reads require one text file.');
                validateReadRange(request as ReadFileRangeRequest);
            }
            const decode = async (doc: Record<string, unknown>) => {
                const file = decodeRead(doc, metadataSchema);
                const result = ranged ? await readRange(file as DriveFile, request as ReadFileRangeRequest, at,
                    typeof doc.version === 'string' ? doc.version : undefined) : file;
                checkAbort(signal);
                return result;
            };
            if ('fileId' in request) {
                const fileId = request.fileId;
                requireInput(validFileId(fileId), 'Provide a fileId returned by MemDrive.');
                return readRef(source, async ref => {
                    const doc = (await fetchOriginals(handle, name, ref, [fileId], signal)).get(fileId);
                    return doc?.kind === 'file' ? decode(doc) : null;
                }, signal);
            }
            const multi = 'paths' in request;
            const value = multi ? request.paths : [request.path];
            requireInput(Array.isArray(value) && value.length >= 1 && value.length <= writeBatchLimit && [...value].every(validPath)
                && new Set(value).size === value.length, 'Provide 1–100 distinct valid absolute file paths.');
            const paths: string[] = [...value];
            return readRef(source, async ref => {
                const response = await remote(() => handle.query({ size: paths.length * 2, ...viewRead(ref), query: pathQuery(paths) },
                    nativeOptions(signal)), 'Could not read files by path.', signal);
                checkAbort(signal);
                const expected = new Set(paths), files = new Map<string, FileListEntry>();
                for (const doc of resultDocs(response, name, paths.length)) {
                    const file = await decode(doc);
                    if (!expected.has(file.path) || files.has(file.path))
                        throw new MemDriveError('INVALID_RESULT', 'Read returned unexpected or duplicate paths.');
                    files.set(file.path, file);
                }
                return multi ? paths.flatMap(path => files.has(path) ? [files.get(path)!] : []) : files.get(paths[0]!) ?? null;
            }, signal);
        }
        return read;
    }

    function searcher(source: RefSource) {
        return async (request: SearchFilesRequest | SearchExternalFilesRequest, options?: RequestOptions) => {
            const { signal } = operationOptions(options);
            checkAbort(signal);
            if (dimensions !== undefined) {
                const body = vectorSearchQuery(request, metadataSchema, dimensions);
                return readRef(source, async ref => {
                    const response = await remote(() => handle.query({ ...body, ...viewRead(ref),
                        fields: { include: ['id', 'kind', 'fileId', 'path', 'modifiedAt', 'metadata'] } },
                    nativeOptions(signal)), 'File search failed.', signal);
                    checkAbort(signal);
                    const docs = resultDocs(response, name, body.size!);
                    const seen = new Set<string>();
                    const hits = docs.map(doc => {
                        const file = decodeFileEntry(doc, metadataSchema);
                        if (seen.has(file.fileId))
                            throw new MemDriveError('INVALID_RESULT', 'Search returned a duplicate file.');
                        seen.add(file.fileId);
                        return file;
                    });
                    return { hits, reranked: false as const };
                }, signal);
            }
            const body = searchQuery(request, metadataSchema);
            return readRef(source, async ref => {
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
            }, signal);
        };
    }

    function view<Selection extends FileDrive['at']>(source: RefSource, at: Selection,
        enqueueRef?: <T>(operation: () => Promise<T>, signal?: AbortSignal) => Promise<T>) {
        Object.freeze(at);
        return {
            at,
            name, read: reader(source, at), search: searcher(source), list: fileLister(handle, name, source, metadataSchema),
            findText: dimensions === undefined ? fileTextFinder(handle, name, source, metadataSchema, enqueueRef) : undefined,
            describe,
            listForks: (options?: RequestOptions) => listRefs('fork', options),
            listCheckpoints: (options?: RequestOptions) => listRefs('checkpoint', options),
            async status(options?: RequestOptions) {
                const { signal } = operationOptions(options);
                checkAbort(signal);
                return publishing.status(at, signal);
            },
            async history(request: FileHistoryRequest = {}, options?: RequestOptions) {
                const { signal } = operationOptions(options);
                checkAbort(signal);
                return publishing.history(request, signal);
            },
            async fork(request: CreateFileRefRequest, options?: RequestOptions) {
                const { signal } = operationOptions(options);
                checkAbort(signal);
                requireInput(keysOnly(request, ['name', 'asOf']) && validForkName(request.name),
                    'Fork name must be 3–47 letters, digits, underscores or hyphens and cannot be main.');
                const { asOf } = request;
                validateRefTime(asOf, at.kind === 'checkpoint');
                const fork = request.name;
                assertRefAvailable('fork', fork);
                const branchName = forkPrefix + fork;
                const create = async () => {
                    const ref = asOf === undefined ? await pinRef(source, signal)
                        : at.kind === 'main' ? await publishing.pinAt(asOf, signal)
                        : { kind: 'branch' as const, name: forkPrefix + at.name, asOf: Date.parse(asOf) };
                    await createRef(pendingRefs, { kind: 'fork', name: fork }, signal,
                        () => handle.branches.create({ branchName, source: ref }, mutationOptions(signal)),
                        response => response?.branch?.name === branchName, asOf);
                    return working(fork);
                };
                return enqueueRef ? enqueueRef(create, signal) : create();
            },
            async checkpoint(request: CreateFileRefRequest, options?: RequestOptions) {
                const { signal } = operationOptions(options);
                checkAbort(signal);
                requireInput(keysOnly(request, ['name', 'asOf']) && validCheckpointName(request.name),
                    'Checkpoint name must be 3–41 letters, digits, underscores or hyphens.');
                const { asOf } = request;
                validateRefTime(asOf, at.kind === 'checkpoint');
                const checkpoint = request.name;
                assertRefAvailable('checkpoint', checkpoint);
                const tagName = checkpointPrefix + checkpoint;
                const create = async () => {
                    const ref = asOf === undefined ? await pinRef(source, signal)
                        : at.kind === 'main' ? await publishing.pinAt(asOf, signal)
                        : { kind: 'branch' as const, name: forkPrefix + at.name, asOf: Date.parse(asOf) };
                    await createRef(pendingRefs, { kind: 'checkpoint', name: checkpoint }, signal,
                        () => handle.tags.create({ tagName, source: ref }, mutationOptions(signal)),
                        response => response?.tag?.name === tagName, asOf);
                    return pinned(checkpoint);
                };
                return enqueueRef ? enqueueRef(create, signal) : create();
            },
        };
    }

    function working(fork: string): WorkingFileDrive<EmbeddingMode> {
        const existing = forks.get(fork);
        if (existing) return existing;
        const state = { deleted: false, uncertain: false };
        refStates.set(`fork:${fork}`, state);
        const branch = forkPrefix + fork;
        const writer = writerFor(branch);
        const { enqueueRef, write, diff } = writer;
        const drive: WorkingFileDrive<EmbeddingMode> = guarded({
            ...view(branchRef(branch), { kind: 'fork', name: fork }, enqueueRef), write, diff,
            delete: refDeletion('fork', fork, state),
            merge(request: MergeRequest, options?: RequestOptions) {
                const { signal } = operationOptions(options);
                checkAbort(signal);
                validateMergeRequest(request);
                const bound = { requestId: request.requestId, summary: request.summary, branch };
                return publishing.merge(bound, writer, signal);
            },
        }, state);
        forks.set(fork, drive);
        return drive;
    }

    function pinned(checkpoint: string): CheckpointFileDrive<EmbeddingMode> {
        const existing = checkpoints.get(checkpoint);
        if (existing) return existing;
        const state = { deleted: false, uncertain: false };
        refStates.set(`checkpoint:${checkpoint}`, state);
        const drive: CheckpointFileDrive<EmbeddingMode> = guarded({
            ...view({ kind: 'tag', name: checkpointPrefix + checkpoint }, { kind: 'checkpoint', name: checkpoint }),
            delete: refDeletion('checkpoint', checkpoint, state),
        }, state);
        checkpoints.set(checkpoint, drive);
        return drive;
    }

    const mainView: MainFileDrive<EmbeddingMode> = guarded({ ...view(publishing.main, { kind: 'main' }),
        async configure(request: { retentionInDays: number }, options?: RequestOptions) {
            const { signal } = operationOptions(options);
            checkAbort(signal);
            requireInput(keysOnly(request, ['retentionInDays']) && validRetention(request.retentionInDays), 'Configure requires retentionInDays from 1–31.');
            const days = request.retentionInDays;
            return gate.exclusive(async () => {
                assertLive();
                if (pendingRetention !== undefined && pendingRetention !== days)
                    throw new MemDriveError('CONFIGURATION_UNCONFIRMED', 'Fence outstanding requests and retry the same retention value first.');
                const inspect = async () => {
                    const response = await remote(() => handle.get(nativeOptions(signal)), 'Could not inspect retention configuration.', signal);
                    const found = parseStore(response.collection, name);
                    if ((await publicationIdentity(name, response.collection)).driveId !== identity.driveId) {
                        invalid = true;
                        throw new MemDriveError('STORE_REPLACED', 'This handle belongs to a previous store generation.');
                    }
                    return found;
                };
                let found = await inspect();
                if (found.retentionInDays !== days) {
                    pendingRetention = days;
                    try {
                        await nativeRequest(() => handle.update({ snapshotRetentionInDays: days }, mutationOptions(signal)), signal);
                    } catch (cause) {
                        const error = databaseError(cause, 'Could not configure snapshot retention.');
                        if ([400, 401, 403, 404, 409, 422, 429].includes(error.status ?? 0)) { pendingRetention = undefined; throw error; }
                        throw new MemDriveError('CONFIGURATION_UNCONFIRMED', 'Retention configuration may have succeeded. Fence outstanding requests before retrying the same value.', { cause });
                    }
                    try {
                        found = await inspect();
                        if (found.retentionInDays !== days) throw new MemDriveError('INVALID_RESULT', 'The configured retention was not observed.');
                    } catch (cause) {
                        throw new MemDriveError('CONFIGURATION_UNCONFIRMED', 'Could not confirm retention configuration. Fence outstanding requests before retrying the same value.', { cause });
                    }
                }
                pendingRetention = undefined;
                description.retentionInDays = days;
                return structuredClone(description);
            });
        },
    });

    return {
        main: mainView,
        identity, assertLive, assertDeleteSafe, backendId: backend?.id,
        invalidate() { invalid = true; },
        mode: embedding.mode,
        recover: publishing.recover,
        initialize: publishing.initialize,
        async openFork(fork: string, signal?: AbortSignal) {
            assertRefAvailable('fork', fork);
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
            assertRefAvailable('checkpoint', checkpoint);
            const cached = checkpoints.get(checkpoint);
            if (cached) return cached;
            const tagName = checkpointPrefix + checkpoint;
            const response = await remote(() => handle.tags.get(tagName, nativeOptions(signal)),
                'Could not inspect the named checkpoint.', signal, { 404: 'CHECKPOINT_NOT_FOUND' });
            checkAbort(signal);
            if (response?.tag?.name !== tagName)
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

export function create(options: CreateFileStoreOptions, requestOptions?: RequestOptions): Promise<MainFileDrive>;
export function create(options: CreateExternalFileStoreOptions, requestOptions?: RequestOptions): Promise<MainFileDrive<'external'>>;
export function create(options: CreateFileStoreOptions | CreateExternalFileStoreOptions, requestOptions?: RequestOptions): Promise<MainFileDrive<EmbeddingMode>>;
export async function create(options: CreateFileStoreOptions | CreateExternalFileStoreOptions, requestOptions?: RequestOptions) {
    const { signal } = operationOptions(requestOptions);
    checkAbort(signal);
    validateConnection(options, ['client', 'name', 'labels', 'textSearch', 'metadataSchema', 'embedding', 'chunking', 'chunker', 'retentionInDays']);
    const { client, name } = options;
    return lifecycle(options).run(async () => {
        storesFor(client).get(name)?.assertLive();
        requireInput(typeof client.createCollection === 'function', 'Client must support collection creation.');
        const { indexConfigs, tags, description, collectionDescription } = storeConfiguration(options);
        if ('chunking' in description && description.chunking) textChunker(description.chunking, options.chunker, true);
        const response = await remote(() => client.createCollection({ collectionName: name, indexConfigs, tags, ...(options.retentionInDays === undefined ? {} : { snapshotRetentionInDays: options.retentionInDays }),
            ...(collectionDescription === undefined ? {} : { description: collectionDescription }) },
            nativeOptions(signal)), 'Could not create the file store.', signal, { 409: 'STORE_EXISTS' });
        checkAbort(signal);
        if (validRetention(response.collection?.snapshotRetentionInDays)) description.retentionInDays = response.collection.snapshotRetentionInDays;
        const stores = storesFor(client);
        const identity = await publicationIdentity(name, response.collection);
        checkAbort(signal);
        const created = stores.get(name) ?? store(client, client.collection(name), description, identity, options.chunker);
        stores.set(name, created);
        await created.initialize(signal);
        return created.main;
    });
}

type AtMain = { at?: undefined; recover?: boolean | undefined };
type AtFork = { at: ForkSelection; recover?: never };
type AtCheckpoint = { at: CheckpointSelection; recover?: never };

export function open(options: OpenFileStoreOptions & AtMain, requestOptions?: RequestOptions): Promise<MainFileDrive>;
export function open(options: OpenFileStoreOptions & AtFork, requestOptions?: RequestOptions): Promise<WorkingFileDrive>;
export function open(options: OpenFileStoreOptions & AtCheckpoint, requestOptions?: RequestOptions): Promise<CheckpointFileDrive>;
export function open(options: OpenFileStoreOptions<'external'> & AtMain, requestOptions?: RequestOptions): Promise<MainFileDrive<'external'>>;
export function open(options: OpenFileStoreOptions<'external'> & AtFork, requestOptions?: RequestOptions): Promise<WorkingFileDrive<'external'>>;
export function open(options: OpenFileStoreOptions<'external'> & AtCheckpoint, requestOptions?: RequestOptions): Promise<CheckpointFileDrive<'external'>>;
export function open(options: OpenFileStoreOptions, requestOptions?: RequestOptions): Promise<FileDrive>;
export function open(options: OpenFileStoreOptions<'external'>, requestOptions?: RequestOptions): Promise<FileDrive<'external'>>;
export function open(options: OpenFileStoreOptions<EmbeddingMode>, requestOptions?: RequestOptions): Promise<FileDrive<EmbeddingMode>>;
export async function open(options: OpenFileStoreOptions<EmbeddingMode>, requestOptions?: RequestOptions) {
    const { signal } = operationOptions(requestOptions);
    checkAbort(signal);
    validateConnection(options, ['client', 'name', 'at', 'recover', 'mode', 'chunker']);
    const { client, name, at, recover, mode = 'managed' } = options;
    requireInput(mode === 'managed' || mode === 'external', 'Select managed or external embedding mode.');
    requireInput(recover === undefined || at === undefined && typeof recover === 'boolean',
        'Recovery can be requested when opening main.');
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
    return lifecycle(options).run(async () => {
        const stores = storesFor(client);
        let selected = stores.get(name);
        if (!selected) {
            const handle = client.collection(name);
            const response = await remote(() => handle.get(nativeOptions(signal)), 'Could not inspect the file store.', signal, { 404: 'STORE_NOT_FOUND' });
            checkAbort(signal);
            if (response?.collection?.tags?.[formatTag] === deletingFormat)
                throw new MemDriveError('STORE_DELETING', 'Store destruction is in progress. Resume with MemDrive.destroy.');
            const description = parseStore(response?.collection, name);
            const identity = await publicationIdentity(name, response.collection);
            checkAbort(signal);
            selected = stores.get(name) ?? store(client, handle, description, identity, options.chunker);
            stores.set(name, selected);
        }
        selected.assertLive();
        if (options.chunker && selected.backendId !== options.chunker.id)
            throw new MemDriveError('CHUNKER_MISMATCH', 'The cached store is bound to another chunker. Use a separate client instance.');
        if (mode !== selected.mode)
            throw new MemDriveError('INCOMPATIBLE_STORE', `The file store uses ${selected.mode} embedding mode.`);
        if (fork !== undefined) return selected.openFork(fork, signal);
        if (checkpoint !== undefined) return selected.openCheckpoint(checkpoint, signal);
        if (recover) await selected.recover(signal);
        return selected.main;
    });
}

export async function destroy(options: ConnectionOptions, requestOptions?: RequestOptions): Promise<void> {
    const { signal } = operationOptions(requestOptions);
    checkAbort(signal);
    validateConnection(options, ['client', 'name']);
    const { client, name } = options;
    const gate = lifecycle(options);
    return gate.exclusive(async () => {
        const stores = storesFor(client);
        await destroyStore(options, async (metadata, identity) => {
            let selected = stores.get(name);
            if (selected && selected.identity.driveId !== identity.driveId) {
                selected.invalidate();
                selected = undefined;
            }
            selected ??= store(client, client.collection(name), parseStore(metadata, name), identity);
            await selected.assertDeleteSafe(signal);
        }, () => { gate.invalidate(); stores.get(name)?.invalidate(); }, signal);
        stores.delete(name);
        gate.reset();
    });
}

export const MemDrive = Object.freeze({ create, open, destroy });
