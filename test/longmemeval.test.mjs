import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { row, keys } from './helpers/longmemeval-http.mjs';
import { prepareCase, timestamp, packEvidence, evidenceMetrics, resultSpans, sourceFiles, jsonHash } from '../benchmark/longmemeval/protocol.mjs';
import { collectEvidence, fileTools, runTool } from '../benchmark/longmemeval/agent.mjs';
import { Journal, readJSON } from '../benchmark/longmemeval/runtime.mjs';

const config = JSON.parse(await readFile(new URL('../benchmark/longmemeval/config.json', import.meta.url)));
const state = () => ({ databaseOperations: 0, cleanupOperations: 0, receiptNumber: 0, modelTokens: 0, models: {} });
const fileId = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const response = output => ({ status: 'completed', output });
const call = (id, name, args) => ({ id: 'item-' + id, call_id: id, type: 'function_call', name, arguments: JSON.stringify(args) });
const select = evidence => response([{ type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: JSON.stringify({ evidence }) }] }]);

function fixture(input = row(), configOverride = config) {
    const prepared = prepareCase(input, configOverride);
    const file = { ...prepared.files[0], fileId };
    const sources = sourceFiles(prepared, [fileId, otherId]);
    return { file, options: { mode: 'agentic', definitions: fileTools(configOverride), prepared, sources,
        config: configOverride, countTokens: text => text.length } };
}

test('source adaptation preserves literal messages and calendar timestamps without evaluation annotations', () => {
    const input = row(), prepared = prepareCase(input, config);
    assert.equal(prepared.boundary, 2);
    assert.equal(prepared.files[0].content, input.haystack_sessions[0][0].content);
    assert.equal(prepared.files[0].path, '/sessions/1/messages/0.txt');
    assert.equal(prepared.files[0].metadata.timestamp, '2023-01-02T10:00:00.000Z');
    assert.equal(prepared.recent.length, 4);
    assert.doesNotMatch(JSON.stringify(prepared), /has_answer|answer_session_ids|single-session-user/);
    assert.throws(() => timestamp('2023/02/29 (Wed) 10:00'), /Invalid calendar/);
    assert.throws(() => sourceFiles(prepared, [fileId, fileId]), /Duplicate/);
});

test('file identity, metadata and UTF-16 ranges are verified before evidence can be selected or packed', () => {
    const input = row(), { file, options: { sources, prepared } } = fixture(input);
    const hit = { ...file, content: '🧭 key', range: { start: 4, end: 10 } };
    const spans = hit => resultSpans('search_files', { ok: true, value: { hits: [hit] } }, sources);
    const [span] = spans(hit);
    assert.equal(span.content, '🧭 key');
    assert.equal(span.start, 4);
    assert.deepEqual(spans({ ...hit, range: undefined }), [span]);
    assert.deepEqual(spans({ ...hit, range: undefined, content: 'not in original' }), []);
    assert.throws(() => spans({ ...hit, range: { start: 5, end: 10 } }), /Split Unicode/);
    assert.throws(() => spans({ ...hit, content: 'wrong' }), /differs from source/);
    assert.throws(() => spans({ ...hit, path: '/foreign.txt' }), /file path differs/);
    assert.throws(() => spans({ ...hit, fileId: otherId }), /file path differs/);
    assert.throws(() => spans({ ...hit, metadata: { ...hit.metadata, timestamp: 'wrong' } }), /metadata differs/);
    const packed = packEvidence(prepared, [span], config, text => text.length, sources);
    assert.deepEqual(packed.spans, [span]);
    const metrics = evidenceMetrics(input, prepared, { packed: packed.spans });
    assert.equal(metrics.stages.packed.archived.anyTurnRecall, 1);
    assert.equal(metrics.stages.packed.archived.fullTurnRecall, 0);
    delete input.haystack_sessions[0][0].has_answer;
    assert.equal(evidenceMetrics(input, prepared, { packed: packed.spans }).stages.packed.archived.anyTurnRecall, null);
    input.question_id += '_abs';
    assert.equal(evidenceMetrics(input, prepared, { packed: packed.spans }).applicable, false);
});

test('oversized evidence stays in retrieval accounting and cannot be selected', async () => {
    const limited = { ...config, limits: { ...config.limits, toolResultTokens: 30 } };
    const { file, options } = fixture(row(), limited);
    const executeTool = async () => ({ ok: true, value: file });
    const ask = evidence => async (request, round) => {
        if (round === 0) return response([call('read', 'read_file', { fileId })]);
        const delivered = JSON.parse(request.input.at(-1).output);
        assert.equal(delivered.error.code, 'BENCHMARK_RESULT_LIMIT');
        assert(!JSON.stringify(delivered).includes(file.content));
        return select(evidence);
    };
    const empty = await collectEvidence({ ...options, executeTool, ask: ask([]) });
    assert.equal(empty.retrieved.length, 1);
    assert.deepEqual(empty.delivered, []);
    assert.deepEqual(empty.selected, []);
    await assert.rejects(collectEvidence({ ...options, executeTool, ask: ask([{ fileId, start: 0, end: file.content.length }]) }),
        /Selected evidence was not delivered/);
});

test('the collector preserves opaque Responses state and rejects incomplete responses or duplicate tool calls', async () => {
    const { options } = fixture();
    const executeTool = async () => ({ ok: true, value: { hits: [], reranked: false } });
    const reasoning = { type: 'reasoning', id: 'r1', encrypted_content: 'test-state' };
    const first = response([reasoning, call('search-1', 'search_files', { query: 'key' })]);
    await assert.rejects(collectEvidence({ ...options, executeTool, ask: async () => ({ status: 'incomplete' }) }), /incomplete/);
    await assert.rejects(collectEvidence({ ...options, executeTool, ask: async (request, round) => {
        if (round) assert.deepEqual(request.input[2], reasoning);
        return first;
    } }), /Invalid tool call ID/);
});

