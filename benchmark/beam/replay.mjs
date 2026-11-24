#!/usr/bin/env node
// Replay one prepared original-BEAM conversation session by session and report how
// the model used the file tools. The harness only observes: it never writes, merges
// or deletes on the model's behalf.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { MemDrive, fileToolError, fileToolInstructions } from '@functional-systems/memdrive';
import { fileClient } from '../../test/helpers/file-client.mjs';
import { createToolHost, failureCodes, limits, openAI, protocol, ReplayFailure, runSession, scriptedTransport, toolDefinitions, toolNames } from './replay-agent.mjs';
import { conversationMetrics, sessionMetrics } from './replay-metrics.mjs';
import { hash, loadSessions } from './replay-sessions.mjs';
import { cleanupStore, lambdadbConnection, ledgerFile, newStoreName, storeLabels, storeProtocol, writeLedger } from './replay-store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const json = value => JSON.stringify(value, null, 2) + '\n';
const privateFile = { mode: 0o600 };
const positive = value => value === undefined || (Number.isSafeInteger(value) && value >= 1);
const backends = { fixture: 'native-client-fixture', lambdadb: 'lambdadb' };
const sorted = map => Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));

async function fingerprint(directory) {
    const result = {};
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) Object.assign(result, await fingerprint(file));
        else result[path.relative(root, file)] = hash(await readFile(file));
    }
    return result;
}

/** Read-only harness observations after a session. A failed read is recorded and left null. */
export async function observe(drive, mainVersionBefore) {
    const observation = { mainVersionBefore, mainVersionAfter: null, publications: null, forks: null, errors: [] };
    const attempt = async (step, read) => {
        try { return await read(); }
        catch (error) { observation.errors.push({ step, code: fileToolError(error).error.code }); return null; }
    };
    observation.mainVersionAfter = await attempt('status', async () => (await drive.status()).mainVersion);
    observation.publications = await attempt('history', async () => {
        const entries = [];
        for (let page = await drive.history({ sinceVersion: mainVersionBefore, limit: 100 }); ; page = await drive.history(page.next)) {
            entries.push(...page.entries);
            if (!page.next) return entries;
        }
    });
    const listed = await attempt('listForks', () => drive.listForks());
    if (listed) {
        observation.forks = [];
        for (const { at } of listed.forks) {
            const changes = await attempt(`diff:${at.name}`, () => drive.diff({ at }));
            observation.forks.push({ at, changes: changes ? changes.length : null });
        }
    }
    return observation;
}

/**
 * Check one successful model `list` call against a consistent read of the same view.
 * Every file in the store was written by the model, so the paths seen in its successful
 * `write` results, read back with the same `at` (a paths batch omits missing files),
 * are the files that existed when it listed. Only an unpaginated listing without
 * `cursor` or `delimiter` is compared; `prefix` and `nameContains` apply exactly as in
 * the SDK. Observation only: the model never sees this, and a failed read is unchecked.
 */
export async function checkList(drive, event, written) {
    const { at, prefix = '', nameContains = '', delimiter, cursor } = event.args;
    const record = { turn: event.turn, round: event.round, at: at ?? { kind: 'main' }, delivered: event.delivered };
    const reason = cursor !== undefined ? 'cursor' : delimiter !== undefined ? 'delimiter' : event.result.next ? 'next' : null;
    if (reason) return { ...record, checked: false, reason };
    const candidates = [...written].filter(file => file.startsWith(prefix) && file.slice(file.lastIndexOf('/') + 1).includes(nameContains)).sort();
    const existing = [];
    try {
        for (let start = 0; start < candidates.length; start += 100)
            existing.push(...(await drive.read({ ...(at ? { at } : {}), paths: candidates.slice(start, start + 100) })).map(file => file.path));
    } catch (error) { return { ...record, checked: false, reason: 'read_failed', code: fileToolError(error).error.code }; }
    const listed = new Set(event.result.files.map(file => file.path));
    return { ...record, checked: true, existing: existing.length, listed: listed.size, missed: existing.filter(file => !listed.has(file)) };
}

/** Durations from the injected clock, kept apart from the deterministic metrics. */
function sessionTiming(wallMs, requests, events) {
    const toolMsByName = {};
    for (const event of events) toolMsByName[event.name] = (toolMsByName[event.name] ?? 0) + event.elapsedMs;
    return { wallMs, modelRequestMs: requests.reduce((sum, receipt) => sum + (receipt.elapsedMs ?? 0), 0),
        toolMs: events.reduce((sum, event) => sum + event.elapsedMs, 0), toolMsByName: sorted(toolMsByName) };
}

