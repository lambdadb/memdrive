import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { nativeFixture, row, keys } from './helpers/longmemeval-http.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { create } from '@functional-systems/memdrive';
import { createTools } from '@functional-systems/memdrive/tools';
import { memdriveClient } from './helpers/memdrive-client.mjs';
import { prepareCase, timestamp, metadataSchema, packEvidence, evidenceMetrics, validateSpan, jsonHash } from '../benchmark/longmemeval/protocol.mjs';
import { collectEvidence, canonicalToolDefinitions } from '../benchmark/longmemeval/agent.mjs';
import { Journal, ingest, reuse, cleanup, readJSON } from '../benchmark/longmemeval/runtime.mjs';
const config = JSON.parse(await readFile(new URL('../benchmark/longmemeval/config.json', import.meta.url)));

const textCount = text => text.length;
async function toolsFor(prepared) {
    const fixture = memdriveClient(); fixture.search = (_request, docs) => docs;
    const drive = await create({ client: fixture.client, name: 'benchmark_test', metadataSchema, textSearch: { analyzers: ['english'] } });
    await drive.remember({ mems: prepared.mems });
    return createTools({ drive });
}
const response = (content, calls) => ({ choices: [{ finish_reason: calls ? 'tool_calls' : 'stop',
    message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) } }] });
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('tool schema comparison ignores only enum ordering and retains actual schema changes', () => {
    const definitions = [{ name: 'test', inputSchema: { enum: ['b', 'a'], oneOf: [{ const: 2 }, { const: 1 }] }, outputSchema: {} }];
    const reordered = structuredClone(definitions); reordered[0].inputSchema.enum.reverse();
    assert.deepEqual(canonicalToolDefinitions(reordered), canonicalToolDefinitions(definitions));
    reordered[0].inputSchema.enum.push('c');
    assert.throws(() => assert.deepEqual(canonicalToolDefinitions(reordered), canonicalToolDefinitions(definitions)));
    const alternatives = structuredClone(definitions); alternatives[0].inputSchema.oneOf.reverse();
    assert.throws(() => assert.deepEqual(canonicalToolDefinitions(alternatives), canonicalToolDefinitions(definitions)));
    assert.deepEqual(definitions[0].inputSchema.enum, ['b', 'a']);
});

test('source adaptation keeps literal text, pairs and dates while excluding answer annotations', () => {
    const input = row(), prepared = prepareCase(input, config);
    assert.equal(prepared.boundary, 2); assert.equal(prepared.mems[0].content, input.haystack_sessions[0][0].content);
    assert.equal(prepared.mems[0].timestamp, '2023-01-02T10:00:00.000Z');
    input.answer = 'secret-reference'; input.answer_session_ids = ['hidden']; input.haystack_sessions[0][0].has_answer = false;
    assert.deepEqual(prepareCase(input, config), prepared);
    assert.throws(() => timestamp('2023/02/29 (Wed) 10:00'));
    assert.throws(() => timestamp('2024/02/29 (Thu) 24:00'));
    assert.equal(timestamp('2024/02/29 (Thu) 23:00'), '2024-02-29T23:00:00.000Z');
});

test('public tools collect only delivered source spans and pack them within a common budget', async () => {
    const prepared = prepareCase(row(), config), tools = await toolsFor(prepared);
    const original = prepared.mems[0];
    let round = 0;
    const collected = await collectEvidence({ mode: 'agentic', tools, prepared, config, countTokens: textCount,
        ask: async request => {
            assert(request.tools.every(tool => !tool.function.name.includes('remember')));
            if (round++ === 0) return response(null, [call('r', 'memdrive_recall', { requests: [{ query: 'key' }] })]);
            if (round === 2) return response(null, [call('read', 'memdrive_read', { ids: [original.id] })]);
            return response(JSON.stringify({ evidence: [{ memId: original.id }] }));
        } });
    assert.equal(collected.selected.length, 1); assert.equal(collected.rounds, 3);
    const packed = packEvidence(prepared, collected.selected, config, textCount);
    assert(packed.memoryTokens <= 4096); assert.equal(packed.spans[0].content, original.content);
    const metrics = evidenceMetrics(row(), prepared, { packed: packed.spans });
    assert.equal(metrics.stages.packed.archived.fullTurnRecall, 1);
    const small = { ...config, retrieval: { ...config.retrieval, memoryTokens: 10 } };
    assert.equal(packEvidence(prepared, collected.selected, small, textCount).spans.length, 0);
    await assert.rejects(collectEvidence({ mode: 'agentic', tools, prepared, config, countTokens: textCount,
        ask: async () => response(JSON.stringify({ evidence: [{ memId: original.id }] })) }), /not delivered/);
});

