// Process metrics for a replayed session or an asked question. Pure functions over the
// recorded model tool events, request receipts and the harness's observation after the
// session; no model or SDK calls. Durations are recorded separately so these metrics
// stay deterministic.

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
// `tree` returns folders and counts but no files, so it is not a lookup before a create.
const lookups = new Set(['search', 'findText', 'list', 'read']);
const operationKinds = ['create', 'updateEdits', 'updateContent', 'updateOther', 'append', 'delete'];

/** The operations of a write call paired with their results; a batch returns results in input order. */
function writeOperations(event) {
    const operations = Array.isArray(event.args?.operations) ? event.args.operations : [event.args];
    const results = event.ok ? [event.result].flat() : [];
    return operations.map((operation, index) => ({ operation, result: results[index] }));
}
const kindOf = operation => operation?.op === 'update'
    ? operation.edits !== undefined ? 'updateEdits' : operation.content !== undefined ? 'updateContent' : 'updateOther'
    : operation?.op;
/** The file an operation wrote: a create's or append's returned ID, otherwise the requested one. */
const fileOf = ({ operation, result }) => ['create', 'append'].includes(operation?.op) ? result?.fileId : operation?.fileId;

/**
 * Whether each operation created, updated or deleted its file, in call order. An append
 * created its file when it was by path, no earlier operation of the session wrote that
 * file ID and the result's createdAt equals its modifiedAt; every other append updated it.
 */
function classify(operations) {
    const written = new Set();
    return operations.map(item => {
        const { operation, result } = item, file = fileOf(item);
        const change = operation?.op !== 'append' ? operation?.op
            : operation.path !== undefined && !written.has(file) && typeof result?.createdAt === 'string' && result.createdAt === result.modifiedAt
                ? 'create' : 'update';
        if (typeof file === 'string') written.add(file);
        return { ...item, change };
    });
}

/** Mean and maximum of per-turn counts; the mean is null without turns. */
const perTurn = counts => ({ mean: counts.length ? counts.reduce((sum, count) => sum + count, 0) / counts.length : null,
    max: counts.length ? Math.max(...counts) : null });

const rangeOptions = ['startLine', 'endLine', 'maxChars', 'offset', 'revision'];
/** Whether a given prefix narrows below the whole drive, whose prefixes are `whole`. */
const narrows = (prefix, whole) => prefix !== undefined && !whole.includes(prefix);
/** UTF-16 units of the original text in a read result: one file, null, a range page or a batch. */
const contentChars = result => [result].flat().reduce((sum, file) => sum + (typeof file?.content === 'string' ? file.content.length : 0), 0);

/**
 * How one model conversation (a replay session or one question) explored and read the
 * drive, from its tool events in call order. Calls count whatever their outcome; calls
 * whose arguments are not a JSON object (invalid JSON, `null`, an array or a scalar,
 * all rejected by the host or SDK) are left out of every split by argument.
 * Characters count only results that reached the model.
 */
export function toolUse(events) {
    const named = name => events.filter(event => event.name === name);
    const parsed = list => list.filter(event => event.args !== null && typeof event.args === 'object' && !Array.isArray(event.args));
    const trees = parsed(named('tree')), lists = named('list'), reads = parsed(named('read'));
    const listings = parsed(lists).filter(event => event.args.cursor === undefined);
    const firstTree = events.findIndex(event => event.name === 'tree');
    const continued = new Set(parsed(lists).map(event => event.args.cursor).filter(cursor => typeof cursor === 'string'));
    const ranged = event => rangeOptions.some(key => event.args[key] !== undefined);
    const delivered = list => list.filter(event => event.ok && event.delivered);
    const failed = list => tally(list.filter(event => !event.ok), event => event.error?.code ?? 'UNKNOWN');
    return {
        firstTool: events[0]?.name ?? 'none',
        firstNonGuideTool: events.find(event => event.name !== 'guide')?.name ?? 'none',
        tree: { withPrefix: trees.filter(event => narrows(event.args.prefix, ['/'])).length,
            withoutPrefix: trees.filter(event => !narrows(event.args.prefix, ['/'])).length },
        list: { listings: listings.length, continuations: parsed(lists).length - listings.length,
            afterTree: listings.filter(event => firstTree >= 0 && events.indexOf(event) > firstTree).length,
            withPrefix: listings.filter(event => narrows(event.args.prefix, ['', '/'])).length,
            withNameContains: listings.filter(event => narrows(event.args.nameContains, [''])).length,
            withDelimiter: listings.filter(event => event.args.delimiter !== undefined).length,
            // A delivered page whose next no later call forwarded: the model saw only part of that listing.
            stoppedBeforeEnd: delivered(lists).filter(event => typeof event.result?.next?.cursor === 'string' && !continued.has(event.result.next.cursor)).length },
        search: named('search').length,
        findText: named('findText').length,
        read: { whole: reads.filter(event => !ranged(event)).length, ranged: reads.filter(ranged).length,
            wholeChars: delivered(reads.filter(event => !ranged(event))).reduce((sum, event) => sum + contentChars(event.result), 0),
            rangedChars: delivered(reads.filter(ranged)).reduce((sum, event) => sum + contentChars(event.result), 0) },
        failedTreesByCode: failed(named('tree')),
        failedListsByCode: failed(lists),
    };
}

