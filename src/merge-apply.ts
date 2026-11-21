import { managedEmbedding } from './config.js';
import { checkAbort, databaseError, MemDriveError, mutationOptions, nativeOptions, nativeRequest, requireInput } from './errors.js';
import type { prepareMerge } from './merge-preflight.js';
import { bytes, contentHash, decodeFile, fileOriginal, fileRecords, fingerprintOf, originalId, resultDocs, validFileId } from './records.js';
import { branchRef, fetchOriginals, pathQuery, viewRead, type Handle, type ViewRef } from './storage-reads.js';
import type { MetadataSchema } from './types.js';
import { listChunkIds, writeBatches, type workingWriter } from './writes.js';

export type PreparedMerge = Awaited<ReturnType<typeof prepareMerge>>;
type Target = PreparedMerge['targets'][number];
type BaselineQueue = ReturnType<typeof workingWriter>['enqueueBaseline'];
type NativeDoc = Record<string, unknown>;
const rejectedStatuses = new Set([400, 401, 403, 404, 413, 422, 429]);

async function mutate(operation: () => Promise<unknown>, signal?: AbortSignal) {
    checkAbort(signal);
    try {
        await operation();
    } catch (cause) {
        const error = databaseError(cause, 'The merge content mutation was rejected.');
        if (rejectedStatuses.has(error.status ?? 0)) throw error;
        throw mutationUnconfirmed(cause);
    }
}

function mutationUnconfirmed(cause: unknown) {
    return new MemDriveError('MERGE_MUTATION_UNCONFIRMED',
        'A merge content mutation may still be in flight. Settle outstanding writes before resuming.', { cause });
}