test('file tool input validation stays local and forwards cancellation to the SDK', async () => {
    const controller = new AbortController();
    const drive = { search: async (request, { signal }) => {
        assert.deepEqual(request, { query: 'key', limit: 1, rerank: true });
        assert.equal(signal, controller.signal);
        return { hits: [], reranked: false };
    } };
    assert.equal((await runTool(drive, 'search_files', { query: 'key', limit: 51 }, config)).ok, false);
    assert.equal((await runTool(drive, 'delete_file', { fileId }, config)).ok, false);
    assert.equal((await runTool(drive, 'search_files', { query: 'key', limit: 1 }, config, controller.signal)).ok, true);
});

test('budgets reject before dispatch and leave receipt counters consistent', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'memdrive-lme-budget-'));
    try {
        const q = state(), limited = { ...config, limits: { ...config.limits, modelTokensPerQuestion: 1, databaseOperationsPerQuestion: 0 } };
        const journal = new Journal({ root, config: limited, binding: 'test', credentials: keys, state: q, save: async () => {},
            fetcher: async () => { throw new Error('Unexpected dispatch'); } });
        await assert.rejects(journal.model('answer', { ...config.model, messages: [] }, 'answer.json'), /budget/);
        await assert.rejects(journal.native().collection('mdflme_' + 'a'.repeat(24)).get(), /budget|operation/i);
        assert.equal(q.receiptNumber, 0); assert.equal(q.databaseOperations, 0); assert.equal(q.modelTokens, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('model mismatch retains known usage and interrupted requests are never retried', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'memdrive-lme-model-'));
    try {
        const q = state(); let calls = 0;
        const journal = new Journal({ root, config, binding: 'test', credentials: keys, state: q, save: async () => {},
            fetcher: async () => { calls++; return new Response(JSON.stringify({ model: 'wrong', usage: { prompt_tokens: 20, completion_tokens: 4 } }), { status: 200 }); } });
        await assert.rejects(journal.model('answer', { ...config.model, messages: [] }, 'answer.json'), /identity/);
        assert.equal(q.modelTokens, 24); assert.equal(q.models.answer.inputTokens, 20);
        const receipt = { kind: 'collector', method: 'POST', url: config.modelEndpoint, body: {} };
        const file = path.join(root, 'pending.json');
        const { atomic } = await import('../benchmark/longmemeval/runtime.mjs');
        await atomic(file, { binding: 'test', requestHash: jsonHash(receipt), request: receipt, status: 'pending' });
        await assert.rejects(journal.request({ file, url: config.modelEndpoint, body: {}, key: keys.modelKey, kind: 'collector' }), /interrupted/);
        assert.equal(calls, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('Responses journal reserves output budget and records native usage before incomplete handling', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'memdrive-lme-responses-'));
    try {
        const q = state(); let requests = 0;
        const request = { model: config.model.model, max_output_tokens: 4096, input: [], reasoning: { effort: 'low' } };
        const fetcher = async (url, options) => {
            requests++; assert.equal(url, config.collectorEndpoint); assert.deepEqual(JSON.parse(options.body), request);
            return new Response(JSON.stringify({ model: config.model.model, status: 'incomplete', output: [],
                usage: { input_tokens: 20, output_tokens: 12, output_tokens_details: { reasoning_tokens: 8 } } }), { status: 200 });
        };
        const journal = new Journal({ root, config, binding: 'test', credentials: keys, state: q, save: async () => {}, fetcher });
        assert.equal((await journal.model('collector', request, 'collector-0.json')).status, 'incomplete');
        assert.equal(q.modelTokens, 32); assert.equal(q.models.collector.outputTokens, 12); assert.equal(q.models.collector.unknownUsageCalls, 0);
        journal.config = { ...config, limits: { ...config.limits, modelTokensPerQuestion: 32 } };
        await assert.rejects(journal.model('collector', request, 'collector-1.json'), /budget/);
        assert.equal(requests, 1); assert.equal(q.models.collector.calls, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
});


test('aborted attempts record nondispatched receipts without counter gaps', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'memdrive-lme-abort-'));
    try {
        const q = state(), controller = new AbortController(); controller.abort();
        let dispatched = 0;
        const journal = new Journal({ root, config, binding: 'test', credentials: keys, state: q, save: async () => {}, signal: controller.signal,
            fetcher: async () => { dispatched++; throw new Error('Unexpected dispatch'); } });
        await assert.rejects(journal.model('answer', { ...config.model, messages: [] }, 'answer.json'));
        await assert.rejects(journal.native().collection('mdflme_' + 'a'.repeat(24)).get());
        assert.equal(dispatched, 0); assert.equal(q.models.answer.calls, 1);
        assert.equal(q.receiptNumber, q.databaseOperations);
        assert.equal((await readJSON(path.join(root, 'answer.json'))).status, 'aborted');
        assert.equal((await readJSON(path.join(root, 'database/1.json'))).status, 'aborted');
        journal.signal = undefined;
        await assert.rejects(journal.model('collector', { max_output_tokens: 1 }, 'collector-0.json', controller.signal));
        assert.equal(dispatched, 0);
        assert.equal((await readJSON(path.join(root, 'collector-0.json'))).status, 'aborted');
    } finally { await rm(root, { recursive: true, force: true }); }
});
