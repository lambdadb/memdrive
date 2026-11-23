import type { CheckpointAt, ConnectionOptions, CreateExternalFileStoreOptions, CreateFileStoreOptions, EmbeddingMode, FileAt, FileDrive, FileListEntry, FileSearchHit,
    FileHistoryRequest, FileStoreDescription, FindTextRequest, ForkAt, ListFilesRequest, OpenFileStoreOptions, ReadFileRequest, ReadFilesRequest, RequestOptions, SearchExternalFilesRequest,
    SearchFilesRequest, WriteFileRequest, CreateExternalFileRequest, UpdateExternalFileRequest } from './types.js';
import { checkAbort, databaseError, MemDriveError, mutationOptions, nativeOptions, nativeRequest, operationOptions, requireInput } from './errors.js';
import { formatTag, isObject, keysOnly, parseStore, storeConfiguration, validRetention } from './config.js';
import { decodeFile, decodeFileEntry, resultDocs, validFileId, validPath } from './records.js';
import { branchRef, fetchOriginals, pathQuery, pinRef, readRef, viewRead, type Handle, type RefSource, type WithoutAt } from './storage-reads.js';
import { workingWriter, writeBatchLimit } from './writes.js';
import { searchQuery, validateReranking, vectorSearchQuery } from './search.js';
import { fileLister } from './list.js';
import { fileTextFinder } from './find-text.js';
import { textChunker } from './text-chunks.js';
import type { DoclingChunker } from './types.js';
import { createRef, validateRefVersion } from './refs.js';
import { rangeKeys, readRange, validateReadRange } from './read-range.js';
import type { DriveFile, FileReadPage, ReadFileRangeRequest } from './types.js';
import { deletingFormat, deleteReference, destroyStore, lifecycle } from './lifecycle.js';
import { publicationIdentity, validateMergeRequest } from './publication-log.js';
import { publication } from './publication.js';
import { storeTag } from './cursor-tokens.js';
export type * from './types.js';
export { MemDriveError } from './errors.js';
export { createFileTools, getFileToolDefinitions, fileToolError, fileToolGuide, fileToolGuideTopics } from './tools.js';
export type { FileToolGuideTopic } from './tool-guide.js';
export type { FileToolDefinition, FileToolErrorResult, FileToolName, FileTools } from './tools.js';

type Client = ConnectionOptions['client'];

const main = 'main';
const forkPrefix = 'fork-';
const checkpointPrefix = 'checkpoint-';
const clients = new WeakMap<Client, Map<string, Store>>();
const validName = (name: unknown, maxLength = 52): name is string =>
    typeof name === 'string' && name.length >= 3 && name.length <= maxLength && /^[A-Za-z0-9_-]+$/.test(name);
const validForkName = (name: unknown): name is string => validName(name, 52 - forkPrefix.length) && name !== main;
const validCheckpointName = (name: unknown): name is string => validName(name, 52 - checkpointPrefix.length);
const atShape = 'at must be { kind: "main" }, { kind: "fork", name } or { kind: "checkpoint", name }';

/** Normalize a request's target or source view. Omission selects main. */
function parseAt(value: unknown): FileAt {
    if (value === undefined) return { kind: 'main' };
    requireInput(isObject(value) && (value.kind === 'main' ? keysOnly(value, ['kind'])
        : (value.kind === 'fork' || value.kind === 'checkpoint') && keysOnly(value, ['kind', 'name']) && Object.hasOwn(value, 'name')),
    `${atShape}.`);
    if (value.kind === 'main') return { kind: 'main' };
    if (value.kind === 'fork') {
        requireInput(validForkName(value.name), 'A fork name in at must be 3–47 letters, digits, underscores or hyphens and cannot be main.');
        return { kind: 'fork', name: value.name };
    }
    requireInput(validCheckpointName(value.name), 'A checkpoint name in at must be 3–41 letters, digits, underscores or hyphens.');
    return { kind: 'checkpoint', name: value.name };
}

/** Split a request object into its normalized view and the remaining SDK input. */
function target(request: unknown, message: string) {
    requireInput(isObject(request), message);
    const { at, ...rest } = request;
    return { at: parseAt(at), rest };
}