/** Totals of `toolUse` over conversations: first tools tallied by name, counts summed. */
export function toolUseTotals(conversations) {
    const total = pick => conversations.reduce((sum, item) => sum + pick(item), 0);
    const fields = (key, names) => Object.fromEntries(names.map(name => [name, total(item => item[key][name])]));
    const perConversation = key => ({ calls: total(item => item[key]), mean: conversations.length ? total(item => item[key]) / conversations.length : null,
        max: conversations.length ? Math.max(...conversations.map(item => item[key])) : null });
    return {
        conversations: conversations.length,
        firstTool: tally(conversations, item => item.firstTool),
        firstNonGuideTool: tally(conversations, item => item.firstNonGuideTool),
        tree: fields('tree', ['withPrefix', 'withoutPrefix']),
        list: fields('list', ['listings', 'continuations', 'afterTree', 'withPrefix', 'withNameContains', 'withDelimiter', 'stoppedBeforeEnd']),
        search: perConversation('search'),
        findText: perConversation('findText'),
        withoutSearchOrFindText: conversations.filter(item => item.search === 0 && item.findText === 0).length,
        read: fields('read', ['whole', 'ranged', 'wholeChars', 'rangedChars']),
        failedTreesByCode: sumMaps(conversations.map(item => item.failedTreesByCode)),
        failedListsByCode: sumMaps(conversations.map(item => item.failedListsByCode)),
    };
}

/**
 * `events` are the model's tool calls in call order: { turn, round, name, args, ok, result | error, checkpoint? }.
 * `observation` holds the harness reads after the session (see `observe` in replay.mjs); a failed read is null.
 */
export function sessionMetrics({ userTurns, requests, events, observation = null }) {
    const turns = Array.from({ length: userTurns }, (_, turn) => events.filter(event => event.turn === turn));
    const writes = events.filter(event => event.name === 'write');
    const saved = writes.filter(event => event.ok);
    const operations = classify(saved.flatMap(event => writeOperations(event).map(item => ({ ...item, event }))));
    const turnsByFile = new Map();
    for (const item of operations) {
        const file = fileOf(item);
        if (typeof file === 'string') turnsByFile.set(file, (turnsByFile.get(file) ?? new Set()).add(item.event.turn));
    }
    const distinct = change => new Set(operations.filter(item => item.change === change).map(fileOf).filter(file => typeof file === 'string')).size;
    // A create, or an append that created its file, counts as looked up when a successful search, findText, list or read came earlier in the session.
    const firstLookup = events.findIndex(event => event.ok && lookups.has(event.name));
    const creates = operations.filter(item => item.change === 'create');
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
        toolUse: toolUse(events),
    };
}

/**
 * Totals over the attempted sessions. Per-turn means are over every utterance of the
 * conversation; file counts are summed per session, so a file written in two sessions
 * counts in both. `finalFiles` is the last session's inventory size.
 */
export function conversationMetrics(sessions) {
    const sum = key => sessions.reduce((total, session) => total + session[key], 0);
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
        toolUse: toolUseTotals(sessions.map(session => session.toolUse)),
    };
}
