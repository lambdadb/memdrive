import { keysOnly, parseStore } from './config.js';
import { historyRetention } from './history-retention.js';
import { checkAbort, databaseError, MemDriveError, mutationOptions, nativeOptions, nativeRequest, requireInput } from './errors.js';
import { applyMerge, advanceMergeSource, verifyMerge } from './merge-apply.js';
import { initialMainRef, prepareMerge } from './merge-preflight.js';
import { canonicalVersion, publicationId, publicationIdentity, publicationLog, publishedFileLimit, slotOf, tagFor, versionFor,
    type PublicationRecord } from './publication-log.js';
import { resultDocs } from './records.js';
import { historicalViewUnavailable, refBackoff } from './refs.js';
import { branchRead, branchRef, type Handle, type ViewRef } from './storage-reads.js';
import { decodeToken, encodeToken, storeTag } from './cursor-tokens.js';
import type { ConnectionOptions, FileHistoryEntry, FileHistoryRequest, FileHistoryResult, FileStoreStatus, MergeResult, MetadataSchema } from './types.js';
import type { workingWriter } from './writes.js';

type Writer = ReturnType<typeof workingWriter>;

const historyToken = 'h1';
// One fetch probes exponentially spaced versions; later fetches divide the bracket.
const gallopProbes = 20;
const searchProbes = 250;
// A just-created tag can be rejected as a rollback target until its snapshot is published.
const rollbackWindow = 60_000;
const clearBatch = 1000;
const clearRounds = 1000;
const historyUnavailable = () => new MemDriveError('HISTORY_CURSOR_UNAVAILABLE',
    'History cursor is malformed or does not belong to this store. Start again from the last processed version.');

function tagRef(name: string) {
    return { kind: 'tag' as const, name };
}

/**
 * The main branch of each store generation in this process, shared by every
 * drive object of it: the merge queue that alone writes to main, and the
 * published version main is known to hold. That version is unknown in a new
 * process and after a failed merge, when main may hold unpublished writes.
 */
const mainBranches = new Map<string, { tail: Promise<void>; holds?: string | undefined }>();

/**
 * Publication state of one store. The journal holds one record per published
 * main version, written after that version's tag is confirmed; reads select
 * the latest one. Memory stays bounded: the journal is read on demand by
 * document ID, and only the latest published version is kept.
 *
 * Merges of a store run one at a time in this process, in a queue that is
 * the only writer of the main branch. A merge that fails after writing to main rolls main back to the
 * latest published tag, so the next merge starts from published content.
 */
