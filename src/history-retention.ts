import { checkAbort, databaseError, MemDriveError, mutationOptions, nativeOptions, nativeRequest } from './errors.js';
import { deleteReference } from './lifecycle.js';
import { parseWatermark, tagFor, versionFor, watermarkId, type publicationLog } from './publication-log.js';
import type { Handle } from './storage-reads.js';

const day = 86_400_000;
const tagLimit = 100;
// A cleanup pass reads versions in growing batches, so a pass with nothing to
// release reads only a few records.
const firstScanBatch = 8n;
const scanBatch = 256n;
const scanLimit = 1000n;

/** Release the main version tags that later publications superseded once they leave the history window. */
export function historyRetention(content: Handle, journal: ReturnType<typeof publicationLog>,
    hasTag: (name: string, signal?: AbortSignal) => Promise<boolean>) {
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

    // Every version below the watermark has no internal tag left to release:
    // the main tag of the version it superseded. The latest publication's own
    // main tag belongs to the version that later supersedes it, so the
    // current main is never a candidate.
    // Released tags never return, so a value once reached stays valid and a
    // lower stored value only repeats confirmed work.
    let watermark: bigint | undefined;
    let stored = 0n;

    /**
     * Release expired internal tags superseded by publications below `end`, in
     * version order from the watermark. The scan stops at the first
     * publication still inside the window.
     */
    async function prune(end: bigint, retentionInDays: number, signal?: AbortSignal): Promise<void> {
        if (watermark === undefined) stored = watermark = parseWatermark(await journal.read(watermarkId, signal));
        if (watermark > end) throw new MemDriveError('INVALID_RESULT', 'The retention watermark is ahead of the publication journal.');
        const cutoff = new Date(Date.now() - retentionInDays * day).toISOString();
        const releases: { slot: bigint; tag: string; listed: boolean }[] = [];
        const start = watermark;
        let next = start, confirmed = 0;
        try {
            let names: Set<string> | undefined;
            let listed = 0;
            scan: for (let size = firstScanBatch; next < end && next - start < scanLimit; size = size < scanBatch ? size * 2n : scanBatch) {
                const last = next + size <= end ? next + size - 1n : end - 1n;
                const states = await journal.readSlots(next, last, signal);
                for (let slot = next; slot <= last; slot++) {
                    if (states.get(slot)!.publishedAt > cutoff) break scan;
                    // A superseded main version ages from the publication that replaced it.
                    if (slot > 1n) {
                        const tag = tagFor(versionFor(slot - 1n));
                        names ??= await listTags(signal);
                        const present = names.has(tag);
                        // Bound both deletions and the direct checks of tags the listing omits.
                        if ((present ? listed : releases.length - listed) === tagLimit) break scan;
                        if (present) listed++;
                        releases.push({ slot, tag, listed: present });
                    }
                    next = slot + 1n;
                }
            }
            for (const { tag, listed: present } of releases) {
                const absent = async () => {
                    if (await hasTag(tag, signal)) throw new MemDriveError('INVALID_RESULT', 'History tag deletion was not confirmed.');
                };
                // A superseded version's name is never reused within a store
                // generation. Retrying an unknown deletion is safe.
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

    return { prune };
}
