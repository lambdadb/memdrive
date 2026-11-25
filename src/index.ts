import type { CheckpointAt, CheckpointedWriteResult, ConnectionOptions, CreateExternalFileStoreOptions, CreateFileStoreOptions, EmbeddingMode, FileAt, FileDrive, FileListEntry, FileSearchHit,
    FileStoreDescription, FindTextRequest, ForkAt, ListFilesRequest, OpenFileStoreOptions, ReadFileRequest, ReadFilesRequest, RequestOptions, SearchExternalFilesRequest,
    SearchFilesRequest, WritableAt, CreateExternalFileRequest, UpdateExternalFileRequest, WriteFileRequest } from './types.js';
import { checkAbort, databaseError, errorSummary, MemDriveError, mutationOptions, nativeOptions, nativeRequest, operationOptions, requireInput } from './errors.js';
import { isObject, keysOnly, parseStore, snapshotRetentionInDays, storeConfiguration } from './config.js';
import { contentHash, decodeFile, decodeFileEntry, resultDocs, validFileId, validPath } from './records.js';
import { branchRef, fetchOriginals, pathQuery, viewRead, type Handle, type ViewRef, type WithoutAt } from './storage-reads.js';
import { fileWriter, writeBatchLimit, type WriteTrack } from './writes.js';
import { searchQuery, validateReranking, vectorSearchQuery } from './search.js';
import { fileLister } from './list.js';
import { fileTextFinder } from './find-text.js';
import { textChunker } from './text-chunks.js';
import type { DoclingChunker } from './types.js';
import { rangeKeys, readRange, validateReadRange } from './read-range.js';
import type { DriveFile, FileReadPage, ReadFileRangeRequest } from './types.js';
import { decodeToken, encodeToken, storeTag } from './cursor-tokens.js';
import { afterStoreQueues, onBranch } from './branch-queue.js';
export type * from './types.js';
// The LambdaDB client classes at the exact version this SDK pins, so a host
// constructs its client without depending on @functional-systems/lambdadb itself.
export { HTTPClient, LambdaDBClient } from '@functional-systems/lambdadb';
export { MemDriveError } from './errors.js';
export { createFileTools, getFileToolDefinitions, fileToolError, fileToolGuide, fileToolGuideTopics } from './tools.js';
export { fileToolInstructions } from './tool-guide.js';
export type { FileToolGuideTopic } from './tool-guide.js';
export type { FileToolCheckpoint, FileToolDefinition, FileToolErrorResult, FileToolName, FileTools } from './tools.js';

type RefAt = ForkAt | CheckpointAt;
type WriteOperation = WriteFileRequest | CreateExternalFileRequest | UpdateExternalFileRequest;

const forkPrefix = 'fork-';
const checkpointPrefix = 'checkpoint-';
/**
 * Each branch has one SDK-reserved alias, `latest-<branch>` (`latest-main`,
 * `latest-fork-<name>`), naming its latest checkpoint. The SDK exposes no
 * alias API, so callers can neither create nor delete it through the SDK.
 */
const latestPrefix = 'latest-';
const latestAlias = (branch: string) => latestPrefix + branch;
const validName = (name: unknown, maxLength = 52): name is string =>
    typeof name === 'string' && name.length >= 3 && name.length <= maxLength && /^[A-Za-z0-9_-]+$/.test(name);
// LambdaDB ref names have at most 52 characters, and a fork's reserved alias must fit.
const validForkName = (name: unknown): name is string => validName(name, 52 - latestPrefix.length - forkPrefix.length) && name !== 'main';
const validCheckpointName = (name: unknown): name is string => validName(name, 52 - checkpointPrefix.length);
/** Rows fetched by a path read: enough to expose files that share a path. */
const pathReadSize = 1000;
const refToken = 'r1';
const validRefLimit = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 100;
const validPageToken = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 16_384;
/**
 * How much earlier than the client's clock a checkpoint's server creation time
 * may be and still count as created by the request sent after that clock
 * reading. Synchronized hosts differ by milliseconds; a larger skew only leaves
 * a checkpoint in place, while a checkpoint with the same name created by
 * another call within this window would be misattributed. Checkpoint names
 * must be unique, which makes that case a name reuse within two seconds.
 */
