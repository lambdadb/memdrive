import { keysOnly, validDate } from './config.js';
import { checkAbort, databaseError, MemDriveError, mutationOptions, nativeOptions, nativeRequest, requireInput } from './errors.js';
import { contentHash, resultDocs, validFileId, validPath, validText } from './records.js';
import { branchRead, type Handle } from './storage-reads.js';
import type { MergeRequest, MergeResult } from './types.js';

export type BoundRequest = Omit<MergeRequest, 'at'> & { branch: string };
type RecordBase = { id: string; driveId: string };
export type Reservation = RecordBase & BoundRequest & {
    kind: 'merge-reservation-v1'; sourceTag: string | null; startedAt: string; priorVersion: string; version: string;
};
export type Outcome = { status: 'published' | 'unchanged'; version: string }
    | { status: 'conflict'; fileIds: string[]; paths: string[] };
export type Completion = RecordBase & Outcome & { kind: 'merge-result-v1'; completedAt: string };
export type Applied = RecordBase & { kind: 'merge-applied-v1' };
export type Bookkeeping = RecordBase & { kind: 'merge-bookkeeping-v1' };
export type HistoryArchive = RecordBase & { kind: 'merge-history-v1'; version: string; publishedAt: string; summary: string;
    sourceTag: string; fileIds: string[]; fileIdsTruncated: boolean };
export type PublicationRecord = Reservation | Completion | Applied | Bookkeeping | HistoryArchive;

export const versionFor = (slot: bigint) => `v${slot}`;
export const tagFor = (version: string) => `md-main-${version}`;
export const reservationId = (slot: bigint) => `reservation:${slot}`;
export const completionId = (slot: bigint) => `completion:${slot}`;
export const appliedId = (slot: bigint) => `applied:${slot}`;
export const bookkeepingId = (slot: bigint) => `bookkeeping:${slot}`;

const requestId = (value: unknown): value is string => validText(value) && value.length > 0 && value.length <= 128;
const summary = (value: unknown): value is string => validText(value) && value.trim().length > 0 && value.length <= 1024;
const branch = (value: unknown): value is string => typeof value === 'string' && /^fork-[A-Za-z0-9_-]{3,47}$/.test(value);

export function validateMergeRequest(request: unknown): asserts request is Omit<MergeRequest, 'at'> {
    requireInput(keysOnly(request, ['requestId', 'summary']) && requestId(request.requestId) && summary(request.summary),
        'Provide a merge request ID and a nonempty summary.');
}

export function parseReservation(doc: Record<string, unknown>, slot: bigint, priorVersion: string): Reservation {
    if (doc.kind !== 'merge-reservation-v1' || doc.version !== versionFor(slot) || doc.priorVersion !== priorVersion
        || !validDate(doc.startedAt) || !requestId(doc.requestId) || !summary(doc.summary) || !branch(doc.branch)
        || (doc.sourceTag !== null && (typeof doc.sourceTag !== 'string' || !doc.sourceTag.startsWith('merge-capture-')
            || !validFileId(doc.sourceTag.slice('merge-capture-'.length)))))
        throw invalid();
    const { kind, requestId: id, branch: sourceBranch, summary: message, sourceTag, startedAt, version } = doc;
    return { id: reservationId(slot), driveId: doc.driveId as string, kind, requestId: id, summary: message,
        branch: sourceBranch, sourceTag, startedAt, priorVersion, version };
}

export function parseOutcome(doc: Record<string, unknown>, reservation: Reservation): Outcome & { completedAt: string } {
    if (doc.kind !== 'merge-result-v1' || !validDate(doc.completedAt)) throw invalid();
    if (doc.status === 'published' && doc.version === reservation.version && reservation.sourceTag !== null
        || doc.status === 'unchanged' && doc.version === reservation.priorVersion)
        return { status: doc.status, version: doc.version as string, completedAt: doc.completedAt };
    if (doc.status === 'conflict' && Array.isArray(doc.fileIds) && doc.fileIds.every(validFileId)
        && Array.isArray(doc.paths) && doc.paths.every(validPath) && doc.fileIds.length + doc.paths.length > 0)
        return { status: 'conflict', fileIds: doc.fileIds as string[], paths: doc.paths as string[], completedAt: doc.completedAt };
    throw invalid();
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

    async function read(id: string, signal?: AbortSignal) {
        let response;
        try {
            response = await nativeRequest(() => internal.docs.fetch({ ids: [id], ...branchRead('main') }, nativeOptions(signal)), signal);
        } catch (cause) {
            throw databaseError(cause, 'Could not read the merge publication journal.');
        }
        checkAbort(signal);
        const [doc] = resultDocs(response, name, 1);
        if (response.isDocsInline !== true || response.total !== Number(Boolean(doc))
            || (doc && (doc.id !== id || doc.driveId !== driveId)))
            throw invalid();
        return doc;
    }

    async function confirmed(record: PublicationRecord, signal?: AbortSignal) {
        const observed = await read(record.id, signal);
        if (!observed) return false;
        if (!Object.entries(record).every(([field, value]) => JSON.stringify(value) === JSON.stringify(observed[field])))
            throw invalid();
        return true;
    }

    async function write(record: PublicationRecord, signal?: AbortSignal) {
        if (await confirmed(record, signal)) return;
        checkAbort(signal);
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

    return { exists, ensure, read, confirmed, write };
}
