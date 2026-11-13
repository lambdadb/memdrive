#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, rm, copyFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parseArgs, parseEnv } from 'node:util';
import { get_encoding } from 'tiktoken';
import { createTools } from '@functional-systems/memdrive/tools';
import { collectEvidence } from './agent.mjs';
import { prepareCase, metadataSchema, hash, jsonHash, packEvidence, evidenceMetrics, judgeRequest, verdict, integer } from './protocol.mjs';
import { atomic, readJSON, exists, credentials, Journal, ingest, cleanup } from './runtime.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(directory, '../..');

export const config = await readJSON(path.join(directory, 'config.json'));
const rules = await readJSON(path.join(directory, 'judge-rules.json'));
assert.equal(hash(await readFile(path.join(directory, 'judge-rules.json'))), config.rulesSha256);

export async function frozenTools() {
    const registry = await createTools({ drive: {
        describe: async () => ({ name: 'benchmark', labels: {}, metadataSchema, embedding: { mode: 'managed', provider: 'openai',
            model: 'text-embedding-3-small', dimensions: 1536, similarity: 'cosine' }, textSearch: { analyzers: ['english'] } }),
        recall: async () => { throw new Error('Definition-only handle'); },
    } });
    return registry.definitions;
}
async function treeFiles(directory) {
    const result = [];
    for (const item of await readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, item.name);
        if (item.isDirectory()) result.push(...await treeFiles(target));
        else if (item.isFile()) result.push(target);
    }
    return result.sort();
}
export async function fingerprints() {
    const files = [path.join(repository, 'package.json'), path.join(repository, 'package-lock.json')];
    for (const folder of ['src', 'dist/esm', 'benchmark/longmemeval']) files.push(...await treeFiles(path.join(repository, folder)));
    // Fingerprint actual installed runtime code as well as the dependency lock.
    for (const name of ['@functional-systems/lambdadb', 'tiktoken', 'zod']) {
        const packageRoot = path.join(repository, 'node_modules', name);
        files.push(...await treeFiles(packageRoot));
    }
    return Object.fromEntries(await Promise.all(files.map(async file => [path.relative(repository, file), hash(await readFile(file))])));
}
export async function dataset(root) {
    const bytes = await readFile(path.join(root, 'dataset.json'));
    assert.equal(bytes.length, config.dataset.bytes, 'Dataset byte count differs');
    assert.equal(hash(bytes), config.dataset.sha256, 'Dataset hash differs');
    const rows = JSON.parse(bytes);
    assert.equal(rows.length, config.dataset.questions);
    const byId = new Map(rows.map(row => [row.question_id, row]));
    assert.equal(byId.size, rows.length, 'Duplicate question IDs');
    return byId;
}
export async function prepare(root, mode, limit) {
    assert(['single', 'tools'].includes(mode));
    assert(Number.isSafeInteger(limit) && limit > 0 && limit <= config.dataset.questions);
    assert(!await exists(path.join(root, 'lock.json')), 'Use a new run directory');
    const rows = await dataset(root);
    const ids = [...rows.keys()].sort().slice(0, limit);
    const lock = { protocol: config.protocol, owner: hash(randomBytes(32)), mode, ids, config,
        package: await readJSON(path.join(repository, 'package.json')),
        sources: await fingerprints(), tools: await frozenTools(), inputs: Object.fromEntries(ids.map(id => [id, jsonHash(prepareCase(rows.get(id), config))])) };
    await writeFile(path.join(root, 'lock.json'), JSON.stringify(lock, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return lock;
}
async function checked(root, checkSources = true) {
    const lock = await readJSON(path.join(root, 'lock.json'));
    assert.equal(lock.protocol, config.protocol); assert.deepEqual(lock.config, config);
    assert.equal(new Set(lock.ids).size, lock.ids.length); assert(lock.ids.length > 0);
    assert(/^[a-f0-9]{64}$/.test(lock.owner)); assert(['single', 'tools'].includes(lock.mode));
    if (checkSources) assert.deepEqual(await fingerprints(), lock.sources, 'Prepared code/dependencies changed; use a new run');
    assert.deepEqual(await frozenTools(), lock.tools);
    const rows = await dataset(root);
    for (const id of lock.ids) assert.equal(jsonHash(prepareCase(rows.get(id), config)), lock.inputs[id], 'Prepared source changed');
    return { lock, rows, binding: jsonHash(lock) };
}
const questionPath = (root, id) => path.join(root, 'questions', hash(id));
function safeError(error) {
    // Detailed receipts identify the failed phase; do not persist service exception bodies or credential-bearing stacks.
    const message = String(error.message);
    const code = /budget|limit/i.test(message) ? 'budget_exhausted'
        : /Selected evidence|selection/i.test(message) ? 'invalid_evidence_selection'
        : error instanceof SyntaxError ? 'invalid_json'
        : /request failed|HTTP/i.test(message) ? 'request_failed'
        : /model identity/i.test(message) ? 'model_identity_mismatch'
        : /usage/i.test(message) ? 'missing_usage'
        : /source|original|timestamp|metadata|bounds|Unicode/i.test(message) ? 'source_integrity_failure'
        : 'protocol_failure';
    return { code, message: 'Inspect the phase, tool trace and request receipts.' };
}
export function summary(lock, state) {
    const cases = Object.values(state.questions), successful = cases.filter(item => item.status === 'scored');
    const correct = successful.filter(item => item.verdict.correct).length;
    const models = {};
    for (const item of cases) for (const [kind, usage] of Object.entries(item.models)) {
        const total = models[kind] ??= { calls: 0, inputTokens: 0, outputTokens: 0, unknownUsageCalls: 0, milliseconds: 0 };
        for (const key of Object.keys(total)) total[key] = total[key] === null || usage[key] === null ? null : total[key] + usage[key];
    }
    const byType = {};
    for (const item of cases) {
        const total = byType[item.questionType] ??= { attempted: 0, scored: 0, correct: 0, failed: 0 };
        total.attempted++; if (item.status === 'scored') { total.scored++; if (item.verdict.correct) total.correct++; }
        if (item.status === 'failed') total.failed++;
    }
    const failed = cases.filter(item => item.status === 'failed').length;
    const complete = cases.length === lock.ids.length && successful.length + failed === lock.ids.length
        && cases.every(item => item.entry.absent);
    return { protocol: lock.protocol, mode: lock.mode, questions: lock.ids.length, fullCohort: lock.ids.length === config.dataset.questions,
        complete, scored: successful.length, failed, unfinished: lock.ids.length - successful.length - failed,
        correct, accuracy: complete ? correct / lock.ids.length : null,
        correctnessOverFrozenCohort: correct / lock.ids.length,
        models, byType,
        modelTokens: cases.reduce((sum, item) => sum + item.modelTokens, 0),
        databaseOperations: cases.reduce((sum, item) => sum + item.databaseOperations + item.cleanupOperations, 0),
        billedCostUsd: null };
}
export async function run(root, keys, { fetcher = fetch, signal } = {}) {
    const { lock, rows, binding } = await checked(root);
    assert(keys.modelKey?.trim() && keys.judgeKey?.trim(), 'Missing LLM_API_KEY or TYPESAFE_API_KEY');
    const stateFile = path.join(root, 'run.json');
    assert(!await exists(stateFile), 'Run already started; use verify/cleanup and a new run directory, never silently retry paid requests');
    const state = { binding, connection: keys.connection, startedAt: new Date().toISOString(), status: 'running', questions: {} };
    const save = () => atomic(stateFile, state);
    await save();
    const encoder = get_encoding('cl100k_base'), countTokens = text => encoder.encode(text, [], []).length;
    const runSignal = AbortSignal.any([signal, AbortSignal.timeout(config.limits.runHours * 3600000)].filter(Boolean));
    try {
        for (const id of lock.ids) {
            runSignal.throwIfAborted();
            const qroot = questionPath(root, id), prepared = prepareCase(rows.get(id), config);
            const q = { id, questionType: rows.get(id).question_type, status: 'running', phase: 'ingest', databaseOperations: 0, cleanupOperations: 0, receiptNumber: 0, modelTokens: 0, models: {},
                entry: { collection: `mdlme_${randomBytes(12).toString('hex')}`, owner: lock.owner, scope: jsonHash([lock.owner, id]), absent: false } };
            state.questions[id] = q; await save();
            const questionSignal = AbortSignal.any([runSignal, AbortSignal.timeout(config.limits.questionSeconds * 1000)]);
            const journal = new Journal({ root: qroot, config, binding, credentials: keys, state: q, save, fetcher, signal: questionSignal });
            let collected, packed;
            try {
                try {
                    const tools = await ingest(journal, prepared, q.entry);
                    assert.deepEqual(tools.definitions, lock.tools, 'Live tools differ from prepared definitions');
                    q.phase = 'collect'; await save();
                    const events = [];
                    collected = await collectEvidence({ mode: lock.mode, tools, prepared, config, countTokens, signal: questionSignal,
                        ask: (request, round) => journal.model('collector', request, `collector-${round}.json`),
                        onTool: async event => { events.push(event); await atomic(path.join(qroot, 'tools.json'), events); } });
                    packed = packEvidence(prepared, collected.selected, config, countTokens);
                    await atomic(path.join(qroot, 'evidence.json'), { collected, packed,
                        metrics: evidenceMetrics(rows.get(id), prepared, { retrieved: collected.retrieved, delivered: collected.delivered, packed: packed.spans }) });
                } finally { await cleanup(journal, q.entry); }
                q.phase = 'answer'; await save();
                assert(countTokens(JSON.stringify(packed.request)) + config.model.max_completion_tokens <= config.limits.contextTokens,
                    'Answer context budget exhausted');
                const answer = await journal.model('answer', packed.request, 'answer.json');
                assert.equal(answer.choices?.[0]?.finish_reason, 'stop');
                const content = answer.choices[0].message.content;
                assert(typeof content === 'string' && content.trim());
                q.phase = 'judge'; await save();
                const judgment = await journal.model('judge', judgeRequest(rows.get(id), content, config, rules), 'judge.json');
                q.verdict = verdict(judgment, config); q.status = 'scored'; q.phase = 'complete';
            } catch (error) {
                q.status = 'failed'; q.error = safeError(error);
                console.error(`FAILED ${id} at ${q.phase}`);
            }
            await save();
            await atomic(path.join(root, 'summary.json'), summary(lock, state));
            console.log(`${id}: ${q.status}${q.verdict ? ` (${q.verdict.correct ? 'correct' : 'incorrect'})` : ''}`);
            // Cleanup failures stop further allocations; the frozen denominator and incomplete status remain visible.
            if (!q.entry.absent) throw new Error('Cleanup is incomplete; run cleanup before any new evaluation');
        }
        state.status = 'completed';
    } catch {
        state.status = 'incomplete';
    } finally {
        encoder.free(); await save(); await atomic(path.join(root, 'summary.json'), summary(lock, state));
    }
    assert.equal(state.status, 'completed', 'Run incomplete; inspect summary and clean owned resources');
    return summary(lock, state);
}

export async function cleanRun(root, keys, { fetcher = fetch } = {}) {
    // Cleanup deliberately ignores changed source fingerprints and dataset availability.
    const lock = await readJSON(path.join(root, 'lock.json')), state = await readJSON(path.join(root, 'run.json'));
    assert.equal(state.binding, jsonHash(lock)); assert.equal(state.connection, keys.connection);
    const save = () => atomic(path.join(root, 'run.json'), state);
    for (const [id, q] of Object.entries(state.questions)) {
        assert(lock.ids.includes(id)); assert.equal(q.entry.owner, lock.owner);
        assert.equal(q.entry.scope, jsonHash([lock.owner, id]));
        if (q.entry.absent) continue;
        // Each explicit cleanup invocation gets a fresh bounded cleanup allowance; total operations stay cumulative.
        const previous = q.cleanupOperations;
        const cleanupConfig = { ...lock.config, limits: { ...lock.config.limits, cleanupOperations: previous + lock.config.limits.cleanupOperations } };
        await cleanup(new Journal({ root: questionPath(root, id), config: cleanupConfig, binding: state.binding,
            credentials: keys, state: q, save, fetcher }), q.entry);
    }
    await atomic(path.join(root, 'summary.json'), summary(lock, state));
}

function validateReceipt(receipt, binding) {
    assert.equal(receipt.binding, binding); assert.equal(receipt.requestHash, jsonHash(receipt.request));
    assert(['complete', 'pending', 'uncertain', 'aborted'].includes(receipt.status));
    if (receipt.status === 'complete') {
        assert(Number.isInteger(receipt.httpStatus)); assert.equal(typeof receipt.raw, 'string');
        assert(Number.isFinite(receipt.milliseconds) && receipt.milliseconds >= 0);
    }
}
export async function verify(root) {
    const { lock, rows, binding } = await checked(root);
    const state = await readJSON(path.join(root, 'run.json')); assert.equal(state.binding, binding);
    assert(Object.keys(state.questions).every(id => lock.ids.includes(id)));
    const encoder = get_encoding('cl100k_base'), countTokens = text => encoder.encode(text, [], []).length;
    try {
        for (const [id, q] of Object.entries(state.questions)) {
            assert.equal(q.id, id); assert.equal(q.questionType, rows.get(id).question_type); assert.equal(q.entry.owner, lock.owner); assert.equal(q.entry.scope, jsonHash([lock.owner, id]));
            const qroot = questionPath(root, id), prepared = prepareCase(rows.get(id), config);
            let absent = false, modelTokens = 0; const models = {};
            for (let number = 1; number <= q.receiptNumber; number++) {
                const receipt = await readJSON(path.join(qroot, `database/${number}.json`)); validateReceipt(receipt, binding);
                assert.equal(receipt.request.kind, 'database');
                const url = new URL(receipt.request.url), collectionPath = `/collections/${q.entry.collection}`;
                assert(url.pathname.endsWith('/collections') || url.pathname.includes(collectionPath), 'Receipt escaped owned collection');
                if (receipt.request.method === 'GET' && url.pathname.endsWith(collectionPath) && receipt.httpStatus === 404) absent = true;
                else if (receipt.request.method === 'POST' && url.pathname.endsWith('/collections')) {
                    assert.equal(receipt.request.body.collectionName, q.entry.collection); absent = false;
                }
            }
            assert.equal(q.entry.absent, absent, 'Cleanup state lacks a recorded absence check');
            const modelReceipts = new Map();
            for (const filename of await readdir(qroot)) if (/^(collector-\d+|answer|judge)\.json$/.test(filename)) {
                const receipt = await readJSON(path.join(qroot, filename)); validateReceipt(receipt, binding);
                modelReceipts.set(filename, receipt);
                const kind = receipt.request.kind; assert.equal(kind, filename.startsWith('collector-') ? 'collector' : filename.slice(0, -5));
                assert.equal(receipt.request.url, kind === 'judge' ? config.judge.endpoint : config.modelEndpoint);
                const usage = models[kind] ??= { calls: 0, inputTokens: 0, outputTokens: 0, unknownUsageCalls: 0, milliseconds: 0 };
                usage.calls++; usage.unknownUsageCalls++; usage.milliseconds += receipt.status === 'complete' ? receipt.milliseconds : 0;
                if (receipt.status === 'complete' && receipt.httpStatus === 200) {
                    let response; try { response = JSON.parse(receipt.raw); } catch { assert.equal(q.status, 'failed'); }
                    const input = response?.usage?.[kind === 'judge' ? 'input_tokens' : 'prompt_tokens'];
                    const output = response?.usage?.[kind === 'judge' ? 'output_tokens' : 'completion_tokens'];
                    if (integer(input) && (kind === 'judge' || integer(output))) {
                        usage.unknownUsageCalls--; usage.inputTokens += input;
                        usage.outputTokens = integer(output) && usage.outputTokens !== null ? usage.outputTokens + output : null;
                        if (kind !== 'judge') modelTokens += input + output;
                    } else assert.equal(q.status, 'failed', 'Successful question lacks model usage');
                }
            }
            assert.equal(q.modelTokens, modelTokens, 'Model token accounting differs');
            assert.deepEqual(q.models, models, 'Per-stage model accounting differs');
            assert.equal(q.receiptNumber, q.databaseOperations + q.cleanupOperations);
            if (await exists(path.join(qroot, 'evidence.json'))) {
                const saved = await readJSON(path.join(qroot, 'evidence.json'));
                const events = await readJSON(path.join(qroot, 'tools.json'));
                const firstReceipt = await readJSON(path.join(qroot, 'database/1.json'));
                const endpoint = new URL(firstReceipt.request.url);
                const projectMatch = /^(.*)\/projects\/([^/]+)\//.exec(endpoint.pathname);
                assert(projectMatch, 'Invalid database project URL');
                const replayKeys = { database: endpoint.origin + projectMatch[1], project: decodeURIComponent(projectMatch[2]), databaseKey: 'offline-replay' };
                assert.equal(jsonHash([replayKeys.database, replayKeys.project]), state.connection);
                const replayState = { databaseOperations: 0, cleanupOperations: 0, receiptNumber: 0, modelTokens: 0, models: {} };
                const journal = new Journal({ root: qroot, config, binding, credentials: replayKeys, state: replayState,
                    save: async () => {}, replay: true, onReplayReceipt: receipt => { clock = Math.max(clock, Date.parse(receipt.startedAt) + receipt.milliseconds); }, fetcher: async () => { throw new Error('Offline verification attempted network'); } });
                const originalNow = Date.now;
                let clock = Date.parse(firstReceipt.startedAt);
                Date.now = () => clock;
                try {
                const registry = await ingest(journal, prepared, q.entry);
                assert.deepEqual(registry.definitions, lock.tools);
                const semantic = result => {
                    const copy = structuredClone(result);
                    if (copy.ok) {
                        for (const item of copy.value.results ?? []) if (item.usage) delete item.usage.elapsedMs;
                        if (copy.value.asOf) delete copy.value.asOf;
                    }
                    return copy;
                };
                let at = 0;
                const replayed = await collectEvidence({ mode: lock.mode, prepared, config, countTokens,
                    now: () => events[at]?.startedAt,
                    tools: { definitions: lock.tools, execute: async (name, args) => {
                        const event = events[at++]; assert(event); assert.equal(event.name, name); assert.deepEqual(event.args, args);
                        assert(integer(event.startedAt)); clock = event.startedAt;
                        const actual = await registry.execute(name, args);
                        assert.deepEqual(semantic(actual), semantic(event.raw), 'Tool result differs from native receipt replay');
                        return event.raw;
                    } }, ask: async (request, round) => {
                        const receipt = modelReceipts.get(`collector-${round}.json`); assert(receipt);
                        assert.equal(receipt.status, 'complete'); assert.equal(receipt.httpStatus, 200);
                        assert.deepEqual(receipt.request.body, request); return JSON.parse(receipt.raw);
                    } });
                assert.equal(at, events.length); assert.deepEqual(replayed, saved.collected); assert.deepEqual(events, replayed.trace);
                const replayEntry = { ...q.entry, absent: false };
                journal.config = { ...config, limits: { ...config.limits, cleanupOperations: q.cleanupOperations } };
                while (!replayEntry.absent && replayState.receiptNumber < q.receiptNumber) {
                    const before = replayState.receiptNumber;
                    try { await cleanup(journal, replayEntry); }
                    catch (error) { if (q.status !== 'failed' || replayState.receiptNumber === before) throw error; }
                }
                assert(replayEntry.absent);
                assert.equal(replayState.receiptNumber, q.receiptNumber, 'Unused or missing database receipts');
                const packed = packEvidence(prepared, replayed.selected, config, countTokens);
                assert.deepEqual(packed, saved.packed);
                assert.deepEqual(saved.metrics, evidenceMetrics(rows.get(id), prepared,
                    { retrieved: replayed.retrieved, delivered: replayed.delivered, packed: packed.spans }));
                const answer = modelReceipts.get('answer.json');
                if (answer) assert.deepEqual(answer.request.body, packed.request);
                if (q.status === 'scored') {
                    assert.equal(answer?.httpStatus, 200); assert.equal(answer.status, 'complete');
                    const response = JSON.parse(answer.raw); assert.equal(response.model, config.model.model);
                    assert.equal(response.choices[0].finish_reason, 'stop');
                    const judgment = modelReceipts.get('judge.json'); assert.equal(judgment?.httpStatus, 200);
                    assert.equal(judgment.status, 'complete');
                    assert.deepEqual(judgment.request.body, judgeRequest(rows.get(id), response.choices[0].message.content, config, rules));
                    assert.deepEqual(q.verdict, verdict(JSON.parse(judgment.raw), config));
                }
                } finally { Date.now = originalNow; }
            } else assert.notEqual(q.status, 'scored', 'Scored question lacks evidence');
            assert(['scored', 'failed', 'running'].includes(q.status));
        }
        const expected = summary(lock, state); assert.deepEqual(await readJSON(path.join(root, 'summary.json')), expected);
        assert(expected.complete && state.status === 'completed', 'Run is incomplete; partial counts are not a completed benchmark');
        return expected;
    } finally { encoder.free(); }
}

async function main() {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { root: { type: 'string' },
        mode: { type: 'string' }, limit: { type: 'string' }, dataset: { type: 'string' }, 'env-file': { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) {
        console.log('Usage: node benchmark/longmemeval/run.mjs setup|prepare|run|verify|cleanup --root PATH\n'
            + 'setup [--dataset LOCAL_FILE]; prepare [--mode single|tools] [--limit 10]; run/cleanup [--env-file PATH]'); return;
    }
    const [command] = positionals;
    assert(positionals.length === 1 && ['setup', 'prepare', 'run', 'verify', 'cleanup'].includes(command) && values.root, 'Use --help for usage');
    assert(!values.dataset || command === 'setup'); assert(!values.mode || command === 'prepare'); assert(!values.limit || command === 'prepare');
    assert(!values['env-file'] || ['run', 'cleanup'].includes(command));
    const root = path.resolve(values.root); await mkdir(root, { recursive: true });
    const guard = path.join(root, '.running');
    await mkdir(guard); // Never remove another process's guard, including one left by an interrupted process.
    const controller = new AbortController();
    const stop = () => controller.abort(new Error('Interrupted'));
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    try {
        if (command === 'setup') {
            const target = path.join(root, 'dataset.json'); assert(!await exists(target), 'Dataset already exists');
            if (values.dataset) {
                const temporary = target + '.tmp';
                await copyFile(path.resolve(values.dataset), temporary);
                try {
                    const bytes = await readFile(temporary);
                    assert.equal(bytes.length, config.dataset.bytes); assert.equal(hash(bytes), config.dataset.sha256);
                    await rename(temporary, target);
                } finally { await rm(temporary, { force: true }); }
            }
            else {
                const response = await fetch(config.dataset.url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(900000)]) });
                assert(response.ok, `Dataset download returned HTTP ${response.status}`);
                const bytes = new Uint8Array(await response.arrayBuffer());
                assert.equal(bytes.length, config.dataset.bytes); assert.equal(hash(bytes), config.dataset.sha256);
                await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
            }
            await dataset(root); console.log('Pinned dataset verified.');
        } else if (command === 'prepare') {
            const lock = await prepare(root, values.mode ?? 'tools', Number(values.limit ?? 10));
            console.log(`Prepared ${lock.mode}: ${lock.ids.length}/${config.dataset.questions} frozen questions.`);
        } else if (command === 'verify') console.log(JSON.stringify(await verify(root), null, 2));
        else {
            const env = { ...process.env, ...(values['env-file'] ? parseEnv(await readFile(values['env-file'], 'utf8')) : {}) };
            const keys = credentials(env);
            if (command === 'cleanup') await cleanRun(root, keys);
            else console.log(JSON.stringify(await run(root, keys, { signal: controller.signal }), null, 2));
        }
    } finally {
        process.off('SIGINT', stop); process.off('SIGTERM', stop); await rm(guard, { recursive: true });
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
