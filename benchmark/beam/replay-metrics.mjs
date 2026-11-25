// Process metrics for a replayed session. Pure functions over the recorded model
// tool events, request receipts, the harness's `list` checks and its observation
// after the session; no model or SDK calls. Durations are recorded separately so
// these metrics stay deterministic.

const tally = (items, key) => {
    const result = {};
    for (const item of items) result[key(item)] = (result[key(item)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
};
const sumMaps = maps => {
    const result = {};
    for (const map of maps) for (const [key, value] of Object.entries(map)) result[key] = (result[key] ?? 0) + value;
    return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
};
const validUsage = usage => ['input_tokens', 'output_tokens'].every(key => Number.isSafeInteger(usage?.[key]) && usage[key] >= 0);
const lookups = new Set(['search', 'findText', 'list', 'read']);
const operationKinds = ['create', 'updateEdits', 'updateContent', 'updateOther', 'delete'];

/** The operations of a write call paired with their results; a batch returns results in input order. */
function writeOperations(event) {
    const operations = Array.isArray(event.args?.operations) ? event.args.operations : [event.args];
    const results = event.ok ? [event.result].flat() : [];
    return operations.map((operation, index) => ({ operation, result: results[index] }));
}
const kindOf = operation => operation?.op === 'update'
    ? operation.edits !== undefined ? 'updateEdits' : operation.content !== undefined ? 'updateContent' : 'updateOther'
    : operation?.op;
/** The file an operation wrote: a create's returned ID, otherwise the requested one. */
const fileOf = ({ operation, result }) => operation?.op === 'create' ? result?.fileId : operation?.fileId;

/** Mean and maximum of per-turn counts; the mean is null without turns. */
const perTurn = counts => ({ mean: counts.length ? counts.reduce((sum, count) => sum + count, 0) / counts.length : null,
    max: counts.length ? Math.max(...counts) : null });

// One record per traversal of the model's `list` calls: { checked, reason?, missed?, stale? }.
function listCheckSummary(checks) {
    const checked = checks.filter(check => check.checked);
    return { traversals: checks.length, checked: checked.length,
        uncheckedByReason: tally(checks.filter(check => !check.checked), check => check.reason),
        withMissedFiles: checked.filter(check => check.missed.length > 0).length,
        missedFiles: checked.reduce((sum, check) => sum + check.missed.length, 0),
        withStaleFiles: checked.filter(check => check.stale.length > 0).length,
        staleFiles: checked.reduce((sum, check) => sum + check.stale.length, 0) };
}

/**
 * `events` are the model's tool calls in call order: { turn, round, name, args, ok, result | error, checkpoint? }.
 * `observation` holds the harness reads after the session (see `observe` in replay.mjs); a failed read is null.
 * `listChecks` are the harness's checks of the model's `list` traversals.
 */
export function sessionMetrics({ userTurns, requests, events, observation = null, listChecks = [] }) {
    const turns = Array.from({ length: userTurns }, (_, turn) => events.filter(event => event.turn === turn));
    const writes = events.filter(event => event.name === 'write');
    const saved = writes.filter(event => event.ok);
    const operations = saved.flatMap(event => writeOperations(event).map(item => ({ ...item, event })));
    const turnsByFile = new Map();
    for (const item of operations) {
        const file = fileOf(item);
        if (typeof file === 'string') turnsByFile.set(file, (turnsByFile.get(file) ?? new Set()).add(item.event.turn));
    }
    const distinct = kind => new Set(operations.filter(item => item.operation?.op === kind).map(fileOf).filter(file => typeof file === 'string')).size;
    // A create counts as looked up when a successful search, findText, list or read came earlier in the session.
    const firstLookup = events.findIndex(event => event.ok && lookups.has(event.name));
    const creates = operations.filter(item => item.operation?.op === 'create');
    const lookedUp = creates.filter(item => firstLookup >= 0 && events.indexOf(item.event) > firstLookup).length;
    const guides = events.filter(event => event.name === 'guide');
    // Every successful write moved main's latest checkpoint to its own; a failed one left it.
    const lastSave = saved.at(-1);
    const observed = observation !== null && !observation.errors.some(error => error.step.startsWith('describe'));
    return {
        userTurns,
        modelRequests: requests.length,
        inputTokens: requests.reduce((sum, request) => sum + (validUsage(request.usage) ? request.usage.input_tokens : 0), 0),
        outputTokens: requests.reduce((sum, request) => sum + (validUsage(request.usage) ? request.usage.output_tokens : 0), 0),
        unknownUsageRequests: requests.filter(request => !validUsage(request.usage)).length,
        toolCalls: events.length,
        toolCallsByName: tally(events, event => event.name),
        toolErrorsByCode: tally(events.filter(event => !event.ok), event => event.error?.code ?? 'UNKNOWN'),
        toolCallsPerTurn: perTurn(turns.map(list => list.length)),
        toolRounds: turns.reduce((sum, list) => sum + new Set(list.map(event => event.round)).size, 0),
        toolRoundsPerTurn: perTurn(turns.map(list => new Set(list.map(event => event.round)).size)),
        guideCalls: { index: guides.filter(event => event.args?.topic === undefined).length,
            byTopic: tally(guides.filter(event => event.args?.topic !== undefined), event => String(event.args.topic)) },
        writeCalls: writes.length,
        failedWritesByCode: tally(writes.filter(event => !event.ok), event => event.error?.code ?? 'UNKNOWN'),
        noSuccessfulWrite: saved.length === 0,
        turnsWithWrite: new Set(saved.map(event => event.turn)).size,
        turnsWithMultipleWriteCalls: turns.filter(list => list.filter(event => event.name === 'write').length > 1).length,
        operations: Object.fromEntries(operationKinds.map(kind => [kind, operations.filter(item => kindOf(item.operation) === kind).length])),
        filesCreated: distinct('create'),
        filesUpdated: distinct('update'),
        filesWrittenInSeveralTurns: [...turnsByFile.values()].filter(set => set.size > 1).length,
        createsAfterLookup: lookedUp,
        createsWithoutLookup: creates.length - lookedUp,
        // From the harness's observation after the last utterance.
        filesAfter: Array.isArray(observation?.inventory) ? observation.inventory.length : null,
        latestCheckpointAsExpected: observed
            ? observation.latestCheckpointAfter === (lastSave ? lastSave.checkpoint : observation.latestCheckpointBefore) : null,
        listCheck: listCheckSummary(listChecks),
    };
}

/**
 * Totals over the attempted sessions. Per-turn means are over every utterance of the
 * conversation; file counts are summed per session, so a file written in two sessions
 * counts in both. `finalFiles` is the last session's inventory size.
 */
export function conversationMetrics(sessions) {
    const sum = key => sessions.reduce((total, session) => total + session[key], 0);
    const listSum = key => sessions.reduce((total, session) => total + session.listCheck[key], 0);
    const turns = sum('userTurns');
    const maxOf = key => sessions.some(session => session[key].max !== null) ? Math.max(...sessions.map(session => session[key].max ?? 0)) : null;
    return {
        sessions: sessions.length,
        userTurns: turns, modelRequests: sum('modelRequests'), inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
        unknownUsageRequests: sum('unknownUsageRequests'), toolCalls: sum('toolCalls'),
        toolCallsByName: sumMaps(sessions.map(session => session.toolCallsByName)),
        toolErrorsByCode: sumMaps(sessions.map(session => session.toolErrorsByCode)),
        toolCallsPerTurn: { mean: turns ? sum('toolCalls') / turns : null, max: maxOf('toolCallsPerTurn') },
        toolRounds: sum('toolRounds'),
        toolRoundsPerTurn: { mean: turns ? sum('toolRounds') / turns : null, max: maxOf('toolRoundsPerTurn') },
        guideCalls: { index: sessions.reduce((total, session) => total + session.guideCalls.index, 0),
            byTopic: sumMaps(sessions.map(session => session.guideCalls.byTopic)) },
        writeCalls: sum('writeCalls'),
        failedWritesByCode: sumMaps(sessions.map(session => session.failedWritesByCode)),
        sessionsWithoutWrite: sessions.filter(session => session.noSuccessfulWrite).length,
        turnsWithWrite: sum('turnsWithWrite'), turnsWithMultipleWriteCalls: sum('turnsWithMultipleWriteCalls'),
        operations: Object.fromEntries(operationKinds.map(kind => [kind, sessions.reduce((total, session) => total + session.operations[kind], 0)])),
        filesCreated: sum('filesCreated'), filesUpdated: sum('filesUpdated'), filesWrittenInSeveralTurns: sum('filesWrittenInSeveralTurns'),
        createsAfterLookup: sum('createsAfterLookup'), createsWithoutLookup: sum('createsWithoutLookup'),
        finalFiles: sessions.at(-1)?.filesAfter ?? null,
        sessionsWithUnexpectedLatestCheckpoint: sessions.filter(session => session.latestCheckpointAsExpected === false).length,
        listCheck: { traversals: listSum('traversals'), checked: listSum('checked'),
            uncheckedByReason: sumMaps(sessions.map(session => session.listCheck.uncheckedByReason)),
            withMissedFiles: listSum('withMissedFiles'), missedFiles: listSum('missedFiles'),
            withStaleFiles: listSum('withStaleFiles'), staleFiles: listSum('staleFiles') },
    };
}
