import { keysOnly, validDate } from './config.js';
import { checkAbort, databaseError, MemDriveError, mutationOptions, nativeOptions, nativeRequest, requireInput } from './errors.js';
import { contentHash, resultDocs, validFileId, validText } from './records.js';
import { branchRead, type Handle } from './storage-reads.js';
import type { FileHistoryEntry, MergeRequest } from './types.js';

type RecordBase = { id: string; driveId: string };
/**
 * The record of one published main version, written once after its tag is
 * confirmed. Its existence is the publication point. It lists at most
 * `publishedFileLimit` affected file IDs in ascending order, and whether
 * the publication affected more.
 */
export type PublicationRecord = RecordBase & FileHistoryEntry & { kind: 'publication-v1' };
/** Every version below `slot` has no superseded main tag left to release. */
export type RetentionWatermark = RecordBase & { kind: 'retention-watermark-v1'; slot: string };

export const versionFor = (slot: bigint) => `v${slot}`;
export const tagFor = (version: string) => `md-main-${version}`;
export const publicationId = (slot: bigint) => `publication:${slot}`;
export const watermarkId = 'retention:watermark';
/** LambdaDB accepts 1–1,000 IDs per fetch. */
export const fetchLimit = 1000;
export const publishedFileLimit = 100;

const canonicalSlot = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,42}$/.test(value);
export const canonicalVersion = (value: unknown): value is string => typeof value === 'string'
    && value.length <= 52 - 'md-main-'.length && /^v(?:0|[1-9][0-9]*)$/.test(value);
export const slotOf = (version: string) => BigInt(version.slice(1));

const summary = (value: unknown): value is string => validText(value) && value.trim().length > 0 && value.length <= 1024;

export function validateMergeRequest(request: unknown): asserts request is Omit<MergeRequest, 'at'> {
    requireInput(keysOnly(request, ['summary']) && summary(request.summary), 'Provide a nonempty merge summary.');
}

/** The history entry that the publication record of `slot` states. */
export function parsePublication(doc: Record<string, unknown>, slot: bigint): FileHistoryEntry {
    const { fileIds, fileIdsTruncated, publishedAt } = doc;
    if (doc.kind !== 'publication-v1' || doc.id !== publicationId(slot) || doc.version !== versionFor(slot)
        || !validDate(publishedAt) || !summary(doc.summary)
        || !Array.isArray(fileIds) || fileIds.length < 1 || fileIds.length > publishedFileLimit
        || !fileIds.every((id, index) => validFileId(id) && (index === 0 || fileIds[index - 1] < id))
        || typeof fileIdsTruncated !== 'boolean' || (fileIdsTruncated && fileIds.length !== publishedFileLimit))
        throw invalid();
    return { version: doc.version, publishedAt, summary: doc.summary, fileIds: [...fileIds] as string[], fileIdsTruncated };
}

export function parseWatermark(doc: Record<string, unknown> | undefined): bigint {
    if (!doc) return 1n;
    if (doc.kind !== 'retention-watermark-v1' || !canonicalSlot(doc.slot)) throw invalid();
    return BigInt(doc.slot);
}

const invalid = () => new MemDriveError('INVALID_RESULT', 'The merge publication journal contains an invalid record.');
const format = 'merge-publication-v1';
const tagsFor = (driveId: string) => ({ 'memdrive.format': format, 'memdrive.owner': driveId });

export async function publicationIdentity(name: string, metadata: { projectName: string; createdAt: Date }) {
    if (typeof metadata?.projectName !== 'string' || !(metadata.createdAt instanceof Date)
        || !Number.isFinite(metadata.createdAt.getTime()))
        throw new MemDriveError('INVALID_RESULT', 'Collection lookup did not identify the file store generation.');
    const driveId = await contentHash(JSON.stringify([name, metadata.projectName, metadata.createdAt.toISOString()]));
    return { name: `md-journal-${driveId.slice(0, 40)}`, driveId };
}

