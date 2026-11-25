import type { CheckpointAt, ConnectionOptions, CreateExternalFileStoreOptions, CreateFileStoreOptions, EmbeddingMode, FileAt, FileDrive, FileListEntry, FileSearchHit,
    FileStoreDescription, FindTextRequest, ForkAt, ListFilesRequest, OpenFileStoreOptions, ReadFileRequest, ReadFilesRequest, RequestOptions, SearchExternalFilesRequest,
    SearchFilesRequest, WritableAt, CreateExternalFileRequest, UpdateExternalFileRequest, WriteFileRequest } from './types.js';
import { checkAbort, databaseError, MemDriveError, mutationOptions, nativeOptions, nativeRequest, operationOptions, requireInput } from './errors.js';
import { isObject, keysOnly, parseStore, snapshotRetentionInDays, storeConfiguration } from './config.js';
import { contentHash, decodeFile, decodeFileEntry, resultDocs, validFileId, validPath } from './records.js';
import { fetchOriginals, pathQuery, viewRead, type Handle, type ViewRef, type WithoutAt } from './storage-reads.js';
import { fileWriter, writeBatchLimit } from './writes.js';
import { searchQuery, validateReranking, vectorSearchQuery } from './search.js';
import { fileLister } from './list.js';
import { fileTextFinder } from './find-text.js';
import { textChunker } from './text-chunks.js';
import type { DoclingChunker } from './types.js';
import { rangeKeys, readRange, validateReadRange } from './read-range.js';
import type { DriveFile, FileReadPage, ReadFileRangeRequest } from './types.js';
import { storeTag } from './cursor-tokens.js';
export type * from './types.js';
// The LambdaDB client classes at the exact version this SDK pins, so a host
// constructs its client without depending on @functional-systems/lambdadb itself.
export { HTTPClient, LambdaDBClient } from '@functional-systems/lambdadb';
export { MemDriveError } from './errors.js';
export { createFileTools, getFileToolDefinitions, fileToolError, fileToolGuide, fileToolGuideTopics } from './tools.js';
export { fileToolInstructions } from './tool-guide.js';
export type { FileToolGuideTopic } from './tool-guide.js';
export type { FileToolDefinition, FileToolErrorResult, FileToolName, FileTools } from './tools.js';

type RefAt = ForkAt | CheckpointAt;
type WriteOperation = WriteFileRequest | CreateExternalFileRequest | UpdateExternalFileRequest;

const forkPrefix = 'fork-';
const checkpointPrefix = 'checkpoint-';
const validName = (name: unknown, maxLength = 52): name is string =>
    typeof name === 'string' && name.length >= 3 && name.length <= maxLength && /^[A-Za-z0-9_-]+$/.test(name);
const validForkName = (name: unknown): name is string => validName(name, 52 - forkPrefix.length) && name !== 'main';
const validCheckpointName = (name: unknown): name is string => validName(name, 52 - checkpointPrefix.length);
/** Rows fetched by a path read: enough to expose files that share a path. */
const pathReadSize = 1000;
const atShape = 'at must be { kind: "main" }, { kind: "fork", name } or { kind: "checkpoint", name }';

/** Normalize a request's view. Omission selects main. */
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

/** The native ref of a view: main and forks are branches, checkpoints are tags. */
function refOf(at: FileAt): ViewRef {
    if (at.kind === 'main') return { kind: 'branch', name: 'main' };
    return at.kind === 'fork' ? { kind: 'branch', name: forkPrefix + at.name } : { kind: 'tag', name: checkpointPrefix + at.name };
}
const branchOf = (at: WritableAt) => at.kind === 'main' ? 'main' : forkPrefix + at.name;

