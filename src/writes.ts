import type { TextChunker } from './text-chunks.js';
import { editRequest, planEdit } from './edits.js';
import { diffFiles } from './diff.js';
import { checkAbort, databaseError, MemDriveError, mutationOptions, nativeOptions, nativeRequest, operationOptions, requireInput } from './errors.js';
import { bytes, createRecords, fileOriginal, originalId, resultDocs, validFileId } from './records.js';
import { afterId, branchRead, branchRef, fetchOriginals, pathQuery, viewRead, type Handle, type ViewRef } from './storage-reads.js';
import type { CreateExternalFileRequest, DeleteFileRequest, FileListEntry, MetadataSchema, RequestOptions, UpdateExternalFileRequest,
    WriteFileRequest } from './types.js';

const requestMaxBytes = 6_029_312;
const maximumInputBytes = 300_000;
const maximumRequestDocuments = 1000;
export const writeBatchLimit = 100;
const maximumCleanupBatches = 32;
const knownRejected = new Set([400, 401, 403, 404, 413, 422, 429]);

type Identity = { fileId: string; path?: string | undefined };
type NativeRecord = Identity & { id: string; kind: 'file' | 'chunk' | 'tombstone'; revision?: string | undefined } & Record<string, unknown>;
type WriteRecord = { doc: NativeRecord; inputBytes: number; wireBytes: number };
type Mutation = WriteFileRequest | CreateExternalFileRequest | UpdateExternalFileRequest;
type FileRecords = Awaited<ReturnType<typeof createRecords>>;
type Plan = { op: 'create'; records: FileRecords } | Awaited<ReturnType<typeof planEdit>>;
type Stage = 'write-chunks' | 'write-original' | 'delete-original' | 'cleanup-chunks';
type Expected = { present: Pick<NativeRecord, 'id' | 'kind' | 'fileId' | 'revision'>[] } | { absent: string[] };
type Pending = {
    expected: Expected;
    targets: Identity[];
    stage: Stage;
};