test('oversized read becomes an explicit undelivered tool error without fabricated evidence', async () => {
    const input = row(); input.haystack_sessions[0][0].content = 'Cedar '.repeat(500);
    const prepared = prepareCase(input, config), tools = await toolsFor(prepared);
    const limited = { ...config, limits: { ...config.limits, toolResultTokens: 1600 } };
    let round = 0;
    const collected = await collectEvidence({ mode: 'agentic', tools, prepared, config: limited, countTokens: textCount,
        ask: async request => {
            if (round++ === 0) return response(null, [call('read', 'memdrive_read', { ids: [prepared.mems[0].id] })]);
            assert.equal(JSON.parse(request.messages.at(-1).content).error.code, 'BENCHMARK_RESULT_LIMIT');
            return response('{"evidence":[]}');
        } });
    assert.equal(collected.retrieved.length, 1); assert.equal(collected.delivered.length, 0);
    assert.equal(collected.selected.length, 0);
});

test('source coverage does not mistake an excerpt for full evidence or missing annotations for zero recall', () => {
    const input = row(), prepared = prepareCase(input, config), mem = prepared.mems[0];
    const partial = { memId: mem.id, start: 0, end: 3, content: mem.content.slice(0, 3), metadata: mem.metadata, timestamp: mem.timestamp };
    const metrics = evidenceMetrics(input, prepared, { retrieved: [partial] });
    assert.equal(metrics.stages.retrieved.archived.anyTurnRecall, 1);
    assert.equal(metrics.stages.retrieved.archived.fullTurnRecall, 0);
    input.haystack_sessions[0][0].has_answer = false;
    assert.equal(evidenceMetrics(input, prepared, { retrieved: [] }).stages.retrieved.archived.anyTurnRecall, null);
    input.question_id += '_abs'; assert.equal(evidenceMetrics(input, prepared, {}).applicable, false);
    assert.throws(() => validateSpan({ ...partial, content: 'forged' }, prepared), /differs/);
    assert.throws(() => validateSpan({ ...partial, start: 4, end: 5, content: mem.content.slice(4, 5) }, prepared), /Unicode/);
});



const state = () => ({ databaseOperations: 0, cleanupOperations: 0, receiptNumber: 0, modelTokens: 0, models: {} });