export function publication(client: ConnectionOptions['client'], content: Handle, { name, driveId }: { name: string; driveId: string },
    schema: MetadataSchema, dimensions: number | undefined, canMaintain: () => boolean) {
    const internal = client.collection(name);
    const journal = publicationLog(content, internal, driveId);
    const initialVersion = 'v0';
    const retained = historyRetention(content, journal, hasTag);
    const cursorStore = storeTag(driveId);
    let published = initialVersion;
    // Whether this client has searched for the journal head at least once.
    let located = false;
    const mainBranch = mainBranches.get(driveId) ?? { tail: Promise.resolve() };
    mainBranches.set(driveId, mainBranch);
    let readTail = Promise.resolve();
    let boot: Promise<void> | undefined;
    let initialExists = false;
    let provision: Promise<void> | undefined;

    async function hasTag(name: string, signal?: AbortSignal) {
        try {
            const result = await nativeRequest(() => content.tags.get(name, nativeOptions(signal)), signal);
            if (result?.tag?.name !== name)
                throw new MemDriveError('INVALID_RESULT', 'Tag lookup did not return the requested tag.');
            return true;
        } catch (cause) {
            const error = databaseError(cause, 'Could not inspect the requested tag.');
            if (error.status === 404) return false;
            throw error;
        }
    }

    async function createTag(name: string, signal?: AbortSignal) {
        let cause;
        try {
            const response = await nativeRequest(() => content.tags.create({ source: branchRef('main'), tagName: name },
                mutationOptions(signal)), signal);
            if (response?.tag?.name === name) return;
        } catch (error) {
            cause = error;
        }
        if (!await hasTag(name, signal)) throw databaseError(cause, 'Could not create the pinned main version.');
    }

    /** Delete a main version tag that an interrupted merge created but never recorded as published. */
    async function removeUnpublishedTag(name: string, signal?: AbortSignal) {
        if (!await hasTag(name, signal)) return;
        try {
            await nativeRequest(() => content.tags.delete(name, mutationOptions(signal)), signal);
        } catch (cause) {
            const error = databaseError(cause, 'Could not delete an unpublished main version tag.');
            if (error.status !== 404) throw error;
        }
        if (await hasTag(name, signal)) throw new MemDriveError('INVALID_RESULT', 'An unpublished main version tag is still present.');
    }

    async function hasInitial(signal?: AbortSignal) {
        if (initialExists) return true;
        try {
            const response = await nativeRequest(() => content.branches.get(initialMainRef.name, nativeOptions(signal)), signal);
            if (response?.branch?.name !== initialMainRef.name)
                throw new MemDriveError('INVALID_RESULT', 'Branch lookup did not return the initial main version.');
            initialExists = true;
            return true;
        } catch (cause) {
            const error = databaseError(cause, 'Could not inspect the initial main version.');
            if (error.status === 404) return false;
            throw error;
        }
    }

    async function bootstrap(signal?: AbortSignal) {
        if (await hasInitial(signal)) return;
        let cause;
        try {
            const response = await nativeRequest(() => content.branches.create({ branchName: initialMainRef.name, source: branchRef('main') },
                mutationOptions(signal)), signal);
            if (response?.branch?.name === initialMainRef.name) {
                initialExists = true;
                return;
            }
        } catch (error) {
            cause = error;
        }
        if (!await hasInitial(signal))
            throw new MemDriveError('MAIN_BOOTSTRAP_UNCONFIRMED', 'Could not pin the initial main version. Retry the operation.', { cause });
    }

    function ensureBootstrap(signal?: AbortSignal) {
        boot ??= bootstrap(signal).catch(error => { boot = undefined; throw error; });
        return boot;
    }

    function ensureJournal(signal?: AbortSignal) {
        if (typeof client.createCollection !== 'function')
            throw new MemDriveError('INVALID_INPUT', 'Merge requires a client that can provision the internal collection.');
        provision ??= journal.ensure(options => client.createCollection(options, mutationOptions(signal)), signal)
            .catch(error => { provision = undefined; throw error; });
        return provision;
    }

    const gap = () => new MemDriveError('INVALID_RESULT', 'The publication journal is not contiguous.');

    /**
     * Find the latest published version at or after the known one. Records
     * are contiguous, so their existence is monotonic: gallop to bracket the
     * head, then divide the bracket. The cost is logarithmic in the distance.
     */
    async function locate(signal?: AbortSignal) {
        const base = slotOf(published);
        const present = async (probes: bigint[]) => {
            const found = await journal.readMany(probes.map(publicationId), signal, ['id', 'driveId']);
            const count = probes.findIndex(probe => !found.has(publicationId(probe)));
            if (count === -1) return probes.length;
            if (probes.slice(count).some(probe => found.has(publicationId(probe)))) throw gap();
            return count;
        };
        // A client that knows the head probes only the next version: it is almost always absent.
        if (located && !await present([base + 1n])) return base;
        let low = base, high: bigint | undefined;
        for (let exponent = 0; high === undefined; exponent += gallopProbes) {
            const probes = Array.from({ length: gallopProbes }, (_, index) => base + (1n << BigInt(exponent + index)));
            const count = await present(probes);
            if (count) low = probes[count - 1]!;
            if (count < probes.length) high = probes[count]!;
        }
        while (high - low > 1n) {
            const span: bigint = high - low, between = span - 1n;
            const count = between < BigInt(searchProbes) ? between : BigInt(searchProbes);
            const start = low;
            const probes = Array.from({ length: Number(count) }, (_, index) => start + span * BigInt(index + 1) / (count + 1n));
            const found = await present(probes);
            if (found) low = probes[found - 1]!;
            if (found < probes.length) high = probes[found]!;
        }
        return low;
    }

    /** Read the latest published version. It only moves forward. */
    function refresh(signal?: AbortSignal) {
        const task = readTail.then(async () => {
            if (!await journal.exists(signal)) return;
            const head = await locate(signal);
            located = true;
            if (head > slotOf(published)) published = versionFor(head);
        });
        readTail = task.then(() => undefined, () => undefined);
        return task;
    }

    const refFor = (version: string) => version === initialVersion ? initialMainRef : tagRef(tagFor(version));

    async function status(at: FileStoreStatus['at'], signal?: AbortSignal): Promise<FileStoreStatus> {
        await refresh(signal);
        checkAbort(signal);
        return { at, mainVersion: published };
    }

    // A stateless cursor records the last returned version, the fixed
    // throughVersion and the page size. Any client of the same store resumes it.
    async function history(request: FileHistoryRequest, signal?: AbortSignal): Promise<FileHistoryResult> {
        requireInput(keysOnly(request, ['sinceVersion', 'limit', 'cursor']), 'Invalid history options.');
        let since: string, through: string | undefined, limit: number;
        if ('cursor' in request) {
            requireInput(Object.keys(request).length === 1 && typeof request.cursor === 'string',
                'Pass only cursor when continuing history.');
            const token = decodeToken(historyToken, request.cursor);
            if (!token || Object.keys(token).sort().join() !== 'd,l,s,t' || token.d !== await cursorStore
                || !canonicalVersion(token.s) || !canonicalVersion(token.t)
                || !Number.isSafeInteger(token.l) || (token.l as number) < 1 || (token.l as number) > 100) throw historyUnavailable();
            ({ s: since, t: through } = token);
            limit = token.l as number;
        } else {
            ({ sinceVersion: since = initialVersion, limit = 20 } = request);
            requireInput(canonicalVersion(since), 'Provide a canonical version such as v0 or v1.');
            requireInput(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'History limit must be 1–100.');
        }
        await refresh(signal);
        checkAbort(signal);
        const throughVersion = through ?? published;
        const first = slotOf(since), last = slotOf(throughVersion);
        // Every version through the latest one is a publication.
        if (first > last || last > slotOf(published)) {
            throw through !== undefined ? historyUnavailable()
                : new MemDriveError('VERSION_NOT_FOUND', 'The requested version was not observed as a published main version.',
                    { details: { version: since } });
        }
        const end = first + BigInt(limit) < last ? first + BigInt(limit) : last;
        const states = await journal.readSlots(first + 1n, end, signal);
        checkAbort(signal);
        const entries: FileHistoryEntry[] = [...states.values()];
        const result: FileHistoryResult = { entries, throughVersion };
        if (end < last) result.next = { cursor: encodeToken(historyToken, { d: await cursorStore, s: versionFor(end), t: throughVersion, l: limit }) };
        return result;
    }

    async function pin(signal?: AbortSignal) {
        await refresh(signal);
        if (published === initialVersion) await ensureBootstrap(signal);
        checkAbort(signal);
        return refFor(published);
    }

    async function pinVersion(version: string, signal?: AbortSignal): Promise<ViewRef> {
        await refresh(signal);
        if (!canonicalVersion(version)) throw historicalViewUnavailable(version);
        if (version === initialVersion) {
            // Never synthesize a missing v0: after a publication, current main is no longer the initial view.
            if (!await hasInitial(signal)) throw historicalViewUnavailable(version);
            return initialMainRef;
        }
        // A tag newer than the latest publication was never published.
        const ref = tagRef(tagFor(version));
        if (slotOf(version) > slotOf(published) || !await hasTag(ref.name, signal)) throw historicalViewUnavailable(version);
        return ref;
    }

    async function read<T>(operation: (ref: ViewRef) => Promise<T>, signal?: AbortSignal) {
        await refresh(signal);
        if (published !== initialVersion || await hasInitial(signal)) return operation(refFor(published));
        // A store whose creation was interrupted has no frozen v0 yet. A merge
        // pins it before writing to main, so recheck before releasing the result.
        const provisional = await operation(branchRef('main'))
            .then(value => ({ value } as const), cause => ({ cause } as const));
        await refresh(signal);
        if (published === initialVersion && !await hasInitial(signal)) {
            if ('cause' in provisional) throw provisional.cause;
            return provisional.value;
        }
        return operation(refFor(published));
    }

    /** Roll main back to a published tag. Only a definite rejection of a not yet restorable tag is retried. */
    async function rollback(tag: string, signal?: AbortSignal) {
        const deadline = Date.now() + rollbackWindow;
        for (let delay = 250; ; delay = Math.min(delay * 2, 4_000)) {
            try {
                const response = await nativeRequest(() => content.branches.rollback('main', { tag }, mutationOptions(signal)), signal);
                if (typeof response?.branchId !== 'string') throw new MemDriveError('INVALID_RESULT', 'Main rollback returned an invalid response.');
                return;
            } catch (cause) {
                const error = databaseError(cause, 'Could not roll main back to the published version.');
                if (error.status !== 400 || !/published snapshot/i.test(String((cause as Error)?.message))
                    || Date.now() + delay > deadline) throw error;
                await refBackoff(delay, signal);
            }
        }
    }

    /** Remove everything from main, which holds nothing at the initial version. */
    async function clearMain(signal?: AbortSignal) {
        for (let round = 0; ; round++) {
            let response;
            try {
                response = await nativeRequest(() => content.query({ ...branchRead('main'), size: clearBatch, fields: { include: ['id'] },
                    query: { queryString: { query: '/.*/', defaultField: 'id' } } }, nativeOptions(signal)), signal);
            } catch (cause) {
                throw databaseError(cause, 'Could not inspect unpublished main writes.');
            }
            const ids = resultDocs(response, content.collectionName, clearBatch).map(({ id }) => id);
            if (!ids.length) return;
            if (round === clearRounds || !ids.every(id => typeof id === 'string'))
                throw new MemDriveError('INVALID_RESULT', 'Could not remove unpublished main writes.');
            try {
                await nativeRequest(() => content.docs.delete({ branch: 'main', ids: ids as string[] }, mutationOptions(signal)), signal);
            } catch (cause) {
                throw databaseError(cause, 'Could not remove unpublished main writes.');
            }
        }
    }

    /** Make the main branch hold exactly a published version again, unless it is known to. */
    async function restoreMain(version: string, signal?: AbortSignal) {
        if (mainBranch.holds === version) return;
        if (version === initialVersion) await clearMain(signal);
        else await rollback(tagFor(version), signal);
        mainBranch.holds = version;
    }

    function enqueue<T>(operation: () => Promise<T>) {
        const task = mainBranch.tail.then(operation);
        mainBranch.tail = task.then(() => undefined, () => undefined);
        return task;
    }

    async function publish({ summary, branch }: { summary: string; branch: string }, writer: Writer, signal?: AbortSignal): Promise<MergeResult> {
        checkAbort(signal);
        await ensureJournal(signal);
        await ensureBootstrap(signal);
        await refresh(signal);
        const prior = published;
        const plan = await prepareMerge(content, content.collectionName, branchRef(branch), refFor(prior), schema, signal, dimensions);
        const advanceTo = (version: string, next?: AbortSignal) => advanceMergeSource(content, content.collectionName, branch,
            [...plan.targets.map(({ change: { fileId }, fingerprint }) => ({ fileId, fingerprint, version })), ...plan.settled],
            schema, dimensions, next);
        // Source bookkeeping that failed, or whose publication is uncertain, is
        // completed by the fork's next operation before it runs, once the
        // journal shows `version` published.
        const defer = (version: string) => writer.defer(async next => {
            await refresh(next);
            if (slotOf(published) >= slotOf(version)) await advanceTo(version, next);
        });
        const settle = (version: string) => advanceTo(version, signal).catch(() => defer(version));
        if (!plan.targets.length) {
            await settle(prior);
            return { status: 'unchanged', version: prior };
        }
        // Main may hold writes of a merge that failed here or in an earlier process.
        await restoreMain(prior, signal);
        const version = versionFor(slotOf(prior) + 1n), target = tagRef(tagFor(version));
        // A tag left by an interrupted merge never becomes this version's content.
        await removeUnpublishedTag(target.name, signal);
        mainBranch.holds = undefined;
        let recording = false;
        try {
            await applyMerge(content, content.collectionName, plan, version, signal);
            await createTag(target.name, signal);
            // Confirm both pinned lookup and indexed candidate visibility.
            for (let attempt = 0; ; attempt++) {
                try {
                    await verifyMerge(content, content.collectionName, plan, version, target, signal);
                    break;
                } catch (cause) {
                    if (attempt === 5 || !(cause instanceof MemDriveError) || cause.code !== 'INVALID_RESULT') throw cause;
                    await refBackoff(250 * 2 ** attempt, signal);
                }
            }
            // The affected files are the plan's targets: the fork's net changes in ascending ID order.
            const record: PublicationRecord = { id: publicationId(slotOf(version)), driveId, kind: 'publication-v1', version,
                publishedAt: new Date().toISOString(), summary,
                fileIds: plan.targets.slice(0, publishedFileLimit).map(({ change }) => change.fileId),
                fileIdsTruncated: plan.targets.length > publishedFileLimit };
            recording = true;
            await journal.write(record, signal);
        } catch (cause) {
            // A record whose reply and confirmation were lost may still have
            // landed: it is the publication point, and main holds its content.
            const landed = recording && await refresh(signal).then(() => published === version, () => false);
            if (!landed) {
                if (recording) defer(version);
                // Main may hold part of this merge. Restore the latest recorded
                // version now if possible; the next merge does otherwise.
                await refresh(signal).then(() => restoreMain(published, signal)).catch(() => {});
                throw cause;
            }
        }
        if (slotOf(version) > slotOf(published)) published = version;
        mainBranch.holds = version;
        await settle(version);
        return { status: 'published', version };
    }

    async function merge(request: { summary: string; branch: string }, writer: Writer, signal?: AbortSignal) {
        // The merge is one operation of its fork's queue, taken before the merge
        // queue. Writes, diffs, references and other merges of the fork wait
        // until it ends, while it reads and advances the fork directly.
        const result = await writer.enqueueMerge(confirmSource => enqueue(async () => {
            // A fork write of unknown outcome must settle before the fork is published.
            await confirmSource();
            return publish(request, writer, signal);
        }), signal);
        // Retention stays in the merge queue but no longer needs the fork, whose queue is free again.
        await enqueue(() => maintainHistory(signal));
        return result;
    }

    async function maintainHistory(signal?: AbortSignal) {
        if (signal?.aborted || !canMaintain()) return;
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(abort, 5_000);
        try {
            // The SDK window can change through another client. Never guess a value
            // or clean a replacement store generation with this client's journal.
            const response = await nativeRequest(() => content.get(nativeOptions(controller.signal)), controller.signal);
            const found = parseStore(response.collection, content.collectionName);
            if ((await publicationIdentity(content.collectionName, response.collection)).driveId !== driveId) return;
            await retained.prune(slotOf(published) + 1n, found.retentionInDays, controller.signal);
        } catch {
            // Maintenance must not change a merge result. Tag deletions are
            // idempotent; later merges retry.
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
        }
    }

    return { main: { read, pin }, pinVersion, merge, status, history, initialize: ensureBootstrap };
}