const creationTolerance = 2_000;
/** A native 4xx other than a timeout: the request was not applied. */
const rejected = (error: MemDriveError) => error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 408;
const atShape = 'at must be { kind: "main" }, { kind: "fork", name } or { kind: "checkpoint", name }';

/** Normalize a request's view. Omission selects main. */
function parseAt(value: unknown): FileAt {
    if (value === undefined) return { kind: 'main' };
    requireInput(isObject(value) && (value.kind === 'main' ? keysOnly(value, ['kind'])
        : (value.kind === 'fork' || value.kind === 'checkpoint') && keysOnly(value, ['kind', 'name']) && Object.hasOwn(value, 'name')),
    `${atShape}.`);
    if (value.kind === 'main') return { kind: 'main' };
    if (value.kind === 'fork') {
        requireInput(validForkName(value.name), 'A fork name in at must be 3–40 letters, digits, underscores or hyphens and cannot be main.');
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
 * One drive object of a store. It keeps the store's configuration; every call
 * resolves its view from `at` and goes to LambdaDB. State-changing calls share
 * per-branch queues with every drive object of the same store generation in
 * this process, keyed by the store tag.
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

    /**
     * One native page of forks or checkpoints, in LambdaDB's name order. The
     * cursor wraps the native page token and is bound to this store.
     */
    async function listRefs(kind: 'fork' | 'checkpoint', request: unknown, options?: RequestOptions) {
        const signal = begin(options);
        const operation = kind === 'fork' ? 'listForks' : 'listCheckpoints';
        requireInput(keysOnly(request, ['limit', 'cursor']), `${operation} accepts an optional limit or a cursor.`);
        let limit: number, pageToken: string | undefined;
        if (request.cursor !== undefined) {
            requireInput(Object.keys(request).length === 1, 'Pass only cursor when continuing a listing.');
            const value = decodeToken(refToken, request.cursor);
            if (!value || !keysOnly(value, ['d', 'k', 'l', 't']) || value.d !== cursorStore || value.k !== kind
                || !validRefLimit(value.l) || !validPageToken(value.t))
                throw new MemDriveError('LIST_CURSOR_UNAVAILABLE', 'Listing cursor is malformed or belongs to another store or listing. Start again without a cursor.');
            limit = value.l;
            pageToken = value.t;
        } else {
            limit = request.limit === undefined ? 100 : request.limit as number;
            requireInput(validRefLimit(limit), `${operation} limit must be 1–100.`);
        }
        const page = { size: limit, ...(pageToken === undefined ? {} : { pageToken }) };
        const response = kind === 'fork'
            ? await remote(() => handle.branches.listPage(page, nativeOptions(signal)), 'Could not list forks.', signal)
            : await remote(() => handle.tags.listPage(page, nativeOptions(signal)), 'Could not list checkpoints.', signal);
        checkAbort(signal);
        const entries: unknown = response && ('branches' in response ? response.branches : 'tags' in response ? response.tags : undefined);
        const seen = new Set<string>();
        if (!Array.isArray(entries) || entries.length > limit || !entries.every(entry => {
            if (typeof entry?.name !== 'string' || seen.has(entry.name)) return false;
            seen.add(entry.name);
            return true;
        })) throw new MemDriveError('INVALID_RESULT', 'Reference listing returned invalid or duplicate names.');
        const prefix = kind === 'fork' ? forkPrefix : checkpointPrefix;
        const valid = kind === 'fork' ? validForkName : validCheckpointName;
        const listed = (entries as { name: string; createdAt?: unknown }[]).flatMap(({ name, createdAt }) => {
            if (!name.startsWith(prefix) || !valid(name.slice(prefix.length))) return [];
            if (!(createdAt instanceof Date) || !Number.isFinite(createdAt.getTime()))
                throw new MemDriveError('INVALID_RESULT', 'Reference listing returned an invalid creation time.');
            return [{ at: { kind, name: name.slice(prefix.length) }, createdAt: createdAt.toISOString() }];
        });
        const next: unknown = response?.nextPageToken;
        if (next !== undefined && (!validPageToken(next) || next === pageToken))
            throw new MemDriveError('INVALID_RESULT', 'Native reference listing did not make progress.');
        return { listed, ...(next === undefined ? {} : { next: { cursor: encodeToken(refToken, { d: cursorStore, k: kind, l: limit, t: next }) } }) };
    }

    /** The checkpoint name the branch's reserved alias targets, or null when it has none. */
    async function latestCheckpoint(branch: string, signal?: AbortSignal) {
        let response;
        try { response = await nativeRequest(() => handle.aliases.get(latestAlias(branch), nativeOptions(signal)), signal); }
        catch (cause) {
            const error = databaseError(cause, 'Could not read the latest checkpoint.');
            if (error.status === 404) return null;
            throw error;
        }
        checkAbort(signal);
        const alias = response?.alias;
        const target = typeof alias?.targetName === 'string' && alias.targetName.startsWith(checkpointPrefix)
            ? alias.targetName.slice(checkpointPrefix.length) : undefined;
        if (alias?.aliasName !== latestAlias(branch) || alias.targetKind !== 'TAG' || !validCheckpointName(target))
            throw new MemDriveError('INVALID_RESULT', 'The latest checkpoint alias returned an unexpected target.');
        return target;
    }

    /** The branches whose latest checkpoint is the given tag. */
    async function latestOf(tagName: string, signal?: AbortSignal) {
        const branches: WritableAt[] = [];
        let pageToken: string | undefined;
        for (;;) {
            const response = await remote(() => handle.aliases.listPage({ size: 100, ...(pageToken === undefined ? {} : { pageToken }) },
                nativeOptions(signal)), 'Could not read the latest checkpoints.', signal);
            checkAbort(signal);
            if (!Array.isArray(response?.aliases)) throw new MemDriveError('INVALID_RESULT', 'Alias listing returned an invalid page.');
            for (const alias of response.aliases) {
                if (alias?.targetKind !== 'TAG' || alias.targetName !== tagName || typeof alias.aliasName !== 'string'
                    || !alias.aliasName.startsWith(latestPrefix)) continue;
                const branch = alias.aliasName.slice(latestPrefix.length);
                if (branch === 'main') branches.push({ kind: 'main' });
                else if (branch.startsWith(forkPrefix) && validForkName(branch.slice(forkPrefix.length)))
                    branches.push({ kind: 'fork', name: branch.slice(forkPrefix.length) });
            }
            const next: unknown = response.nextPageToken;
            if (next === undefined) return branches;
            if (!validPageToken(next) || next === pageToken) throw new MemDriveError('INVALID_RESULT', 'Native alias listing did not make progress.');
            pageToken = next;
        }
    }

    /**
     * Point the branch's reserved alias at a checkpoint: a retarget, or a creation
     * when the branch has none yet and `create` is set. Returns whether it moved.
     */
    async function moveLatest(branch: string, name: string, signal?: AbortSignal, create = true) {
        const alias = latestAlias(branch), target = { kind: 'tag' as const, name: checkpointPrefix + name };
        let response;
        try {
            response = await remote(() => handle.aliases.retarget(alias, { target }, mutationOptions(signal)), 'Could not move the latest checkpoint.', signal);
        } catch (cause) {
            if (!(cause instanceof MemDriveError) || cause.status !== 404) throw cause;
            if (!create) return false;
            response = await remote(() => handle.aliases.create({ aliasName: alias, target }, mutationOptions(signal)),
                'Could not create the latest checkpoint.', signal);
        }
        if (response?.alias?.targetName !== target.name) throw new MemDriveError('INVALID_RESULT', 'The latest checkpoint moved to another target.');
        return true;
    }

    /**
     * After a failed alias move, read the alias back: a move whose response was
     * lost can still have happened. Otherwise report LATEST_CHECKPOINT_NOT_MOVED.
     */
    async function confirmLatest(at: WritableAt, name: string | null, error: MemDriveError, details: Record<string, unknown>,
        accept: (current: string | null) => boolean = current => current === name) {
        let current: string | null | undefined;
        try { current = await latestCheckpoint(branchOf(at)); }
        catch { current = undefined; }
        if (current !== undefined && accept(current)) return;
        const branch = at.kind === 'main' ? 'main' : `the fork ${at.name}`;
        throw new MemDriveError('LATEST_CHECKPOINT_NOT_MOVED', name === null
            ? `${branch} was created, but a latest checkpoint left by an earlier fork with this name could not be removed. Delete the fork and create it again.`
            : `The latest checkpoint of ${branch} could not be moved to ${name}.`,
        { cause: error, details: { at: { ...at }, checkpoint: name === null ? null : { kind: 'checkpoint', name }, ...details,
            latestCheckpoint: current === undefined ? 'unknown' : current === null ? null : { kind: 'checkpoint', name: current },
            cause: errorSummary(error) } });
    }

    /**
     * Apply a write, tag the branch and move its reserved alias to the tag, all in
     * the caller's branch-queue turn. Success sends the write's requests, one tag
     * creation and one alias retarget (an alias creation instead when the branch
     * has none). On a failure after the write began, the branch is restored to its
     * latest checkpoint, or, without one, the files this call created are deleted.
     * The restore ignores the caller's abort signal so that it completes.
     */
    async function checkpointedWrite(branch: string, operations: WriteOperation | WriteOperation[], name: string, signal?: AbortSignal) {
        const tagName = checkpointPrefix + name;
        const checkpoint = { at: { kind: 'checkpoint' as const, name } };
        const track: WriteTrack = { created: [], changed: [] };
        let result: unknown, requested = 0;

        async function restore(stage: 'write' | 'checkpoint' | 'alias', error: MemDriveError, tagged: boolean | undefined): Promise<CheckpointedWriteResult<unknown>> {
            const fail = (code: string, message: string, details: Record<string, unknown>) =>
                new MemDriveError(code, message, { cause: error, details: { stage, cause: errorSummary(error), ...details } });
            const notRestored = (message: string, restoreError: unknown, details: Record<string, unknown>) => fail('CHECKPOINT_RESTORE_FAILED', message,
                { restored: false, ...(restoreError === undefined ? {} : { restoreCause: errorSummary(databaseError(restoreError, 'The restore failed.')) }), ...details });
            const applied = stage === 'write' ? 'The write failed' : 'The write was applied, but its checkpoint could not be recorded';
            const partial = `${applied}, and the branch could not be fully restored; it may hold part of the write. Read the affected files before deciding what to do.`;
            const created = { checkpointCreated: tagged ?? 'unknown' };
            let previous: string | null;
            try { previous = await latestCheckpoint(branch); }
            catch (restoreError) { throw notRestored(partial, restoreError, created); }
            // An alias move with a lost response can still have happened.
            if (stage === 'alias' && previous === name) return { result, checkpoint };
            /**
             * Best effort: remove the checkpoint this call created, never the latest one.
             * After an unknown creation outcome the tag is removed only when its creation
             * time shows this call created it; a lost 409 leaves an older checkpoint alone.
             */
            const removeTag = async (): Promise<Record<string, unknown>> => {
                if (tagged === false || previous === name) return {};
                if (tagged === undefined) {
                    let createdAt: unknown;
                    try { createdAt = (await nativeRequest(() => handle.tags.get(tagName)))?.tag?.createdAt; }
                    catch (cause) {
                        return databaseError(cause, 'Could not inspect the checkpoint.').status === 404 ? { checkpointCreated: false } : created;
                    }
                    if (!(createdAt instanceof Date) || createdAt.getTime() < requested - creationTolerance) return created;
                }
                try { await nativeRequest(() => handle.tags.delete(tagName, mutationOptions())); }
                catch (cause) { return { checkpointCreated: true, checkpointRemoved: databaseError(cause, 'Could not delete the checkpoint.').status === 404 }; }
                return { checkpointCreated: true, checkpointRemoved: true };
            };
            if (previous !== null) {
                const restoredTo = { kind: 'checkpoint' as const, name: previous };
                // Sent once: resending a rollback can undo later writes.
                try { await nativeRequest(() => handle.branches.rollback(branch, { tag: checkpointPrefix + previous }, mutationOptions())); }
                catch (restoreError) { throw notRestored(partial, restoreError, { previousCheckpoint: restoredTo, ...created }); }
                throw fail('CHECKPOINT_WRITE_FAILED', `${applied}; the branch was restored to its latest checkpoint.`,
                    { restored: true, restoredTo, ...await removeTag() });
            }
            // No latest checkpoint yet: remove the files this call created. Updates
            // and deletions of existing files cannot be undone without a checkpoint.
            const removal = await removeTag();
            const details = error.details ?? {};
            const touched = stage === 'write' ? new Set([...(Array.isArray(details.completedFileIds) ? details.completedFileIds : []),
                ...[details.incompleteTargets, details.targets].flatMap(targets => Array.isArray(targets) ? targets.map(item => item?.fileId) : [])]) : undefined;
            const unrestoredFileIds = track.changed.filter(fileId => !touched || touched.has(fileId));
            try { if (track.created.length) await writer.write(branch, track.created.map(fileId => ({ op: 'delete' as const, fileId }))); }
            catch (restoreError) { throw notRestored(partial, restoreError, { restoredTo: null, createdFileIds: [...track.created], unrestoredFileIds, ...removal }); }
            if (unrestoredFileIds.length) throw notRestored(`${applied}. The branch has no earlier checkpoint, so its created files were removed but changes to existing files remain.`,
                undefined, { restoredTo: null, unrestoredFileIds, ...removal });
            throw fail('CHECKPOINT_WRITE_FAILED', `${applied}; the branch has no earlier checkpoint, so the files this write created were removed.`,
                { restored: true, restoredTo: null, ...removal });
        }

        try { result = await writer.write(branch, operations, { signal }, track); }
        catch (cause) {
            // Errors raised before the first native mutation, including an abort, leave the branch untouched.
            if (!track.dispatched || !(cause instanceof MemDriveError)) throw cause;
            return restore('write', cause, false);
        }
        let sent = false;
        requested = Date.now();
        try {
            const response = await remote(() => handle.tags.create({ tagName, source: branchRef(branch) }, mutationOptions(signal)),
                'Could not create the checkpoint.', signal, { 409: 'CHECKPOINT_CONFLICT' });
            sent = true;
            if (response?.tag?.name !== tagName) throw new MemDriveError('INVALID_RESULT', 'Checkpoint creation returned another reference.');
        } catch (cause) {
            const error = databaseError(cause, 'Could not create the checkpoint.');
            return restore('checkpoint', error, sent || !rejected(error) ? undefined : false);
        }
        try { await moveLatest(branch, name, signal); }
        catch (cause) {
            return restore('alias', databaseError(cause, 'Could not move the latest checkpoint.'), true);
        }
        return { result, checkpoint };
    }

    /** Create a fork (branch) or checkpoint (tag) from a source view with one native request. */
    async function createRef(kind: 'fork' | 'checkpoint', request: unknown, options?: RequestOptions) {
        const signal = begin(options);
        requireInput(keysOnly(request, ['at', 'name']), `${kind} accepts an optional source at and a name.`);
        const source = parseAt(request.at);
        requireInput(kind === 'fork' ? validForkName(request.name) : validCheckpointName(request.name), kind === 'fork'
            ? 'Fork name must be 3–40 letters, digits, underscores or hyphens and cannot be main.'
            : 'Checkpoint name must be 3–41 letters, digits, underscores or hyphens.');
        const at = { kind, name: request.name } as RefAt;
        const nativeName = (kind === 'fork' ? forkPrefix : checkpointPrefix) + at.name;
        const createNative = () => onViews([source], () => kind === 'fork'
            ? remote(() => handle.branches.create({ branchName: nativeName, source: refOf(source) }, mutationOptions(signal)),
                'Could not create the fork.', signal, { 409: 'BRANCH_CONFLICT' }).then(response => response?.branch?.name)
            : remote(() => handle.tags.create({ tagName: nativeName, source: refOf(source) }, mutationOptions(signal)),
                'Could not create the checkpoint.', signal, { 409: 'CHECKPOINT_CONFLICT' }).then(response => response?.tag?.name), signal);
        const createAndMove = async () => {
            if (await createNative() !== nativeName) throw new MemDriveError('INVALID_RESULT', `${kind} creation returned another reference.`);
            // A new fork starts without a latest checkpoint. An alias left by an earlier
            // fork of that name (deleted outside deleteFork, or by a race) is removed
            // in the new fork's queue turn, before any checkpointed write can use it.
            if (kind === 'fork') {
                try {
                    await remote(() => handle.aliases.delete(latestAlias(nativeName), mutationOptions()), 'Could not clear the fork\'s latest checkpoint.');
                } catch (cause) {
                    if (!(cause instanceof MemDriveError) || cause.status !== 404)
                        await confirmLatest(at as ForkAt, null, databaseError(cause, 'Could not clear the latest checkpoint.'), { forkCreated: true }, current => current === null);
                }
            }
            // A checkpoint of main or a fork becomes that branch's latest checkpoint in the same
            // queue turn. The move completes even after an abort, since the checkpoint exists.
            if (kind === 'checkpoint' && source.kind !== 'checkpoint') {
                const branch = branchOf(source);
                try { await moveLatest(branch, at.name); }
                catch (cause) { await confirmLatest(source, at.name, databaseError(cause, 'Could not move the latest checkpoint.'), { checkpointCreated: true }); }
            }
        };
        // A ref taken from a branch waits for that branch's pending writes; a checkpoint source cannot change.
        // A new fork also holds its own queue for the turn.
        const branches = [...(source.kind === 'checkpoint' ? [] : [branchOf(source)]), ...(kind === 'fork' ? [nativeName] : [])];
        await (branches.length ? onBranch(cursorStore, branches, signal, createAndMove) : createAndMove());
        return { at: { ...at } };
    }

    async function deleteRef(kind: 'fork' | 'checkpoint', request: unknown, options?: RequestOptions) {
        const signal = begin(options);
        const operation = kind === 'fork' ? 'deleteFork' : 'deleteCheckpoint';
        requireInput(keysOnly(request, ['at']) && isObject(request.at) && request.at.kind === kind,
            `${operation} requires only at, selecting an existing ${kind}: { kind: "${kind}", name }.`);
        const at = parseAt(request.at) as RefAt;
        const nativeName = (kind === 'fork' ? forkPrefix : checkpointPrefix) + at.name;
        const remove = () => onViews([at], async () => {
            if (kind === 'fork') {
                // The reserved alias goes first, so a recreated fork never inherits it.
                let cleared = false;
                try {
                    await remote(() => handle.aliases.delete(latestAlias(nativeName), mutationOptions(signal)), 'Could not delete the fork\'s latest checkpoint.', signal);
                    cleared = true;
                } catch (cause) { if (!(cause instanceof MemDriveError) || cause.status !== 404) throw cause; }
                try { return await remote(() => handle.branches.delete(nativeName, mutationOptions(signal)), 'Could not delete the fork.', signal); }
                catch (cause) {
                    if (!cleared || !(cause instanceof MemDriveError) || cause.status === 404) throw cause;
                    const error = new MemDriveError(cause.code, `${cause.message} The fork's latest checkpoint was already removed; the fork itself remains.`,
                        { cause, details: { ...cause.details, latestCheckpointCleared: true } });
                    error.status = cause.status;
                    throw error;
                }
            }
            const branches = await latestOf(nativeName, signal);
            if (branches.length) throw new MemDriveError('CHECKPOINT_IN_USE',
                `The checkpoint ${at.name} is the latest checkpoint of ${branches.map(item => item.kind === 'main' ? 'main' : `the fork ${item.name}`).join(', ')} and cannot be deleted.`,
                { details: { latestOf: branches } });
            // LambdaDB also refuses to delete an alias target, with 409.
            return remote(() => handle.tags.delete(nativeName, mutationOptions(signal)), 'Could not delete the checkpoint.', signal,
                { 409: 'CHECKPOINT_IN_USE' });
        }, signal);
        await (kind === 'fork' ? onBranch(cursorStore, nativeName, signal, remove) : remove());
        return { at: { ...at } };
    }

    const drive = Object.freeze({
        name,
        /** The store's configuration and the latest checkpoint of main or a fork, with one alias read. */
        async describe(request: unknown = {}, options?: RequestOptions) {
            const signal = begin(options);
            requireInput(keysOnly(request, ['at']), 'describe accepts only an optional at selecting main or a fork.');
            const at = parseAt(request.at);
            requireInput(at.kind !== 'checkpoint', 'describe reports the latest checkpoint of main or a fork; select one of them.');
            const latest = await latestCheckpoint(branchOf(at), signal);
            return { ...structuredClone(description), latestCheckpoint: latest === null ? null : { at: { kind: 'checkpoint' as const, name: latest } } };
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
            const { listed, ...next } = await listRefs('fork', request, options);
            return { forks: listed, ...next };
        },
        async listCheckpoints(request: unknown = {}, options?: RequestOptions) {
            const { listed, ...next } = await listRefs('checkpoint', request, options);
            return { checkpoints: listed, ...next };
        },
        deleteFork: (request: unknown, options?: RequestOptions) => deleteRef('fork', request, options),
        deleteCheckpoint: (request: unknown, options?: RequestOptions) => deleteRef('checkpoint', request, options),
        write: (request: unknown, options?: RequestOptions) => onView(request, 'Write requires a request object.', options, (at, _ref, rest, signal) => {
            requireInput(at.kind !== 'checkpoint', 'Checkpoints are read-only. Write to main or a fork.');
            const { checkpoint, ...body } = rest;
            requireInput(!('operations' in body) || keysOnly(body, ['operations']) && Array.isArray(body.operations),
                'A batch write accepts only at, checkpoint and an operations array.');
            requireInput(checkpoint === undefined || keysOnly(checkpoint, ['name']) && validCheckpointName(checkpoint.name),
                'checkpoint must be { name } with 3–41 letters, digits, underscores or hyphens.');
            const branch = branchOf(at);
            const operations = 'operations' in body ? body.operations as WriteOperation[] : body as unknown as WriteOperation;
            const name = checkpoint?.name as string;
            return onBranch<unknown>(cursorStore, branch, signal, () => checkpoint === undefined
                ? writer.write(branch, operations, { signal })
                : checkpointedWrite(branch, operations, name, signal));
        }),
        /** Restore main or a fork to a checkpoint with one native rollback, never retried. */
        async rollback(request: unknown, options?: RequestOptions) {
            const signal = begin(options);
            const message = 'rollback requires at, selecting main or a fork, and to, selecting a checkpoint.';
            requireInput(keysOnly(request, ['at', 'to']) && isObject(request.at) && isObject(request.to), message);
            const at = parseAt(request.at), to = parseAt(request.to);
            requireInput(at.kind !== 'checkpoint' && to.kind === 'checkpoint', message);
            const branch = branchOf(at);
            await onBranch(cursorStore, branch, signal, async () => {
                await onViews([at, to], () => remote(() => handle.branches.rollback(branch, { tag: checkpointPrefix + to.name }, mutationOptions(signal)),
                    `Could not roll back to the checkpoint ${to.name}.`, signal), signal);
                // A branch with a latest checkpoint now holds the target's contents, so
                // the target becomes the checkpoint a failed checkpointed write restores.
                // A branch without one keeps none. This runs even after an abort.
                try {
                    // A 404 means no alias, or a target deleted meanwhile; only the first is fine.
                    if (!await moveLatest(branch, to.name, undefined, false))
                        await confirmLatest(at, to.name, new MemDriveError('CHECKPOINT_NOT_FOUND', 'The latest checkpoint could not be moved to the rollback target.'),
                            { rolledBack: true }, current => current === null || current === to.name);
                } catch (cause) {
                    if (cause instanceof MemDriveError && cause.code === 'LATEST_CHECKPOINT_NOT_MOVED') throw cause;
                    await confirmLatest(at, to.name, databaseError(cause, 'Could not move the latest checkpoint.'), { rolledBack: true });
                }
            });
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
 * Deletion waits for the store's pending state-changing calls in this process;
 * calls queued after it fail against the deleted collection.
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
    await afterStoreQueues(await storeTag(options.name, collection), signal, async () => {
        try {
            await nativeRequest(() => handle.delete(mutationOptions(signal)), signal);
        } catch (cause) {
            const error = databaseError(cause, 'Could not delete the file store.');
            if (error.status !== 404) throw error;
        }
    });
}

export const MemDrive = Object.freeze({ create, open, destroy });
