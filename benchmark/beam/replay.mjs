#!/usr/bin/env node
// Replay one prepared original-BEAM conversation session by session and report how
// the model used the file tools. The harness only observes: it never writes or
// deletes on the model's behalf; it only makes each model write a checkpointed write.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { MemDrive, fileToolInstructions } from '@functional-systems/memdrive';
import { fileClient } from '../../test/helpers/file-client.mjs';
import { checkpointName, createToolHost, failureCodes, limits, openAI, protocol, ReplayFailure, runSession, scriptedTransport, toolDefinitions, toolNames,
    withGuide } from './replay-agent.mjs';
import { conversationMetrics, sessionMetrics } from './replay-metrics.mjs';
import { dateOf, fingerprint, hash, loadSessions } from './replay-sessions.mjs';
import { checkAmendments } from './replay-amendments.mjs';
import { questionsSucceeded, runQuestions, runRejudge } from './replay-questions.mjs';
import { cleanupStore, lambdadbConnection, ledgerFile, newStoreName, observeStore, storeLabels, storeProtocol, writeLedger } from './replay-store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const json = value => JSON.stringify(value, null, 2) + '\n';
const privateFile = { mode: 0o600 };
const positive = value => value === undefined || (Number.isSafeInteger(value) && value >= 1);
const backends = { fixture: 'native-client-fixture', lambdadb: 'lambdadb' };
const sorted = map => Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));

/**
 * Read-only harness observation after a session (see `observeStore`): main's latest
 * checkpoint before the session and now, `tree` of the whole drive and the inventory.
 */
export async function observe(drive, { latestCheckpointBefore }) {
    const { latestCheckpoint, tree, files, errors } = await observeStore(drive);
    return { latestCheckpointBefore, latestCheckpointAfter: latestCheckpoint, tree, inventory: files, errors };
}

/** Durations from the injected clock, kept apart from the deterministic metrics. */
function sessionTiming(wallMs, userTurns, requests, events) {
    const toolMsByName = {};
    for (const event of events) toolMsByName[event.name] = (toolMsByName[event.name] ?? 0) + event.elapsedMs;
    const total = items => items.reduce((sum, item) => sum + (item.elapsedMs ?? 0), 0);
    return { wallMs, modelRequestMs: total(requests), toolMs: total(events), toolMsByName: sorted(toolMsByName),
        // Per utterance: model request time and tool-call time. Wall time per utterance is not recorded.
        perTurn: Array.from({ length: userTurns }, (_, turn) => ({ modelRequestMs: total(requests.filter(receipt => receipt.turn === turn)),
            toolMs: total(events.filter(event => event.turn === turn)) })) };
}

const backendLimitations = {
    'native-client-fixture': 'Real public SDK on the native-client fixture: ranked search ignores the query, and there is no latency or cost.',
    lambdadb: 'Real public SDK on one live LambdaDB store; timings include network and service variance from a single run.',
};

export function summarize(manifest, results, cleanup) {
    const totals = conversationMetrics(results.map(result => result.metrics));
    const measured = manifest.transport === 'openai-responses';
    const completed = results.filter(result => result.status === 'completed').length;
    return { protocol, mode: manifest.mode, transport: manifest.transport, backend: manifest.backend, model: manifest.model,
        conversationId: manifest.source.conversationId, instructions: { source: manifest.instructions.source, sha256: manifest.instructions.sha256 },
        guide: manifest.guide, tools: manifest.tools,
        planned: manifest.plan.length, attempted: results.length, completed, failed: results.length - completed,
        complete: completed === manifest.plan.length, cleanup, store: manifest.store,
        // Scripted and injected transports exercise the harness; they are not model measurements.
        modelBehavior: measured ? totals : null,
        smoke: measured ? null : totals,
        sessions: results.map(({ id, index, status, error, metrics, timing }) => ({ id, index, status, ...(error ? { error } : {}), metrics, timing })),
        limitations: ['Process metrics from recorded tool calls and SDK reads; no answer generation, judging or content-quality score.',
            'Direct model API with only user utterances, SDK tool definitions and optional server instructions; not a real agent application with its own system prompt and memory features.',
            'The model answers each utterance itself; dataset assistant messages are not replayed, so later utterances may not match its replies.',
            backendLimitations[manifest.backend],
            'One model conversation per session and one conversation per run; a failed session ends the run without resume.'] };
}

