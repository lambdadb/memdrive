import type { TextChunker } from './text-chunks.js';
import { editRequest, planEdit } from './edits.js';
import { checkAbort, databaseError, MemDriveError, mutationOptions, nativeOptions, nativeRequest, operationOptions, requireInput } from './errors.js';
import { bytes, createRecords, fileOriginal, fileRecords, originalId, resultDocs, validFileId, type WriteChange } from './records.js';
import { afterId, branchRead, branchRef, fetchOriginals, pathQuery, viewRead, type Handle, type ViewRef } from './storage-reads.js';
import type { CreateExternalFileRequest, FileListEntry, MetadataSchema, RequestOptions, UpdateExternalFileRequest,
    WriteFileRequest } from './types.js';

const requestMaxBytes = 6_029_312;
const maximumInputBytes = 300_000;
const maximumRequestDocuments = 1000;
export const writeBatchLimit = 100;
const maximumCleanupBatches = 32;
const knownRejected = new Set([400, 401, 403, 404, 413, 422, 429]);

type Identity = { fileId: string; path?: string | undefined };
type NativeRecord = Identity & { id: string; kind: 'file' | 'chunk'; revision?: string | undefined } & Record<string, unknown>;
type WriteRecord = { doc: NativeRecord; inputBytes: number; wireBytes: number };
type Mutation = WriteFileRequest | CreateExternalFileRequest | UpdateExternalFileRequest;
type FileRecords = Awaited<ReturnType<typeof createRecords>>;
type Input = { op: 'create'; records: FileRecords } | ReturnType<typeof editRequest>;
/** An input after appends by path are resolved to a create or an append by fileId. */
type Resolved = Exclude<Input, { op: 'append'; path: string }>;
type Plan = { op: 'create'; records: FileRecords } | Awaited<ReturnType<typeof planEdit>>;
type Stage = 'write-chunks' | 'write-original' | 'delete-original' | 'cleanup-chunks';
/** Filled by a tracked write: created and targeted file IDs, and whether a native mutation was sent. */
export type WriteTrack = { created: string[]; changed: string[]; dispatched?: boolean };
type Expected = { present: Pick<NativeRecord, 'id' | 'kind' | 'fileId' | 'revision'>[] } | { absent: string[] };

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

/**
 * Patch the chunks and original of a file whose text and metadata are unchanged.
 * A native patch deep-merges into the stored original and cannot remove a field,
 * so a new modifier is sent with both names, `null` for a missing one.
 */
