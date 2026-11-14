import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { create, open } from '@functional-systems/memdrive';
import { createRetriever } from '@functional-systems/memdrive/retriever';
import { memdriveClient } from './helpers/memdrive-client.mjs';
const usage = { inputTokens: 100, outputTokens: 10 };
const call = (id, name, args) => ({ id, name, arguments: args });
const search = (id = 'search', requests = [{ query: 'evidence' }]) => ({ calls: [call(id, 'memdrive_recall', { requests })] });
const selected = (...evidenceIds) => ({ evidenceIds });
const setup = async () => {
    const fixture = memdriveClient();
    const drive = await create({ client: fixture.client, name: 'retriever_test', metadataSchema: {
        role: { type: 'string' }, tags: { type: 'string[]' }, score: { type: 'number' },
    } });
    await drive.remember({ mems: [{ id: 'original', content: 'cedar', timestamp: '2025-01-01T00:00:00Z', metadata: { role: 'user', tags: ['keep'], score: 2 } }] });
    fixture.search = (_request, docs) => docs;
    return { fixture, drive };
};
function scripted(steps, overrides = {}) {
    let calls = 0; const inputs = [], replies = [];
    return { get calls() { return calls; }, inputs, replies,
        createSession(input) {
            inputs.push(input); let round = 0;
            return { prepare(next) { replies.push(next); return { inputTokens: overrides.estimate ?? 100,
                respond: async options => { calls++; const step = steps[round++];
                    return { status: 'completed', usage, ...(typeof step === 'function' ? await step(next, options) : step) }; },
            }; } };
        },
    };
}
const agentOptions = (model, extra = {}) => ({ model, countTokens: text => text.length, ...extra });

test('retriever defaults to one data recall and its portable tool calls the same path', async () => {
    const { drive, fixture } = await setup(); const model = scripted([]);
    const retriever = await createRetriever({ drive, agent: agentOptions(model) });
    const direct = await retriever.recall({ query: 'cedar' });
    const tool = await retriever.tools.execute('memdrive_recall', { query: 'cedar' });
    assert.equal(direct.completion.status, 'completed'); assert.deepEqual(direct.matches, tool.value.matches);
    assert.equal(model.calls, 0); assert.equal(fixture.calls.filter(c => c.kind === 'query').length, 2);
    const schema = retriever.tools.definitions[0]; const ajv = new Ajv2020({ strict: false });
    assert(ajv.compile(schema.inputSchema)({ query: 'cedar' }));
    assert.equal(ajv.compile(schema.inputSchema)({ requests: [{ query: 'cedar' }] }), false);
    assert(ajv.compile(schema.outputSchema)(tool));
    assert.equal((await retriever.tools.execute('memdrive_recall', { query: '' })).error.code, 'INVALID_INPUT');
});

test('agent selects only delivered canonical evidence and retains invalid batch siblings', async () => {
    const { drive, fixture } = await setup();
    const model = scripted([search('batch', [{ query: 'first' }, { query: '' }, { query: 'last' }]), replies => {
        const result = replies[0].result;
        assert.deepEqual(result.value.results.map(x => x.error?.code ?? x.matches[0].evidenceId), ['e1', 'INVALID_INPUT', 'e1']);
        return selected('e1');
    }]);
    const retriever = await createRetriever({ drive, strategy: 'agentic', agent: agentOptions(model) });
    const result = await retriever.recall({ query: 'where?' });
    assert.equal(result.completion.status, 'completed'); assert.equal(result.matches[0].memId, 'original');
    assert.equal(result.usage.modelCalls, 2); assert.equal(result.usage.dataCalls, 3);
    assert.equal(result.usage.databaseRequests, 2); assert.equal(result.usage.inputTokens, 200);
    assert.equal(fixture.calls.filter(c => c.kind === 'query').length, 2);
    assert(model.inputs[0].tools.every(tool => tool.annotations.readOnlyHint));
});

