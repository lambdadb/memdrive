import { changedFiles } from './diff.js';
import { checkAbort, databaseError, MemDriveError, mutationOptions, nativeOptions, nativeRequest } from './errors.js';
import { deleteReference } from './lifecycle.js';
import { validFileId } from './records.js';
import { parseWatermark, slotOf, tagFor, watermarkId, type HistoryArchive, type SlotState, type publicationLog } from './publication-log.js';
import type { Handle } from './storage-reads.js';
import type { FileHistoryEntry } from './types.js';

export type RetainedPublication = Pick<FileHistoryEntry, 'version' | 'publishedAt' | 'summary'> & { sourceTag: string };
const fileLimit = 100;
const day = 86_400_000;
const tagLimit = 100;
// A cleanup pass reads slots in growing batches (two records per slot), so a
// pass with nothing to release reads only a few records.
const firstScanBatch = 8n;
const scanBatch = 256n;
const scanLimit = 1000n;

/** The history entry source of a slot that published a main version. */
export function publicationOf({ reservation, outcome }: SlotState): RetainedPublication | undefined {
    // parseOutcome requires the retained capture for a publication.
    return outcome?.status === 'published'
        ? { version: outcome.version, publishedAt: outcome.completedAt, summary: reservation.summary, sourceTag: reservation.sourceTag! }
        : undefined;
}