function moveRecords(original: ReturnType<typeof fileOriginal>, ids: string[], newModifier: boolean): { docs: WriteRecord[] } {
    requireInput(bytes(original) <= 5 * 1024 * 1024, 'The file original exceeds the native 5 MiB document limit.');
    const { id, fileId, path, fileName, ancestorPaths, modifiedAt, modifiedBy, revision } = original;
    const shared = { fileId, path, fileName, ancestorPaths, modifiedAt, revision };
    const modifier = newModifier ? { modifiedBy: { user: modifiedBy?.user ?? null, agent: modifiedBy?.agent ?? null } } : {};
    const patches = [
        ...ids.map(id => ({ id, kind: 'chunk' as const, ...shared })),
        { id, kind: 'file' as const, ...shared, ...modifier },
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
 * Write files to one branch. The caller runs it in that branch's queue, so writes
 * in one process do not interleave; writers in other processes or SDK copies can,
 * and the last native write then wins.
 */
export function fileWriter(handle: Handle, name: string, schema: MetadataSchema, dimensions?: number, chunker?: TextChunker) {
    async function confirm(branch: string, expected: Expected, signal?: AbortSignal) {
        const ids = 'present' in expected ? expected.present.map(doc => doc.id) : expected.absent;
        const originals = 'present' in expected ? new Map(expected.present.map(doc => [doc.id, doc])) : undefined;
        const revisions = originals && [...originals.values()].some(doc => doc.revision !== undefined);
        const fields = { include: revisions ? ['id', 'kind', 'fileId', 'revision'] : ['id'] };
        const response = await nativeRequest(() => handle.docs.fetch({ ids, ...branchRead(branch), fields }, nativeOptions(signal)), signal);
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

    /**
     * Resolve appends by path with one consistent lookup in the caller's queue
     * turn: a path without a file becomes a create, a path with one file an
     * append by its fileId, and a path several files share fails as on read.
     * Append paths must differ from each other and from the paths of creates.
     */
    async function resolveAppends(inputs: Input[], branchSettings: ReturnType<typeof branchRead>, change: WriteChange, signal?: AbortSignal) {
        const paths = inputs.flatMap(input => input.op === 'append' && input.path !== undefined ? [input.path] : []);
        const creates = new Set(inputs.flatMap(input => input.op === 'create' ? [input.records.file.path] : []));
        requireInput(new Set(paths).size === paths.length && !paths.some(path => creates.has(path)),
            'Destination paths must be distinct within one write.');
        const found = new Map<string, string[]>(paths.map(path => [path, []]));
        if (paths.length) {
            let response;
            try {
                response = await nativeRequest(() => handle.query({ size: maximumRequestDocuments, ...branchSettings,
                    query: pathQuery(paths), fields: { include: ['id', 'kind', 'fileId', 'path'] } }, nativeOptions(signal)), signal);
            } catch (cause) { throw databaseError(cause, 'Could not look up the files to append to.'); }
            checkAbort(signal);
            for (const doc of resultDocs(response, name, maximumRequestDocuments)) {
                if (doc.kind !== 'file' || !validFileId(doc.fileId) || doc.id !== originalId(doc.fileId)
                    || typeof doc.path !== 'string' || !found.has(doc.path))
                    throw new MemDriveError('INVALID_RESULT', 'Append path lookup returned an unexpected file.');
                found.get(doc.path)!.push(doc.fileId);
            }
        }
        const ambiguous = [...found].filter(([, fileIds]) => fileIds.length > 1);
        if (ambiguous.length) throw new MemDriveError('PATH_AMBIGUOUS', 'Several files share a requested path. Read or change them by fileId.',
            { details: { paths: ambiguous.map(([path, fileIds]) => ({ path, fileIds: fileIds.sort() })) } });
        return Promise.all(inputs.map(async (input): Promise<Resolved> => {
            if (input.op !== 'append' || input.path === undefined) return input;
            const [fileId] = found.get(input.path)!;
            return fileId === undefined
                ? { op: 'create', records: await createRecords({ op: 'create', path: input.path, content: input.content }, change, schema, dimensions, chunker, { signal }) }
                : { op: 'append', fileId, content: input.content };
        }));
    }

    /**
     * `track`, when given, receives the file IDs this call creates and the
     * existing file IDs it targets, before the first native mutation.
     */
    async function write(branch: string, request: Mutation | Mutation[], change: WriteChange, options?: RequestOptions, track?: WriteTrack) {
        const { signal } = operationOptions(options);
        checkAbort(signal);
        const multi = Array.isArray(request);
        const operations = multi ? [...request] : [request];
        requireInput(operations.length >= 1 && operations.length <= writeBatchLimit, 'Submit 1–100 file operations.');
        const parsed: Input[] = await Promise.all(operations.map(async operation => operation?.op === 'create'
            ? { op: 'create' as const, records: await createRecords(operation, change, schema, dimensions, chunker, { signal }) }
            : editRequest(operation, schema, dimensions)));
        checkAbort(signal);
        const branchSettings = branchRead(branch);
        const inputs = await resolveAppends(parsed, branchSettings, change, signal);
        const targetIds = inputs.flatMap(input => input.op === 'create' ? [] : [input.fileId]);
        requireInput(new Set(targetIds).size === targetIds.length, 'Target file IDs must be distinct within one write.');
        if (track) {
            track.created.push(...inputs.flatMap(input => input.op === 'create' ? [input.records.file.fileId] : []));
            track.changed.push(...targetIds);
        }

        const originals = await fetchOriginals(handle, name, branchRef(branch), targetIds, signal, dimensions !== undefined);
        const plans: Plan[] = await Promise.all(inputs.map(input =>
            input.op === 'create' ? input : planEdit(input, originals.get(input.fileId), change, schema, dimensions, chunker, { signal })));
        // Only new paths are checked: creates and moves. An update that keeps its
        // path never fails on it, even when a concurrent create shares that path.
        const destinations = new Map<string, string>();
        for (const plan of plans) {
            if (plan.op === 'delete' || (plan.op === 'update' && plan.file.path === originals.get(plan.file.fileId)?.path)) continue;
            const file = plan.op === 'create' ? plan.records.file : plan.file;
            requireInput(!destinations.has(file.path), 'Destination paths must be distinct within one write.');
            destinations.set(file.path, file.fileId);
        }
        // Best effort: a concurrent writer can still claim a path between this
        // check and the write below. LambdaDB has no conditional write yet.
        if (destinations.size) {
            const paths = [...destinations.keys()];
            let response;
            try {
                response = await nativeRequest(() => handle.query({ size: maximumRequestDocuments, ...branchSettings,
                    query: pathQuery(paths), fields: { include: ['id', 'kind', 'fileId', 'path'] } }, nativeOptions(signal)), signal);
            } catch (cause) { throw databaseError(cause, 'Could not check write destinations.'); }
            checkAbort(signal);
            const conflicts = new Set<string>();
            for (const doc of resultDocs(response, name, maximumRequestDocuments)) {
                if (doc.kind !== 'file' || !validFileId(doc.fileId) || doc.id !== originalId(doc.fileId)
                    || typeof doc.path !== 'string' || !destinations.has(doc.path))
                    throw new MemDriveError('INVALID_RESULT', 'Destination lookup returned an unexpected file.');
                if (destinations.get(doc.path) !== doc.fileId) conflicts.add(doc.path);
            }
            if (conflicts.size) throw new MemDriveError('PATH_EXISTS', 'A file already exists at a requested path.',
                { details: { paths: [...conflicts] } });
        }

        // Plan all native request boundaries before mutating the first file.
        const steps: Array<{ creates: FileRecords[]; batches: WriteRecord[][] }
            | { edit: Exclude<Plan, { op: 'create' }>; batches: WriteRecord[][]; patch: boolean }> = [];
        let creates: FileRecords[] = [];
        const queueCreates = () => {
            if (creates.length) steps.push({ creates, batches: writeBatches(creates, branch) });
            creates = [];
        };
        for (const plan of plans) {
            if (plan.op === 'create') creates.push(plan.records);
            else {
                queueCreates();
                let batches: WriteRecord[][] = [], patch = false;
                if (plan.op === 'update') {
                    const ids = plan.moveOnly
                        ? await listChunkIds(handle, name, branchRef(branch), plan.file.fileId, { generation: plan.generation }, signal) : [];
                    if (plan.moveOnly && (ids.length || !plan.file.content.trim())) {
                        batches = writeBatches([moveRecords(plan.original, ids, plan.newModifier)], branch);
                        patch = true;
                    } else {
                        // A nonempty original without chunks in its generation, for
                        // example after concurrent writers removed each other's
                        // chunks, is chunked again under a new generation.
                        const revision = globalThis.crypto.randomUUID();
                        const records = plan.moveOnly
                            ? await fileRecords(plan.file, { revision, generation: revision }, chunker, { signal }) : plan.records;
                        batches = writeBatches([records], branch);
                    }
                }
                steps.push({ edit: plan, batches, patch });
            }
        }
        queueCreates();

        const completed: (FileListEntry | { fileId: string })[] = [];
        const staged = new Map<string, Identity>();
        const context = () => ({ completedFileIds: completed.map(file => file.fileId), incompleteTargets: [...staged.values()] });
        const failed = (error: MemDriveError, stage: Stage, targets: Identity[]) => {
            const failure = new MemDriveError(error.code, error.message, { cause: error, details: { stage, targets, ...context() } });
            failure.status = error.status;
            return failure;
        };

        /** Send one mutation and read it back. An unknown outcome is reported, never retried. */
        async function dispatch(stage: Stage, targets: Identity[], expected: Expected, operation: () => Promise<unknown>) {
            const uncertain = (cause: unknown) => new MemDriveError('WRITE_UNCONFIRMED',
                'A file operation may have been applied. Inspect the files before retrying.', {
                    cause, details: { ...(targets.length === 1 ? targets[0] : {}), stage, targets, ...context() },
                });
            try { checkAbort(signal); }
            catch (cause) { throw failed(databaseError(cause, 'Write was aborted before dispatch.'), stage, targets); }
            try {
                await nativeRequest(() => {
                    if (track) track.dispatched = true;
                    return operation();
                }, signal);
            } catch (cause) {
                const error = databaseError(cause, 'The file mutation was rejected.');
                if (knownRejected.has(error.status ?? 0)) throw failed(error, stage, targets);
                throw uncertain(cause);
            }
            try { await confirm(branch, expected, signal); }
            catch (cause) { throw uncertain(cause); }
        }

        async function put(docs: NativeRecord[], patch: boolean) {
            const targets = [...new Map(docs.map(({ fileId, path }) => [fileId, { fileId, path }])).values()];
            const stage = docs.some(doc => doc.kind !== 'chunk') ? 'write-original' : 'write-chunks';
            const present = docs.map(({ id, kind, fileId, revision }) => ({ id, kind, fileId, revision }));
            await dispatch(stage, targets, { present }, () => patch
                ? handle.docs.update({ docs, branch }, mutationOptions(signal))
                : handle.docs.upsert({ docs, branch }, mutationOptions(signal)));
            for (const { fileId, kind, path } of docs) {
                if (kind === 'chunk') staged.set(fileId, { fileId, path });
                else staged.delete(fileId);
            }
        }

        async function remove(ids: string[], target: Identity, stage: 'delete-original' | 'cleanup-chunks') {
            await dispatch(stage, [target], { absent: ids }, () => handle.docs.delete({ ids, branch }, mutationOptions(signal)));
        }

        /**
         * Delete the chunks that the file's current original does not use. The
         * original is read again first, so a concurrent writer's newer generation
         * is kept; when no original exists, every chunk of the file is removed.
         */
        async function cleanup(target: Identity) {
            const root = chunkIdBase(target.fileId);
            const matches = { queryString: { query: `/${root}.*/`, defaultField: 'id' }, occur: 'filter' };
            const cleaned = new Set<string>();
            try {
                const current = (await fetchOriginals(handle, name, branchRef(branch), [target.fileId], signal)).get(target.fileId);
                const generation = current?.generation;
                if (generation !== undefined && !validFileId(generation))
                    throw new MemDriveError('INVALID_RESULT', 'Read returned invalid file generation data.');
                const keepOld = current ? { generation } : undefined;
                const pattern = generationPattern(target.fileId, keepOld?.generation);
                const keep = { queryString: { query: `/${pattern}/`, defaultField: 'id' }, occur: 'must_not' };
                const active = new RegExp(`^${pattern}$`);
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

        // Chunks are written before the original that makes a file visible, and
        // a deleted original disappears before its chunks are removed. A file
        // counts as completed once its original is written or deleted, so a
        // failed chunk cleanup still reports the change as applied.
        for (const step of steps) {
            if ('creates' in step) {
                const files = new Map(step.creates.map(({ file }) => [file.fileId, file]));
                for (const batch of step.batches) {
                    const docs = batch.map(record => record.doc);
                    await put(docs, false);
                    for (const doc of docs) if (doc.kind === 'file') completed.push(files.get(doc.fileId)!);
                }
                continue;
            }
            const edit = step.edit;
            if (edit.op === 'update') {
                for (const batch of step.batches) await put(batch.map(record => record.doc), step.patch);
                completed.push(edit.file);
                if (dimensions === undefined) await cleanup({ fileId: edit.file.fileId, path: edit.file.path });
            } else {
                const { fileId, path, removeOriginal } = edit;
                if (removeOriginal) await remove([originalId(fileId)], { fileId, path }, 'delete-original');
                completed.push({ fileId });
                if (dimensions === undefined) await cleanup({ fileId, path });
            }
        }
        return multi ? completed : completed[0]!;
    }
    return { write };
}