/**
 * Replay one conversation. `guide: 'off'` leaves the `guide` tool out of the catalog;
 * the instruction text stays the SDK's, which names no tool.
 * Every `write` call is a checkpointed write named by `checkpointName`.
 */
export async function runReplay({ manifest: manifestFile, conversation, output, mode = 'model', model = 'gpt-6.1-sol', instructions = 'sdk',
    policyFile, guide = 'on', sessions: sessionLimit, turns: turnLimit, key, askFactory, budget = limits, sessionTokens, sessionSeconds, contextTokens,
    backend = 'fixture', env = {}, connect = lambdadbConnection, clock = () => performance.now() }) {
    assert(['model', 'scripted'].includes(mode), 'Invalid mode');
    assert(Object.hasOwn(backends, backend), 'Use --backend fixture or lambdadb');
    const tools = withGuide(toolNames, guide);
    assert(positive(sessionTokens) && positive(sessionSeconds) && positive(contextTokens),
        'session-tokens, session-seconds and context-tokens must be positive integers');
    budget = { ...budget, ...(sessionTokens === undefined ? {} : { sessionTokens }), ...(sessionSeconds === undefined ? {} : { sessionSeconds }),
        ...(contextTokens === undefined ? {} : { contextTokens }) };
    assert(['none', 'sdk'].includes(instructions), 'Use --instructions none or sdk');
    assert(typeof model === 'string' && model.length > 0 && model.length <= 100, 'Invalid model');
    assert(positive(sessionLimit) && positive(turnLimit), 'sessions and turns must be positive integers');
    assert(typeof output === 'string' && output, 'Provide a new output directory');
    const source = await loadSessions(manifestFile, conversation);
    const policy = policyFile === undefined ? null : await readFile(policyFile, 'utf8');
    assert(policy === null || policy.trim(), 'The policy file is empty');
    // One server-instruction text, as an MCP server would supply it. Omitted entirely when empty.
    const parts = [...(instructions === 'sdk' ? [fileToolInstructions] : []), ...(policy === null ? [] : [policy])];
    const text = parts.length ? parts.join('\n\n') : null;
    const plan = source.sessions.slice(0, sessionLimit).map(session => ({ id: session.id, index: session.index, timestamp: session.timestamp,
        date: dateOf(session.timestamp), markersStripped: session.markersStripped,
        userTurns: session.turns.length, plannedTurns: Math.min(turnLimit ?? session.turns.length, session.turns.length) }));
    // Validate credentials before creating an artifact directory or any SDK state.
    const transport = askFactory ? askFactory(plan) : mode === 'scripted' ? scriptedTransport() : openAI({ key });
    const connection = backend === 'lambdadb' ? connect(env) : null;
    const name = newStoreName(), labels = storeLabels(randomUUID());
    const definitions = toolDefinitions(tools);
    const sources = { ...Object.fromEntries(await Promise.all(['replay.mjs', 'replay-agent.mjs', 'replay-metrics.mjs', 'replay-sessions.mjs', 'replay-store.mjs', 'original-config.json']
        .map(async name => [`benchmark/beam/${name}`, hash(await readFile(path.join(root, 'benchmark/beam', name)))]))),
    ...await fingerprint(path.join(root, 'dist/esm'), root),
    'test/helpers/file-client.mjs': hash(await readFile(path.join(root, 'test/helpers/file-client.mjs'))),
    'package-lock.json': hash(await readFile(path.join(root, 'package-lock.json'))) };
    const manifest = { protocol, mode, transport: askFactory ? 'injected-test' : mode === 'model' ? 'openai-responses' : 'scripted',
        backend: backends[backend], store: connection ? { name, ledger: ledgerFile } : null, model, limits: budget, startedAt: new Date().toISOString(), node: process.version,
        package: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version,
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sources,
        source: { split: source.split, conversationId: source.id, manifestSha256: source.manifestSha256, runtimeSha256: source.runtimeSha256,
            sessions: source.sessions.length },
        instructions: { source: instructions, policySha256: policy === null ? null : hash(policy), text, sha256: text === null ? null : hash(text) },
        // Each session also gets its batch date as a separate developer message, and utterances lose their trailing generation marker.
        context: { currentDate: 'session-date', trailingMarkers: 'stripped' },
        request: { reasoning: { effort: 'low' }, store: false, include: ['reasoning.encrypted_content'], parallel_tool_calls: false },
        // The host makes every write tool call a checkpointed write on main.
        writes: { checkpointed: true, checkpointNames: 'turn-<base-36 milliseconds>-<8 hex>' },
        guide, tools, toolDefinitions: definitions, toolDefinitionsSha256: hash(JSON.stringify(definitions)), plan };
    output = path.resolve(output);
    await mkdir(path.dirname(output), { recursive: true });
    await mkdir(output); // Existing runs cannot be overwritten or replayed as fresh measurements.
    await writeFile(path.join(output, 'manifest.json'), json(manifest), privateFile);

    const fixture = connection ? null : fileClient(), client = connection?.client ?? fixture.client;
    const results = [];
    let cleanup = 'not_started';
    try {
        // A live create can succeed even when its response is lost: record ownership first.
        const ledger = connection && { protocol: storeProtocol, name, endpoint: connection.endpoint, project: connection.project, labels, status: 'pending' };
        if (ledger) await writeLedger(output, ledger, { create: true });
        const drive = await MemDrive.create({ client, name, labels });
        if (ledger) await writeLedger(output, { ...ledger, status: 'ready' });
        const call = createToolHost({ drive, resultBytes: budget.resultBytes, tools, checkpoint: checkpointName });
        for (const entry of plan) {
            const directory = path.join(output, `session-${String(entry.index + 1).padStart(3, '0')}-${entry.id}`);
            await mkdir(directory);
            const append = file => value => appendFile(path.join(directory, file), JSON.stringify(value) + '\n', privateFile);
            const state = { input: [], requests: [], events: [], userTurns: 0 };
            const result = { ...entry, status: 'failed' };
            const latestCheckpointBefore = (await drive.describe()).latestCheckpoint?.at.name ?? null;
            const started = clock();
            try {
                await runSession({ session: source.sessions[entry.index], turns: entry.plannedTurns, call, ask: transport, model,
                    instructions: text, definitions, budget, signal: AbortSignal.timeout(budget.sessionSeconds * 1000), state, clock, date: entry.date,
                    hooks: { item: append('transcript.jsonl'), receipt: append('requests.jsonl'), event: append('events.jsonl') } });
                result.status = 'completed';
            } catch (error) {
                result.error = { code: error instanceof ReplayFailure && failureCodes.includes(error.code) ? error.code : 'REPLAY_ERROR',
                    message: 'Inspect the request receipts and tool events; no automatic retry was attempted.' };
            }
            const wallMs = clock() - started;
            const observation = await observe(drive, { latestCheckpointBefore });
            result.metrics = sessionMetrics({ userTurns: state.userTurns, requests: state.requests, events: state.events, observation });
            result.timing = sessionTiming(wallMs, state.userTurns, state.requests, state.events);
            await writeFile(path.join(directory, 'observation.json'), json(observation), privateFile);
            await writeFile(path.join(directory, 'result.json'), json(result), privateFile);
            results.push(result);
            await writeFile(path.join(output, 'summary.json'), json(summarize(manifest, results, cleanup)), privateFile);
            // There is no resume, and later sessions depend on this one's drive.
            if (result.status !== 'completed') break;
        }
    } finally {
        // A live store is kept for inspection; remove it with --cleanup.
        if (connection) cleanup = 'retained';
        else try {
            await MemDrive.destroy({ client, name });
            cleanup = fixture.collections.size ? 'failed' : 'completed';
        } catch { cleanup = 'failed'; }
        await writeFile(path.join(output, 'summary.json'), json(summarize(manifest, results, cleanup)), privateFile);
    }
    return { manifest, results, summary: summarize(manifest, results, cleanup) };
}

