import { keysOnly, validDate } from './config.js';
import { checkAbort, databaseError, MemDriveError, mutationOptions, nativeOptions, nativeRequest, requireInput } from './errors.js';
import { contentHash, resultDocs, validFileId, validPath, validText } from './records.js';
import { branchRead, type Handle } from './storage-reads.js';
import type { MergeRequest, MergeResult } from './types.js';

export type BoundRequest = Omit<MergeRequest, 'at'> & { branch: string };
type RecordBase = { id: string; driveId: string };
export type Reservation = RecordBase & BoundRequest & {
    kind: 'merge-reservation-v1'; startedAt: string; priorVersion: string; version: string;
};
/**
 * A publication records the files it affected: at most `publishedFileLimit`
 * IDs in ascending order, and whether it affected more.
 */
export type Outcome = { status: 'published'; version: string; fileIds: string[]; fileIdsTruncated: boolean }
    | { status: 'unchanged'; version: string }
    | { status: 'conflict'; fileIds: string[]; paths: string[] };
export type Completion = RecordBase & Outcome & { kind: 'merge-result-v1'; completedAt: string };
export type Applied = RecordBase & { kind: 'merge-applied-v1' };
export type Bookkeeping = RecordBase & { kind: 'merge-bookkeeping-v1' };
/**
 * Locates a request's reservation by a document ID derived from the request ID.
 * It is written once, after the reservation it names, and never changes.
 */
export type RequestIndex = RecordBase & { kind: 'merge-request-v1'; requestId: string; slot: string };
/** Every slot below `slot` has no remaining internal tag to release. */
export type RetentionWatermark = RecordBase & { kind: 'retention-watermark-v1'; slot: string };
/** One slot as read from the journal: its reservation and, once terminal, its outcome. */
export type SlotState = { reservation: Reservation; outcome?: Outcome & { completedAt: string } };
export type PublicationRecord = Reservation | Completion | Applied | Bookkeeping | RequestIndex;

export const versionFor = (slot: bigint) => `v${slot}`;
export const tagFor = (version: string) => `md-main-${version}`;
export const reservationId = (slot: bigint) => `reservation:${slot}`;
export const completionId = (slot: bigint) => `completion:${slot}`;
export const appliedId = (slot: bigint) => `applied:${slot}`;
export const bookkeepingId = (slot: bigint) => `bookkeeping:${slot}`;
export const requestIndexId = async (requestId: string) => `request:${await contentHash(requestId)}`;
export const watermarkId = 'retention:watermark';
/** LambdaDB accepts 1–1,000 IDs per fetch. */
export const fetchLimit = 1000;
export const publishedFileLimit = 100;

const canonicalSlot = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,42}$/.test(value);
export const canonicalVersion = (value: unknown): value is string => typeof value === 'string'
    && value.length <= 52 - 'md-main-'.length && /^v(?:0|[1-9][0-9]*)$/.test(value);
export const slotOf = (version: string) => BigInt(version.slice(1));

const requestId = (value: unknown): value is string => validText(value) && value.length > 0 && value.length <= 128;
const summary = (value: unknown): value is string => validText(value) && value.trim().length > 0 && value.length <= 1024;
const branch = (value: unknown): value is string => typeof value === 'string' && /^fork-[A-Za-z0-9_-]{3,47}$/.test(value);

export function validateMergeRequest(request: unknown): asserts request is Omit<MergeRequest, 'at'> {
    requireInput(keysOnly(request, ['requestId', 'summary']) && requestId(request.requestId) && summary(request.summary),
        'Provide a merge request ID and a nonempty summary.');
}

/**
 * Validate one reservation. Pass the prior version when the preceding slots
 * were observed; a record read on demand must still name an earlier version.
 */
export function parseReservation(doc: Record<string, unknown>, slot: bigint, expectedPrior?: string): Reservation {
    const { priorVersion } = doc;
    if (doc.kind !== 'merge-reservation-v1' || doc.id !== reservationId(slot) || doc.version !== versionFor(slot)
        || !canonicalVersion(priorVersion) || slotOf(priorVersion) >= slot
        || (expectedPrior !== undefined && priorVersion !== expectedPrior)
        || !validDate(doc.startedAt) || !requestId(doc.requestId) || !summary(doc.summary) || !branch(doc.branch))
        throw invalid();
    const { kind, requestId: id, branch: sourceBranch, summary: message, startedAt, version } = doc;
    return { id: reservationId(slot), driveId: doc.driveId as string, kind, requestId: id, summary: message,
        branch: sourceBranch, startedAt, priorVersion, version };
}

