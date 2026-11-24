// Process metrics for a replayed session. Pure functions over the recorded
// model tool events, request receipts and harness observations; no model or SDK calls.

const tally = (items, key) => {
    const result = {};
    for (const item of items) result[key(item)] = (result[key(item)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
};
const validUsage = usage => ['input_tokens', 'output_tokens'].every(key => Number.isSafeInteger(usage?.[key]) && usage[key] >= 0);
const forkOf = event => event.args?.at?.kind === 'fork' ? event.args.at.name : undefined;

function lagSummary(lags) {
    const merged = lags.filter(lag => lag !== null);
    return { writes: lags.length, merged: merged.length, neverMerged: lags.length - merged.length,
        sameTurn: merged.filter(lag => lag === 0).length,
        meanTurns: merged.length ? merged.reduce((sum, lag) => sum + lag, 0) / merged.length : null,
        maxTurns: merged.length ? Math.max(...merged) : null };
}

/**
 * `events` are the model's tool calls in call order: { turn, name, args, ok, result | error }.
 * `observation` holds the harness reads taken after the session; a failed read is null.
 */
export function sessionMetrics({ userTurns, requests, events, observation }) {
    const succeeded = events.filter(event => event.ok);
    const named = name => succeeded.filter(event => event.name === name);
    const merges = events.filter(event => event.name === 'merge');
    // A write call is published by the next merge of its fork that returned a result
    // (published or unchanged). A batch write is one call. Lag counts user turns.
    const lags = named('write').map(write => {
        const merge = events.slice(events.indexOf(write) + 1)
            .find(event => event.name === 'merge' && event.ok && forkOf(event) === forkOf(write));
        return merge ? merge.turn - write.turn : null;
    });
    const publications = observation?.publications ?? null;
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
        merges: { published: merges.filter(event => event.ok && event.result?.status === 'published').length,
            unchanged: merges.filter(event => event.ok && event.result?.status === 'unchanged').length,
            failed: merges.filter(event => !event.ok).length },
        publicationLags: lags,
        publicationLag: lagSummary(lags),
        noSuccessfulWrite: named('write').length === 0,
        // From history(): versions published during this session. A truncated entry
        // omits file IDs, so the republished count is then only a lower bound.
        publications: publications ? publications.length : null,
        republishedFiles: published ? Object.values(published).filter(count => count >= 2).length : null,
        republishedFilesIsLowerBound: publications ? publications.some(entry => entry.fileIdsTruncated) : null,
        // From listForks() and diff() after the last turn. The harness changes nothing.
        forksRemaining: forks ? forks.length : null,
        unpublishedForks: known ? known.filter(fork => fork.changes > 0).length : null,
        unpublishedChanges: known ? known.reduce((sum, fork) => sum + fork.changes, 0) : null,
        publishedForksLeft: known ? known.filter(fork => fork.changes === 0).length : null,
        unobservedForks: forks ? forks.length - known.length : null,
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
    const nullableSum = key => sessions.some(session => session[key] === null) ? null : sum(key);
    const lags = sessions.flatMap(session => session.publicationLags);
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
        publications: nullableSum('publications'), republishedFiles: nullableSum('republishedFiles'),
        republishedFilesIsLowerBound: sessions.some(session => session.republishedFilesIsLowerBound === null) ? null
            : sessions.some(session => session.republishedFilesIsLowerBound),
        sessionsEndingWithUnpublishedForks: sessions.some(session => session.unpublishedForks === null) ? null
            : sessions.filter(session => session.unpublishedForks > 0).length,
        finalForksRemaining: last?.forksRemaining ?? null, finalUnpublishedForks: last?.unpublishedForks ?? null,
        finalUnpublishedChanges: last?.unpublishedChanges ?? null, finalPublishedForksLeft: last?.publishedForksLeft ?? null,
    };
}
