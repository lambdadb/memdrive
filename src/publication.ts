import { keysOnly, parseStore } from './config.js';
import { historyRetention, publicationOf, type RetainedPublication } from './history-retention.js';
import { checkAbort, databaseError, MemDriveError, mutationOptions, nativeOptions, nativeRequest, requireInput } from './errors.js';
import { mergeCaptureJournal } from './merge-journal.js';
import { applyMerge, advanceMergeSource, verifyMerge } from './merge-apply.js';
import { confirmedMergeSource, initialMainRef, prepareMerge } from './merge-preflight.js';
import { appliedId, bookkeepingId, canonicalVersion, completionId, parseOutcome, parseRequestIndex, parseReservation, publicationIdentity, publicationLog,
    requestIndexId, reservationId, returnOutcome, slotOf, tagFor, versionFor, type BoundRequest, type Outcome, type PublicationRecord, type RequestIndex,
    type Reservation, type SlotState } from './publication-log.js';
import { awaitMergeTag, historicalViewUnavailable, refBackoff } from './refs.js';
import { branchRef, type Handle, type ViewRef } from './storage-reads.js';
import { decodeToken, encodeToken, storeTag } from './cursor-tokens.js';
import type { ConnectionOptions, FileHistoryRequest, FileHistoryResult, FileStoreStatus, MetadataSchema } from './types.js';
import type { workingWriter } from './writes.js';

type Writer = ReturnType<typeof workingWriter>;
// `indexed` is set once this client has confirmed the entry's request index.
type Entry = { slot: bigint; reservation: Reservation; outcome?: Outcome & { completedAt: string }; indexed?: boolean };
type Records = Map<string, Record<string, unknown>>;

const historyToken = 'h1';
// One fetch probes exponentially spaced slots; later fetches divide the bracket.
const gallopProbes = 20;
const searchProbes = 250;
const historyUnavailable = () => new MemDriveError('HISTORY_CURSOR_UNAVAILABLE',
    'History cursor is malformed or its versions are no longer available. Start again from the last processed version.');

function tagRef(name: string) {
    return { kind: 'tag' as const, name };
}

function mergeBlocked(requestId: string, cause?: unknown) {
    return new MemDriveError('MERGE_BLOCKED', 'A previous merge must settle before main can advance.',
        { cause, details: { requestId } });
}

/**
 * Publication state of one store. Memory stays bounded and independent of the
 * number of merges: the journal is read on demand by document ID, and only
 * the head position, the unfinished merge and unconfirmed records are kept.
 */