const backendLimitations = {
    'native-client-fixture': 'Real public SDK on the native-client fixture: ranked search ignores the query, list is always current, and there is no latency or cost.',
    lambdadb: 'Real public SDK on one live LambdaDB store; timings include network and service variance from a single run.',
};

export function summarize(manifest, results, cleanup) {
    const totals = conversationMetrics(results.map(result => result.metrics));
    const measured = manifest.transport === 'openai-responses';
    const completed = results.filter(result => result.status === 'completed').length;
    return { protocol, mode: manifest.mode, transport: manifest.transport, backend: manifest.backend, model: manifest.model,
        conversationId: manifest.source.conversationId, instructions: { source: manifest.instructions.source, sha256: manifest.instructions.sha256 },
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

export async function runReplay({ manifest: manifestFile, conversation, output, mode = 'model', model = 'gpt-6.1-sol', instructions = 'sdk',
    policyFile, sessions: sessionLimit, turns: turnLimit, key, askFactory, budget = limits, sessionTokens, sessionSeconds,
    backend = 'fixture', env = {}, connect = lambdadbConnection, clock = () => performance.now() }) {
    assert(['model', 'scripted'].includes(mode), 'Invalid mode');
    assert(Object.hasOwn(backends, backend), 'Use --backend fixture or lambdadb');
    assert(positive(sessionTokens) && positive(sessionSeconds), 'session-tokens and session-seconds must be positive integers');
    budget = { ...budget, ...(sessionTokens === undefined ? {} : { sessionTokens }), ...(sessionSeconds === undefined ? {} : { sessionSeconds }) };
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
        userTurns: session.turns.length, plannedTurns: Math.min(turnLimit ?? session.turns.length, session.turns.length) }));
    // Validate credentials before creating an artifact directory or any SDK state.
    const transport = askFactory ? askFactory(plan) : mode === 'scripted' ? scriptedTransport(plan.map(entry => entry.plannedTurns)) : openAI({ key });
    const connection = backend === 'lambdadb' ? connect(env) : null;
    const name = newStoreName(), labels = storeLabels(randomUUID());
    const definitions = toolDefinitions();
    const sources = { ...Object.fromEntries(await Promise.all(['replay.mjs', 'replay-agent.mjs', 'replay-metrics.mjs', 'replay-sessions.mjs', 'replay-store.mjs', 'original-config.json']
        .map(async name => [`benchmark/beam/${name}`, hash(await readFile(path.join(root, 'benchmark/beam', name)))]))),
    ...await fingerprint(path.join(root, 'dist/esm')),
    'test/helpers/file-client.mjs': hash(await readFile(path.join(root, 'test/helpers/file-client.mjs'))),
    'package-lock.json': hash(await readFile(path.join(root, 'package-lock.json'))) };
    const manifest = { protocol, mode, transport: askFactory ? 'injected-test' : mode === 'model' ? 'openai-responses' : 'scripted',
        backend: backends[backend], store: connection ? { name, ledger: ledgerFile } : null, model, limits: budget, startedAt: new Date().toISOString(), node: process.version,
        package: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version,
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sources,
        source: { split: source.split, conversationId: source.id, manifestSha256: source.manifestSha256, runtimeSha256: source.runtimeSha256,
            sessions: source.sessions.length },
        instructions: { source: instructions, policySha256: policy === null ? null : hash(policy), text, sha256: text === null ? null : hash(text) },
        request: { reasoning: { effort: 'low' }, store: false, include: ['reasoning.encrypted_content'], parallel_tool_calls: false },
        tools: toolNames, toolDefinitions: definitions, toolDefinitionsSha256: hash(JSON.stringify(definitions)), plan };
    output = path.resolve(output);
    await mkdir(path.dirname(output), { recursive: true });
    await mkdir(output); // Existing runs cannot be overwritten or replayed as fresh measurements.
    await writeFile(path.join(output, 'manifest.json'), json(manifest), privateFile);

    const fixture = connection ? null : fileClient(), client = connection?.client ?? fixture.client;
    const results = [], written = new Set();
    let cleanup = 'not_started';
    try {
        // A live create can succeed even when its response is lost: record ownership first.
        const ledger = connection && { protocol: storeProtocol, name, endpoint: connection.endpoint, project: connection.project, labels, status: 'pending' };
        if (ledger) await writeLedger(output, ledger, { create: true });
        const drive = await MemDrive.create({ client, name, labels });
        if (ledger) await writeLedger(output, { ...ledger, status: 'ready' });
        const call = createToolHost({ drive, resultBytes: budget.resultBytes });
        for (const entry of plan) {
            const directory = path.join(output, `session-${String(entry.index + 1).padStart(3, '0')}-${entry.id}`);
            await mkdir(directory);
            const append = file => value => appendFile(path.join(directory, file), JSON.stringify(value) + '\n', privateFile);
            const state = { input: [], requests: [], events: [], userTurns: 0 }, listChecks = [];
            const result = { ...entry, status: 'failed' };
            const before = (await drive.status()).mainVersion;
            const logEvent = append('events.jsonl'), logCheck = append('list-checks.jsonl');
            // Runs before the next model call, so the harness sees the state the model listed.
            const event = async recorded => {
                await logEvent(recorded);
                if (!recorded.ok) return;
                if (recorded.name === 'write') for (const file of [recorded.result].flat()) if (typeof file?.path === 'string') written.add(file.path);
                if (recorded.name === 'list') {
                    const check = await checkList(drive, recorded, written);
                    listChecks.push(check);
                    await logCheck(check);
                }
            };
            const started = clock();
            try {
                await runSession({ session: source.sessions[entry.index], turns: entry.plannedTurns, call, ask: transport, model,
                    instructions: text, definitions, budget, signal: AbortSignal.timeout(budget.sessionSeconds * 1000), state, clock,
                    hooks: { item: append('transcript.jsonl'), receipt: append('requests.jsonl'), event } });
                result.status = 'completed';
            } catch (error) {
                result.error = { code: error instanceof ReplayFailure && failureCodes.includes(error.code) ? error.code : 'REPLAY_ERROR',
                    message: 'Inspect the request receipts and tool events; no automatic retry was attempted.' };
            }
            const wallMs = clock() - started;
            const observation = await observe(drive, before);
            result.metrics = sessionMetrics({ userTurns: state.userTurns, requests: state.requests, events: state.events, observation, listChecks });
            result.timing = sessionTiming(wallMs, state.requests, state.events);
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

const help = `Replay one prepared original-BEAM conversation against the MemDrive file tools.
  --manifest FILE --conversation ID --output NEW_DIR
  [--mode model|scripted] [--model ID] [--instructions sdk|none] [--policy-file FILE]
  [--sessions COUNT] [--turns COUNT] [--session-tokens N] [--session-seconds N]
  [--backend fixture|lambdadb] [--env-file FILE]
Delete the LambdaDB store a run retained:
  --cleanup --output RUN_DIR [--env-file FILE]
Model mode needs LLM_API_KEY and makes paid requests. Scripted mode makes none.
The lambdadb backend needs LAMBDADB_BASE_URL, LAMBDADB_PROJECT_NAME and
LAMBDADB_PROJECT_API_KEY, makes paid requests and keeps its store.
`;

async function main() {
    const { values } = parseArgs({ options: Object.fromEntries([
        ...['manifest', 'conversation', 'output', 'mode', 'model', 'instructions', 'policy-file', 'sessions', 'turns', 'env-file',
            'backend', 'session-tokens', 'session-seconds'].map(option => [option, { type: 'string' }]),
        ['help', { type: 'boolean' }], ['cleanup', { type: 'boolean' }],
    ]) });
    if (values.help) { console.log(help); return; }
    const env = { ...process.env, ...(values['env-file'] ? parseEnv(await readFile(values['env-file'], 'utf8')) : {}) };
    if (values.cleanup) {
        assert(values.output && Object.keys(values).every(option => ['cleanup', 'output', 'env-file'].includes(option)),
            'Cleanup takes only --output RUN_DIR and --env-file FILE');
        console.log(json(await cleanupStore({ output: values.output, ...lambdadbConnection(env) })));
        return;
    }
    assert(values.manifest && values.conversation && values.output, help);
    const count = value => value === undefined ? undefined : Number(value);
    const { summary } = await runReplay({ manifest: values.manifest, conversation: values.conversation, output: values.output,
        mode: values.mode, model: values.model, instructions: values.instructions, policyFile: values['policy-file'],
        sessions: count(values.sessions), turns: count(values.turns), sessionTokens: count(values['session-tokens']),
        sessionSeconds: count(values['session-seconds']), backend: values.backend, env, key: env.LLM_API_KEY });
    console.log(json(summary));
    if (!summary.complete || !['completed', 'retained'].includes(summary.cleanup)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch(error => {
        console.error(json({ error: error.name, message: error.name === 'AssertionError' ? error.message.split('\n')[0]
            : 'BEAM replay could not complete. Check arguments, LLM_API_KEY, LambdaDB configuration and run receipts; a LambdaDB run keeps store.json for --cleanup. Use a new output directory.' }));
        process.exitCode = 1;
    });
}