/**
 * What the CLI prints for a failure: the error's name, its code and HTTP status when it has
 * them (an SDK, Node or argument-parser code names the cause), and a fixed message. Only an
 * assertion's own first line is shown; other messages, causes and stacks can carry service text.
 */
export function describeFailure(error) {
    return { error: error?.name ?? 'Error', ...(typeof error?.code === 'string' ? { code: error.code } : {}),
        ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
        message: error?.name === 'AssertionError' ? error.message.split('\n')[0]
            : 'BEAM replay could not complete. Check arguments, LLM_API_KEY, LambdaDB configuration and run receipts; a LambdaDB run keeps store.json for --cleanup. Use a new output directory.' };
}

const help = `Replay one prepared original-BEAM conversation against the MemDrive file tools.
  --manifest FILE --conversation ID --output NEW_DIR
  [--mode model|scripted] [--model ID] [--instructions sdk|none] [--policy-file FILE] [--guide on|off]
  [--sessions COUNT] [--turns COUNT] [--session-tokens N] [--session-seconds N] [--context-tokens N]
  [--backend fixture|lambdadb] [--env-file FILE]
Ask and judge the BEAM questions against the store a LambdaDB run retained:
  --questions --run RUN_DIR --manifest FILE --output NEW_DIR [--scope replayed|all]
  [--model ID] [--judge-model ID] [--judge-effort low|medium|high] [--limit N]
  [--answer-policy-file FILE] [--guide on|off] [--amendments on|off] [--env-file FILE]
Delete the LambdaDB store a run retained:
  --cleanup --output RUN_DIR [--env-file FILE]
Model mode needs LLM_API_KEY and makes paid requests. Scripted mode makes none.
The lambdadb backend needs LAMBDADB_BASE_URL, LAMBDADB_PROJECT_NAME and
LAMBDADB_PROJECT_API_KEY, makes paid requests and keeps its store.
Questions need LLM_API_KEY and the LambdaDB settings, make paid model and
database requests, and leave the store unchanged.
Judge the stored answers of a question stage again:
  --rejudge --answers QUESTIONS_DIR --manifest FILE --output NEW_DIR
  [--judge-model ID] [--judge-effort low|medium|high] [--repeats N] [--amendments on|off] [--env-file FILE]
Rejudge needs only LLM_API_KEY and makes paid judge requests.
--amendments on (default) also judges the items benchmark/beam/amendments.json amends
and reports amended scores beside the original ones, which it never changes.
Check that file against a whole prepared dataset, without any request:
  --check-amendments --manifest FILE
`;

