// Process metrics for a replayed session. Pure functions over the recorded
// model tool events, request receipts and harness observations; no model or SDK calls.
// Durations are recorded separately so these metrics stay deterministic.

const tally = (items, key) => {
    const result = {};
    for (const item of items) result[key(item)] = (result[key(item)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
};
const validUsage = usage => ['input_tokens', 'output_tokens'].every(key => Number.isSafeInteger(usage?.[key]) && usage[key] >= 0);
const forkOf = event => event.args?.at?.kind === 'fork' ? event.args.at.name : undefined;

const lagStats = lags => {
    const reached = lags.filter(lag => lag !== null);
    return { reached: reached.length, sameTurn: reached.filter(lag => lag === 0).length,
        meanTurns: reached.length ? reached.reduce((sum, lag) => sum + lag, 0) / reached.length : null,
        maxTurns: reached.length ? Math.max(...reached) : null };
};
function lagSummary(lags) {
    const { reached, ...stats } = lagStats(lags);
    return { writes: lags.length, merged: reached, neverMerged: lags.length - reached, ...stats };
}
// `afterLast` utterances came after the session's last publication, or in a session without one.
function utteranceSummary(lags) {
    const { reached, ...stats } = lagStats(lags);
    return { utterances: lags.length, followed: reached, afterLast: lags.length - reached, ...stats };
}
const turnsOf = events => [...new Set(events.map(event => event.turn))].sort((a, b) => a - b);

// One record per successful model `list` call: { checked, reason?, missed? }.
function listCheckSummary(checks) {
    const checked = checks.filter(check => check.checked);
    return { calls: checks.length, checked: checked.length,
        uncheckedByReason: tally(checks.filter(check => !check.checked), check => check.reason),
        missedCalls: checked.filter(check => check.missed.length > 0).length,
        missedFiles: checked.reduce((sum, check) => sum + check.missed.length, 0) };
}

/**
 * `events` are the model's tool calls in call order: { turn, name, args, ok, result | error }.
 * `observation` holds the harness reads taken after the session; a failed read is null.
 * `listChecks` are the harness's checks of the model's successful `list` calls.
 */
export function sessionMetrics({ userTurns, requests, events, observation, listChecks = [] }) {
    const succeeded = events.filter(event => event.ok);
    const named = name => succeeded.filter(event => event.name === name);
    const merges = events.filter(event => event.name === 'merge');
    const publications = observation?.publications ?? null;
    // A merge repeated with a completed request ID returns its original `published`
    // result without publishing again. Count a merge as a publication only the first
    // time its version is returned, and only for a version published in this session
    // when history() was observed; any other `published` result is a replay.
    const sessionVersions = publications && new Set(publications.map(entry => entry.version));
    const returned = new Set(), publishing = new Set();
    for (const event of merges) {
        if (!event.ok || event.result?.status !== 'published') continue;
        const { version } = event.result;
        if (!returned.has(version) && (!sessionVersions || sessionVersions.has(version))) publishing.add(event);
        returned.add(version);
    }
    const replayed = merges.filter(event => event.ok && event.result?.status === 'published' && !publishing.has(event));
    // A write call is published by the next merge of its fork that published a new version.
    // An `unchanged` or replayed result publishes nothing. A batch write is one call. Lag counts user turns.
    const lags = named('write').map(write => {
        const merge = events.slice(events.indexOf(write) + 1).find(event => publishing.has(event) && forkOf(event) === forkOf(write));
        return merge ? merge.turn - write.turn : null;
    });
    // A model can defer the write itself instead of holding edits on a fork, so also
    // time each utterance against the next turn that published anything. An utterance
    // followed by a publication may have been saved; one after the last cannot have been.
    const publicationTurns = turnsOf([...publishing]);
    const utteranceLags = Array.from({ length: userTurns }, (_, turn) => {
        const next = publicationTurns.find(published => published >= turn);
        return next === undefined ? null : next - turn;
    });
    const published = publications && tally(publications.flatMap(entry => entry.fileIds), id => id);
    const forks = observation?.forks ?? null;
    const known = forks?.filter(fork => fork.changes !== null);
    return {
        userTurns,
        modelRequests: requests.length,
        inputTokens: requests.reduce((sum, request) => sum + (validUsage(request.usage) ? request.usage.input_tokens : 0), 0),
        outputTokens: requests.reduce((sum, request) => sum + (validUsage(request.usage) ? request.usage.output_tokens : 0), 0),
        unknownUsageRequests: requests.filter(request => !validUsage(request.usage)).length,
        toolCalls: events.length,
        toolCallsByName: tally(events, event => event.name),
        toolErrorsByCode: tally(events.filter(event => !event.ok), event => event.error?.code ?? 'UNKNOWN'),
        forksCreated: named('fork').length,
        forkNameConflicts: events.filter(event => event.name === 'fork' && event.error?.code === 'BRANCH_CONFLICT').length,
        forksDeleted: named('deleteFork').length,
        merges: { published: publishing.size, replayed: replayed.length,
            unchanged: merges.filter(event => event.ok && event.result?.status === 'unchanged').length,
            failed: merges.filter(event => !event.ok).length },
        publicationLags: lags,
        publicationLag: lagSummary(lags),
        noSuccessfulWrite: named('write').length === 0,
        turnsWithWrite: turnsOf(named('write')).length,
        turnsWithPublication: publicationTurns.length,
        utteranceToPublicationLags: utteranceLags,
        utteranceToPublication: utteranceSummary(utteranceLags),
        // From history(): versions published during this session. A truncated entry
        // omits file IDs, so both file counts are then only lower bounds. A republished
        // file was published more than once: an addition to it counts like a correction.
        publications: publications ? publications.length : null,
        publishedFiles: published ? Object.keys(published).length : null,
        republishedFiles: published ? Object.values(published).filter(count => count >= 2).length : null,
        republishedFilesIsLowerBound: publications ? publications.some(entry => entry.fileIdsTruncated) : null,
        // From listForks() and diff() after the last turn. The harness changes nothing.
        forksRemaining: forks ? forks.length : null,
        unpublishedForks: known ? known.filter(fork => fork.changes > 0).length : null,
        unpublishedChanges: known ? known.reduce((sum, fork) => sum + fork.changes, 0) : null,
        publishedForksLeft: known ? known.filter(fork => fork.changes === 0).length : null,
        unobservedForks: forks ? forks.length - known.length : null,
        // Successful list calls that omitted a file a consistent read of the same view found.
        listCheck: listCheckSummary(listChecks),
    };
}

const sumMaps = maps => {
    const result = {};
    for (const map of maps) for (const [key, value] of Object.entries(map)) result[key] = (result[key] ?? 0) + value;
    return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
};

/**
 * Totals over the attempted sessions. Fork observations are end-of-session states, so
 * their totals count a fork once per session it was still present in; `final*` fields
 * repeat the last session's observation, the state of the drive when the replay ended.
 */
export function conversationMetrics(sessions) {
    const sum = key => sessions.reduce((total, session) => total + session[key], 0);
    const listSum = key => sessions.reduce((total, session) => total + session.listCheck[key], 0);
    const nullableSum = key => sessions.some(session => session[key] === null) ? null : sum(key);
    const lags = sessions.flatMap(session => session.publicationLags);
    const utteranceLags = sessions.flatMap(session => session.utteranceToPublicationLags);
    const last = sessions.at(-1);
    return {
        sessions: sessions.length,
        userTurns: sum('userTurns'), modelRequests: sum('modelRequests'), inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
        unknownUsageRequests: sum('unknownUsageRequests'), toolCalls: sum('toolCalls'),
        toolCallsByName: sumMaps(sessions.map(session => session.toolCallsByName)),
        toolErrorsByCode: sumMaps(sessions.map(session => session.toolErrorsByCode)),
        forksCreated: sum('forksCreated'), forkNameConflicts: sum('forkNameConflicts'), forksDeleted: sum('forksDeleted'),
        merges: sumMaps(sessions.map(session => session.merges)),
        publicationLag: lagSummary(lags),
        sessionsWithoutWrite: sessions.filter(session => session.noSuccessfulWrite).length,
        turnsWithWrite: sum('turnsWithWrite'), turnsWithPublication: sum('turnsWithPublication'),
        utteranceToPublication: utteranceSummary(utteranceLags),
        // Republication is counted within a session: revising a file in a later session is the drive
        // growing, not a publication being redone. This is the sum of the per-session counts.
        publications: nullableSum('publications'), republishedWithinSessions: nullableSum('republishedFiles'),
        republishedFilesIsLowerBound: sessions.some(session => session.republishedFilesIsLowerBound === null) ? null
            : sessions.some(session => session.republishedFilesIsLowerBound),
        sessionsEndingWithUnpublishedForks: sessions.some(session => session.unpublishedForks === null) ? null
            : sessions.filter(session => session.unpublishedForks > 0).length,
        finalForksRemaining: last?.forksRemaining ?? null, finalUnpublishedForks: last?.unpublishedForks ?? null,
        finalUnpublishedChanges: last?.unpublishedChanges ?? null, finalPublishedForksLeft: last?.publishedForksLeft ?? null,
        listCheck: { calls: listSum('calls'), checked: listSum('checked'),
            uncheckedByReason: sumMaps(sessions.map(session => session.listCheck.uncheckedByReason)),
            missedCalls: listSum('missedCalls'), missedFiles: listSum('missedFiles') },
    };
}