test('fixed caller scope applies to search, counts, originals and pages with SDK filter semantics', async () => {
    const { drive, fixture } = await setup();
    await drive.remember({ mems: [
        { id: 'excluded', content: 'excluded text', timestamp: '2025-01-01T00:00:00Z', metadata: { role: 'user', tags: ['keep'], score: 2 } },
        { id: 'blocked', content: 'blocked text', timestamp: '2025-01-01T00:00:00Z', metadata: { role: 'user', tags: ['blocked'], score: 2 } },
        { id: 'assistant', content: 'assistant text', timestamp: '2025-01-01T00:00:00Z', metadata: { role: 'assistant', tags: ['keep'], score: 2 } },
    ] });
    fixture.search = (request, docs) => request.facets ? { docs: [], facets: { 'metadata.role': { buckets: [{ value: 'user', count: 1 }] } } }
        : docs.filter(doc => doc.memId === 'original');
    const model = scripted([
        { calls: [call('list', 'memdrive_list', { limit: 100 })] },
        replies => { assert.deepEqual(replies[0].result.value.mems.map(m => m.content), ['cedar']); return { calls: [call('read', 'memdrive_read', { ids: ['m1'] }), call('counts', 'memdrive_count_values', { fields: ['metadata.role'] })] }; },
        replies => { assert.equal(replies[0].result.value.mems[0].evidenceId, 'e1'); return search('narrow', [{ query: 'q', filter: { field: 'metadata.tags', op: 'in', value: ['keep'] } }]); },
        selected('e1'),
    ]);
    const retriever = await createRetriever({ drive, strategy: 'agentic', agent: agentOptions(model) });
    const result = await retriever.recall({ query: 'q', excludeIds: ['excluded'], filter: { and: [
        { field: 'metadata.role', op: 'eq', value: 'user' }, { field: 'metadata.tags', op: 'neq', value: 'blocked' },
        { field: 'timestamp', op: 'gte', value: '2024-12-31T19:00:00-05:00' }, { field: 'metadata.score', op: 'gt', value: 1 },
        { field: 'metadata.tags', op: 'exists', value: true },
    ] } });
    assert.equal(result.completion.status, 'completed'); assert.equal(result.matches[0].content, 'cedar');
    assert.equal(result.usage.databaseRequests, null); assert.equal(result.usage.knownRecallDatabaseRequests, 1);
    assert.equal(result.usage.dataCalls, 4);
    for (const request of fixture.calls.filter(c => c.kind === 'query').map(c => JSON.stringify(c.request))) {
        assert(request.includes('excluded')); assert(request.includes('metadata.role')); assert(request.includes('blocked'));
    }
    assert(model.replies.every(replies => !JSON.stringify(replies).includes('excluded text') && !JSON.stringify(replies).includes('blocked text')));
    const before = model.calls;
    await assert.rejects(retriever.recall({ query: 'q', filter: { field: 'undeclared', op: 'eq', value: 1 } }), { code: 'INVALID_INPUT' });
    assert.equal(model.calls, before);
});

test('agent limits stop explicitly without raw-candidate fallback or paid retry', async () => {
    for (const [limits, steps, expected, calls] of [
        [{ rounds: 1 }, [search()], 'rounds', 1],
        [{ dataCalls: 1 }, [search('batch', [{ query: 'q' }, { query: 'q2' }])], 'data_calls', 1],
        [{ toolCalls: 1 }, [{ calls: [call('one', 'memdrive_list', {}), call('two', 'memdrive_list', {})] }], 'tool_calls', 1],
        [{ contextTokens: 100 }, [selected()], 'context_tokens', 0],
        [{ modelTokens: 100 }, [selected()], 'model_tokens', 0],
        [{ maxOutputTokens: 5 }, [selected()], 'output_tokens', 1],
    ]) {
        const { drive } = await setup(), model = scripted(steps);
        const result = await (await createRetriever({ drive, strategy: 'agentic', agent: agentOptions(model, { limits }) })).recall({ query: 'q' });
        assert.equal(result.completion.status, 'budget_exhausted'); assert.equal(result.completion.reason, expected);
        assert.deepEqual(result.matches, []); assert.equal(model.calls, calls);
    }
});

test('invalid, unknown, undelivered and oversized final selections fail without inventing evidence', async () => {
    for (const [steps, limits, request] of [
        [[selected('e99')], {}, { query: 'q' }],
        [[search(), selected('e1')], { toolResultTokens: 1 }, { query: 'q' }],
        [[{ ...selected(), calls: [] }], {}, { query: 'q' }],
        [[{ status: 'incomplete', ...selected() }], {}, { query: 'q' }],
        [[{ ...selected(), usage: {} }], {}, { query: 'q' }],
    ]) {
        const { drive } = await setup(), model = scripted(steps);
        const result = await (await createRetriever({ drive, strategy: 'agentic', agent: agentOptions(model, { limits }) })).recall(request);
        assert.equal(result.completion.status, 'failed'); assert.deepEqual(result.matches, []);
    }
    const invalidModel = scripted([selected()]), invalidDrive = (await setup()).drive;
    const invalidRetriever = await createRetriever({ drive: invalidDrive, strategy: 'agentic', agent: agentOptions(invalidModel) });
    await assert.rejects(invalidRetriever.recall({ query: 'q', context: 'x'.repeat(8192) }), { code: 'INVALID_INPUT' });
    assert.equal(invalidModel.calls, 0);
    const { drive } = await setup(); await drive.remember({ mems: [{ id: 'other', content: 'other' }] });
    const model = scripted([search(), selected('e1', 'e2')]);
    const result = await (await createRetriever({ drive, strategy: 'agentic', agent: agentOptions(model) })).recall({ query: 'q', limit: 1 });
    assert.equal(result.completion.status, 'failed'); assert.deepEqual(result.matches, []);
});