/** write, diff and merge act only on an explicitly selected working fork. */
function forkTarget(request: unknown, operation: string) {
    const message = `${operation} requires an explicit working fork in at, such as { kind: "fork", name }. Main and checkpoints are read-only; there is no default target.`;
    requireInput(isObject(request) && request.at !== undefined, message);
    const { at, rest } = target(request, message);
    requireInput(at.kind === 'fork', message);
    return { at, rest };
}
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
type Writer = ReturnType<typeof workingWriter>;
type RefAt = ForkAt | CheckpointAt;
type WriteOperation = WriteFileRequest | CreateExternalFileRequest | UpdateExternalFileRequest;
const refKey = (at: RefAt) => `${at.kind}:${at.name}`;

function store(client: Client, handle: Handle, description: FileStoreDescription<EmbeddingMode>, identity: Awaited<ReturnType<typeof publicationIdentity>>, backend?: DoclingChunker) {
    const { name, metadataSchema, embedding } = description;
    const gate = lifecycle({ client, name });
    let invalid = false;
    let pendingRetention: number | undefined;
    function assertLive() {
        if (invalid) throw new MemDriveError('STORE_DELETED', 'This store handle has been invalidated by destruction.');
    }
    /** Track complete operations for lifecycle exclusion. */
    const run = <T>(operation: () => Promise<T>) => gate.run(async () => {
        assertLive();
        return operation();
    });
    const dimensions = embedding.mode === 'external' ? embedding.dimensions : undefined;
    const chunker = 'chunking' in description && description.chunking ? textChunker(description.chunking, backend) : undefined;
    if (!chunker && backend) throw new MemDriveError('INCOMPATIBLE_STORE', 'This store does not support configured structured chunking.');
    const decodeRead = dimensions === undefined ? decodeFile : decodeFileEntry;
    const cursorStore = storeTag(identity.driveId);
    // Confirmed forks and checkpoints, keyed by kind and name. Deletion removes
    // the entry and its cursors; an unconfirmed deletion keeps it fenced.
    const refs = new Map<string, View>();
    const pendingRefs = new Set<string>();
    const writers = new Map<string, Writer>();
    function writerFor(branch: string) {
        const existing = writers.get(branch);
        if (existing) return existing;
        const writer = workingWriter(handle, name, branch, metadataSchema, dimensions, chunker);
        writers.set(branch, writer);
        return writer;
    }
    const publishing = publication(client, handle, identity, metadataSchema, writerFor, dimensions,
        () => gate.soleOperation() && !invalid && pendingRetention === undefined && pendingRefs.size === 0
            && ![...refs.values()].some(view => view.uncertain));

    async function assertDeleteSafe(signal?: AbortSignal, retry?: View) {
        if (pendingRetention !== undefined) throw new MemDriveError('CONFIGURATION_UNCONFIRMED', 'Settle the pending retention configuration before deleting resources.');
        if (pendingRefs.size) throw new MemDriveError('REF_CREATION_UNCONFIRMED', 'Resolve unconfirmed reference creation before deleting.');
        if ([...refs.values()].some(view => view !== retry && view.uncertain))
            throw new MemDriveError('REF_DELETION_UNCONFIRMED', 'Settle unconfirmed reference deletion before deleting other resources.');
        await publishing.assertIdle(signal);
        for (const writer of writers.values()) await writer.enqueueRef(async () => undefined, signal);
    }

    async function listRefs(kind: 'fork' | 'checkpoint', signal?: AbortSignal) {
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
            ? [name.slice(prefix.length)] : []).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    }

    async function describe(options?: RequestOptions) {
        const { signal } = operationOptions(options);
        checkAbort(signal);
        return run(async () => structuredClone(description));
    }

    function reader(source: RefSource, at: FileAt) {
        type Request = WithoutAt<ReadFileRequest | ReadFileRangeRequest | ReadFilesRequest>;
        async function read(request: Request, options?: RequestOptions): Promise<FileReadPage | FileListEntry | FileListEntry[] | null> {
            const { signal } = operationOptions(options);
            checkAbort(signal);
            requireInput(keysOnly(request, ['fileId', 'path', 'paths', ...rangeKeys])
                && ['fileId', 'path', 'paths'].filter(key => Object.hasOwn(request, key)).length === 1,
            'Read requires exactly one of fileId, path or paths.');
            const ranged = rangeKeys.some(key => Object.hasOwn(request, key));
            if (ranged) {
                requireInput(dimensions === undefined && !('paths' in request), 'Ranged reads require one text file.');
                validateReadRange(request as WithoutAt<ReadFileRangeRequest>);
            }
            const decode = async (doc: Record<string, unknown>) => {
                const file = decodeRead(doc, metadataSchema);
                const result = ranged ? await readRange(file as DriveFile, request as WithoutAt<ReadFileRangeRequest>, at,
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

    function view(at: FileAt, source: RefSource, writer?: Writer) {
        Object.freeze(at);
        return {
            at, source, writer, uncertain: false,
            read: reader(source, at), search: searcher(source),
            lister: fileLister(handle, name, source, metadataSchema, at),
            finder: dimensions === undefined ? fileTextFinder(handle, name, source, metadataSchema, at,
                { enqueue: writer?.enqueueRef, pinVersion: publishing.pinVersion, store: cursorStore }) : undefined,
        };
    }
    type View = ReturnType<typeof view>;
    const mainView: View = view({ kind: 'main' }, publishing.main);

    function refView(at: RefAt): View {
        const key = refKey(at);
        const existing = refs.get(key);
        if (existing) return existing;
        const created = at.kind === 'fork'
            ? view({ kind: 'fork', name: at.name }, branchRef(forkPrefix + at.name), writerFor(forkPrefix + at.name))
            : view({ kind: 'checkpoint', name: at.name }, { kind: 'tag', name: checkpointPrefix + at.name });
        refs.set(key, created);
        return created;
    }

    function assertRefAvailable(at: RefAt) {
        if (refs.get(refKey(at))?.uncertain)
            throw new MemDriveError('REF_DELETION_UNCONFIRMED', `Fence outstanding requests and retry ${at.kind === 'fork' ? 'deleteFork' : 'deleteCheckpoint'} with the same at.`);
    }

    /** Resolve a view, verifying a fork or checkpoint on its first use in this client. */
    async function resolve(at: FileAt, signal?: AbortSignal): Promise<View> {
        if (at.kind === 'main') return mainView;
        assertRefAvailable(at);
        const cached = refs.get(refKey(at));
        if (cached) return cached;
        if (at.kind === 'fork') {
            const response = await remote(() => handle.branches.list(nativeOptions(signal)), 'Could not find the working fork.', signal);
            checkAbort(signal);
            if (!Array.isArray(response?.branches) || !response.branches.every(branch => typeof branch?.name === 'string'))
                throw new MemDriveError('INVALID_RESULT', 'Fork lookup returned invalid branches.');
            if (!response.branches.some(branch => branch.name === forkPrefix + at.name))
                throw new MemDriveError('BRANCH_NOT_FOUND', 'The working fork does not exist.');
        } else {
            const tagName = checkpointPrefix + at.name;
            const response = await remote(() => handle.tags.get(tagName, nativeOptions(signal)),
                'Could not inspect the named checkpoint.', signal, { 404: 'CHECKPOINT_NOT_FOUND' });
            checkAbort(signal);
            if (response?.tag?.name !== tagName)
                throw new MemDriveError('INVALID_RESULT', 'Checkpoint lookup returned an invalid tag.');
        }
        pendingRefs.delete(refKey(at));
        return refView(at);
    }

    /** Reject a live list cursor issued for another view of this store without consuming it. */
    function assertListView(selected: View, rest: Record<string, unknown>) {
        const { cursor } = rest;
        if (Object.keys(rest).length !== 1 || typeof cursor !== 'string' || selected.lister.owns(cursor)) return;
        for (const other of [mainView, ...refs.values()]) {
            if (other !== selected && other.lister.owns(cursor))
                throw new MemDriveError('CURSOR_VIEW_MISMATCH', 'This cursor belongs to another view. Forward the returned next request unchanged, including its at.');
        }
    }

    function begin(options?: RequestOptions) {
        const { signal } = operationOptions(options);
        checkAbort(signal);
        return signal;
    }

    async function createView(kind: 'fork' | 'checkpoint', request: unknown, options?: RequestOptions) {
        const signal = begin(options);
        requireInput(keysOnly(request, ['at', 'name', 'version']), `${kind} accepts an optional source at, a name and an optional version.`);
        const source = parseAt(request.at);
        requireInput(kind === 'fork' ? validForkName(request.name) : validCheckpointName(request.name), kind === 'fork'
            ? 'Fork name must be 3–47 letters, digits, underscores or hyphens and cannot be main.'
            : 'Checkpoint name must be 3–41 letters, digits, underscores or hyphens.');
        const { version } = request;
        validateRefVersion(version, source.kind === 'main');
        const at = { kind, name: request.name } as RefAt;
        return run(async () => {
            assertRefAvailable(at);
            const selected = await resolve(source, signal);
            const create = async () => {
                const ref = version === undefined ? await pinRef(selected.source, signal)
                    : await publishing.pinVersion(version, signal);
                if (kind === 'fork') {
                    const branchName = forkPrefix + at.name;
                    await createRef(pendingRefs, at, signal, () => handle.branches.create({ branchName, source: ref }, mutationOptions(signal)),
                        response => response?.branch?.name === branchName, version);
                } else {
                    const tagName = checkpointPrefix + at.name;
                    await createRef(pendingRefs, at, signal, () => handle.tags.create({ tagName, source: ref }, mutationOptions(signal)),
                        response => response?.tag?.name === tagName, version);
                }
                refView(at);
                return { at: { ...at } };
            };
            // Captures of a working fork are ordered with its writes.
            return selected.writer ? selected.writer.enqueueRef(create, signal) : create();
        });
    }

    async function deleteView(kind: 'fork' | 'checkpoint', request: unknown, options?: RequestOptions) {
        const signal = begin(options);
        const operation = kind === 'fork' ? 'deleteFork' : 'deleteCheckpoint';
        requireInput(keysOnly(request, ['at']) && isObject(request.at) && request.at.kind === kind,
            `${operation} requires only at, selecting an existing ${kind}: { kind: "${kind}", name }.`);
        const at = parseAt(request.at) as RefAt;
        return gate.exclusive(async () => {
            assertLive();
            // A fenced view after an unconfirmed deletion is retried here, not resolved again.
            const selected = refs.get(refKey(at)) ?? await resolve(at, signal);
            await assertDeleteSafe(signal, selected);
            const native = kind === 'fork' ? forkPrefix + at.name : checkpointPrefix + at.name;
            await deleteReference(() => kind === 'fork'
                ? handle.branches.delete(native, mutationOptions(signal))
                : handle.tags.delete(native, mutationOptions(signal)), async () => {
                try {
                    await nativeRequest<unknown>(() => kind === 'fork'
                        ? handle.branches.get(native, nativeOptions(signal))
                        : handle.tags.get(native, nativeOptions(signal)), signal);
                } catch (cause) {
                    if (databaseError(cause, 'Could not confirm reference deletion.').status === 404) return;
                    throw cause;
                }
                throw new MemDriveError('INVALID_RESULT', 'The deleted reference is still present.');
            }, () => { selected.uncertain = true; }, signal);
            refs.delete(refKey(at));
            selected.lister.release();
            if (kind === 'fork') writers.delete(native);
            return { at: { ...at } };
        });
    }

    async function onFork(operation: string, request: unknown, options: RequestOptions | undefined,
        apply: (writer: Writer, rest: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>, validate?: (rest: Record<string, unknown>) => void) {
        const signal = begin(options);
        const { at, rest } = forkTarget(request, operation);
        validate?.(rest);
        return run(async () => {
            const selected = await resolve(at, signal);
            return apply(selected.writer!, rest, signal);
        });
    }

    async function onView<T>(request: unknown, message: string, options: RequestOptions | undefined,
        apply: (selected: View, rest: Record<string, unknown>, signal?: AbortSignal) => Promise<T>) {
        const signal = begin(options);
        const { at, rest } = target(request, message);
        return run(async () => apply(await resolve(at, signal), rest, signal));
    }

    const drive = Object.freeze({
        name, describe,
        async status(request: unknown = {}, options?: RequestOptions) {
            requireInput(keysOnly(request, ['at']), 'status accepts only an optional at.');
            return onView(request, 'status accepts only an optional at.', options,
                (selected, _rest, signal) => publishing.status({ ...selected.at }, signal));
        },
        async history(request: FileHistoryRequest = {}, options?: RequestOptions) {
            const signal = begin(options);
            return run(() => publishing.history(request, signal));
        },
        list: (request: unknown = {}, options?: RequestOptions) => onView(request, 'Invalid list options.', options, (selected, rest, signal) => {
            assertListView(selected, rest);
            return selected.lister.list(rest as WithoutAt<ListFilesRequest>, { signal });
        }),
        read: (request: unknown, options?: RequestOptions) => onView(request, 'Read requires exactly one of fileId, path or paths.', options,
            (selected, rest, signal) => selected.read(rest as WithoutAt<ReadFileRequest>, { signal })),
        search: (request: unknown, options?: RequestOptions) => onView(request, 'Search requires a request object.', options,
            (selected, rest, signal) => selected.search(rest as unknown as SearchFilesRequest, { signal })),
        findText: dimensions === undefined
            ? (request: unknown, options?: RequestOptions) => onView(request, 'Invalid text match options.', options,
                (selected, rest, signal) => selected.finder!(rest as WithoutAt<FindTextRequest>, { signal }))
            : undefined,
        fork: (request: unknown, options?: RequestOptions) => createView('fork', request, options),
        checkpoint: (request: unknown, options?: RequestOptions) => createView('checkpoint', request, options),
        async listForks(request: unknown = {}, options?: RequestOptions) {
            const signal = begin(options);
            requireInput(keysOnly(request, []), 'listForks accepts an empty object.');
            return run(async () => ({ forks: (await listRefs('fork', signal)).map(name => ({ at: { kind: 'fork' as const, name } })) }));
        },
        async listCheckpoints(request: unknown = {}, options?: RequestOptions) {
            const signal = begin(options);
            requireInput(keysOnly(request, []), 'listCheckpoints accepts an empty object.');
            return run(async () => ({ checkpoints: (await listRefs('checkpoint', signal)).map(name => ({ at: { kind: 'checkpoint' as const, name } })) }));
        },
        deleteFork: (request: unknown, options?: RequestOptions) => deleteView('fork', request, options),
        deleteCheckpoint: (request: unknown, options?: RequestOptions) => deleteView('checkpoint', request, options),
        write: (request: unknown, options?: RequestOptions) => onFork('write', request, options,
            (writer, rest, signal) => 'operations' in rest
                ? writer.write(rest.operations as WriteOperation[], { signal })
                : writer.write(rest as unknown as WriteOperation, { signal }),
            rest => requireInput(!('operations' in rest) || keysOnly(rest, ['operations']) && Array.isArray(rest.operations),
                'A batch write accepts only at and an operations array.')),
        diff: (request: unknown, options?: RequestOptions) => onFork('diff', request, options,
            (writer, _rest, signal) => writer.diff({ signal }),
            rest => requireInput(Object.keys(rest).length === 0, 'diff accepts only at.')),
        merge: (request: unknown, options?: RequestOptions) => onFork('merge', request, options, (writer, rest, signal) => {
            const { at } = request as { at: ForkAt };
            return publishing.merge({ requestId: rest.requestId as string, summary: rest.summary as string, branch: forkPrefix + at.name }, writer, signal);
        }, rest => validateMergeRequest(rest)),
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
    }) as unknown as FileDrive<EmbeddingMode>;

    return {
        drive,
        identity, assertLive, assertDeleteSafe, backendId: backend?.id,
        invalidate() { invalid = true; },
        mode: embedding.mode,
        recover: publishing.recover,
        initialize: publishing.initialize,
    };
}

function storesFor(client: Client) {
    const existing = clients.get(client);
    if (existing) return existing;
    const stores = new Map<string, Store>();
    clients.set(client, stores);
    return stores;
}

export function create(options: CreateFileStoreOptions, requestOptions?: RequestOptions): Promise<FileDrive>;
export function create(options: CreateExternalFileStoreOptions, requestOptions?: RequestOptions): Promise<FileDrive<'external'>>;
export function create(options: CreateFileStoreOptions | CreateExternalFileStoreOptions, requestOptions?: RequestOptions): Promise<FileDrive<EmbeddingMode>>;
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
        return created.drive;
    });
}

export function open(options: OpenFileStoreOptions, requestOptions?: RequestOptions): Promise<FileDrive>;
export function open(options: OpenFileStoreOptions<'external'>, requestOptions?: RequestOptions): Promise<FileDrive<'external'>>;
export function open(options: OpenFileStoreOptions<EmbeddingMode>, requestOptions?: RequestOptions): Promise<FileDrive<EmbeddingMode>>;
export async function open(options: OpenFileStoreOptions<EmbeddingMode>, requestOptions?: RequestOptions) {
    const { signal } = operationOptions(requestOptions);
    checkAbort(signal);
    validateConnection(options, ['client', 'name', 'recover', 'mode', 'chunker']);
    const { client, name, recover, mode = 'managed' } = options;
    requireInput(mode === 'managed' || mode === 'external', 'Select managed or external embedding mode.');
    requireInput(recover === undefined || typeof recover === 'boolean', 'recover must be a boolean.');
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
        if (recover) await selected.recover(signal);
        return selected.drive;
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
