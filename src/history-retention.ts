import { changedFiles } from './diff.js';
import { checkAbort, databaseError, MemDriveError, mutationOptions, nativeOptions, nativeRequest } from './errors.js';
import { deleteReference } from './lifecycle.js';
import { validFileId } from './records.js';
import { tagFor, type HistoryArchive, type Outcome, type Reservation, type publicationLog } from './publication-log.js';
import type { Handle } from './storage-reads.js';
import type { FileHistoryEntry } from './types.js';

export type RetainedPublication = Pick<FileHistoryEntry, 'version' | 'publishedAt' | 'summary'> & { sourceTag: string };
export type CompletedRequest = { reservation: Reservation; outcome: Outcome & { completedAt: string } };
const fileLimit = 100;
const day = 86_400_000;

/** Preserve bounded public history before releasing its source snapshot. */
export function historyRetention(content: Handle, journal: ReturnType<typeof publicationLog>, driveId: string,
    hasTag: (name: string, signal?: AbortSignal) => Promise<boolean>) {
    const archiveId = (version: string) => `history:${version}`;

    async function archived(publication: RetainedPublication, signal?: AbortSignal): Promise<FileHistoryEntry | undefined> {
        const doc = await journal.read(archiveId(publication.version), signal);
        if (!doc) return undefined;
        const { fileIds, fileIdsTruncated } = doc;
        if (doc.kind !== 'merge-history-v1'
            || !Object.entries(publication).every(([key, value]) => doc[key] === value)
            || !Array.isArray(fileIds) || fileIds.length < 1 || fileIds.length > fileLimit
            || !fileIds.every((id, index) => validFileId(id) && (index === 0 || fileIds[index - 1] < id))
            || typeof fileIdsTruncated !== 'boolean' || fileIdsTruncated && fileIds.length !== fileLimit)
            throw new MemDriveError('INVALID_RESULT', 'The retained history summary does not match its publication.');
        const { version, publishedAt, summary } = publication;
        return { version, publishedAt, summary, fileIds: [...fileIds] as string[], fileIdsTruncated };
    }

    async function entry(publication: RetainedPublication, signal?: AbortSignal): Promise<FileHistoryEntry> {
        const existing = await archived(publication, signal);
        if (existing) return existing;
        const { version, publishedAt, summary, sourceTag } = publication;
        const unavailable = () => new MemDriveError('HISTORY_UNAVAILABLE',
            'The retained merge capture and its history summary are missing.', { details: { version } });
        const fileIds: string[] = [];
        let fileIdsTruncated = false;
        try {
            for await (const { change } of changedFiles(content, content.collectionName, { kind: 'tag', name: sourceTag }, signal)) {
                if (fileIds.length === fileLimit) { fileIdsTruncated = true; break; }
                fileIds.push(change.fileId);
            }
        } catch (cause) {
            if (cause instanceof MemDriveError && cause.status === 404) {
                const saved = await archived(publication, signal);
                if (saved) return saved;
                if (!await hasTag(sourceTag, signal)) throw unavailable();
            }
            throw cause;
        }
        if (!fileIds.length) {
            const saved = await archived(publication, signal);
            if (saved) return saved;
            if (!await hasTag(sourceTag, signal)) throw unavailable();
            throw new MemDriveError('INVALID_RESULT', 'A published merge capture contained no changed files.');
        }
        // A different client may have archived/deleted the capture during a
        // paged scan. Prefer its complete archive even if the last page was empty.
        return await archived(publication, signal) ?? { version, publishedAt, summary, fileIds, fileIdsTruncated };
    }

    async function archive(publication: RetainedPublication, signal?: AbortSignal) {
        if (await archived(publication, signal)) return;
        const record: HistoryArchive = { id: archiveId(publication.version), driveId, kind: 'merge-history-v1',
            ...await entry(publication, signal), sourceTag: publication.sourceTag };
        await journal.write(record, signal);
    }

    async function prune(publications: readonly RetainedPublication[], requests: readonly CompletedRequest[],
        retentionInDays: number, signal?: AbortSignal): Promise<void> {
        const cutoff = new Date(Date.now() - retentionInDays * day).toISOString();
        const candidates: { tag: string; expiresFrom: string; publication?: RetainedPublication | undefined }[] = [];
        for (let i = 0; i + 1 < publications.length; i++) {
            const publication = publications[i]!;
            const supersededAt = publications[i + 1]!.publishedAt;
            if (supersededAt <= cutoff) candidates.push({ tag: tagFor(publication.version), expiresFrom: supersededAt, publication });
        }
        const byVersion = new Map(publications.map(publication => [publication.version, publication]));
        for (const { reservation, outcome } of requests) {
            if (reservation.sourceTag !== null && outcome.completedAt <= cutoff) {
                const publication = outcome.status === 'published' ? byVersion.get(outcome.version) : undefined;
                if (outcome.status === 'published' && !publication)
                    throw new MemDriveError('INVALID_RESULT', 'A completed publication is missing from history.');
                candidates.push({ tag: reservation.sourceTag, expiresFrom: outcome.completedAt, publication });
            }
        }
        if (!candidates.length) return;
        let response;
        try { response = await nativeRequest(() => content.tags.list(nativeOptions(signal)), signal); }
        catch (cause) { throw databaseError(cause, 'Could not inspect internal history tags.'); }
        checkAbort(signal);
        const names = new Set<string>();
        if (!Array.isArray(response?.tags) || !response.tags.every(tag => {
            if (typeof tag?.name !== 'string' || names.has(tag.name)) return false;
            names.add(tag.name);
            return true;
        })) throw new MemDriveError('INVALID_RESULT', 'History cleanup received invalid tag metadata.');
        const owned = new Set<string>();
        for (const candidate of candidates) {
            if (owned.has(candidate.tag)) throw new MemDriveError('INVALID_RESULT', 'Multiple completed requests claim the same history tag.');
            owned.add(candidate.tag);
        }
        const eligible = candidates.filter(candidate => names.has(candidate.tag))
            .sort((a, b) => a.expiresFrom.localeCompare(b.expiresFrom) || a.tag.localeCompare(b.tag));
        const selected = eligible.slice(0, 100);
        // Confirm every selected publication summary before any deletion.
        const saved = new Set<string>();
        for (const { publication } of selected) {
            if (publication && !saved.has(publication.version)) {
                await archive(publication, signal);
                saved.add(publication.version);
            }
        }
        for (const { tag } of selected) {
            // Names belong to immutable completed requests and are never reused
            // within a store generation. Retrying an unknown deletion is safe.
            await deleteReference(() => content.tags.delete(tag, mutationOptions(signal)), async () => {
                if (await hasTag(tag, signal)) throw new MemDriveError('INVALID_RESULT', 'History tag deletion was not confirmed.');
            }, () => {}, signal);
        }
    }

    return { entry, prune };
}