async function main() {
    const { values } = parseArgs({ options: Object.fromEntries([
        ...['manifest', 'conversation', 'output', 'mode', 'model', 'instructions', 'policy-file', 'guide', 'sessions', 'turns', 'env-file',
            'backend', 'session-tokens', 'session-seconds', 'context-tokens', 'run', 'scope', 'judge-model', 'judge-effort', 'limit', 'answer-policy-file', 'answers', 'repeats', 'amendments'].map(option => [option, { type: 'string' }]),
        ['help', { type: 'boolean' }], ['cleanup', { type: 'boolean' }], ['questions', { type: 'boolean' }], ['rejudge', { type: 'boolean' }],
        ['check-amendments', { type: 'boolean' }],
    ]) });
    if (values.help) { console.log(help); return; }
    if (values['check-amendments']) {
        assert(values.manifest && Object.keys(values).every(option => ['check-amendments', 'manifest'].includes(option)), 'The amendments check takes only --manifest FILE');
        console.log(json(await checkAmendments({ manifest: values.manifest })));
        return;
    }
    const env = { ...process.env, ...(values['env-file'] ? parseEnv(await readFile(values['env-file'], 'utf8')) : {}) };
    if (values.cleanup) {
        assert(values.output && Object.keys(values).every(option => ['cleanup', 'output', 'env-file'].includes(option)),
            'Cleanup takes only --output RUN_DIR and --env-file FILE');
        console.log(json(await cleanupStore({ output: values.output, ...lambdadbConnection(env) })));
        return;
    }
    const count = value => value === undefined ? undefined : Number(value);
    const questionOptions = ['questions', 'run', 'manifest', 'output', 'scope', 'model', 'judge-model', 'judge-effort', 'limit', 'answer-policy-file', 'guide', 'amendments',
        'env-file'];
    if (values.questions) {
        assert(values.run && values.manifest && values.output && Object.keys(values).every(option => questionOptions.includes(option)),
            'Questions take --run RUN_DIR --manifest FILE --output NEW_DIR and optionally --scope, --model, --judge-model, --judge-effort, --limit, --answer-policy-file, --guide, '
            + '--amendments and --env-file');
        const { summary } = await runQuestions({ run: values.run, manifest: values.manifest, output: values.output, scope: values.scope,
            model: values.model, judgeModel: values['judge-model'], judgeEffort: values['judge-effort'], limit: count(values.limit),
            answerPolicyFile: values['answer-policy-file'], guide: values.guide, amendments: values.amendments, env, key: env.LLM_API_KEY });
        console.log(json(summary));
        if (!questionsSucceeded(summary)) process.exitCode = 1;
        return;
    }
    if (values.rejudge) {
        assert(values.answers && values.manifest && values.output
            && Object.keys(values).every(option => ['rejudge', 'answers', 'manifest', 'output', 'judge-model', 'judge-effort', 'repeats', 'amendments', 'env-file'].includes(option)),
        'Rejudge takes --answers QUESTIONS_DIR --manifest FILE --output NEW_DIR and optionally --judge-model, --judge-effort, --repeats, --amendments and --env-file');
        const { summary } = await runRejudge({ answers: values.answers, manifest: values.manifest, output: values.output,
            judgeModel: values['judge-model'], judgeEffort: values['judge-effort'], repeats: count(values.repeats), amendments: values.amendments, key: env.LLM_API_KEY });
        console.log(json(summary));
        if (!summary.questions.complete || summary.tokens.failedRequests || summary.amendedTokens?.failedRequests) process.exitCode = 1;
        return;
    }
    assert(values.manifest && values.conversation && values.output && !['run', 'scope', 'judge-model', 'judge-effort', 'limit', 'answer-policy-file', 'answers', 'repeats', 'amendments'].some(option => option in values), help);
    const { summary } = await runReplay({ manifest: values.manifest, conversation: values.conversation, output: values.output,
        mode: values.mode, model: values.model, instructions: values.instructions, policyFile: values['policy-file'], guide: values.guide,
        sessions: count(values.sessions), turns: count(values.turns), sessionTokens: count(values['session-tokens']),
        sessionSeconds: count(values['session-seconds']), contextTokens: count(values['context-tokens']), backend: values.backend, env,
        key: env.LLM_API_KEY });
    console.log(json(summary));
    if (!summary.complete || !['completed', 'retained'].includes(summary.cleanup)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch(error => {
        console.error(json(describeFailure(error)));
        process.exitCode = 1;
    });
}