/** Split a request object into its normalized view and the remaining SDK input. */
function target(request: unknown, message: string) {
    requireInput(isObject(request), message);
    const { at, ...rest } = request;
    return { at: parseAt(at), rest };
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

function begin(options?: RequestOptions) {
    const { signal } = operationOptions(options);
    checkAbort(signal);
    return signal;
}

/**
 * One drive object of a store. It keeps the store's configuration and holds
 * no other state: every call resolves its view from `at` and goes to LambdaDB.
 */
function store(handle: Handle, description: FileStoreDescription<EmbeddingMode>, cursorStore: string, backend?: DoclingChunker) {
    const { name, metadataSchema, embedding } = description;
    const dimensions = embedding.mode === 'external' ? embedding.dimensions : undefined;
    const chunker = 'chunking' in description ? textChunker(description.chunking, backend) : undefined;
    if (!chunker && backend) throw new MemDriveError('INCOMPATIBLE_STORE', 'This store does not support configured structured chunking.');
    const decodeRead = dimensions === undefined ? decodeFile : decodeFileEntry;
    const writer = fileWriter(handle, name, metadataSchema, dimensions, chunker);
    const lister = fileLister(handle, name, metadataSchema, cursorStore);
    const finder = dimensions === undefined ? fileTextFinder(handle, name, metadataSchema, cursorStore, refIncarnation) : undefined;

    /** Whether a native GET reports 404. Other failures leave the original error in place. */
    async function absent(lookup: () => Promise<unknown>, signal?: AbortSignal) {
        try { await nativeRequest(lookup, signal); return false; }
        catch (cause) { return databaseError(cause, 'Lookup failed.').status === 404; }
    }

    /**
     * Name what a native 404 refers to. LambdaDB reports a missing collection
     * and a missing ref alike, so only the failure path inspects which is gone.
     */
    async function onViews<T>(views: FileAt[], operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        try { return await operation(); }
        catch (cause) {
            if (!(cause instanceof MemDriveError) || cause.status !== 404) throw cause;
            const notFound = (code: string, message: string) => {
                const error = new MemDriveError(code, message, { cause, ...(cause.details === undefined ? {} : { details: cause.details }) });
                error.status = 404;
                return error;
            };
            if (await absent(() => handle.get(nativeOptions(signal)), signal))
                throw notFound('STORE_NOT_FOUND', 'The file store does not exist.');
            for (const at of views) {
                if (at.kind === 'fork' && await absent(() => handle.branches.get(forkPrefix + at.name, nativeOptions(signal)), signal))
                    throw notFound('BRANCH_NOT_FOUND', `The fork ${at.name} does not exist.`);
                if (at.kind === 'checkpoint' && await absent(() => handle.tags.get(checkpointPrefix + at.name, nativeOptions(signal)), signal))
                    throw notFound('CHECKPOINT_NOT_FOUND', `The checkpoint ${at.name} does not exist.`);
            }
            throw cause;
        }
    }

    /** Run a request against the view its at selects. */
    async function onView<T>(request: unknown, message: string, options: RequestOptions | undefined,
        apply: (at: FileAt, ref: ViewRef, rest: Record<string, unknown>, signal?: AbortSignal) => Promise<T>) {
        const signal = begin(options);
        const { at, rest } = target(request, message);
        return onViews([at], () => apply(at, refOf(at), rest, signal), signal);
    }

    /** A fork's or checkpoint's current identity; a recreated ref with the same name differs. */
    async function refIncarnation(at: RefAt, signal?: AbortSignal) {
        const time = (value: unknown) => value instanceof Date ? value.getTime() : value;
        let identity: unknown[];
        if (at.kind === 'fork') {
            const branchName = forkPrefix + at.name;
            const { branch } = await remote(() => handle.branches.get(branchName, nativeOptions(signal)),
                'Could not inspect the fork.', signal, { 404: 'BRANCH_NOT_FOUND' });
            identity = [branch?.name === branchName ? time(branch.createdAt) : undefined, branch?.parentSnapshot?.snapshotId ?? null];
        } else {
            const tagName = checkpointPrefix + at.name;
            const { tag } = await remote(() => handle.tags.get(tagName, nativeOptions(signal)),
                'Could not inspect the checkpoint.', signal, { 404: 'CHECKPOINT_NOT_FOUND' });
            // A tag created before its source's first snapshot reports a null
            // snapshotId that becomes a string once published, so only the
            // creation time identifies its incarnation.
            identity = [tag?.name === tagName ? time(tag.createdAt) : undefined, null];
        }
        checkAbort(signal);
        if (!Number.isSafeInteger(identity[0]) || (identity[1] !== null && (typeof identity[1] !== 'string' || !identity[1])))
            throw new MemDriveError('INVALID_RESULT', 'Reference lookup returned an invalid identity.');
        return (await contentHash(JSON.stringify(identity))).slice(0, 32);
    }

    type Request = WithoutAt<ReadFileRequest | ReadFileRangeRequest | ReadFilesRequest>;
    async function read(at: FileAt, ref: ViewRef, request: Request, signal?: AbortSignal): Promise<FileReadPage | FileListEntry | FileListEntry[] | null> {
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
            const result = ranged ? await readRange(file as DriveFile, request as WithoutAt<ReadFileRangeRequest>, at) : file;
            checkAbort(signal);
            return result;
        };
        if ('fileId' in request) {
            const fileId = request.fileId;
            requireInput(validFileId(fileId), 'Provide a fileId returned by MemDrive.');
            const doc = (await fetchOriginals(handle, name, ref, [fileId], signal)).get(fileId);
            return doc ? decode(doc) : null;
        }
        const multi = 'paths' in request;
        const value = multi ? request.paths : [request.path];
        requireInput(Array.isArray(value) && value.length >= 1 && value.length <= writeBatchLimit && [...value].every(validPath)
            && new Set(value).size === value.length, 'Provide 1–100 distinct valid absolute file paths.');
        const paths: string[] = [...value];
        // Concurrent creates can leave several files at one path; fetch enough
        // rows to see them and report the ambiguity instead of picking one.
        const response = await remote(() => handle.query({ size: pathReadSize, ...viewRead(ref), query: pathQuery(paths) },
            nativeOptions(signal)), 'Could not read files by path.', signal);
        checkAbort(signal);
        const expected = new Set(paths), files = new Map<string, FileListEntry>(), ambiguous = new Map<string, string[]>();
        for (const doc of resultDocs(response, name, pathReadSize)) {
            const file = await decode(doc);
            if (!expected.has(file.path))
                throw new MemDriveError('INVALID_RESULT', 'Read returned an unexpected path.');
            const other = files.get(file.path);
            if (other) ambiguous.set(file.path, [...(ambiguous.get(file.path) ?? [other.fileId]), file.fileId]);
            files.set(file.path, file);
        }
        if (ambiguous.size) throw new MemDriveError('PATH_AMBIGUOUS', 'Several files share a requested path. Read or change them by fileId.',
            { details: { paths: [...ambiguous].map(([path, fileIds]) => ({ path, fileIds: fileIds.sort() })) } });
        return multi ? paths.flatMap(path => files.has(path) ? [files.get(path)!] : []) : files.get(paths[0]!) ?? null;
    }

    async function search(ref: ViewRef, request: SearchFilesRequest | SearchExternalFilesRequest, signal?: AbortSignal) {
        if (dimensions !== undefined) {
            const body = vectorSearchQuery(request, metadataSchema, dimensions);
            const response = await remote(() => handle.query({ ...body, ...viewRead(ref),
                fields: { include: ['id', 'kind', 'fileId', 'path', 'modifiedAt', 'metadata'] } },
            nativeOptions(signal)), 'File search failed.', signal);
            checkAbort(signal);
            const seen = new Set<string>();
            const hits = resultDocs(response, name, body.size!).map(doc => {
                const file = decodeFileEntry(doc, metadataSchema);
                if (seen.has(file.fileId)) throw new MemDriveError('INVALID_RESULT', 'Search returned a duplicate file.');
                seen.add(file.fileId);
                return file;
            });
            return { hits, reranked: false as const };
        }
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
        const files = new Map([...originals].map(([id, doc]) => [id, decodeFile(doc, metadataSchema)] as const));
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

    /** Create a fork (branch) or checkpoint (tag) from a source view with one native request. */
    async function createRef(kind: 'fork' | 'checkpoint', request: unknown, options?: RequestOptions) {
        const signal = begin(options);
        requireInput(keysOnly(request, ['at', 'name']), `${kind} accepts an optional source at and a name.`);
        const source = parseAt(request.at);
        requireInput(kind === 'fork' ? validForkName(request.name) : validCheckpointName(request.name), kind === 'fork'
            ? 'Fork name must be 3–47 letters, digits, underscores or hyphens and cannot be main.'
            : 'Checkpoint name must be 3–41 letters, digits, underscores or hyphens.');
        const at = { kind, name: request.name } as RefAt;
        const nativeName = (kind === 'fork' ? forkPrefix : checkpointPrefix) + at.name;
        const created = await onViews([source], () => kind === 'fork'
            ? remote(() => handle.branches.create({ branchName: nativeName, source: refOf(source) }, mutationOptions(signal)),
                'Could not create the fork.', signal, { 409: 'BRANCH_CONFLICT' }).then(response => response?.branch?.name)
            : remote(() => handle.tags.create({ tagName: nativeName, source: refOf(source) }, mutationOptions(signal)),
                'Could not create the checkpoint.', signal, { 409: 'CHECKPOINT_CONFLICT' }).then(response => response?.tag?.name), signal);
        if (created !== nativeName) throw new MemDriveError('INVALID_RESULT', `${kind} creation returned another reference.`);
        return { at: { ...at } };
    }

    async function deleteRef(kind: 'fork' | 'checkpoint', request: unknown, options?: RequestOptions) {
        const signal = begin(options);
        const operation = kind === 'fork' ? 'deleteFork' : 'deleteCheckpoint';
        requireInput(keysOnly(request, ['at']) && isObject(request.at) && request.at.kind === kind,
            `${operation} requires only at, selecting an existing ${kind}: { kind: "${kind}", name }.`);
        const at = parseAt(request.at) as RefAt;
        const nativeName = (kind === 'fork' ? forkPrefix : checkpointPrefix) + at.name;
        await onViews([at], () => remote(() => kind === 'fork'
            ? handle.branches.delete(nativeName, mutationOptions(signal))
            : handle.tags.delete(nativeName, mutationOptions(signal)), `Could not delete the ${kind}.`, signal), signal);
        return { at: { ...at } };
    }

    const drive = Object.freeze({
        name,
        async describe(options?: RequestOptions) {
            begin(options);
            return structuredClone(description);
        },
        list: (request: unknown = {}, options?: RequestOptions) => onView(request, 'Invalid list options.', options,
            (at, ref, rest, signal) => lister(at, ref, rest as WithoutAt<ListFilesRequest>, { signal })),
        read: (request: unknown, options?: RequestOptions) => onView(request, 'Read requires exactly one of fileId, path or paths.', options,
            (at, ref, rest, signal) => read(at, ref, rest as Request, signal)),
        search: (request: unknown, options?: RequestOptions) => onView(request, 'Search requires a request object.', options,
            (_at, ref, rest, signal) => search(ref, rest as unknown as SearchFilesRequest, signal)),
        findText: finder === undefined ? undefined
            : (request: unknown, options?: RequestOptions) => onView(request, 'Invalid text match options.', options,
                (at, ref, rest, signal) => finder(at, ref, rest as WithoutAt<FindTextRequest>, { signal })),
        fork: (request: unknown, options?: RequestOptions) => createRef('fork', request, options),
        checkpoint: (request: unknown, options?: RequestOptions) => createRef('checkpoint', request, options),
        async listForks(request: unknown = {}, options?: RequestOptions) {
            const signal = begin(options);
            requireInput(keysOnly(request, []), 'listForks accepts an empty object.');
            return { forks: (await listRefs('fork', signal)).map(name => ({ at: { kind: 'fork' as const, name } })) };
        },
        async listCheckpoints(request: unknown = {}, options?: RequestOptions) {
            const signal = begin(options);
            requireInput(keysOnly(request, []), 'listCheckpoints accepts an empty object.');
            return { checkpoints: (await listRefs('checkpoint', signal)).map(name => ({ at: { kind: 'checkpoint' as const, name } })) };
        },
        deleteFork: (request: unknown, options?: RequestOptions) => deleteRef('fork', request, options),
        deleteCheckpoint: (request: unknown, options?: RequestOptions) => deleteRef('checkpoint', request, options),
        write: (request: unknown, options?: RequestOptions) => onView(request, 'Write requires a request object.', options, (at, _ref, rest, signal) => {
            requireInput(at.kind !== 'checkpoint', 'Checkpoints are read-only. Write to main or a fork.');
            requireInput(!('operations' in rest) || keysOnly(rest, ['operations']) && Array.isArray(rest.operations),
                'A batch write accepts only at and an operations array.');
            return writer.write(branchOf(at), 'operations' in rest ? rest.operations as WriteOperation[] : rest as unknown as WriteOperation, { signal });
        }),
        /** Restore main or a fork to a checkpoint with one native rollback, never retried. */
        async rollback(request: unknown, options?: RequestOptions) {
            const signal = begin(options);
            const message = 'rollback requires at, selecting main or a fork, and to, selecting a checkpoint.';
            requireInput(keysOnly(request, ['at', 'to']) && isObject(request.at) && isObject(request.to), message);
            const at = parseAt(request.at), to = parseAt(request.to);
            requireInput(at.kind !== 'checkpoint' && to.kind === 'checkpoint', message);
            await onViews([at, to], () => remote(() => handle.branches.rollback(branchOf(at), { tag: checkpointPrefix + to.name },
                mutationOptions(signal)), `Could not roll back to the checkpoint ${to.name}.`, signal), signal);
            return { at: { ...at } };
        },
    }) as unknown as FileDrive<EmbeddingMode>;
    return drive;
}

export function create(options: CreateFileStoreOptions, requestOptions?: RequestOptions): Promise<FileDrive>;
export function create(options: CreateExternalFileStoreOptions, requestOptions?: RequestOptions): Promise<FileDrive<'external'>>;
export function create(options: CreateFileStoreOptions | CreateExternalFileStoreOptions, requestOptions?: RequestOptions): Promise<FileDrive<EmbeddingMode>>;
export async function create(options: CreateFileStoreOptions | CreateExternalFileStoreOptions, requestOptions?: RequestOptions) {
    const signal = begin(requestOptions);
    validateConnection(options, ['client', 'name', 'labels', 'textSearch', 'metadataSchema', 'embedding', 'chunking', 'chunker']);
    const { client, name } = options;
    requireInput(typeof client.createCollection === 'function', 'Client must support collection creation.');
    const { indexConfigs, tags, description, collectionDescription } = storeConfiguration(options);
    if ('chunking' in description) textChunker(description.chunking, options.chunker, true);
    const response = await remote(() => client.createCollection({ collectionName: name, indexConfigs, tags,
        snapshotRetentionInDays, description: collectionDescription },
    nativeOptions(signal)), 'Could not create the file store.', signal, { 409: 'STORE_EXISTS' });
    return store(client.collection(name), description, await storeTag(name, response.collection), options.chunker);
}

export function open(options: OpenFileStoreOptions, requestOptions?: RequestOptions): Promise<FileDrive>;
export function open(options: OpenFileStoreOptions<'external'>, requestOptions?: RequestOptions): Promise<FileDrive<'external'>>;
export function open(options: OpenFileStoreOptions<EmbeddingMode>, requestOptions?: RequestOptions): Promise<FileDrive<EmbeddingMode>>;
export async function open(options: OpenFileStoreOptions<EmbeddingMode>, requestOptions?: RequestOptions) {
    const signal = begin(requestOptions);
    validateConnection(options, ['client', 'name', 'mode', 'chunker']);
    const { client, name, mode = 'managed' } = options;
    requireInput(mode === 'managed' || mode === 'external', 'Select managed or external embedding mode.');
    const handle = client.collection(name);
    const response = await remote(() => handle.get(nativeOptions(signal)), 'Could not inspect the file store.', signal, { 404: 'STORE_NOT_FOUND' });
    checkAbort(signal);
    const description = parseStore(response?.collection, name);
    if (description.embedding.mode !== mode)
        throw new MemDriveError('INCOMPATIBLE_STORE', `The file store uses ${description.embedding.mode} embedding mode.`);
    return store(handle, description, await storeTag(name, response.collection), options.chunker);
}

/**
 * Delete the store's collection, including every fork and checkpoint. A missing
 * store is already destroyed; a collection that is not a file store is refused.
 */
export async function destroy(options: ConnectionOptions, requestOptions?: RequestOptions): Promise<void> {
    const signal = begin(requestOptions);
    validateConnection(options, ['client', 'name']);
    const handle = options.client.collection(options.name);
    let collection;
    try {
        collection = (await nativeRequest(() => handle.get(nativeOptions(signal)), signal))?.collection;
    } catch (cause) {
        const error = databaseError(cause, 'Could not inspect the file store.');
        if (error.status === 404) return;
        throw error;
    }
    parseStore(collection, options.name);
    try {
        await nativeRequest(() => handle.delete(mutationOptions(signal)), signal);
    } catch (cause) {
        const error = databaseError(cause, 'Could not delete the file store.');
        if (error.status !== 404) throw error;
    }
}

export const MemDrive = Object.freeze({ create, open, destroy });