test('abort and timeout bound model/hook waits, keep unknown usage and do not retry', async () => {
    const { drive } = await setup(), controller = new AbortController();
    const model = scripted([async (_replies, { signal }) => { controller.abort(); assert(signal.aborted); return new Promise(() => {}); }]);
    const retriever = await createRetriever({ drive, strategy: 'agentic', agent: agentOptions(model) });
    const aborted = await retriever.recall({ query: 'q' }, { signal: controller.signal });
    assert.equal(aborted.completion.status, 'aborted'); assert.equal(aborted.usage.unknownUsageCalls, 1); assert.equal(model.calls, 1);
    const hookModel = scripted([selected()]);
    const blocked = await createRetriever({ drive, strategy: 'agentic', agent: agentOptions(hookModel, { limits: { timeoutMs: 5 } }), record: () => new Promise(() => {}) });
    const timeout = await blocked.recall({ query: 'q' });
    assert.equal(timeout.completion.status, 'budget_exhausted'); assert.equal(timeout.completion.reason, 'timeout'); assert.equal(hookModel.calls, 0);
});

test('agent configuration is snapshotted and external-vector agentic mode rejects explicitly', async () => {
    const { drive } = await setup(); const model = scripted([selected()]);
    const agent = agentOptions(model, { instructions: 'original', limits: { rounds: 1 } });
    const retriever = await createRetriever({ drive, strategy: 'agentic', agent });
    agent.instructions = 'changed'; agent.limits.rounds = 99; agent.countTokens = () => { throw new Error('mutated'); };
    assert.equal((await retriever.recall({ query: 'q' })).completion.status, 'completed'); assert.equal(model.inputs[0].instructions, 'original');
    const fixture = memdriveClient();
    const vector = await create({ client: fixture.client, name: 'vectors', metadataSchema: {}, embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'test' } });
    await assert.rejects(createRetriever({ drive: vector, strategy: 'agentic', agent: agentOptions(model) }), { code: 'INVALID_INPUT' });
});

test('in-flight tool cancellation has unknown native total and bound branch cannot be changed', async () => {
    const { drive, fixture } = await setup();
    await drive.branches.create({ name: 'alternate' });
    const branch = await open({ client: fixture.client, name: 'retriever_test', branch: 'alternate' });
    await branch.remember({ mems: [{ id: 'original', content: 'branch evidence' }] });
    const model = scripted([search(), selected('e1')]);
    const retriever = await createRetriever({ drive: branch, strategy: 'agentic', agent: agentOptions(model) });
    const result = await retriever.recall({ query: 'q' });
    assert.equal(result.matches[0].content, 'branch evidence');
    const controller = new AbortController();
    fixture.search = async () => { controller.abort(); return new Promise(() => {}); };
    const cancelled = await (await createRetriever({ drive: branch, strategy: 'agentic', agent: agentOptions(scripted([search()])) }))
        .recall({ query: 'q' }, { signal: controller.signal });
    assert.equal(cancelled.completion.status, 'aborted'); assert.equal(cancelled.usage.databaseRequests, null);
    assert.equal(cancelled.usage.dataCalls, 1); assert.deepEqual(cancelled.matches, []);
});

test('model adapter cannot mutate caller scope or final selection limit', async () => {
    const { drive } = await setup();
    await drive.remember({ mems: [{ id: 'second', content: 'second', metadata: { role: 'user' } },
        { id: 'excluded', content: 'excluded', metadata: { role: 'user' } }, { id: 'outside', content: 'outside', metadata: { role: 'assistant' } }] });
    const script = scripted([{ calls: [call('list', 'memdrive_list', {})] }, replies => {
        assert.deepEqual(replies[0].result.value.mems.map(mem => mem.content), ['cedar', 'second']);
        return selected('e1', 'e2');
    }]);
    const model = { createSession(input) {
        input.request.filter = undefined; input.request.excludeIds.length = 0; input.request.limit = 100;
        return script.createSession(input);
    } };
    const retriever = await createRetriever({ drive, strategy: 'agentic', agent: agentOptions(model) });
    const request = { query: 'q', filter: { field: 'metadata.role', op: 'eq', value: 'user' }, excludeIds: ['excluded'], limit: 1 };
    const result = await retriever.recall(request);
    assert.equal(result.completion.status, 'failed'); assert.deepEqual(result.matches, []);
    assert.equal(request.limit, 1); assert.deepEqual(request.excludeIds, ['excluded']);
    await assert.rejects(createRetriever({ drive, strategy: 'agentic', agent: agentOptions({ createSession: 1 }) }), { code: 'INVALID_INPUT' });
});
