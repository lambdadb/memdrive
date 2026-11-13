#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, rm, copyFile, rename, link, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { get_encoding } from 'tiktoken';
import { createTools } from '@functional-systems/memdrive/tools';
import { collectEvidence } from './agent.mjs';
import { prepareCase, metadataSchema, hash, jsonHash, packEvidence, evidenceMetrics, judgeRequest, verdict, integer } from './protocol.mjs';
import { atomic, readJSON, exists, credentials, Journal, reuse } from './runtime.mjs';
import { dataset as loadDataset, questionPath, newUsage, lease, initialize, proof, ingestCorpus, cleanupCorpus } from './corpus.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(directory, '../..');

export const config = await readJSON(path.join(directory, 'config.json'));
const rulesText = await readFile(path.join(directory, 'judge-rules.json'), 'utf8');

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
export const dataset = root => loadDataset(root, config.dataset);
export async function prepare(root, corpusRoot, mode, limit) {
    assert(['single_pass', 'agentic'].includes(mode));
    assert(!await exists(path.join(root, 'lock.json')), 'Use a new run directory');
    assert.equal(hash(rulesText), config.rulesSha256, 'Judge rules do not match configured hash');
    await mkdir(root, { recursive: true });
    return lease(corpusRoot, async canonical => {
        assert.notEqual(await realpath(root), canonical, 'Corpus and run directories must differ');
        const corpusProof = await proof(canonical, config, limit), rows = await dataset(canonical);
        const ids = corpusProof.manifest.ids.slice(0, limit);
        const lock = { protocol: config.protocol, mode, ids, config, rulesText,
            corpus: { path: canonical, proofSha256: jsonHash(corpusProof) },
            package: await readJSON(path.join(repository, 'package.json')), sources: await fingerprints(), tools: await frozenTools(),
            inputs: Object.fromEntries(ids.map(id => [id, jsonHash(prepareCase(rows.get(id), config))])) };
        const target = path.join(root, 'dataset.json'); assert(!await exists(target), 'Use a new run directory');
        try { await link(path.join(canonical, 'dataset.json'), target); }
        catch (error) { if (error.code !== 'EXDEV') throw error; await copyFile(path.join(canonical, 'dataset.json'), target); }
        await atomic(path.join(root, 'corpus-proof.json'), corpusProof);
        await writeFile(path.join(root, 'lock.json'), JSON.stringify(lock, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        return lock;
    });
}
async function checked(root) {
    const lock = await readJSON(path.join(root, 'lock.json')), profile = lock.config;
    assert.equal(lock.protocol, 'memdrive-longmemeval-v2'); assert.equal(profile.protocol, lock.protocol);
    assert.equal(new Set(lock.ids).size, lock.ids.length); assert(lock.ids.length > 0);
    assert(['single_pass', 'agentic'].includes(lock.mode));
    const current = await fingerprints();
    // Frozen settings/rules remain authoritative for later phases; executable code/runtime must match.
    const executable = files => Object.fromEntries(Object.entries(files).filter(([name]) =>
        !name.startsWith('benchmark/') || /\.mjs$/.test(name)));
    assert.deepEqual(executable(current), executable(lock.sources), 'Executable code changed; use the original checkout/runtime');
    assert.deepEqual(await frozenTools(), lock.tools); assert.equal(hash(lock.rulesText), profile.rulesSha256);
    const corpusProof = await readJSON(path.join(root, 'corpus-proof.json'));
    assert.equal(jsonHash(corpusProof), lock.corpus.proofSha256);
    const rows = await loadDataset(root, profile.dataset);
    assert.deepEqual(corpusProof.manifest.dataset, profile.dataset);
    for (const id of lock.ids) {
        const prepared = prepareCase(rows.get(id), profile), entry = corpusProof.entries[id];
        assert.equal(jsonHash(prepared), lock.inputs[id], 'Prepared source changed');
        assert.equal(jsonHash(prepared.mems), corpusProof.manifest.sources[id]);
        assert.equal(entry.sourceHash, corpusProof.manifest.sources[id]);
        assert.deepEqual(entry.entry, { ...corpusProof.manifest.collections[id], absent: false });
    }
    return { lock, rows, binding: jsonHash(lock), corpusProof, rules: JSON.parse(lock.rulesText) };
}

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
    const correct = successful.filter(item => item.verdict.correct).length, models = {}, byType = {};
    for (const item of cases) {
        for (const [kind, usage] of Object.entries(item.models)) {
            const total = models[kind] ??= { calls: 0, inputTokens: 0, outputTokens: 0, unknownUsageCalls: 0, milliseconds: 0 };
            for (const key of Object.keys(total)) total[key] = total[key] === null || usage[key] === null ? null : total[key] + usage[key];
        }
        const total = byType[item.questionType] ??= { attempted: 0, scored: 0, correct: 0, failed: 0 };
        total.attempted++; if (item.status === 'scored') { total.scored++; if (item.verdict.correct) total.correct++; }
        if (item.status === 'failed') total.failed++;
    }
    const failed = cases.filter(item => item.status === 'failed').length;
    const retrievalComplete = state.recallStatus === 'completed' && cases.length === lock.ids.length;
    const scoringComplete = state.scoreStatus === 'completed' && successful.length + failed === lock.ids.length;
    const phase = state.scoreStatus === 'not_started' ? 'recall' : 'score';
    return { protocol: lock.protocol, mode: lock.mode, questions: lock.ids.length, fullCohort: lock.ids.length === lock.config.dataset.questions,
        phase, complete: phase === 'recall' ? retrievalComplete : scoringComplete, retrievalComplete, scoringComplete,
        retrieved: cases.filter(item => item.hasEvidence).length, scored: successful.length, failed,
        correct, accuracy: scoringComplete ? correct / lock.ids.length : null,
        correctnessOverFrozenCohort: phase === 'score' ? correct / lock.ids.length : null, models, byType,
        modelTokens: cases.reduce((sum, item) => sum + item.modelTokens, 0),
        validation: { databaseOperations: cases.reduce((sum, item) => sum + item.validationOperations, 0),
            milliseconds: cases.reduce((sum, item) => sum + item.validationMilliseconds, 0) },
        retrieval: { databaseOperations: cases.reduce((sum, item) => sum + item.databaseOperations - item.validationOperations, 0),
            milliseconds: cases.reduce((sum, item) => sum + item.retrievalMilliseconds, 0) },
        billedCostUsd: null };
}
export async function recall(root, keys, { fetcher = fetch, signal } = {}) {
    const { lock, rows, binding, corpusProof } = await checked(root), config = lock.config;
    if (lock.mode === 'agentic') assert(keys.modelKey?.trim(), 'Missing LLM_API_KEY for agentic collection');
    assert.equal(keys.connection, corpusProof.connection, 'Corpus connection differs');
    return lease(lock.corpus.path, async canonical => {
        assert.deepEqual(await proof(canonical, config, lock.ids.length), corpusProof, 'Corpus readiness changed');
        const file = path.join(root, 'run.json'); assert(!await exists(file), 'Recall already started; use a new run directory');
        const state = { binding, connection: keys.connection, recallStatus: 'running', scoreStatus: 'not_started', questions: {} };
        const save = () => atomic(file, state); await save();
        const encoder = get_encoding('cl100k_base'), countTokens = text => encoder.encode(text, [], []).length;
        const phaseSignal = AbortSignal.any([signal, AbortSignal.timeout(config.limits.runHours * 3600000)].filter(Boolean));
        try {
            for (const id of lock.ids) {
                phaseSignal.throwIfAborted();
                const qroot = questionPath(root, id), prepared = prepareCase(rows.get(id), config);
                const q = { ...newUsage(), id, questionType: rows.get(id).question_type, status: 'collecting', phase: 'validation',
                    entry: corpusProof.entries[id].entry, hasEvidence: false, validationOperations: 0, validationMilliseconds: 0, retrievalMilliseconds: 0 };
                state.questions[id] = q; await save();
                const questionSignal = AbortSignal.any([phaseSignal, AbortSignal.timeout(config.limits.questionSeconds * 1000)]);
                const journal = new Journal({ root: qroot, config, binding, credentials: keys, state: q, save, fetcher, signal: questionSignal, readOnly: true });
                const started = performance.now(); let retrievalStarted;
                try {
                    const tools = await reuse(journal, prepared, q.entry, corpusProof.manifest.storage);
                    assert.deepEqual(tools.definitions, lock.tools, 'Live tools differ from prepared definitions');
                    q.validationOperations = q.databaseOperations; q.validationMilliseconds = performance.now() - started;
                    q.phase = 'collect'; await save(); retrievalStarted = performance.now();
                    const events = [];
                    await atomic(path.join(qroot, 'tools.json'), events);
                    const collected = await collectEvidence({ mode: lock.mode, tools, prepared, config, countTokens, signal: questionSignal,
                        ask: (request, round) => journal.model('collector', request, `collector-${round}.json`),
                        onTool: async event => { events.push(event); await atomic(path.join(qroot, 'tools.json'), events); } });
                    const packed = packEvidence(prepared, collected.selected, config, countTokens);
                    await atomic(path.join(qroot, 'evidence.json'), { collected, packed,
                        metrics: evidenceMetrics(rows.get(id), prepared, { retrieved: collected.retrieved, delivered: collected.delivered, packed: packed.spans }) });
                    q.hasEvidence = true; q.status = 'recalled'; q.phase = 'recalled';
                } catch (error) { q.status = 'failed'; q.error = safeError(error); console.error(`FAILED ${id} at ${q.phase}`); }
                finally {
                    if (retrievalStarted === undefined) { q.validationOperations = q.databaseOperations; q.validationMilliseconds = performance.now() - started; }
                    else q.retrievalMilliseconds = performance.now() - retrievalStarted;
                }
                await save(); await atomic(path.join(root, 'summary.json'), summary(lock, state));
                console.log(`${id}: ${q.status}`);
            }
            state.recallStatus = 'completed';
        } catch { state.recallStatus = 'incomplete'; }
        finally { encoder.free(); await save(); await atomic(path.join(root, 'summary.json'), summary(lock, state)); }
        assert.equal(state.recallStatus, 'completed', 'Recall incomplete; corpus retained, inspect run records');
        return summary(lock, state);
    });
}
export async function score(root, keys, { fetcher = fetch, signal } = {}) {
    const { lock, rows, binding, rules } = await checked(root), config = lock.config;
    assert(keys.modelKey?.trim() && keys.judgeKey?.trim(), 'Missing LLM_API_KEY or TYPESAFE_API_KEY');
    await verify(root); // Validate saved retrieval before any answer/judge request. No corpus or database access.
    const file = path.join(root, 'run.json'), state = await readJSON(file);
    assert.equal(state.scoreStatus, 'not_started', 'Scoring already started; uncertain paid requests are never retried automatically');
    assert.equal(state.recallStatus, 'completed'); state.scoreStatus = 'running';
    const save = () => atomic(file, state); await save();
    const phaseSignal = AbortSignal.any([signal, AbortSignal.timeout(config.limits.runHours * 3600000)].filter(Boolean));
    try {
        for (const id of lock.ids) {
            phaseSignal.throwIfAborted();
            const q = state.questions[id]; if (!q.hasEvidence) continue;
            const qroot = questionPath(root, id), saved = await readJSON(path.join(qroot, 'evidence.json'));
            const journal = new Journal({ root: qroot, config, binding, credentials: keys, state: q, save, fetcher,
                signal: AbortSignal.any([phaseSignal, AbortSignal.timeout(config.limits.questionSeconds * 1000)]), readOnly: true });
            try {
                q.phase = 'answer'; await save();
                const answer = await journal.model('answer', saved.packed.request, 'answer.json');
                assert.equal(answer.choices?.[0]?.finish_reason, 'stop');
                const content = answer.choices[0].message.content; assert(typeof content === 'string' && content.trim());
                q.phase = 'judge'; await save();
                const judgment = await journal.model('judge', judgeRequest(rows.get(id), content, config, rules), 'judge.json');
                q.verdict = verdict(judgment, config); q.status = 'scored'; q.phase = 'complete';
            } catch (error) { q.status = 'failed'; q.error = safeError(error); console.error(`FAILED ${id} at ${q.phase}`); }
            await save(); await atomic(path.join(root, 'summary.json'), summary(lock, state));
        }
        state.scoreStatus = 'completed';
    } catch { state.scoreStatus = 'incomplete'; }
    finally { await save(); await atomic(path.join(root, 'summary.json'), summary(lock, state)); }
    assert.equal(state.scoreStatus, 'completed', 'Scoring incomplete; inspect saved receipts');
    return summary(lock, state);
}

function validateReceipt(receipt, binding) {
    assert.equal(receipt.binding, binding); assert.equal(receipt.requestHash, jsonHash(receipt.request));
    assert(['complete', 'pending', 'uncertain', 'aborted'].includes(receipt.status));
    if (receipt.status === 'complete') {
        assert(Number.isInteger(receipt.httpStatus)); assert.equal(typeof receipt.raw, 'string');
        assert(Number.isFinite(receipt.milliseconds) && receipt.milliseconds >= 0);
        assert(integer(receipt.completedAt));
    }
}
export async function verify(root) {
    const { lock, rows, binding, corpusProof, rules } = await checked(root), config = lock.config;
    const state = await readJSON(path.join(root, 'run.json')); assert.equal(state.binding, binding);
    assert.equal(state.connection, corpusProof.connection);
    assert(['running', 'completed', 'incomplete'].includes(state.recallStatus));
    assert(['not_started', 'running', 'completed', 'incomplete'].includes(state.scoreStatus));
    assert(Object.keys(state.questions).every(id => lock.ids.includes(id)));
    const encoder = get_encoding('cl100k_base'), countTokens = text => encoder.encode(text, [], []).length;
    try {
        for (const [id, q] of Object.entries(state.questions)) {
            assert.equal(q.id, id); assert.equal(q.questionType, rows.get(id).question_type); assert.deepEqual(q.entry, corpusProof.entries[id].entry);
            const qroot = questionPath(root, id), prepared = prepareCase(rows.get(id), config);
            let modelTokens = 0; const models = {};
            for (let number = 1; number <= q.receiptNumber; number++) {
                const receipt = await readJSON(path.join(qroot, `database/${number}.json`)); validateReceipt(receipt, binding);
                assert.equal(receipt.request.kind, 'database');
                const url = new URL(receipt.request.url), collectionPath = `/collections/${q.entry.collection}`;
                assert(url.pathname.includes(collectionPath), 'Receipt escaped corpus collection');
                assert(receipt.request.method === 'GET' || (receipt.request.method === 'POST'
                    && /\/(query|docs\/(fetch|list))$/.test(url.pathname)), 'Evaluation contains a database mutation');
            }
            assert.equal(q.cleanupOperations, 0); assert.equal(q.entry.absent, false);
            const modelReceipts = new Map();
            for (const filename of await readdir(qroot).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) if (/^(collector-\d+|answer|judge)\.json$/.test(filename)) {
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
                    save: async () => {}, replay: true, readOnly: true, onReplayReceipt: receipt => { clock = receipt.completedAt; }, fetcher: async () => { throw new Error('Offline verification attempted network'); } });
                const originalNow = Date.now;
                let clock = Date.parse(firstReceipt.startedAt);
                Date.now = () => clock;
                try {
                const registry = await reuse(journal, prepared, q.entry, corpusProof.manifest.storage);
                assert.equal(replayState.databaseOperations, q.validationOperations, 'Validation operation count differs');
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
            } else assert(!q.hasEvidence && q.status !== 'scored' && q.status !== 'recalled', 'Question lacks saved evidence');
            assert.equal(q.hasEvidence, await exists(path.join(qroot, 'evidence.json')));
            assert(['scored', 'failed', 'collecting', 'recalled'].includes(q.status));
            if (state.recallStatus === 'completed') assert.notEqual(q.status, 'collecting');
            if (state.scoreStatus === 'not_started') { assert.notEqual(q.status, 'scored'); assert(!modelReceipts.has('answer.json') && !modelReceipts.has('judge.json')); }
            assert(integer(q.validationOperations) && q.validationOperations <= q.databaseOperations);
            assert(Number.isFinite(q.validationMilliseconds) && q.validationMilliseconds >= 0);
            assert(Number.isFinite(q.retrievalMilliseconds) && q.retrievalMilliseconds >= 0);
        }
        const expected = summary(lock, state); assert.deepEqual(await readJSON(path.join(root, 'summary.json')), expected);
        assert(expected.complete, 'Run phase is incomplete; partial counts are not a completed benchmark');
        return expected;
    } finally { encoder.free(); }
}