export function parseOutcome(doc: Record<string, unknown>, reservation: Reservation): Outcome & { completedAt: string } {
    if (doc.kind !== 'merge-result-v1' || !validDate(doc.completedAt)) throw invalid();
    const { fileIds, fileIdsTruncated } = doc;
    if (doc.status === 'published' && doc.version === reservation.version
        && Array.isArray(fileIds) && fileIds.length >= 1 && fileIds.length <= publishedFileLimit
        && fileIds.every((id, index) => validFileId(id) && (index === 0 || fileIds[index - 1] < id))
        && typeof fileIdsTruncated === 'boolean' && (!fileIdsTruncated || fileIds.length === publishedFileLimit))
        return { status: 'published', version: doc.version, fileIds: fileIds as string[], fileIdsTruncated, completedAt: doc.completedAt };
    if (doc.status === 'unchanged' && doc.version === reservation.priorVersion)
        return { status: 'unchanged', version: doc.version, completedAt: doc.completedAt };
    if (doc.status === 'conflict' && Array.isArray(doc.fileIds) && doc.fileIds.every(validFileId)
        && Array.isArray(doc.paths) && doc.paths.every(validPath) && doc.fileIds.length + doc.paths.length > 0)
        return { status: 'conflict', fileIds: doc.fileIds as string[], paths: doc.paths as string[], completedAt: doc.completedAt };
    throw invalid();
}

/** The slot a request index record names for the expected request. */
export function parseRequestIndex(doc: Record<string, unknown>, expected: string): bigint {
    if (doc.kind !== 'merge-request-v1' || doc.requestId !== expected || !canonicalSlot(doc.slot)) throw invalid();
    return BigInt(doc.slot);
}

export function parseWatermark(doc: Record<string, unknown> | undefined): bigint {
    if (!doc) return 1n;
    if (doc.kind !== 'retention-watermark-v1' || !canonicalSlot(doc.slot)) throw invalid();
    return BigInt(doc.slot);
}

export function returnOutcome(value: Outcome, requestId: string): MergeResult {
    if (value.status === 'conflict')
        throw new MemDriveError('MERGE_CONFLICT', 'Published main changed a targeted file or occupies a requested destination.',
            { details: { requestId, fileIds: [...value.fileIds], paths: [...value.paths] } });
    return { requestId, status: value.status, version: value.version };
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

    /** Read the reservations and outcomes of slots `from` through `to`, plus any `extra` slots, in one fetch. */
    async function readSlots(from: bigint, to: bigint, signal?: AbortSignal, extra: readonly bigint[] = []) {
        const slots = [...extra];
        for (let slot = from; slot <= to; slot++) slots.push(slot);
        const states = new Map<bigint, SlotState>();
        if (!slots.length) return states;
        const records = await readMany(slots.flatMap(slot => [reservationId(slot), completionId(slot)]), signal);
        for (const slot of slots) {
            const reservation = records.get(reservationId(slot)), completion = records.get(completionId(slot));
            if (!reservation) {
                if (completion) throw invalid();
                continue;
            }
            const state: SlotState = { reservation: parseReservation(reservation, slot) };
            if (completion) state.outcome = parseOutcome(completion, state.reservation);
            states.set(slot, state);
        }
        return states;
    }

    async function confirmed(record: PublicationRecord, signal?: AbortSignal) {
        const observed = await read(record.id, signal);
        if (!observed) return false;
        if (!Object.entries(record).every(([field, value]) => JSON.stringify(value) === JSON.stringify(observed[field])))
            throw invalid();
        return true;
    }

    /**
     * Write a record unless it is already there. `dispatching` runs just before
     * the mutation is sent: a failure before it left nothing in flight.
     */
    async function write(record: PublicationRecord, signal?: AbortSignal, dispatching?: () => void) {
        if (await confirmed(record, signal)) return;
        checkAbort(signal);
        dispatching?.();
        let cause;
        try {
            await internal.docs.upsert({ branch: 'main', docs: [record] }, mutationOptions(signal));
        } catch (error) {
            cause = error;
        }
        try {
            if (await confirmed(record, signal)) return;
        } catch (error) {
            cause ??= error;
        }
        throw new MemDriveError('MERGE_JOURNAL_UNCONFIRMED', 'Could not confirm the durable merge record. Retry the same request.',
            { cause, details: { record: record.id } });
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

    return { exists, ensure, read, readMany, readSlots, confirmed, write, saveWatermark };
}