export function publication(client: ConnectionOptions['client'], content: Handle, { name, driveId }: { name: string; driveId: string },
    schema: MetadataSchema, writerFor: (branch: string) => Writer, dimensions: number | undefined, canMaintain: () => boolean,
    changed: () => void) {
    const internal = client.collection(name);
    const journal = publicationLog(content, internal, driveId);
    const capture = mergeCaptureJournal(content, internal, { name, driveId }, { captureEmpty: true });
    const initialVersion = 'v0';
    const retained = historyRetention(content, journal, driveId, hasTag);
    const cursorStore = storeTag(driveId);
    let published = initialVersion;
    // The first slot not yet observed as settled. Every lower slot has a
    // terminal outcome and, if it published, confirmed source bookkeeping.
    let slot = 1n;
    // The reservation at `slot` while it is unsettled.
    let active: Entry | undefined;
    // Whether this client has searched for the journal head at least once.
    let located = false;
    let executing: string | undefined;
    // A record whose write is unconfirmed. Only the identical record is
    // submitted again. `then` is the request index that follows a reservation.
    let unresolved: { requestId: string; record: PublicationRecord; then?: RequestIndex } | undefined;
    let unsettled: { requestId: string; cause: unknown } | undefined;
    let capturing = 0;
    let readTail = Promise.resolve();
    let mergeTail = Promise.resolve();
    let boot: Promise<void> | undefined;
    let initialExists = false;
    const sourceMerges = new Map<string, Promise<void>>();
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
        if (await hasTag(name, signal)) return;
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
        requireCreate();
        provision ??= journal.ensure(options => client.createCollection(options, mutationOptions(signal)), signal)
            .catch(error => { provision = undefined; throw error; });
        return provision;
    }

    function requireCreate() {
        if (typeof client.createCollection !== 'function')
            throw new MemDriveError('INVALID_INPUT', 'Merge requires a client that can provision the internal collection.');
    }

    const gap = () => new MemDriveError('INVALID_RESULT', 'The publication journal is not contiguous.');

    /**
     * Find the highest reserved slot at or after `slot`. Reservations are
     * contiguous, so their existence is monotonic: gallop to bracket the head,
     * then divide the bracket. The cost is logarithmic in the distance.
     */
    async function locate(signal?: AbortSignal): Promise<{ slot: bigint; records: Records } | undefined> {
        const reserved = (probes: bigint[], found: Records) => {
            const count = probes.findIndex(probe => !found.has(reservationId(probe)));
            if (count === -1) return probes.length;
            if (probes.slice(count).some(probe => found.has(reservationId(probe)))) throw gap();
            return count;
        };
        let reservedAt: bigint | undefined, first: Records | undefined;
        let missingAt: bigint;
        for (let exponent = 0; ; exponent += gallopProbes) {
            const probes = Array.from({ length: gallopProbes }, (_, index) => slot + (1n << BigInt(exponent + index)) - 1n);
            // The usual head is the next slot. Read its other records with the probe.
            const found = await journal.readMany([...probes.map(reservationId),
                ...(exponent ? [] : [completionId(slot), bookkeepingId(slot)])], signal, exponent ? ['id', 'driveId'] : undefined);
            first ??= found;
            const count = reserved(probes, found);
            if (count) reservedAt = probes[count - 1]!;
            if (count < probes.length) {
                missingAt = probes[count]!;
                break;
            }
        }
        if (reservedAt === undefined) return undefined;
        let low = reservedAt, high = missingAt;
        while (high - low > 1n) {
            const span: bigint = high - low, between = span - 1n;
            const count = between < BigInt(searchProbes) ? between : BigInt(searchProbes);
            const start = low;
            const probes = Array.from({ length: Number(count) }, (_, index) => start + span * BigInt(index + 1) / (count + 1n));
            const found = reserved(probes, await journal.readMany(probes.map(reservationId), signal, ['id', 'driveId']));
            if (found) low = probes[found - 1]!;
            if (found < probes.length) high = probes[found]!;
        }
        if (low === slot) return { slot: low, records: first };
        return { slot: low, records: await journal.readMany([reservationId(low), completionId(low), bookkeepingId(low)], signal) };
    }

    /** Apply a slot's terminal and bookkeeping records to its entry. True once the slot is settled. */
    function observe(entry: Entry, records: Records) {
        if (!entry.outcome) {
            const record = records.get(completionId(entry.slot));
            if (!record) return false;
            entry.outcome = parseOutcome(record, entry.reservation);
        }
        if (entry.outcome.status === 'published') {
            const record = records.get(bookkeepingId(entry.slot));
            if (!record) return false;
            if (record.kind !== 'merge-bookkeeping-v1')
                throw new MemDriveError('INVALID_RESULT', 'The publication journal contains invalid source bookkeeping.');
        }
        return true;
    }

    function refresh(signal?: AbortSignal) {
        const task = readTail.then(async () => {
            if (!await journal.exists(signal)) return;
            const previous = unresolved;
            if (previous && await journal.confirmed(previous.record, signal) && unresolved === previous)
                unresolved = previous.then ? { requestId: previous.requestId, record: previous.then } : undefined;
            for (let advanced = false; ;) {
                let records: Records, searched = false;
                if (active) {
                    records = await journal.readMany(active.outcome ? [bookkeepingId(slot)] : [completionId(slot), bookkeepingId(slot)], signal);
                } else {
                    let at = slot;
                    if (located && !advanced) {
                        // A client that knows the head probes only the next slot:
                        // it is almost always still free, or the new head itself.
                        records = await journal.readMany([reservationId(slot), completionId(slot), bookkeepingId(slot)], signal);
                    } else {
                        // A cold client, or one that just saw the journal move, searches for the head.
                        const head = await locate(signal);
                        located = true;
                        if (!head) return;
                        ({ slot: at, records } = head);
                        searched = true;
                    }
                    const record = records.get(reservationId(at));
                    if (!record) {
                        if (records.size) throw gap();
                        return;
                    }
                    // A reservation is written only after every earlier slot has
                    // settled, so its prior version is main as of that slot.
                    const reservation = parseReservation(record, at, at === slot ? published : undefined);
                    slot = at;
                    published = reservation.priorVersion;
                    active = { slot, reservation };
                }
                const settled = observe(active, records);
                if (active.outcome?.status === 'published') published = active.outcome.version;
                if (!settled) return;
                active = undefined;
                slot++;
                // The search already saw the slot after its head free.
                if (searched) return;
                advanced = true;
            }
        });
        readTail = task.then(() => undefined, () => undefined);
        return task;
    }

    /**
     * Capture the observed journal extent for reads by slot: the highest
     * reserved slot, and a reader of one slot's publication. Only the
     * unfinished head may lack an outcome. Call it synchronously after a refresh.
     */
    function observed() {
        const top = active ? slot : slot - 1n, settledBelow = slot;
        return { top, publicationAt(states: Map<bigint, SlotState>, at: bigint) {
            const state = states.get(at);
            if (!state || (!state.outcome && at < settledBelow))
                throw new MemDriveError('INVALID_RESULT', 'A reserved merge is missing from the publication journal.');
            return publicationOf(state);
        } };
    }

    /**
     * Locate a request: the unfinished head first, then its index record. An
     * index is written once, after its reservation and before the slot can
     * reach a terminal record, so a head may lack one but a settled slot never
     * does, and an index always names a reservation of the same request.
     */
    async function lookup(requestId: string, signal?: AbortSignal): Promise<Entry | undefined> {
        const id = await requestIndexId(requestId);
        for (let attempt = 0; ; attempt++) {
            await refresh(signal);
            if (active?.reservation.requestId === requestId) return active;
            if (!await journal.exists(signal)) return undefined;
            const index = await journal.read(id, signal);
            if (!index) return undefined;
            const at = parseRequestIndex(index, requestId);
            const records = await journal.readMany([reservationId(at), completionId(at), bookkeepingId(at)], signal);
            const record = records.get(reservationId(at));
            const reservation = record && parseReservation(record, at);
            if (reservation?.requestId !== requestId)
                throw new MemDriveError('INVALID_RESULT', 'A merge request index does not name a reservation of its request.');
            const entry: Entry = { slot: at, reservation, indexed: true };
            if (observe(entry, records)) return entry;
            // Unsettled: it must be the head this client observes. Refresh once
            // in case the head advanced after the refresh above.
            if (active?.slot === at) {
                active.indexed = true;
                return active;
            }
            if (attempt) throw new MemDriveError('INVALID_RESULT', 'An unsettled merge precedes the publication journal head.');
        }
    }

    const indexFor = async ({ slot: at, reservation: { requestId } }: Entry): Promise<RequestIndex> =>
        ({ id: await requestIndexId(requestId), driveId, kind: 'merge-request-v1', requestId, slot: String(at) });

    const refFor = (version: string) => version === initialVersion ? initialMainRef : tagRef(tagFor(version));

    async function status(at: FileStoreStatus['at'], signal?: AbortSignal): Promise<FileStoreStatus> {
        await refresh(signal);
        checkAbort(signal);
        const result: FileStoreStatus = { at, mainVersion: published };
        const requestId = active?.reservation.requestId ?? unresolved?.requestId;
        if (requestId !== undefined)
            result.merge = { requestId, phase: active?.outcome?.status === 'published' ? 'bookkeeping' : 'publication' };
        return result;
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
        const continued = through !== undefined;
        const throughVersion = through ?? published, main = published;
        const { top, publicationAt } = observed();
        const unknown = () => continued ? historyUnavailable()
            : new MemDriveError('VERSION_NOT_FOUND', 'The requested version was not observed as a published main version.',
                { details: { version: since } });
        const first = slotOf(since), last = slotOf(throughVersion);
        if (first > last || last > top) throw unknown();

        // Read slots after `since` in batches until the page fills or reaches
        // the fixed end. The first batch also proves that the exclusive start
        // and a cursor's end are publications of this store.
        const publications: RetainedPublication[] = [];
        const size = BigInt(Math.min(400, Math.max(2 * limit, 32)));
        // Current main is a publication by definition; v0 always exists.
        const checkFirst = first !== 0n && since !== main;
        const checkLast = continued && last !== 0n && throughVersion !== main;
        for (let next = checkFirst ? first : first + 1n, checked = !checkFirst && !checkLast;
            !checked || (publications.length < limit && next <= last);) {
            const to = next + size <= last ? next + size - 1n : last;
            const states = await journal.readSlots(next, to, signal, !checked && checkLast && last > to ? [last] : []);
            checkAbort(signal);
            if (!checked) {
                if ((checkFirst && !publicationAt(states, first)) || (checkLast && !publicationAt(states, last))) throw unknown();
                checked = true;
            }
            for (let at = next > first ? next : first + 1n; at <= to && publications.length < limit; at++) {
                const publication = publicationAt(states, at);
                if (publication) publications.push(publication);
            }
            next = to + 1n;
        }

        const entries = await retained.entries(publications, signal);
        checkAbort(signal);
        const result: FileHistoryResult = { entries, throughVersion };
        // The fixed end is itself a publication, so a full page that stops before it has a successor.
        const final = publications.at(-1)?.version;
        if (final !== undefined && final !== throughVersion)
            result.next = { cursor: encodeToken(historyToken, { d: await cursorStore, s: final, t: throughVersion, l: limit }) };
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
        // Only completed publication versions are selectable, even if an
        // unfinished merge has already created its target tag.
        const at = slotOf(version), { top, publicationAt } = observed();
        if (version !== published && (at > top || !publicationAt(await journal.readSlots(at, at, signal), at)))
            throw historicalViewUnavailable(version);
        const ref = tagRef(tagFor(version));
        if (!await hasTag(ref.name, signal)) throw historicalViewUnavailable(version);
        return ref;
    }

    async function read<T>(operation: (ref: ViewRef) => Promise<T>, signal?: AbortSignal) {
        await refresh(signal);
        if (published !== initialVersion || await hasInitial(signal)) return operation(refFor(published));
        // A store whose creation was interrupted has no frozen v0 yet. A merge
        // may have pinned and started applying during this operation. Recheck
        // before releasing its result.
        const provisional = await operation(branchRef('main'))
            .then(value => ({ value } as const), cause => ({ cause } as const));
        await refresh(signal);
        if (published === initialVersion && !active && !await hasInitial(signal)) {
            if ('cause' in provisional) throw provisional.cause;
            return provisional.value;
        }
        return operation(refFor(published));
    }

    async function settleRecord(signal?: AbortSignal) {
        if (!unresolved) return;
        while (unresolved) {
            const pending: NonNullable<typeof unresolved> = unresolved;
            await journal.write(pending.record, signal);
            // A confirmed reservation is followed by its request index.
            if (unresolved === pending) unresolved = pending.then ? { requestId: pending.requestId, record: pending.then } : undefined;
        }
        await refresh(signal);
    }

    function append(requestId: string, record: PublicationRecord, signal?: AbortSignal, then?: RequestIndex) {
        unresolved = { requestId, record, ...(then ? { then } : {}) };
        return settleRecord(signal);
    }

    async function finish(entry: Entry, signal?: AbortSignal) {
        const { reservation, slot } = entry;
        const { requestId, version, priorVersion, sourceTag, branch } = reservation;
        if (entry.outcome && entry !== active) return returnOutcome(entry.outcome, requestId);
        if (unsettled) throw mergeBlocked(unsettled.requestId, unsettled.cause);

        try {
            // The slot reaches no terminal record before its request index is
            // confirmed. A head left by an interrupted attempt may lack it.
            if (!entry.indexed) {
                await append(requestId, await indexFor(entry), signal);
                entry.indexed = true;
            }
            const target = tagRef(tagFor(version));
            const existing = entry.outcome ?? undefined;
            const plan = sourceTag === null ? undefined : await prepareMerge(content, content.collectionName, confirmedMergeSource(content, sourceTag),
                refFor(priorVersion), schema, signal, dimensions).catch(cause => {
                if (!(cause instanceof MemDriveError) || cause.code !== 'MERGE_CONFLICT' || existing) throw cause;
                const { fileIds, paths } = cause.details as { fileIds: string[]; paths: string[] };
                return { status: 'conflict' as const, fileIds, paths };
            });
            if (!entry.outcome) {
                let outcome: Outcome;
                if (!plan) outcome = { status: 'unchanged', version: priorVersion };
                else if ('status' in plan) outcome = plan;
                else if (!plan.targets.length) outcome = { status: 'unchanged', version: priorVersion };
                else {
                    if (!await hasTag(target.name, signal)) {
                        const id = appliedId(slot);
                        const applied = await journal.read(id, signal);
                        if (applied && applied.kind !== 'merge-applied-v1')
                            throw new MemDriveError('INVALID_RESULT', 'The journal contains an invalid merge application record.');
                        if (!applied) {
                            await applyMerge(content, content.collectionName, plan, version, signal);
                            await append(requestId, { id, driveId, kind: 'merge-applied-v1' }, signal);
                        }
                        await awaitMergeTag(() => createTag(target.name, signal), 'target', signal);
                    }
                    // Confirm both pinned lookup and indexed candidate visibility.
                    for (let attempt = 0; ; attempt++) {
                        try {
                            await verifyMerge(content, content.collectionName, plan, version, target, signal);
                            break;
                        } catch (cause) {
                            if (attempt === 5 || !(cause instanceof MemDriveError) || cause.code !== 'INVALID_RESULT')
                                throw cause;
                            await refBackoff(250 * 2 ** attempt, signal);
                        }
                    }
                    outcome = { status: 'published', version };
                }
                await append(requestId, { id: completionId(slot), driveId, kind: 'merge-result-v1', completedAt: new Date().toISOString(), ...outcome }, signal);
            }

            if (entry.outcome?.status === 'published' && entry === active && plan && !('status' in plan)) {
                await advanceMergeSource(content, content.collectionName, plan, version, schema, writerFor(branch).enqueueBaseline, signal);
                await append(requestId, { id: bookkeepingId(slot), driveId, kind: 'merge-bookkeeping-v1' }, signal);
            }
        } catch (cause) {
            if (cause instanceof MemDriveError && cause.code === 'MERGE_MUTATION_UNCONFIRMED') {
                unsettled = { requestId, cause };
                throw mergeBlocked(requestId, cause);
            }
            throw new MemDriveError('MERGE_RESUMABLE', 'Merge processing paused. Retry the same request.',
                { cause, details: { requestId, ...(entry.outcome?.status === 'published' ? { publishedVersion: version } : {}) } });
        }
        if (!entry.outcome) throw new MemDriveError('INVALID_RESULT', 'The terminal merge record was not observed.');
        return returnOutcome(entry.outcome, requestId);
    }

    function enqueue<T>(operation: () => Promise<T>) {
        const task = mergeTail.then(operation);
        mergeTail = task.then(() => undefined, () => undefined);
        return task;
    }

    function checkBinding(entry: Entry, { requestId, branch, summary }: BoundRequest) {
        if (entry.reservation.branch !== branch || entry.reservation.summary !== summary)
            throw new MemDriveError('MERGE_REQUEST_CONFLICT', 'The merge request ID is already bound to different input.', { details: { requestId } });
    }

    function merge(request: BoundRequest, { enqueueCapture, deferUserOperations }: Writer, signal?: AbortSignal) {
        const { requestId } = request;
        // A settled entry never changes, so the capture and the queued merge
        // share one lookup of it. Any other answer is read again where needed.
        let lookedUp: Promise<Entry | undefined> | undefined;
        function find() {
            const previous = lookedUp;
            const found = (async () => {
                const shared = await previous?.catch(() => undefined);
                return shared?.outcome && shared !== active ? shared : lookup(requestId, signal);
            })();
            lookedUp = found;
            return found;
        }
        // Capture independently of the main queue. Its current merge may
        // need this fork for bookkeeping.
        const captureSource = () => enqueueCapture(async (branch, confirmSource) => {
            const existing = await find();
            if (existing) {
                checkBinding(existing, request);
                const tag = existing.reservation.sourceTag;
                return tag === null ? null : confirmedMergeSource(content, tag);
            }
            if (unsettled) throw mergeBlocked(unsettled.requestId, unsettled.cause);
            const blocking = active?.reservation.requestId ?? unresolved?.requestId;
            if (blocking && blocking !== requestId && blocking !== executing) throw mergeBlocked(blocking);
            await ensureJournal(signal);
            return capture(request, operation => operation(branch, confirmSource), signal);
        }, signal);
        // If an earlier merge on this fork is still settling, capture after its
        // source baselines advance. Otherwise a second capture could retain
        // baselines from before its own fork's preceding publication.
        const predecessor = sourceMerges.get(request.branch);
        capturing++;
        const source = (predecessor ? predecessor.then(captureSource) : captureSource())
            .then(value => ({ value } as const), cause => ({ cause } as const))
            .then(captured => {
                capturing--;
                changed();
                return captured;
            });
        if (predecessor) deferUserOperations(source);

        const result = enqueue(async () => {
            executing = requestId;
            let completed = false;
            try {
                checkAbort(signal);
                const existing = await find();
                if (existing) {
                    checkBinding(existing, request);
                    if (existing.outcome && existing !== active) {
                        completed = true;
                        return returnOutcome(existing.outcome, requestId);
                    }
                }
                if (active && active.reservation.requestId !== requestId) throw mergeBlocked(active.reservation.requestId);
                if (unresolved && unresolved.requestId !== requestId) throw mergeBlocked(unresolved.requestId);
                if (unsettled) throw mergeBlocked(unsettled.requestId, unsettled.cause);
                const reserving = unresolved?.record.kind === 'merge-reservation-v1' ? unresolved.record : undefined;
                if (reserving && (reserving.branch !== request.branch || reserving.summary !== request.summary))
                    throw new MemDriveError('MERGE_REQUEST_CONFLICT', 'The merge request ID is already bound to different input.', { details: { requestId } });
                try {
                    await settleRecord(signal);
                } catch (cause) {
                    throw new MemDriveError('MERGE_RESUMABLE', 'Could not confirm the durable merge state. Retry the same request.',
                        { cause, details: { requestId } });
                }
                // Settling may have written this request's own reservation.
                const reserved = () => active?.reservation.requestId === requestId ? active : undefined;
                let entry = existing ?? reserved();
                if (!entry) {
                    const captured = await source;
                    if ('cause' in captured) throw captured.cause;
                    await ensureBootstrap(signal);
                    const id = await requestIndexId(requestId);
                    try {
                        // The reservation is confirmed first, then the index that
                        // names it, so a request ID maps to one slot for good and
                        // a repeated or late index write changes nothing.
                        const reservation: Reservation = { id: reservationId(slot), driveId, kind: 'merge-reservation-v1', ...request,
                            sourceTag: captured.value?.name ?? null, startedAt: new Date().toISOString(), priorVersion: published, version: versionFor(slot) };
                        await append(requestId, reservation, signal, { id, driveId, kind: 'merge-request-v1', requestId, slot: String(slot) });
                    } catch (cause) {
                        throw new MemDriveError('MERGE_RESUMABLE', 'Could not confirm the merge reservation. Retry the same request.',
                            { cause, details: { requestId } });
                    }
                    entry = reserved();
                    if (entry) entry.indexed = true;
                }
                if (!entry) throw new MemDriveError('INVALID_RESULT', 'The merge reservation was not observed.');
                try { return await finish(entry, signal); }
                finally { completed = Boolean(entry.outcome && entry !== active); }
            } finally {
                executing = undefined;
                if (completed) await maintainHistory(signal);
            }
        });
        const settled = result.then(() => undefined, () => undefined);
        sourceMerges.set(request.branch, settled);
        void settled.then(() => {
            if (sourceMerges.get(request.branch) === settled) sourceMerges.delete(request.branch);
            changed();
        });
        return result;
    }

    function recover(signal?: AbortSignal) {
        return enqueue(async () => {
            await ensureBootstrap(signal);
            await refresh(signal);
            if (unsettled) throw mergeBlocked(unsettled.requestId, unsettled.cause);
            if (!active && !unresolved) return;
            try {
                await settleRecord(signal);
                if (active) await finish(active, signal);
            } catch (cause) {
                if (!(cause instanceof MemDriveError) || cause.code !== 'MERGE_CONFLICT') throw cause;
            } finally {
                await maintainHistory(signal);
            }
        });
    }

    async function assertIdle(signal?: AbortSignal) {
        await refresh(signal);
        const blocking = active?.reservation.requestId ?? unresolved?.requestId ?? unsettled?.requestId ?? executing;
        if (blocking) throw mergeBlocked(blocking);
        if (sourceMerges.size) throw new MemDriveError('STORE_BUSY', 'A merge capture is still in progress.');
    }

    async function maintainHistory(signal?: AbortSignal) {
        if (signal?.aborted || active || unresolved || unsettled || !canMaintain()) return;
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
            // No merge is unfinished here, so every slot below `slot` is settled.
            await retained.prune(slot, found.retentionInDays, controller.signal);
        } catch {
            // Maintenance must not change a durable terminal merge result.
            // Archives and tag deletions are idempotent; later merges retry.
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
        }
    }

    /** Whether this client holds merge state or queued work that a new store object would lose. */
    const held = () => Boolean(unresolved || unsettled || executing !== undefined || capturing || sourceMerges.size || capture.unconfirmed());

    return { main: { read, pin }, pinVersion, merge, recover, status, history, assertIdle, initialize: ensureBootstrap, held };
}
