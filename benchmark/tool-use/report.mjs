import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentFailureCodes } from './agent.mjs';
import { summarize } from './run.mjs';
import { retrievalMetrics } from './scenarios.mjs';

// Protocol v4 offers guide, list, read, search, findText and write. The ref tools belong to
// protocol-v3 and earlier run directories; status, history, diff and merge to v1 and v2.
const toolNames = ['guide', 'list', 'read', 'search', 'findText', 'fork', 'checkpoint', 'listForks', 'listCheckpoints',
    'deleteFork', 'deleteCheckpoint', 'write', 'rollback', 'status', 'history', 'diff', 'merge'];
// BINDING_CHANGED and REF_DELETED identify errors in protocol-v1 run directories. The HISTORY_*,
// MERGE_*, LIST_SCAN_LIMIT, REF_*_UNCONFIRMED, HISTORICAL_VIEW_UNAVAILABLE and VERSION_NOT_FOUND
// codes are no longer raised; earlier run directories can hold them.
const toolErrorCodes = [
    'ABORTED', 'BINDING_CHANGED', 'BRANCH_CONFLICT', 'BRANCH_NOT_FOUND', 'CHECKPOINT_CONFLICT', 'CHECKPOINT_NOT_FOUND',
    'CHECKPOINT_RESTORE_FAILED', 'CHECKPOINT_WRITE_FAILED',
    'CURSOR_VIEW_MISMATCH', 'DATABASE_ERROR', 'EDIT_CONFLICT', 'FILE_NOT_FOUND',
    'FIND_TEXT_CURSOR_UNAVAILABLE', 'HISTORICAL_VIEW_UNAVAILABLE', 'HISTORY_CURSOR_UNAVAILABLE', 'HISTORY_UNAVAILABLE',
    'INVALID_INPUT', 'INVALID_JSON', 'INVALID_RESULT', 'LIST_CURSOR_UNAVAILABLE', 'LIST_SCAN_LIMIT', 'MERGE_BLOCKED',
    'MERGE_CAPTURE_UNCONFIRMED', 'MERGE_CONFLICT', 'MERGE_REQUEST_CONFLICT', 'MERGE_SOURCE_CONFLICT', 'MERGE_SOURCE_NOT_READY',
    'PATH_AMBIGUOUS', 'PATH_EXISTS', 'READ_VERSION_CHANGED', 'REF_CREATION_UNCONFIRMED',
    'REF_DELETED', 'REF_DELETION_UNCONFIRMED', 'STORE_NOT_FOUND', 'TARGET_NOT_AUTHORIZED', 'TOOL_EXECUTION_FAILED', 'TOOL_NOT_ALLOWED', 'TOOL_UNAVAILABLE',
    'VERSION_NOT_FOUND', 'WRITE_UNCONFIRMED',
];
const known = (value, choices) => choices.includes(value) ? value : undefined;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const toolName = name => known(name, toolNames) ?? 'unknown';
// Only the view kind is exported; view names are task data.
const viewKind = args => args && typeof args === 'object' ? known(args.at?.kind, ['main', 'fork', 'checkpoint']) : undefined;

async function readJSON(file) {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) {
        // A timed-out process may have been interrupted while writing JSON.
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        return undefined;
    }
}

function requestDiagnostic({ round, status, response, error }, model) {
    return {
        round: count(round), status: known(status, ['pending', 'completed', 'failed_or_uncertain']),
        responseStatus: known(response?.status, ['completed', 'incomplete', 'failed', 'in_progress', 'queued', 'cancelled']),
        expectedModelMatched: typeof response?.model === 'string' ? response.model === model : undefined,
        inputTokens: count(response?.usage?.input_tokens), outputTokens: count(response?.usage?.output_tokens),
        errorCode: known(error?.code, ['MODEL_HTTP_ERROR', 'REQUEST_FAILED']),
        httpStatus: error?.code === 'MODEL_HTTP_ERROR' && Number.isInteger(error.status)
            && error.status >= 100 && error.status <= 599 ? error.status : undefined,
    };
}

function toolEvent(event) {
    if (event.kind === 'resource_read') return { kind: 'resource_read', actor: 'host' };
    if (event.kind !== 'tool') return undefined;
    return { kind: 'tool', name: toolName(event.name), at: viewKind(event.args),
        outcome: event.result?.error ? 'error' : 'ok',
        errorCode: event.result?.error && (known(event.result.error.code, toolErrorCodes) ?? 'OTHER_TOOL_ERROR'),
        truncated: event.delivery?.truncated === true };
}

function caseDiagnostic(entry, result, receipts, model) {
    const offered = result?.agent?.offered ?? receipts.map(receipt => ({ round: receipt.round, definitions: receipt.request?.tools }));
    const evaluation = result?.evaluation;
    const behavior = evaluation?.behavior;
    return { ...entry, status: result?.status ?? 'interrupted', stage: result?.stage, cleanup: result?.cleanup,
        errorCode: known(result?.error?.code, ['EVALUATION_ERROR', ...agentFailureCodes]),
        finalTextLength: typeof result?.agent?.finalText === 'string' ? result.agent.finalText.length : undefined,
        evaluation: evaluation && { passed: evaluation.passed,
            // Check names are static scenario identifiers and their values are booleans.
            checks: Object.fromEntries(Object.entries(evaluation.checks).filter(([, value]) => typeof value === 'boolean')),
            behavior: { toolCalls: count(behavior.toolCalls), guideCalls: count(behavior.guideCalls),
                resourceReadsByHost: count(behavior.resourceReadsByHost), exactEdits: count(behavior.exactEdits),
                readBeforeWrite: behavior.readBeforeWrite, writeCalls: count(behavior.writeCalls),
                // Protocol v3 and earlier runs record writes to main and rollback calls.
                mainWrites: count(behavior.mainWrites), rollbacks: count(behavior.rollbacks) } },
        // Counts and tool names recomputed from the recorded events; no arguments are exported.
        retrieval: Array.isArray(result?.events) ? retrievalMetrics(result.events) : undefined,
        events: (result?.events ?? []).map(toolEvent).filter(Boolean),
        offered: offered.map(round => ({ round: count(round.round),
            tools: (round.definitions ?? []).map(tool => toolName(tool.name)) })),
        requests: receipts.map(receipt => requestDiagnostic(receipt, model)),
    };
}