export function writeBatches(records: { docs: WriteRecord[] }[], branch: string): WriteRecord[][] {
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
            // Ordinary files fit together. Larger files stage chunks first.
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

function moveRecords(original: ReturnType<typeof fileOriginal>, ids: string[]): { docs: WriteRecord[] } {
    requireInput(bytes(original) <= 5 * 1024 * 1024, 'The file original exceeds the native 5 MiB document limit.');
    const { id, fileId, path, fileName, ancestorPaths, modifiedAt, revision, changed, fingerprint, baseline, version } = original;
    const shared = { fileId, path, fileName, ancestorPaths, modifiedAt, revision };
    const patches = [
        ...ids.map(id => ({ id, kind: 'chunk' as const, ...shared })),
        { id, kind: 'file' as const, ...shared, changed, fingerprint, baseline, version },
    ];
    return { docs: patches.map(doc => ({ doc, inputBytes: 0, wireBytes: bytes(doc) + 1 })) };
}

const chunkKind = { queryString: { query: '"chunk"', defaultField: 'kind' }, occur: 'filter' };
const chunkIdBase = (fileId: string) => `chunk:${fileId}:`;
const generationPattern = (fileId: string, generation?: string) =>
    `${chunkIdBase(fileId)}[0-9a-f]{64}:[0-9]+${generation ? `:${generation}` : ''}`;
const chunkFields = { include: ['id', 'kind', 'fileId'] };

export async function listChunkIds(handle: Handle, name: string, ref: ViewRef, fileId: string,
    selection: 'all' | { generation: string | undefined }, signal?: AbortSignal) {
    const pattern = selection === 'all'
        ? `${generationPattern(fileId)}(:[0-9a-f-]+)?`
        : generationPattern(fileId, selection.generation);
    const active = new RegExp(`^${pattern}$`);
    const match = { queryString: { query: `/${pattern}/`, defaultField: 'id' }, occur: 'filter' };
    const ids: string[] = [];
    let after: string | undefined;
    for (let page = 0; page <= maximumCleanupBatches; page++) {
        let response;
        try {
            response = await nativeRequest(() => handle.query({ ...viewRead(ref), size: maximumRequestDocuments,
                fields: chunkFields, sort: [{ id: 'asc' }], query: { bool: [chunkKind, match, ...afterId(after)] },
            }, nativeOptions(signal)), signal);
        } catch (cause) {
            throw databaseError(cause, 'Could not read the file’s current chunk IDs.');
        }
        checkAbort(signal);
        const docs = resultDocs(response, name, maximumRequestDocuments);
        if (response.isDocsInline !== true || response.total !== docs.length)
            throw new MemDriveError('INVALID_RESULT', 'Current chunk lookup returned an incomplete page.');
        if (page === maximumCleanupBatches && docs.length)
            throw new MemDriveError('CHUNK_SCAN_LIMIT', 'Current chunk lookup exceeded the supported number of pages.');
        for (const doc of docs) {
            if (doc.kind !== 'chunk' || doc.fileId !== fileId || typeof doc.id !== 'string' || !active.test(doc.id)
                || (after !== undefined && doc.id <= after))
                throw new MemDriveError('INVALID_RESULT', 'Current chunk lookup returned an unexpected or unordered record.');
            ids.push(doc.id);
            after = doc.id;
        }
        if (docs.length < maximumRequestDocuments) return ids;
    }
    throw new MemDriveError('CHUNK_SCAN_LIMIT', 'Current chunk lookup exceeded the supported number of pages.');
}

/**
 * The single writer of one working fork. `requireWritable` rejects a write
 * while an unsettled merge holds the fork still; `first` asks it to read that
 * state before this writer's first write.
 */
export function workingWriter(handle: Handle, name: string, branch: string, schema: MetadataSchema, dimensions?: number, chunker?: TextChunker,
    requireWritable?: (first: boolean, signal?: AbortSignal) => Promise<void>) {
    let queue = Promise.resolve();
    let writable = false;
    function enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = queue.then(operation);
        queue = result.then(() => undefined, () => undefined);
        return result;
    }
    const pending = new Set<Pending>();
    const branchSettings = branchRead(branch);

    async function confirm(expected: Expected, signal?: AbortSignal) {
        const ids = 'present' in expected ? expected.present.map(doc => doc.id) : expected.absent;
        const originals = 'present' in expected ? new Map(expected.present.map(doc => [doc.id, doc])) : undefined;
        const revisions = originals && [...originals.values()].some(doc => doc.revision !== undefined);
        const fields = { include: revisions ? ['id', 'kind', 'fileId', 'revision'] : ['id'] };
        const response = await nativeRequest(() => handle.docs.fetch({ ids, ...branchSettings, fields }, nativeOptions(signal)), signal);
        checkAbort(signal);
        const found = resultDocs(response, name, ids.length);
        if (response.isDocsInline !== true || response.total !== found.length)
            throw new MemDriveError('INVALID_RESULT', 'Read did not confirm the written or deleted document count.');
        if (!originals) {
            if (found.length) throw new MemDriveError('INVALID_RESULT', 'Deleted records are still visible.');
            return;
        }
        for (const doc of found) {
            const expectedDoc = typeof doc.id === 'string' ? originals.get(doc.id) : undefined;
            if (!expectedDoc || (expectedDoc.revision !== undefined && (expectedDoc.revision !== doc.revision
                || expectedDoc.kind !== doc.kind || expectedDoc.fileId !== doc.fileId)))
                throw new MemDriveError('INVALID_RESULT', 'The written file or chunk revision was not confirmed.');
            originals.delete(expectedDoc.id);
        }
        if (originals.size) throw new MemDriveError('INVALID_RESULT', 'The written file or complete chunk set was not confirmed.');
    }

    function write(request: Exclude<Mutation, DeleteFileRequest>, options?: RequestOptions): Promise<FileListEntry>;
    function write(request: DeleteFileRequest, options?: RequestOptions): Promise<{ fileId: string }>;
    function write(request: Mutation, options?: RequestOptions): Promise<FileListEntry | { fileId: string }>;
    function write(request: Exclude<Mutation, DeleteFileRequest>[], options?: RequestOptions): Promise<FileListEntry[]>;
    function write(request: Mutation[], options?: RequestOptions): Promise<(FileListEntry | { fileId: string })[]>;
    async function write(request: Mutation | Mutation[], options?: RequestOptions) {
        const { signal } = operationOptions(options);
        checkAbort(signal);
        const multi = Array.isArray(request);
        const operations = multi ? [...request] : [request];
        requireInput(operations.length >= 1 && operations.length <= writeBatchLimit, 'Submit 1–100 file operations.');
        const prepared = Promise.all(operations.map(async operation => operation?.op === 'create'
            ? { op: 'create' as const, records: await createRecords(operation, schema, dimensions, chunker, { signal }) }
            : editRequest(operation, schema, dimensions)));
        void prepared.catch(() => {});
        return enqueue(async () => {
            checkAbort(signal);
            // A write queued behind a merge runs after it and proceeds only if that merge settled.
            await requireWritable?.(!writable, signal);
            writable = true;
            const inputs = await prepared;
            const targetIds = inputs.flatMap(input => input.op === 'create' ? [] : [input.fileId]);
            requireInput(new Set(targetIds).size === targetIds.length, 'Target file IDs must be distinct within one write.');
            const targetSet = new Set(targetIds);
            const suppliedPaths = new Set(inputs.flatMap(input => input.op === 'create' ? [input.records.file.path]
                : input.op === 'update' && input.newPath !== undefined ? [input.newPath] : []));
            // A mutation with a lost reply must settle before this handle uses the
            // same file or destination again. A matching revision is proof of
            // the expected effect; an unchanged previous revision is not.
            for (const uncertain of pending) {
                if (!uncertain.targets.some(({ fileId, path }) => targetSet.has(fileId) || (path && suppliedPaths.has(path)))) continue;
                try { await confirm(uncertain.expected, signal); }
                catch (cause) {
                    checkAbort(signal);
                    throw new MemDriveError('WRITE_UNCONFIRMED', 'An earlier write is still unconfirmed. Inspect the fork before retrying.',
                        { cause, details: { ...(uncertain.targets.length === 1 ? uncertain.targets[0] : {}), targets: uncertain.targets, stage: uncertain.stage } });
                }
                pending.delete(uncertain);
            }

            const originals = await fetchOriginals(handle, name, branchRef(branch), targetIds, signal, dimensions !== undefined);
            const plans: Plan[] = await Promise.all(inputs.map(input =>
                input.op === 'create' ? input : planEdit(input, originals.get(input.fileId), schema, dimensions, chunker, { signal })));
            const destinations = new Map<string, string>();
            for (const plan of plans) {
                if (plan.op === 'delete') continue;
                const file = plan.op === 'create' ? plan.records.file : plan.file;
                requireInput(!destinations.has(file.path), 'Destination paths must be distinct within one write.');
                destinations.set(file.path, file.fileId);
            }
            if (destinations.size) {
                const paths = [...destinations.keys()];
                let response;
                try {
                    response = await nativeRequest(() => handle.query({ size: 2 * paths.length, ...branchSettings,
                        query: pathQuery(paths), fields: { include: ['id', 'kind', 'fileId', 'path'] } }, nativeOptions(signal)), signal);
                } catch (cause) { throw databaseError(cause, 'Could not check write destinations.'); }
                checkAbort(signal);
                const occupied = new Set<string>(), conflicts: string[] = [];
                for (const doc of resultDocs(response, name, 2 * paths.length)) {
                    if (doc.kind !== 'file' || !validFileId(doc.fileId) || doc.id !== originalId(doc.fileId)
                        || typeof doc.path !== 'string' || !destinations.has(doc.path) || occupied.has(doc.path))
                        throw new MemDriveError('INVALID_RESULT', 'Destination lookup returned an unexpected or duplicate file.');
                    occupied.add(doc.path);
                    if (destinations.get(doc.path) !== doc.fileId) conflicts.push(doc.path);
                }
                if (conflicts.length) throw new MemDriveError('PATH_EXISTS', 'A file already exists at a requested path.',
                    { details: { paths: conflicts } });
            }

            // Plan all native request boundaries before mutating the first file.
            const steps: Array<{ creates: FileRecords[]; batches: WriteRecord[][] }
                | { edit: Exclude<Plan, { op: 'create' }>; batches: WriteRecord[][] }> = [];
            let creates: FileRecords[] = [];
            const queueCreates = () => {
                if (creates.length) steps.push({ creates, batches: writeBatches(creates, branch) });
                creates = [];
            };
            for (const plan of plans) {
                if (plan.op === 'create') creates.push(plan.records);
                else {
                    queueCreates();
                    let batches: WriteRecord[][] = [];
                    if (plan.op === 'update') {
                        if (plan.moveOnly) {
                            const ids = await listChunkIds(handle, name, branchRef(branch), plan.file.fileId, { generation: plan.generation }, signal);
                            if (!ids.length && plan.file.content.trim())
                                throw new MemDriveError('INVALID_RESULT', 'The nonempty file has no visible chunks in its current generation.');
                            batches = writeBatches([moveRecords(plan.original, ids)], branch);
                        } else {
                            batches = writeBatches([plan.records], branch);
                        }
                    }
                    steps.push({ edit: plan, batches });
                }
            }
            queueCreates();

            const completed: (FileListEntry | { fileId: string })[] = [];
            const staged = new Map<string, Identity>();
            const published = new Set<string>();
            const context = () => ({ completedFileIds: completed.map(file => file.fileId),
                incompleteTargets: [...staged.values()], appliedFileIds: [...published] });
            const failed = (error: MemDriveError, stage: Stage, targets: Identity[]) => {
                const failure = new MemDriveError(error.code, error.message, { cause: error, details: { stage, targets, ...context() } });
                failure.status = error.status;
                return failure;
            };

            async function dispatch(stage: Stage, targets: Identity[], expected: Expected, operation: () => Promise<unknown>,
                fence: Identity[] = targets) {
                const uncertain = (cause: unknown) => {
                    if (fence.length) pending.add({ expected, targets: fence, stage });
                    return new MemDriveError('WRITE_UNCONFIRMED', 'A file operation may have been accepted. Inspect the fork before retrying.', {
                        cause, details: { ...(targets.length === 1 ? targets[0] : {}), stage, targets, ...context() },
                    });
                };
                try { checkAbort(signal); }
                catch (cause) { throw failed(databaseError(cause, 'Write was aborted before dispatch.'), stage, targets); }
                try { await nativeRequest(operation, signal); }
                catch (cause) {
                    const error = databaseError(cause, 'The file mutation was rejected.');
                    if (knownRejected.has(error.status ?? 0)) throw failed(error, stage, targets);
                    throw uncertain(cause);
                }
                try { await confirm(expected, signal); }
                catch (cause) { throw uncertain(cause); }
            }

            async function put(docs: NativeRecord[], patch: boolean, isCreate: boolean) {
                const targets = [...new Map(docs.map(({ fileId, path }) => [fileId, { fileId, path }])).values()];
                const originals = docs.filter(doc => doc.kind !== 'chunk');
                // An orphan create chunk cannot claim a user path. A chunk
                // update or deletion can still race a later edit of the same ID.
                const fence = isCreate ? originals.map(({ fileId, path }) => ({ fileId, path })) : targets;
                const stage = originals.length ? 'write-original' : 'write-chunks';
                const present = docs.map(({ id, kind, fileId, revision }) => ({ id, kind, fileId, revision }));
                await dispatch(stage, targets, { present }, () => patch
                    ? handle.docs.update({ docs, branch }, mutationOptions(signal))
                    : handle.docs.upsert({ docs, branch }, mutationOptions(signal)), fence);
                for (const { fileId, kind, path } of docs) {
                    if (kind === 'chunk') staged.set(fileId, { fileId, path });
                    else staged.delete(fileId);
                }
            }

            async function remove(ids: string[], target: Identity, stage: 'delete-original' | 'cleanup-chunks') {
                // Retired IDs cannot become active again. Reissuing their
                // deletion after a lost response cannot delete a future chunk.
                await dispatch(stage, [target], { absent: ids },
                    () => handle.docs.delete({ ids, branch }, mutationOptions(signal)), stage === 'cleanup-chunks' ? [] : [target]);
            }

            async function cleanup(target: Identity, keepOld?: { generation?: string | undefined }) {
                const root = chunkIdBase(target.fileId);
                const matches = { queryString: { query: `/${root}.*/`, defaultField: 'id' }, occur: 'filter' };
                const pattern = generationPattern(target.fileId, keepOld?.generation);
                const keep = { queryString: { query: `/${pattern}/`, defaultField: 'id' }, occur: 'must_not' };
                const active = new RegExp(`^${pattern}$`);
                const cleaned = new Set<string>();
                try {
                    for (let attempt = 0; attempt <= maximumCleanupBatches; attempt++) {
                        const response = await nativeRequest(() => handle.query({ ...branchSettings, size: maximumRequestDocuments,
                            fields: chunkFields, query: { bool: keepOld ? [chunkKind, matches, keep] : [chunkKind, matches] },
                        }, nativeOptions(signal)), signal);
                        checkAbort(signal);
                        const docs = resultDocs(response, name, maximumRequestDocuments);
                        if (!docs.length) return;
                        if (attempt === maximumCleanupBatches)
                            throw new MemDriveError('CLEANUP_LIMIT', 'More stale chunks remain. Retry the file operation to continue cleanup.');
                        const ids = docs.map(doc => {
                            if (doc.kind !== 'chunk' || doc.fileId !== target.fileId || typeof doc.id !== 'string' || !doc.id.startsWith(root)
                                || (keepOld && active.test(doc.id)) || cleaned.has(doc.id))
                                throw new MemDriveError('INVALID_RESULT', 'Cleanup query returned an unexpected or repeated chunk.');
                            cleaned.add(doc.id);
                            return doc.id;
                        });
                        await remove(ids, target, 'cleanup-chunks');
                    }
                } catch (cause) {
                    const error = databaseError(cause, 'Could not inspect stale chunks.');
                    if (error.details?.stage === 'cleanup-chunks') throw error;
                    throw failed(error, 'cleanup-chunks', [target]);
                }
            }

            for (const step of steps) {
                if ('creates' in step) {
                    const files = new Map(step.creates.map(({ file }) => [file.fileId, file]));
                    for (const batch of step.batches) {
                        const docs = batch.map(record => record.doc);
                        await put(docs, false, true);
                        for (const doc of docs) if (doc.kind === 'file') completed.push(files.get(doc.fileId)!);
                    }
                    continue;
                }
                const edit = step.edit;
                if (edit.op === 'update') {
                    for (const batch of step.batches) await put(batch.map(record => record.doc), edit.moveOnly, false);
                    published.add(edit.file.fileId);
                    if (dimensions === undefined)
                        await cleanup({ fileId: edit.file.fileId, path: edit.file.path }, { generation: edit.generation });
                    completed.push(edit.file);
                } else {
                    const { fileId, path, removeOriginal, tombstone } = edit;
                    if (tombstone) {
                        await put([tombstone], false, false);
                        published.add(fileId);
                    }
                    if (dimensions === undefined) await cleanup({ fileId, path });
                    if (removeOriginal) {
                        await remove([originalId(fileId)], { fileId, path }, 'delete-original');
                        published.add(fileId);
                    }
                    completed.push({ fileId });
                }
            }
            return multi ? completed : completed[0]!;
        });
    }
    /** Reject while a write to this fork has an unknown outcome. */
    async function confirmSource(signal?: AbortSignal) {
        for (const unsettled of pending) {
            try { await confirm(unsettled.expected, signal); }
            catch (cause) {
                checkAbort(signal);
                throw new MemDriveError('WRITE_UNCONFIRMED', 'A source write is still unconfirmed. Inspect the fork before creating a reference or publishing it.',
                    { cause, details: { targets: unsettled.targets, stage: unsettled.stage } });
            }
            pending.delete(unsettled);
        }
    }

    return {
        write,
        /**
         * Run a merge, or its recovery, as one operation of this queue. Writes,
         * diffs, references and other merges of the fork wait until it ends,
         * while the operation itself reads and advances the fork directly.
         * Its `confirmSource` must pass before the merge reserves anything.
         */
        enqueueMerge<T>(operation: (confirmSource: () => Promise<void>) => Promise<T>, signal?: AbortSignal) {
            return enqueue(async () => {
                checkAbort(signal);
                return operation(() => confirmSource(signal));
            });
        },
        /** Whether this queue holds a fence for a write whose outcome is unknown. */
        fenced: () => pending.size > 0,
        enqueueRef<T>(operation: () => Promise<T>, signal?: AbortSignal) {
            return enqueue(async () => {
                checkAbort(signal);
                await confirmSource(signal);
                return operation();
            });
        },
        async diff(options?: RequestOptions) {
            const { signal } = operationOptions(options);
            checkAbort(signal);
            return enqueue(() => diffFiles(handle, name, branch, signal));
        },
    };
}