async function mergeRevision(version: string) {
    const hash = await contentHash(`memdrive-main:${version}`);
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(12, 15)}-8${hash.slice(15, 18)}-${hash.slice(18, 30)}`;
}

async function fetchRecordBatch(handle: Handle, name: string, ref: ViewRef, ids: string[], includeVectors: boolean,
    signal?: AbortSignal) {
    const result = await nativeRequest(() => handle.docs.fetch({ ...viewRead(ref), ids, includeVectors }, nativeOptions(signal)), signal);
    const docs = resultDocs(result, name, ids.length);
    if (result.isDocsInline !== true || result.total !== docs.length)
        throw new MemDriveError('INVALID_RESULT', 'The merge returned an incomplete document fetch.');
    return docs;
}

async function publishedRecords(handle: Handle, name: string, prepared: PreparedMerge, target: Target,
    version: string, revision: string, signal?: AbortSignal) {
    const { file } = target;
    if (!file) return { docs: [], chunkIds: [] };
    const tracking = { revision, generation: revision, fingerprint: '', version };
    const { changed: _changed, baseline: _baseline, fingerprint: _fingerprint, ...original } = fileOriginal(file, tracking);
    const { fileId, path, fileName, ancestorPaths, modifiedAt, metadata } = original;
    const prior = target.baseline
        ? (await fetchOriginals(handle, name, prepared.publishedMain, [fileId], signal)).get(fileId)
        : undefined;
    if (target.baseline && !prior)
        throw new MemDriveError('INVALID_RESULT', 'The retained main tag is missing the merge baseline.');
    if (prior?.body !== file.content) {
        const result = await fileRecords(file, tracking);
        const docs = result.docs.map(record => record.doc.kind === 'file' ? { ...record, doc: original } : record);
        return { docs, chunkIds: docs.filter(({ doc }) => doc.kind === 'chunk').map(({ doc }) => doc.id) };
    }

    // Copy vectors from the immutable baseline when only path or metadata
    // changes. Full replacement removes obsolete metadata keys and avoids
    // relying on the chunker's current segmentation or re-embedding the text.
    const generation = prior.generation;
    if (generation !== undefined && !validFileId(generation))
        throw new MemDriveError('INVALID_RESULT', 'The retained main original has invalid generation data.');
    const oldIds = await listChunkIds(handle, name, prepared.publishedMain, fileId, { generation }, signal);
    if (!oldIds.length && file.content.trim())
        throw new MemDriveError('INVALID_RESULT', 'The retained main original has no visible chunks.');
    const chunks = [];
    for (let offset = 0; offset < oldIds.length; offset += 16) {
        const ids = oldIds.slice(offset, offset + 16);
        const expected = new Set(ids);
        for (const old of await fetchRecordBatch(handle, name, prepared.publishedMain, ids, true, signal)) {
            const { id, kind, content, start, end, embedding } = old;
            if (typeof id !== 'string' || !expected.delete(id) || kind !== 'chunk' || old.fileId !== fileId
                || typeof content !== 'string' || !content.trim()
                || typeof start !== 'number' || typeof end !== 'number' || !Number.isInteger(start) || !Number.isInteger(end)
                || start < 0 || end <= start || end > file.content.length || file.content.slice(start, end) !== content
                || !Array.isArray(embedding) || embedding.length !== managedEmbedding.dimensions || embedding.some(value => !Number.isFinite(value)))
                throw new MemDriveError('INVALID_RESULT', 'The retained main tag returned an invalid chunk or managed vector.');
            const root = generation === undefined ? id : id.slice(0, -(generation.length + 1));
            const doc = { id: `${root}:${revision}`, kind: 'chunk' as const, fileId, path, fileName, ancestorPaths,
                modifiedAt, revision, ...(metadata === undefined ? {} : { metadata }), content, start, end, embedding };
            chunks.push({ doc, inputBytes: 0, wireBytes: bytes(doc) + 1 });
        }
        if (expected.size) throw new MemDriveError('INVALID_RESULT', 'The retained main tag omitted a baseline chunk.');
    }
    chunks.sort((a, b) => a.doc.id < b.doc.id ? -1 : a.doc.id > b.doc.id ? 1 : 0);
    const docs = [...chunks, { doc: original, inputBytes: 0, wireBytes: bytes(original) + 1 }];
    requireInput(docs.every(record => record.wireBytes - 1 <= 5 * 1024 * 1024), 'A merge record exceeds the native 5 MiB document limit.');
    return { docs, chunkIds: chunks.map(({ doc }) => doc.id) };
}

/** Apply only after durable reservation under exclusive main writer ownership. */
export async function applyMerge(handle: Handle, name: string, prepared: PreparedMerge, version: string, signal?: AbortSignal) {
    const revision = await mergeRevision(version);
    for (const target of prepared.targets) {
        const { fileId } = target.change;
        const { docs, chunkIds } = await publishedRecords(handle, name, prepared, target, version, revision, signal);
        const batches = writeBatches([{ docs }], 'main');
        const expected = new Set(chunkIds);
        const stale = (await listChunkIds(handle, name, branchRef('main'), fileId, 'all', signal))
            .filter(id => !expected.has(id));
        for (const batch of batches) {
            await mutate(() => handle.docs.upsert({ branch: 'main', docs: batch.map(({ doc }) => doc) }, mutationOptions(signal)), signal);
        }
        if (!target.file) stale.push(originalId(fileId));
        for (let start = 0; start < stale.length; start += 1000) {
            await mutate(() => handle.docs.delete({ branch: 'main', ids: stale.slice(start, start + 1000) },
                mutationOptions(signal)), signal);
        }
    }
}

function matchesFields(doc: NativeDoc, expected: NativeDoc) {
    return Object.entries(expected).every(([key, value]) => {
        const actual = doc[key];
        if ((key === 'metadata' || key === 'baseline') && actual && value && typeof actual === 'object' && typeof value === 'object')
            return JSON.stringify(Object.entries(actual).sort()) === JSON.stringify(Object.entries(value).sort());
        return JSON.stringify(actual) === JSON.stringify(value);
    });
}

function requireRecords(found: NativeDoc[], expected: NativeDoc[]) {
    const byId = new Map(expected.map(doc => [doc.id, doc]));
    for (const doc of found) {
        const record = byId.get(doc.id);
        if (!record || !matchesFields(doc, record) || doc.changed !== undefined || doc.baseline !== undefined
            || doc.fingerprint !== undefined || (record.metadata === undefined && doc.metadata !== undefined))
            throw new MemDriveError('INVALID_RESULT', 'The published candidate contains an unexpected file or chunk.');
        byId.delete(doc.id);
    }
    if (byId.size)
        throw new MemDriveError('INVALID_RESULT', 'The published candidate is missing a file or chunk.');
}

async function verifyFetch(handle: Handle, name: string, ref: ViewRef,
    ids: string[], expected: NativeDoc[], signal?: AbortSignal) {
    const includeVectors = expected.some(doc => doc.embedding !== undefined);
    requireRecords(await fetchRecordBatch(handle, name, ref, ids, includeVectors, signal), expected);
}

/** Confirm the pinned candidate through file fetches, listing and chunk reads. */
export async function verifyMerge(handle: Handle, name: string, prepared: PreparedMerge, version: string,
    ref: ViewRef, signal?: AbortSignal) {
    const revision = await mergeRevision(version);
    try {
        for (const target of prepared.targets) {
            const { fileId } = target.change;
            const id = originalId(fileId);
            const { docs, chunkIds } = await publishedRecords(handle, name, prepared, target, version, revision, signal);
            if (!target.file) await verifyFetch(handle, name, ref, [id], [], signal);
            for (const batch of writeBatches([{ docs }], 'main')) {
                // Keep full reads small: upsert limits only count embedding input for chunks.
                for (let start = 0; start < batch.length; start += 16) {
                    const expected = batch.slice(start, start + 16).map(({ doc }) => doc);
                    await verifyFetch(handle, name, ref, expected.map(doc => doc.id), expected, signal);
                }
            }
            const listed = await listChunkIds(handle, name, ref, fileId, 'all', signal);
            if (listed.length !== chunkIds.length || JSON.stringify(listed) !== JSON.stringify(chunkIds.sort()))
                throw new MemDriveError('INVALID_RESULT', 'The published candidate lists an incomplete or stale chunk set.');

            const file = target.file;
            const query = file ? pathQuery([file.path], { literal: true })
                : { queryString: { defaultField: 'id', query: id, skipSyntax: true } };
            const listing = await nativeRequest(() => handle.query({ ...viewRead(ref), size: 2, query,
                fields: { include: ['id', 'kind', 'fileId', 'path'] },
            }, nativeOptions(signal)), signal);
            const originals = resultDocs(listing, name, 2);
            if (listing.isDocsInline !== true || listing.total !== originals.length || originals.length !== (file ? 1 : 0)
                || (file && !originals.every(doc => doc.id === id && doc.kind === 'file'
                    && doc.fileId === fileId && doc.path === file.path)))
                throw new MemDriveError('INVALID_RESULT', 'The published candidate did not confirm the file listing.');
        }
    } catch (cause) {
        throw databaseError(cause, 'Could not verify the published candidate content.');
    }
}

/** Rebase the latest working originals under their working writer queue. */
export async function advanceMergeSource(handle: Handle, name: string, prepared: PreparedMerge, version: string,
    schema: MetadataSchema, enqueueSource: BaselineQueue, signal?: AbortSignal) {
    const revision = await mergeRevision(version);
    return enqueueSource(async branch => {
        for (const target of prepared.targets) {
            const { fileId } = target.change;
            const id = originalId(fileId);
            const readCurrent = async () => (await fetchOriginals(handle, name, branchRef(branch), [fileId], signal)).get(fileId);
            const current = await readCurrent();
            async function confirm(expected?: NativeDoc) {
                try {
                    const actual = await readCurrent();
                    if (expected ? !actual || !matchesFields(actual, expected) : actual !== undefined)
                        throw new MemDriveError('INVALID_RESULT', 'The source fork did not confirm the advanced baseline.');
                } catch (cause) {
                    throw mutationUnconfirmed(cause);
                }
            }
            const baseline = target.file
                ? { version, path: target.file.path, fingerprint: target.fingerprint ?? await fingerprintOf(target.file) }
                : undefined;
            if (current?.kind !== 'file' && !baseline) {
                if (current) {
                    await mutate(() => handle.docs.delete({ branch, ids: [id] }, mutationOptions(signal)), signal);
                    await confirm();
                }
                continue;
            }
            const latestRevision = current?.revision ?? revision;
            if (!validFileId(latestRevision))
                throw new MemDriveError('INVALID_RESULT', 'The working original has invalid revision data.');
            let next;
            if (current?.kind === 'file') {
                const file = decodeFile(current, schema);
                const generation = current.generation;
                if (generation !== undefined && !validFileId(generation))
                    throw new MemDriveError('INVALID_RESULT', 'The working original has invalid generation data.');
                next = fileOriginal(file, { revision: latestRevision, generation, baseline, version: baseline?.version,
                    fingerprint: await fingerprintOf(file) });
            } else {
                next = { id, fileId, kind: 'tombstone', path: current?.path ?? target.file!.path,
                    modifiedAt: current?.modifiedAt ?? target.file!.modifiedAt, revision: latestRevision, changed: true, baseline };
            }
            if (current && matchesFields(current, next)) continue;
            await mutate(() => handle.docs.upsert({ branch, docs: [next] }, mutationOptions(signal)), signal);
            await confirm(next);
        }
    }, signal);
}