export async function readEvaluationReport(directory) {
    const manifest = await readJSON(path.join(directory, 'manifest.json'));
    if (!manifest) return { version: 1, manifest: null, summary: null, cases: [] };
    const { protocol, mode, transport, model, instruction, backend, node, startedAt, sourceCommit } = manifest;
    // The runner generates this metadata directly from local inputs and source files.
    const plan = manifest.plan.map(({ id, scenario, guide, repetition }) => ({ id, scenario, guide, repetition }));
    const { rounds, toolCalls, contextTokens, totalTokens, outputTokens, resultBytes, requestSeconds } = manifest.limits;
    const attempted = [], cases = [];
    const directories = new Set(await readdir(directory));
    for (const entry of plan) {
        if (!directories.has(entry.id)) continue;
        const caseDirectory = path.join(directory, entry.id);
        const result = await readJSON(path.join(caseDirectory, 'result.json'));
        const receipts = result?.receipts ?? [];
        if (!result) for (let round = 0; round < rounds; round++) {
            const receipt = await readJSON(path.join(caseDirectory, `request-${round}.json`));
            if (receipt) receipts.push(receipt);
        }
        attempted.push(result ?? { guide: entry.guide, status: 'error', receipts });
        cases.push(caseDiagnostic(entry, result, receipts, model));
    }
    const interrupted = cases.filter(result => result.status === 'interrupted').length;
    const summary = { ...summarize(manifest, attempted), interrupted };
    summary.complete = summary.complete && interrupted === 0;
    return { version: 1, manifest: { protocol, mode, transport, model, instruction, backend, node, startedAt, sourceCommit,
        packageVersion: manifest.package.version, lambdaDBVersion: manifest.package.dependencies['@functional-systems/lambdadb'],
        guideVersion: manifest.guide.version, plan,
        readOnlyScenarios: (manifest.scenarios ?? []).filter(item => item.writable === false && plan.some(entry => entry.scenario === item.id)).map(item => item.id),
        limits: { rounds, toolCalls, contextTokens, totalTokens, outputTokens, resultBytes, requestSeconds },
        sources: manifest.sources }, summary, cases };
}

export function formatEvaluationSummary(report) {
    const { manifest, summary } = report;
    const heading = '## Tool-use evaluation';
    if (!manifest) return `${heading}\n\nThe model step produced no readable run manifest. See its log for the startup or timeout outcome.\n`;
    const description = summary.transport === 'openai-responses'
        ? `OpenAI Responses model evaluation using ${/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(manifest.model) ? `\`${manifest.model}\`` : 'the configured model'}.`
        : summary.transport === 'scripted' ? 'Scripted smoke test with predetermined requests.' : 'Injected test transport.';
    const rows = ['none', 'tool', 'resource'].map(guide => {
        const group = summary.groups[guide];
        const planned = manifest.plan.filter(entry => entry.guide === guide).length;
        return `| ${guide} | ${planned} | ${group?.attempted ?? 0} | ${group?.passed ?? 0} | ${group?.failed ?? 0} | ${group?.errors ?? 0} |`;
    });
    const retrieval = manifest.readOnlyScenarios.flatMap(scenario => ['none', 'tool', 'resource'].flatMap(guide => {
        const counts = summary.groups[guide]?.retrievalByScenario?.[scenario];
        if (!counts) return [];
        const first = ['search', 'findText', 'list', 'read', 'none'].map(name => counts.firstTool[name]).join(' / ');
        return [`| ${scenario} | ${guide} | ${counts.cases} | ${first} | ${counts.search} | ${counts.findText} | ${counts.findTextBeforeSearch} | ${counts.cases - counts.casesUsingSearch} | ${counts.findTextUnscoped} |`];
    }));
    return [heading, '', description, '',
        `Attempted ${summary.attempted} of ${summary.planned} planned cases. Passed ${summary.passed}, failed ${summary.failed}, errors ${summary.errors} (including ${summary.interrupted} interrupted).`, '',
        '| Guide | Planned | Attempted | Passed | Failed | Errors |', '| --- | ---: | ---: | ---: | ---: | ---: |', ...rows, '',
        ...(retrieval.length ? ['### Retrieval tool selection in read-only scenarios', '',
            'Totals over recorded conversations. First tool counts conversations by their first retrieval call. Fixture search returns the same candidates for every query, so these counts describe tool selection, not retrieval relevance.', '',
            '| Scenario | Guide | Cases | First tool: search / findText / list / read / none | search calls | findText calls | findText before first search | Cases without search | Unscoped findText calls |',
            '| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |', ...retrieval, ''] : []),
        'Coverage is limited to synthetic scenarios and literal answer checks, the public SDK on the native-client fixture, and in-process host tools. The host fetches and injects the resource guide.', '',
        'The JSON artifact includes the run configuration, scoring checks, tool outcomes and request diagnostics.', ''].join('\n');
}

async function main() {
    const [directory, output] = process.argv.slice(2);
    if (!directory || !output) throw new Error('Provide a run directory and report path.');
    const report = await readEvaluationReport(directory);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(formatEvaluationSummary(report));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
    main().catch(() => { console.error('Could not export the tool-use evaluation report.'); process.exitCode = 1; });