export function publicationLog(content: Handle, internal: Handle, driveId: string) {
    const name = internal.collectionName;
    const tags = tagsFor(driveId);
    let verified = false;

    async function exists(signal?: AbortSignal): Promise<boolean> {
        if (verified) return true;
        let response;
        try {
            response = await nativeRequest(() => internal.get(nativeOptions(signal)), signal);
        } catch (cause) {
            const error = databaseError(cause, 'Could not inspect the merge publication journal.');
            if (error.status === 404) return false;
            throw error;
        }
        checkAbort(signal);
        const found = response?.collection;
        if (found?.collectionName !== name || found.defaultBranchName !== 'main'
            || found.tags?.['memdrive.format'] !== format || found.tags?.['memdrive.owner'] !== driveId
            || content.collectionName === name)
            throw new MemDriveError('INCOMPATIBLE_STORE', 'The internal collection name is occupied by an incompatible store.');
        verified = true;
        return true;
    }

    async function ensure(create: (options: { collectionName: string; tags: Record<string, string>;
        indexConfigs: { kind: { type: 'keyword' } } }) => Promise<unknown>, signal?: AbortSignal) {
        if (await exists(signal)) return;
        let cause;
        try {
            await nativeRequest(() => create({ collectionName: name, tags, indexConfigs: { kind: { type: 'keyword' } } }), signal);
        } catch (error) {
            cause = error;
        }
        if (!await exists(signal))
            throw databaseError(cause, 'Could not create the merge publication journal.');
    }

    /** Fetch records by ID in one native request. Absent IDs are omitted from the result. */
    async function readMany(ids: readonly string[], signal?: AbortSignal, fields?: string[]) {
        if (ids.length < 1 || ids.length > fetchLimit) throw new MemDriveError('INVALID_RESULT', 'A journal read exceeded the native fetch limit.');
        let response;
        try {
            response = await nativeRequest(() => internal.docs.fetch({ ids: [...ids], ...branchRead('main'),
                ...(fields ? { fields: { include: fields } } : {}) }, nativeOptions(signal)), signal);
        } catch (cause) {
            throw databaseError(cause, 'Could not read the merge publication journal.');
        }
        checkAbort(signal);
        const docs = resultDocs(response, name, ids.length);
        const requested = new Set(ids), found = new Map<string, Record<string, unknown>>();
        if (response.isDocsInline !== true || response.total !== docs.length) throw invalid();
        for (const doc of docs) {
            if (typeof doc.id !== 'string' || !requested.has(doc.id) || found.has(doc.id) || doc.driveId !== driveId) throw invalid();
            found.set(doc.id, doc);
        }
        return found;
    }

    async function read(id: string, signal?: AbortSignal) {
        return (await readMany([id], signal)).get(id);
    }

    /** Read the publications of versions `from` through `to` in one fetch. Every one must exist. */
    async function readSlots(from: bigint, to: bigint, signal?: AbortSignal) {
        const states = new Map<bigint, FileHistoryEntry>();
        if (from > to) return states;
        const slots: bigint[] = [];
        for (let slot = from; slot <= to; slot++) slots.push(slot);
        const records = await readMany(slots.map(publicationId), signal);
        for (const slot of slots) {
            const record = records.get(publicationId(slot));
            if (!record) throw new MemDriveError('INVALID_RESULT', 'A published version is missing from the publication journal.');
            states.set(slot, parsePublication(record, slot));
        }
        return states;
    }

    /** Whether the journal holds exactly this record, rather than none or another publication of its version. */
    async function recorded(record: PublicationRecord, signal?: AbortSignal) {
        const observed = await read(record.id, signal);
        return observed !== undefined && Object.entries(record).every(([field, value]) => JSON.stringify(value) === JSON.stringify(observed[field]));
    }

    /** Write a publication record and confirm it by reading it back. */
    async function write(record: PublicationRecord, signal?: AbortSignal) {
        let cause;
        try {
            await nativeRequest(() => internal.docs.upsert({ branch: 'main', docs: [record] }, mutationOptions(signal)), signal);
        } catch (error) {
            cause = error;
        }
        if (await recorded(record, signal)) return;
        throw cause === undefined ? new MemDriveError('INVALID_RESULT', 'The publication record was not confirmed.')
            : databaseError(cause, 'Could not record the publication.');
    }

    /** Store the retention watermark. A lost or stale write only repeats idempotent cleanup. */
    async function saveWatermark(slot: bigint, signal?: AbortSignal) {
        const record: RetentionWatermark = { id: watermarkId, driveId, kind: 'retention-watermark-v1', slot: String(slot) };
        try {
            await nativeRequest(() => internal.docs.upsert({ branch: 'main', docs: [record] }, mutationOptions(signal)), signal);
        } catch (cause) {
            throw databaseError(cause, 'Could not store the retention watermark.');
        }
    }

    return { exists, ensure, read, readMany, readSlots, recorded, write, saveWatermark };
}
