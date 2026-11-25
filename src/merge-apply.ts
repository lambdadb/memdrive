import { managedEmbedding } from './config.js';
import { netChange } from './diff.js';
import { databaseError, MemDriveError, mutationOptions, nativeOptions, nativeRequest, requireInput } from './errors.js';
import { originalBatchSize, type prepareMerge } from './merge-preflight.js';
import { bytes, contentHash, decodeStoredFile, fileOriginal, originalId, resultDocs, validFileId } from './records.js';
import { branchRef, fetchOriginals, pathQuery, viewRead, type Handle, type ViewRef } from './storage-reads.js';
import type { MetadataSchema } from './types.js';
import { listChunkIds, writeBatches } from './writes.js';

export type PreparedMerge = Awaited<ReturnType<typeof prepareMerge>>;
type Target = PreparedMerge['targets'][number];
type NativeDoc = Record<string, unknown>;

async function mutate(operation: () => Promise<unknown>, signal?: AbortSignal) {
    try { await nativeRequest(operation, signal); }
    catch (cause) { throw databaseError(cause, 'The merge content mutation failed.'); }
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
    const tracking = { revision, ...('content' in file ? { generation: revision } : {}), fingerprint: '', version };
    const { changed: _changed, baseline: _baseline, fingerprint: _fingerprint, ...baseOriginal } = fileOriginal(file, tracking);
    const original = { ...baseOriginal, ...(target.chunking === undefined ? {} : { chunking: target.chunking }) };
    if ('embedding' in file) {
        const wireBytes = bytes(original) + 1;
        requireInput(wireBytes - 1 <= 5 * 1024 * 1024, 'A merge record exceeds the native 5 MiB document limit.');
        return { docs: [{ doc: original, inputBytes: 0, wireBytes }], chunkIds: [] };
    }
    const { fileId, path, fileName, ancestorPaths, modifiedAt, metadata } = original;
    if (target.baseline && !(await fetchOriginals(handle, name, prepared.publishedMain, [fileId], signal)).has(fileId))
        throw new MemDriveError('INVALID_RESULT', 'The retained main tag is missing the merge baseline.');

    // Copy the fork's stored representation and vectors. Publication never
    // invokes a parser or depends on its current segmentation.
    const { source } = prepared;
    const { generation } = target;
    if (generation !== undefined && !validFileId(generation))
        throw new MemDriveError('INVALID_RESULT', 'The merge source original has invalid generation data.');
    const oldIds = await listChunkIds(handle, name, source, fileId, { generation }, signal);
    if (!oldIds.length && file.content.trim())
        throw new MemDriveError('INVALID_RESULT', 'The merge source original has no visible chunks.');
    const chunks = [];
    for (let offset = 0; offset < oldIds.length; offset += 16) {
        const ids = oldIds.slice(offset, offset + 16);
        const expected = new Set(ids);
        for (const old of await fetchRecordBatch(handle, name, source, ids, true, signal)) {
            const { id, kind, content, start, end, embedding, embeddingText } = old;
            if (typeof id !== 'string' || !expected.delete(id) || kind !== 'chunk' || old.fileId !== fileId
                || typeof content !== 'string' || !content.trim()
                || (start !== undefined || end !== undefined) && (typeof start !== 'number' || typeof end !== 'number'
                    || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start
                    || end > file.content.length || file.content.slice(start, end) !== content)
                || typeof embeddingText !== 'string' || !embeddingText.trim() || old.path !== file.path || old.revision !== target.revision
                || !Array.isArray(embedding) || embedding.length !== managedEmbedding.dimensions || embedding.some(value => !Number.isFinite(value)))
                throw new MemDriveError('INVALID_RESULT', 'The merge source returned an invalid chunk or managed vector.');
            const root = generation === undefined ? id : id.slice(0, -(generation.length + 1));
            const doc = { id: `${root}:${revision}`, kind: 'chunk' as const, fileId, path, fileName, ancestorPaths,
                modifiedAt, revision, ...(metadata === undefined ? {} : { metadata }), content, ...(start === undefined ? {} : { start, end }), embedding,
                embeddingText };
            chunks.push({ doc, inputBytes: 0, wireBytes: bytes(doc) + 1 });
        }
        if (expected.size) throw new MemDriveError('INVALID_RESULT', 'The merge source omitted a chunk.');
    }
    chunks.sort((a, b) => a.doc.id < b.doc.id ? -1 : a.doc.id > b.doc.id ? 1 : 0);
    const docs = [...chunks, { doc: original, inputBytes: 0, wireBytes: bytes(original) + 1 }];
    requireInput(docs.every(record => record.wireBytes - 1 <= 5 * 1024 * 1024), 'A merge record exceeds the native 5 MiB document limit.');
    return { docs, chunkIds: chunks.map(({ doc }) => doc.id) };
}

/** Write the plan's targets to the main branch. Only the publication queue writes to main. */
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
        if (key === 'embedding' && expected.kind === 'file') {
            // Native JSON can represent a float32 using fewer decimal digits.
            return Array.isArray(actual) && Array.isArray(value) && actual.length === value.length
                && actual.every((component, index) => typeof component === 'number' && Math.fround(component) === value[index]);
        }
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
            || doc.fingerprint !== undefined || (record.embedding !== undefined && record.kind === 'file'
                && (doc.body !== undefined || doc.content !== undefined))
            || (record.metadata === undefined && doc.metadata !== undefined))
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

/** The main state a changed fork file now matches: its fingerprint, none for a deletion, and the version that holds it. */
export type HeldFile = { fileId: string; fingerprint?: string | undefined; version?: string | undefined };

/**
 * Advance the baselines of fork files that main now holds exactly, so they
 * are no longer changes. Call it while holding the fork's queue. This is
 * best effort: it stops at the first failure, and a file left with its old
 * baseline is settled by the next merge without a conflict.
 */
export async function advanceMergeSource(handle: Handle, name: string, branch: string, held: HeldFile[],
    schema: MetadataSchema, dimensions?: number, signal?: AbortSignal) {
    const source = branchRef(branch);
    for (let start = 0; start < held.length; start += originalBatchSize) {
        const batch = held.slice(start, start + originalBatchSize);
        const originals = await fetchOriginals(handle, name, source, batch.map(({ fileId }) => fileId), signal, dimensions !== undefined);
        for (const { fileId, fingerprint, version } of batch) {
            const current = originals.get(fileId);
            const change = current?.changed === true ? netChange(current) : undefined;
            if (!current || !change || change.fingerprint !== fingerprint) continue;
            // A published deletion leaves nothing on the fork.
            if (fingerprint === undefined) {
                await mutate(() => handle.docs.delete({ branch, ids: [originalId(fileId)] }, mutationOptions(signal)), signal);
                continue;
            }
            if (version === undefined) throw new MemDriveError('INVALID_RESULT', 'A published file has no version.');
            const file = decodeStoredFile(current, schema, dimensions);
            const { revision = await mergeRevision(version), generation } = current;
            if (!validFileId(revision) || (generation !== undefined && !validFileId(generation)))
                throw new MemDriveError('INVALID_RESULT', 'The working original has invalid revision or generation data.');
            const next = { ...fileOriginal(file, { revision, generation, baseline: { version, path: file.path, fingerprint }, version, fingerprint }),
                ...(current.chunking === undefined ? {} : { chunking: current.chunking }) };
            await mutate(() => handle.docs.upsert({ branch, docs: [next] }, mutationOptions(signal)), signal);
        }
    }
}
