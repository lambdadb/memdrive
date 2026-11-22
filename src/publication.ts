import { keysOnly } from './config.js';
import { historyRetention, type RetainedPublication } from './history-retention.js';
import { checkAbort, databaseError, MemDriveError, mutationOptions, nativeOptions, nativeRequest, requireInput } from './errors.js';
import { mergeCaptureJournal } from './merge-journal.js';
import { applyMerge, advanceMergeSource, verifyMerge } from './merge-apply.js';
import { confirmedMergeSource, initialMainRef, prepareMerge } from './merge-preflight.js';
import { appliedId, bookkeepingId, completionId, parseOutcome, parseReservation, publicationLog, reservationId, returnOutcome,
    tagFor, versionFor, type BoundRequest, type Outcome, type PublicationRecord, type Reservation } from './publication-log.js';
import { awaitMergeTag, refBackoff } from './refs.js';
import { branchRef, type Handle, type ViewRef } from './storage-reads.js';
import type { ConnectionOptions, FileHistoryEntry, FileHistoryRequest, FileHistoryResult, FileStoreStatus, MetadataSchema } from './types.js';
import type { workingWriter } from './writes.js';

type Writer = ReturnType<typeof workingWriter>;
type Entry = { slot: bigint; reservation: Reservation; outcome?: Outcome & { completedAt: string } };
type HistoryPage = { start: number; end: number; limit: number; throughVersion: string };

const historyCursorLifetime = 5 * 60 * 1000;
const historyCursorLimit = 64;

function tagRef(name: string) {
    return { kind: 'tag' as const, name };
}

function mergeBlocked(requestId: string, cause?: unknown) {
    return new MemDriveError('MERGE_BLOCKED', 'A previous merge must settle before main can advance.',
        { cause, details: { requestId } });
}