test('native SDK ingestion/readback/tool execution and owned cleanup record replayable HTTP receipts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'memdrive-lme-'));
    try {
        const wire = nativeFixture(), q = state(), prepared = prepareCase(row(), config);
        const entry = { collection: 'mdlme_' + 'a'.repeat(24), owner: 'b'.repeat(64), scope: 'c'.repeat(64), absent: false };
        const journal = new Journal({ root, config, binding: 'test', credentials: keys, state: q, save: async () => {}, fetcher: wire.fetcher });
        const tools = await ingest(journal, prepared, entry);
        const result = await collectEvidence({ mode: 'single_pass', tools, prepared, config, countTokens: textCount });
        assert.equal(result.selected.length, 2);
        const beforeReuse = wire.requests.length;
        const reused = await collectEvidence({ mode: 'single_pass', tools: await reuse(journal, prepared, entry), prepared, config, countTokens: textCount });
        assert.deepEqual(reused.selected, result.selected);
        assert(wire.requests.slice(beforeReuse).every(request => request.method !== 'DELETE'
            && !request.pathname.endsWith('/collections') && !request.pathname.endsWith('/docs/upsert')));
        await cleanup(journal, entry); assert(entry.absent); assert.equal(wire.collection, undefined);
        const replayState = state();
        const replay = new Journal({ root, config, binding: 'test', credentials: keys, state: replayState, save: async () => {}, replay: true,
            fetcher: async () => { throw new Error('Network forbidden'); } });
        const replayTools = await ingest(replay, prepared, entry);
        const repeated = await collectEvidence({ mode: 'single_pass', tools: replayTools, prepared, config, countTokens: textCount });
        assert.deepEqual(repeated.selected, result.selected);
        const replayedReuse = await collectEvidence({ mode: 'single_pass', tools: await reuse(replay, prepared, entry), prepared, config, countTokens: textCount });
        assert.deepEqual(replayedReuse.selected, reused.selected);
        await cleanup(replay, { ...entry, absent: false });
        assert.equal(q.receiptNumber, replayState.receiptNumber);
        for (let i = 1; i <= q.receiptNumber; i++) assert(!JSON.stringify(await readJSON(path.join(root, `database/${i}.json`))).includes(keys.databaseKey));
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('ingestion batches originals and stops without retrying an uncertain batch', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'memdrive-lme-batches-'));
    try {
        const original = prepareCase(row(), config).mems[0];
        const prepared = { mems: Array.from({ length: 41 }, (_, index) => ({ ...original, id: 'original-' + index })) };
        const entry = { collection: 'mdlme_' + 'a'.repeat(24), owner: 'b'.repeat(64), scope: 'c'.repeat(64), absent: false };
        for (const fail of [false, true]) {
            const wire = nativeFixture(), q = state(); let attempts = 0;
            const journal = new Journal({ root: path.join(root, String(fail)), config, binding: 'test', credentials: keys, state: q,
                save: async () => {}, fetcher: async (url, options) => {
                    if (url.endsWith('/docs/upsert') && ++attempts === 2 && fail) throw new Error('Uncertain batch');
                    return wire.fetcher(url, options);
                } });
            if (fail) await assert.rejects(ingest(journal, prepared, entry), /write failed/);
            else await ingest(journal, prepared, entry);
            assert.equal(attempts, fail ? 2 : 3);
            const writes = wire.requests.filter(request => request.pathname.endsWith('/docs/upsert'));
            const originals = writes.map(request => request.body.docs.filter(doc => doc.kind === 'mem'));
            assert.deepEqual(originals.map(batch => batch.length), fail ? [20] : [20, 20, 1]);
            assert.deepEqual(originals.flat().map(doc => doc.memId), prepared.mems.slice(0, fail ? 20 : 41).map(mem => mem.id));
            assert.equal(wire.collections.size, 1); assert(!wire.requests.some(request => request.method === 'DELETE'));
            if (fail) assert.equal((await readJSON(path.join(journal.root, 'database', q.receiptNumber + '.json'))).status, 'uncertain');
        }
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('budgets reject before dispatch and leave receipt counters consistent', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'memdrive-lme-budget-'));
    try {
        const q = state(), limited = { ...config, limits: { ...config.limits, modelTokensPerQuestion: 1, databaseOperationsPerQuestion: 0 } };
        const journal = new Journal({ root, config: limited, binding: 'test', credentials: keys, state: q, save: async () => {},
            fetcher: async () => { throw new Error('Unexpected dispatch'); } });
        await assert.rejects(journal.model('answer', { ...config.model, messages: [] }, 'answer.json'), /budget/);
        await assert.rejects(journal.native().collection('mdlme_' + 'a'.repeat(24)).get(), /budget|operation/i);
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


test('aborted attempts record nondispatched receipts without counter gaps', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'memdrive-lme-abort-'));
    try {
        const q = state(), controller = new AbortController(); controller.abort();
        let dispatched = 0;
        const journal = new Journal({ root, config, binding: 'test', credentials: keys, state: q, save: async () => {}, signal: controller.signal,
            fetcher: async () => { dispatched++; throw new Error('Unexpected dispatch'); } });
        await assert.rejects(journal.model('answer', { ...config.model, messages: [] }, 'answer.json'));
        await assert.rejects(journal.native().collection('mdlme_' + 'a'.repeat(24)).get());
        assert.equal(dispatched, 0); assert.equal(q.models.answer.calls, 1);
        assert.equal(q.receiptNumber, q.databaseOperations);
        assert.equal((await readJSON(path.join(root, 'answer.json'))).status, 'aborted');
        assert.equal((await readJSON(path.join(root, 'database/1.json'))).status, 'aborted');
    } finally { await rm(root, { recursive: true, force: true }); }
});