async function main() {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { root: { type: 'string' },
        corpus: { type: 'string' }, mode: { type: 'string' }, limit: { type: 'string' }, dataset: { type: 'string' }, 'env-file': { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) {
        console.log('Usage: node benchmark/longmemeval/run.mjs setup|ingest|prepare|recall|score|verify|cleanup --root PATH\n'
            + 'setup [--dataset LOCAL_FILE]; ingest [--limit 10]; prepare --corpus PATH [--mode single_pass|agentic] [--limit 10]; ingest/recall/score/cleanup [--env-file PATH]'); return;
    }
    const [command] = positionals;
    assert(positionals.length === 1 && ['setup', 'ingest', 'prepare', 'recall', 'score', 'verify', 'cleanup'].includes(command) && values.root, 'Use --help for usage');
    assert(!values.dataset || command === 'setup'); assert(!values.mode || command === 'prepare'); assert(!values.limit || ['prepare', 'ingest'].includes(command));
    assert(!values.corpus || command === 'prepare');
    assert(!values['env-file'] || ['ingest', 'recall', 'score', 'cleanup'].includes(command));
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
            await lease(root, () => initialize(root, config)); console.log('Pinned dataset and corpus manifest verified; no database calls.');
        } else if (command === 'prepare') {
            assert(values.corpus, 'prepare requires --corpus PATH');
            const lock = await prepare(root, path.resolve(values.corpus), values.mode ?? 'agentic', Number(values.limit ?? 10));
            console.log(`Prepared ${lock.mode}: ${lock.ids.length}/${config.dataset.questions} frozen questions.`);
        } else if (command === 'verify') console.log(JSON.stringify(await verify(root), null, 2));
        else {
            const env = { ...process.env, ...(values['env-file'] ? parseEnv(await readFile(values['env-file'], 'utf8')) : {}) };
            const keys = credentials(env, command !== 'score');
            if (command === 'cleanup') await cleanupCorpus(root, keys);
            else if (command === 'ingest') console.log(JSON.stringify(await ingestCorpus(root, config, keys, Number(values.limit ?? 10), { signal: controller.signal }), null, 2));
            else console.log(JSON.stringify(await (command === 'recall' ? recall : score)(root, keys, { signal: controller.signal }), null, 2));
        }
    } finally {
        process.off('SIGINT', stop); process.off('SIGTERM', stop); await rm(guard, { recursive: true });
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