/** Preserve bounded public history before releasing its source snapshot. */
export function historyRetention(content: Handle, journal: ReturnType<typeof publicationLog>, driveId: string,
    hasTag: (name: string, signal?: AbortSignal) => Promise<boolean>) {
    const archiveId = (version: string) => `history:${version}`;

    function decode(publication: RetainedPublication, doc: Record<string, unknown>): FileHistoryEntry {
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

    async function archived(publication: RetainedPublication, signal?: AbortSignal): Promise<FileHistoryEntry | undefined> {
        const doc = await journal.read(archiveId(publication.version), signal);
        return doc && decode(publication, doc);
    }

    /** Read affected IDs from a publication's retained capture when no archive was found. */
    async function captured(publication: RetainedPublication, signal?: AbortSignal): Promise<FileHistoryEntry> {
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

    async function entry(publication: RetainedPublication, signal?: AbortSignal): Promise<FileHistoryEntry> {
        return await archived(publication, signal) ?? captured(publication, signal);
    }

    /**
     * History entries of one page. Their archives are read in one fetch; only a
     * publication without one reads its capture, and then rereads its archive.
     */
    async function entries(publications: readonly RetainedPublication[], signal?: AbortSignal): Promise<FileHistoryEntry[]> {
        if (!publications.length) return [];
        const archives = await journal.readMany(publications.map(publication => archiveId(publication.version)), signal);
        const result: FileHistoryEntry[] = [];
        for (const publication of publications) {
            const doc = archives.get(archiveId(publication.version));
            result.push(doc ? decode(publication, doc) : await captured(publication, signal));
        }
        return result;
    }

    async function archive(publication: RetainedPublication, signal?: AbortSignal) {
        if (await archived(publication, signal)) return;
        const record: HistoryArchive = { id: archiveId(publication.version), driveId, kind: 'merge-history-v1',
            ...await entry(publication, signal), sourceTag: publication.sourceTag };
        await journal.write(record, signal);
    }

    async function listTags(signal?: AbortSignal) {
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
        return names;
    }

    // Every slot below the watermark has no internal tag left to release: its
    // merge capture and, if it published, the main tag of the version it
    // superseded. The latest publication's own main tag belongs to the slot
    // that later supersedes it, so the current main is never a candidate.
    // Released tags never return, so a value once reached stays valid and a
    // lower stored value only repeats confirmed work.
    let watermark: bigint | undefined;
    let stored = 0n;

    /**
     * Release expired internal tags of settled slots below `end`, in slot
     * order from the watermark. The scan stops at the first slot whose outcome
     * is still inside the window.
     */
    async function prune(end: bigint, retentionInDays: number, signal?: AbortSignal): Promise<void> {
        if (watermark === undefined) stored = watermark = parseWatermark(await journal.read(watermarkId, signal));
        if (watermark > end) throw new MemDriveError('INVALID_RESULT', 'The retention watermark is ahead of the publication journal.');
        const cutoff = new Date(Date.now() - retentionInDays * day).toISOString();
        const releases: { slot: bigint; tag: string; listed: boolean; publication?: RetainedPublication | undefined; superseded?: string }[] = [];
        const start = watermark;
        let next = start, confirmed = 0;
        try {
            const publications = new Map<string, RetainedPublication>();
            const owned = new Set<string>();
            let names: Set<string> | undefined;
            let listed = 0;
            scan: for (let size = firstScanBatch; next < end && next - start < scanLimit; size = size < scanBatch ? size * 2n : scanBatch) {
                const last = next + size <= end ? next + size - 1n : end - 1n;
                const states = await journal.readSlots(next, last, signal);
                for (let slot = next; slot <= last; slot++) {
                    const state = states.get(slot);
                    if (!state?.outcome) throw new MemDriveError('INVALID_RESULT', 'A settled merge is missing from the publication journal.');
                    const { reservation, outcome } = state;
                    if (outcome.completedAt > cutoff) break scan;
                    const publication = publicationOf(state);
                    if (publication) publications.set(publication.version, publication);
                    const due: { tag: string; publication?: RetainedPublication | undefined; superseded?: string }[] = [];
                    // A capture ages from its terminal outcome. A superseded main
                    // version ages from the publication that replaced it.
                    if (reservation.sourceTag !== null) due.push({ tag: reservation.sourceTag, publication });
                    if (publication && slotOf(reservation.priorVersion) > 0n)
                        due.push({ tag: tagFor(reservation.priorVersion), superseded: reservation.priorVersion });
                    if (due.length) names ??= await listTags(signal);
                    for (const candidate of due) {
                        if (owned.has(candidate.tag)) throw new MemDriveError('INVALID_RESULT', 'Multiple completed requests claim the same history tag.');
                        const present = names!.has(candidate.tag);
                        // Bound both deletions and the direct checks of tags the listing omits.
                        if ((present ? listed : releases.length - listed) === tagLimit) break scan;
                        if (present) listed++;
                        owned.add(candidate.tag);
                        releases.push({ slot, ...candidate, listed: present });
                    }
                    next = slot + 1n;
                }
            }
            const selected = releases.filter(release => release.listed);
            const earlier = [...new Set(selected.flatMap(({ superseded }) =>
                superseded !== undefined && !publications.has(superseded) ? [slotOf(superseded)] : []))];
            if (earlier.length) {
                for (const state of (await journal.readSlots(1n, 0n, signal, earlier)).values()) {
                    const publication = publicationOf(state);
                    if (publication) publications.set(publication.version, publication);
                }
            }
            // Confirm every selected publication summary before any deletion.
            const saved = new Set<string>();
            for (const release of selected) {
                const publication = release.superseded === undefined ? release.publication : publications.get(release.superseded);
                if (release.superseded !== undefined && !publication)
                    throw new MemDriveError('INVALID_RESULT', 'A completed publication is missing from history.');
                if (publication && !saved.has(publication.version)) {
                    await archive(publication, signal);
                    saved.add(publication.version);
                }
            }
            for (const { tag, listed: present } of releases) {
                const absent = async () => {
                    if (await hasTag(tag, signal)) throw new MemDriveError('INVALID_RESULT', 'History tag deletion was not confirmed.');
                };
                // Names belong to immutable completed requests and are never reused
                // within a store generation. Retrying an unknown deletion is safe.
                // A tag the listing omitted counts as released only once a direct
                // lookup confirms its absence.
                if (present) await deleteReference(() => content.tags.delete(tag, mutationOptions(signal)), absent, () => {}, signal);
                else await absent();
                confirmed++;
            }
        } finally {
            // Never pass a tag whose release is unconfirmed.
            const reached = confirmed < releases.length ? releases[confirmed]!.slot : next;
            if (reached > watermark) watermark = reached;
            if (watermark > stored && !signal?.aborted) {
                await journal.saveWatermark(watermark, signal);
                stored = watermark;
            }
        }
    }

    return { entries, prune };
}