export function publication(client: ConnectionOptions['client'], content: Handle, { name, driveId }: { name: string; driveId: string },
    schema: MetadataSchema, writerFor: (branch: string) => Writer, dimensions?: number) {
    const internal = client.collection(name);
    const journal = publicationLog(content, internal, driveId);
    const capture = mergeCaptureJournal(content, internal, { name, driveId }, { captureEmpty: true });
    const initialVersion = 'v0';
    const requests = new Map<string, Entry>();
    const publications: RetainedPublication[] = [];
    const retained = historyRetention(content, journal, driveId, hasTag);
    const positions = new Map([[initialVersion, 0]]);
    const cursors = new Map<string, HistoryPage & { expiresAt: number }>();
    let published = initialVersion;
    let slot = 1n;
    let active: Entry | undefined;
    let executing: string | undefined;
    let unresolved: { requestId: string; record: PublicationRecord } | undefined;
    let unsettled: { requestId: string; cause: unknown } | undefined;
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

    function refresh(signal?: AbortSignal) {
        const task = readTail.then(async () => {
            if (!await journal.exists(signal)) return;
            const previous = unresolved;
            if (previous && await journal.confirmed(previous.record, signal) && unresolved === previous)
                unresolved = undefined;
            for (;;) {
                if (!active) {
                    const record = await journal.read(reservationId(slot), signal);
                    if (!record) return;
                    const reservation = parseReservation(record, slot, published);
                    if (requests.has(reservation.requestId))
                        throw new MemDriveError('INVALID_RESULT', 'The publication journal contains a duplicate request.');
                    active = { slot, reservation };
                    requests.set(reservation.requestId, active);
                }
                if (!active.outcome) {
                    const record = await journal.read(completionId(slot), signal);
                    if (!record) return;
                    const outcome = parseOutcome(record, active.reservation);
                    active.outcome = outcome;
                    if (outcome.status === 'published') {
                        const { sourceTag, summary } = active.reservation;
                        // parseOutcome requires the retained capture for a publication.
                        published = outcome.version;
                        publications.push({ version: published, publishedAt: outcome.completedAt, summary, sourceTag: sourceTag! });
                        positions.set(published, publications.length);
                    }
                }
                if (active.outcome.status === 'published') {
                    const record = await journal.read(bookkeepingId(slot), signal);
                    if (!record) return;
                    if (record.kind !== 'merge-bookkeeping-v1')
                        throw new MemDriveError('INVALID_RESULT', 'The publication journal contains invalid source bookkeeping.');
                }
                active = undefined;
                slot++;
            }
        });
        readTail = task.then(() => undefined, () => undefined);
        return task;
    }

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

    async function history(request: FileHistoryRequest, signal?: AbortSignal): Promise<FileHistoryResult> {
        requireInput(keysOnly(request, ['sinceVersion', 'limit', 'cursor']), 'Invalid history options.');
        const now = Date.now();
        for (const [id, page] of cursors) if (page.expiresAt <= now) cursors.delete(id);
        let page: HistoryPage;
        if ('cursor' in request) {
            requireInput(Object.keys(request).length === 1 && typeof request.cursor === 'string',
                'Pass only cursor when continuing history.');
            const found = cursors.get(request.cursor);
            if (!found) throw new MemDriveError('HISTORY_CURSOR_UNAVAILABLE', 'History cursor is unavailable on this store handle. Start again without a cursor.');
            page = found;
        } else {
            const { sinceVersion = initialVersion, limit = 20 } = request;
            requireInput(typeof sinceVersion === 'string' && sinceVersion.length <= 52 - 'md-main-'.length
                && /^v(?:0|[1-9][0-9]*)$/.test(sinceVersion),
                'Provide a canonical version such as v0 or v1.');
            requireInput(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'History limit must be 1–100.');
            await refresh(signal);
            checkAbort(signal);
            const start = positions.get(sinceVersion);
            if (start === undefined)
                throw new MemDriveError('VERSION_NOT_FOUND', 'The requested version was not observed as a published main version.',
                    { details: { version: sinceVersion } });
            page = { start, end: publications.length, limit, throughVersion: published };
        }

        const { start, end, limit, throughVersion } = page;
        const stop = Math.min(start + limit, end);
        const entries: FileHistoryEntry[] = [];
        for (const publication of publications.slice(start, stop))
            entries.push(await retained.entry(publication, signal));
        checkAbort(signal);
        const result: FileHistoryResult = { entries, throughVersion };
        if (stop < end) {
            const cursor = globalThis.crypto.randomUUID();
            if (cursors.size >= historyCursorLimit) cursors.delete(cursors.keys().next().value!);
            cursors.set(cursor, { start: stop, end, limit, throughVersion, expiresAt: Date.now() + historyCursorLifetime });
            result.cursor = cursor;
        }
        return result;
    }

    async function pin(signal?: AbortSignal) {
        await refresh(signal);
        if (published === initialVersion) await ensureBootstrap(signal);
        checkAbort(signal);
        return refFor(published);
    }

    async function read<T>(operation: (ref: ViewRef) => Promise<T>, signal?: AbortSignal) {
        await refresh(signal);
        if (published !== initialVersion || await hasInitial(signal)) return operation(refFor(published));
        // Older stores have no frozen v0. A merge may have pinned and started
        // applying during this operation. Recheck before releasing its result.
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
        const { record } = unresolved;
        await journal.write(record, signal);
        unresolved = undefined;
        await refresh(signal);
    }

    function append(requestId: string, record: PublicationRecord, signal?: AbortSignal) {
        unresolved = { requestId, record };
        return settleRecord(signal);
    }

    async function finish(entry: Entry, signal?: AbortSignal) {
        const { reservation, slot } = entry;
        const { requestId, version, priorVersion, sourceTag, branch } = reservation;
        if (entry.outcome && entry !== active) return returnOutcome(entry.outcome, requestId);
        if (unsettled) throw mergeBlocked(unsettled.requestId, unsettled.cause);

        try {
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
        // Capture independently of the main queue. Its current merge may
        // need this fork for bookkeeping.
        const captureSource = () => enqueueCapture(async (branch, confirmSource) => {
            await refresh(signal);
            const existing = requests.get(requestId);
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
        const source = (predecessor ? predecessor.then(captureSource) : captureSource())
            .then(value => ({ value } as const), cause => ({ cause } as const));
        if (predecessor) deferUserOperations(source);

        const result = enqueue(async () => {
            executing = requestId;
            try {
                checkAbort(signal);
                await refresh(signal);
                const existing = requests.get(requestId);
                if (existing) {
                    checkBinding(existing, request);
                    if (existing.outcome && existing !== active) return returnOutcome(existing.outcome, requestId);
                }
                if (active && active.reservation.requestId !== requestId) throw mergeBlocked(active.reservation.requestId);
                if (unresolved && unresolved.requestId !== requestId) throw mergeBlocked(unresolved.requestId);
                if (unsettled) throw mergeBlocked(unsettled.requestId, unsettled.cause);
                if (unresolved && 'requestId' in unresolved.record
                    && (unresolved.record.branch !== request.branch || unresolved.record.summary !== request.summary))
                    throw new MemDriveError('MERGE_REQUEST_CONFLICT', 'The merge request ID is already bound to different input.', { details: { requestId } });
                try {
                    await settleRecord(signal);
                } catch (cause) {
                    throw new MemDriveError('MERGE_RESUMABLE', 'Could not confirm the durable merge state. Retry the same request.',
                        { cause, details: { requestId } });
                }
                let entry = requests.get(requestId);
                if (!entry) {
                    const captured = await source;
                    if ('cause' in captured) throw captured.cause;
                    await ensureBootstrap(signal);
                    try {
                        await append(requestId, { id: reservationId(slot), driveId, kind: 'merge-reservation-v1', ...request,
                            sourceTag: captured.value?.name ?? null, startedAt: new Date().toISOString(), priorVersion: published, version: versionFor(slot) }, signal);
                    } catch (cause) {
                        throw new MemDriveError('MERGE_RESUMABLE', 'Could not confirm the merge reservation. Retry the same request.',
                            { cause, details: { requestId } });
                    }
                    entry = requests.get(requestId);
                }
                if (!entry) throw new MemDriveError('INVALID_RESULT', 'The merge reservation was not observed.');
                return await finish(entry, signal);
            } finally {
                executing = undefined;
            }
        });
        const settled = result.then(() => undefined, () => undefined);
        sourceMerges.set(request.branch, settled);
        void settled.then(() => {
            if (sourceMerges.get(request.branch) === settled) sourceMerges.delete(request.branch);
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
                if (cause instanceof MemDriveError && cause.code === 'MERGE_CONFLICT') return;
                throw cause;
            }
        });
    }

    async function assertIdle(signal?: AbortSignal, allowCleanupRetry = false) {
        if (!allowCleanupRetry) retained.assertSettled();
        await refresh(signal);
        const blocking = active?.reservation.requestId ?? unresolved?.requestId ?? unsettled?.requestId ?? executing;
        if (blocking) throw mergeBlocked(blocking);
        if (sourceMerges.size) throw new MemDriveError('STORE_BUSY', 'A merge capture is still in progress.');
    }

    async function pruneHistory(configuration: { retentionInDays: number; dryRun: boolean; limit: number }, signal?: AbortSignal) {
        await assertIdle(signal, true);
        const completed = [...requests.values()].flatMap(({ reservation, outcome }) => outcome ? [{ reservation, outcome }] : []);
        return retained.prune(publications, completed, configuration, signal);
    }

    return { main: { read, pin }, merge, recover, status, history, assertIdle, pruneHistory,
        assertCleanupSettled: retained.assertSettled, initialize: ensureBootstrap };
}
