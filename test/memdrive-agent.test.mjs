import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, agentTools } from '../dist/esm/agent.js';
import { createInspector } from '../dist/esm/inspector.js';
import { MemDriveError } from '../dist/esm/errors.js';

const schema = { role: { type: 'string' }, tags: { type: 'string[]' }, score: { type: 'number' } };
const mem = (id, content = id) => ({ id, kind: 'chunk', memId: id, content, start: 0, end: content.length, metadata: { role: 'user', tags: ['tennis'], score: 1 } });
const native = mems => ({ docs: mems.map(doc => ({ doc })) });
const response = (step, calls) => ({ status: 'completed', output: calls.map(([name, args], i) => ({
    type: 'function_call', call_id: `call-${step}-${i}`, name, arguments: JSON.stringify(args),
})) });
function fixture(overrides = {}) {
    const events = [], records = [], requests = [];
    const args = {
        request: { query: 'Which mems help?', recentDialogue: [{ role: 'user', content: 'Earlier context.' }], context: 'A profile.' },
        agent: { model: { name: 'test-model', provider: 'test', checkContext: () => true,
            respond: async request => { requests.push(request); return response(0, [['report_helpful_ids', { ids: [] }]]); } } },
        limit: 3, keywordSearch: true, metadataSchema: schema, query: async () => native([]),
        inspector: { getSchema: async () => ({}), countValues: async () => ({}) },
        observe: event => events.push(event), record: event => records.push(event),
        ...overrides,
    };
    return { args, events, records, requests };
}

test('parallel searches deduplicate bodies in call order and later exclude all shown IDs', async () => {
    const { args, events, records } = fixture();
    const bodies = [], modelRequests = [];
    const a = mem('a'), b = mem('b'), c = mem('c');
    args.request.filter = { field: 'metadata.role', op: 'eq', value: 'user' };
    args.request.excludeIds = ['never'];
    let queries = 0, steps = 0;
    args.query = async body => {
        bodies.push(body);
        switch (queries++) {
            case 0: await Promise.resolve(); return native([a, b]);
            // Object key order cannot create a false conflicting-version error.
            case 1: return native([{ metadata: { score: 1, tags: ['tennis'], role: 'user' }, end: 1, start: 0, content: 'b', kind: 'chunk', memId: 'b', id: 'b' }]);
            default: return native([c]);
        }
    };
    args.agent.instructions = 'Use source evidence.';
    args.agent.model.reasoning = { effort: 'medium' };
    args.agent.model.respond = async request => {
        modelRequests.push(request);
        const step = steps++;
        if (step === 0) return response(step, [
            ['search_keyword', { keywords: ['first', 'second'], filter: { field: 'metadata.tags', op: 'eq', value: 'tennis' } }],
            ['search_semantic', { query: 'relevant meaning' }],
        ]);
        if (step === 1) {
            const outputs = request.input.filter(item => item.type === 'function_call_output').map(item => JSON.parse(item.output));
            assert.deepEqual(outputs.map(output => output.matches), [['e1', 'e2'], ['e2']]);
            assert.deepEqual(outputs.map(output => output.new_evidence.length), [2, 0]);
            return response(step, [['search_semantic', { query: 'another fact' }]]);
        }
        return response(step, [['report_helpful_ids', { ids: ['e2', 'e3'] }]]);
    };
    const result = await runAgent(args);
    assert.deepEqual(result, [b, c]);
    assert.deepEqual(events.map(({ matches: _matches, ...event }) => event), [
        { type: 'retrieved', ids: ['a', 'b'] }, { type: 'retrieved', ids: [] }, { type: 'retrieved', ids: ['c'] },
        { type: 'selected', ids: ['b', 'c'], completion: 'voluntary' },
    ]);
    assert(bodies.every(body => {
        const encoded = JSON.stringify(body);
        return encoded.includes('metadata.role') && !encoded.includes('"defaultField":"kind"');
    }));
    const last = JSON.stringify(bodies.at(-1));
    for (const id of ['never', 'a', 'b']) assert(last.includes(`\\"${id}\\"`));
    assert(modelRequests.every(request => request.instructions === 'Use source evidence.' && !Object.hasOwn(request, 'max_output_tokens')));
    assert.deepEqual(modelRequests[0].reasoning, { effort: 'medium' });
    const input = JSON.parse(modelRequests[0].input[0].content);
    assert.equal(input.context, 'A profile.');
    assert.deepEqual(input.recent_dialogue, args.request.recentDialogue);
    assert.equal(records.filter(event => event.phase === 'query').length, 3);
    assert.equal(records.at(-1).phase, 'selection');
    assert.equal(new Set(agentTools(3, true).map(tool => tool.name)).size, 6);
    assert(!JSON.stringify(agentTools(3, true)).includes('read_source'));
    const keyword = agentTools(3, true)[0];
    assert(keyword.parameters.$defs.filter);
});

test('the forced report has only its tool and may return previously shown mems', async () => {
    const { args, events } = fixture();
    args.agent.maxSteps = 1;
    args.query = async () => native([mem('a')]);
    let step = 0;
    args.agent.model.respond = async request => {
        assert(!Object.hasOwn(request, 'instructions'));
        if (step++ === 0) return response(0, [['search_semantic', { query: 'fact' }]]);
        assert.deepEqual(request.tools.map(tool => tool.name), ['report_helpful_ids']);
        assert.deepEqual(request.tool_choice, { type: 'function', name: 'report_helpful_ids' });
        return response(1, [['report_helpful_ids', { ids: ['e1'] }]]);
    };
    assert.deepEqual(await runAgent(args), [mem('a')]);
    assert.equal(events.at(-1).completion, 'forced');
});

test('schema discovery refreshes fields used by later searches and count filters', async () => {
    let current = {};
    const refreshed = { topic: { type: 'string' } };
    const nativeSchema = { memId: { type: 'keyword' }, content: { type: 'text' }, embedding: { type: 'vector' }, timestamp: { type: 'datetime' },
        metadata: { type: 'object', objectIndexConfigs: { topic: { type: 'keyword' } } } };
    const inspector = createInspector({ metadataSchema: () => current,
        describe: async () => { current = refreshed; return { collection: { indexConfigs: nativeSchema } }; },
        query: async () => ({ facets: { 'metadata.topic': { buckets: [{ value: 'health', count: 1 }] } } }),
    });
    const filter = { field: 'metadata.topic', op: 'eq', value: 'health' };
    // A count request can itself trigger the first native schema refresh.
    const counted = await inspector.countValues({ fields: ['metadata.topic'], filter });
    assert.equal(counted.values['metadata.topic'].buckets[0].count, 1);
    current = {}; inspector.invalidate();
    const found = { id: 'new-field-mem', kind: 'chunk', memId: 'new-field-mem', start: 0, end: 14, content: 'A health note.', metadata: { topic: 'health' } };
    const { args } = fixture({ inspector, metadataSchema: () => current, query: async () => native([found]) });
    let step = 0;
    args.agent.model.respond = async request => {
        const currentStep = step++;
        if (currentStep === 0) return response(currentStep, [['get_schema', {}]]);
        if (currentStep === 1) {
            const output = JSON.parse(request.input.at(-1).output);
            assert.equal(output.fields['metadata.topic'].type, 'string');
            return response(currentStep, [['search_semantic', { query: 'health note', filter }]]);
        }
        return response(currentStep, [['report_helpful_ids', { ids: ['e1'] }]]);
    };
    assert.deepEqual(await runAgent(args), [found]);
});

test('invalid tool filters and native query rejection produce bounded corrective feedback', async () => {
    const { args } = fixture();
    let step = 0, queries = 0;
    args.query = async () => {
        queries++;
        throw new MemDriveError('DATABASE_ERROR', 'Search failed.', { cause: { statusCode: 400 } });
    };
    args.agent.model.respond = async request => {
        const current = step++;
        if (current === 0) return response(current, [['search_semantic', { query: 'fact', filter: { field: 'missing', op: 'eq', value: 'x' } }]]);
        const outputs = request.input.filter(item => item.type === 'function_call_output').map(item => JSON.parse(item.output));
        assert(typeof outputs.at(-1).error === 'string');
        if (current === 1) return response(current, [['search_semantic', { query: 'fact' }]]);
        return response(current, [['report_helpful_ids', { ids: [] }]]);
    };
    assert.deepEqual(await runAgent(args), []);
    assert.equal(queries, 1);
});

test('search response validation rejects wrong model filters, duplicates and conflicting overlap', async () => {
    for (const kind of ['wrong-filter', 'duplicates', 'conflict']) {
        const { args } = fixture();
        let queries = 0;
        args.agent.model.respond = async () => response(0, kind === 'conflict'
            ? [['search_semantic', { query: 'one' }], ['search_semantic', { query: 'two' }]]
            : [['search_semantic', { query: 'one', filter: { field: 'metadata.role', op: 'eq', value: 'assistant' } }]]);
        args.query = async () => native(kind === 'duplicates' ? [mem('a'), mem('a')]
            : [mem('a', kind === 'conflict' && queries++ ? 'changed' : 'a')]);
        await assert.rejects(runAgent(args), { code: 'INVALID_RESPONSE' });
    }
});

test('context overflow, invalid forced selection and recording failures stop explicitly', async () => {
    const { args } = fixture();
    let calls = 0;
    args.agent.model.respond = async () => { calls++; return response(0, [['report_helpful_ids', { ids: ['unknown'] }]]); };
    args.agent.model.checkContext = () => false;
    await assert.rejects(runAgent(args), { code: 'MODEL_CONTEXT_LIMIT' });
    assert.equal(calls, 0);
    args.agent.model.checkContext = () => true;
    args.agent.maxSteps = 0;
    await assert.rejects(runAgent(args), { code: 'FINAL_REPORT_FAILED' });
    assert.equal(calls, 1);
    args.record = () => { throw new Error('Cannot record.'); };
    await assert.rejects(runAgent(args), /Cannot record/);
    assert.equal(calls, 1);
});

test('fatal query failures wait for other in-flight operations and never become empty results', async () => {
    const { args } = fixture();
    let release, started;
    const pending = new Promise(resolve => { release = resolve; });
    const running = new Promise(resolve => { started = resolve; });
    let queries = 0, settled = false;
    args.agent.model.respond = async () => response(0, [['search_semantic', { query: 'one' }], ['search_semantic', { query: 'two' }]]);
    args.query = async () => {
        if (queries++ === 0) throw new MemDriveError('DATABASE_ERROR', 'Unavailable.', { cause: { statusCode: 500 } });
        started(); await pending; return native([]);
    };
    const outcome = runAgent(args).finally(() => { settled = true; });
    await running;
    await Promise.resolve();
    assert.equal(settled, false);
    release();
    await assert.rejects(outcome, { code: 'DATABASE_ERROR' });
});

function inspectorFixture() {
    let at = 0, descriptions = 0, counts = 0;
    const queries = [];
    const configs = {
        memId: { type: 'keyword' }, content: { type: 'text' }, embedding: { type: 'vector' }, timestamp: { type: 'datetime' },
        metadata: { type: 'object', objectIndexConfigs: {
            role: { type: 'keyword', description: 'Message role.' }, tags: { type: 'keyword' }, score: { type: 'double' },
        } },
    };
    const inspector = createInspector({ metadataSchema: () => schema, now: () => at,
        schemaTtlMs: 100, valuesTtlMs: 20,
        describe: async () => { descriptions++; return { collection: { indexConfigs: configs, description: 'Conversation memories.',
            tags: { application: 'example', 'memory.format': 'mems-v0' } } }; },
        query: async body => {
            counts++; queries.push(body);
            return { facets: Object.fromEntries(Object.keys(body.facets).map(field => [field, {
                buckets: [{ value: 'tennis', count: 2 }, { value: 'health', count: 1 }],
            }])) };
        },
    });
    return { inspector, queries, counts: () => counts, descriptions: () => descriptions, time: value => { at = value; } };
}

test('inspection caches native descriptions and scoped keyword counts with detached values', async () => {
    const { inspector, queries, counts, descriptions, time } = inspectorFixture();
    let scheduled = 0;
    const schedule = async job => { scheduled++; return job(); };
    const [first, second] = await Promise.all([inspector.getSchema(schedule), inspector.getSchema(schedule)]);
    assert.equal(first.description, 'Conversation memories.');
    assert.deepEqual(first.labels, { application: 'example' });
    first.labels.application = 'Mutated.';
    assert.equal(second.labels.application, 'example');
    first.fields['metadata.role'].description = 'Mutated.';
    assert.equal(second.fields['metadata.role'].description, 'Message role.');
    assert.equal(second.fields['metadata.tags'].type, 'string[]');
    assert.equal(descriptions(), 1);
    const required = { field: 'metadata.role', op: 'eq', value: 'user' };
    const filter = { field: 'metadata.tags', op: 'eq', value: 'tennis' };
    const args = { fields: ['metadata.tags'], filter, limit: 1 };
    const [a, b] = await Promise.all([inspector.countValues(args, required, schedule), inspector.countValues(args, required, schedule)]);
    assert.equal(counts(), 1);
    assert.equal(scheduled, 2);
    assert.equal(a.values['metadata.tags'].has_more, true);
    a.values['metadata.tags'].buckets[0].count = 999;
    assert.equal(b.values['metadata.tags'].buckets[0].count, 2);
    const query = JSON.stringify(queries[0]);
    assert(query.includes('metadata.role') && query.includes('metadata.tags'));
    await inspector.countValues(args, undefined, schedule);
    assert.equal(counts(), 2); // Required filters are part of the cache identity.
    time(21);
    await inspector.countValues(args, required, schedule);
    assert.equal(counts(), 3);
    assert.equal(descriptions(), 1);
    inspector.invalidate();
    await inspector.getSchema(schedule);
    assert.equal(descriptions(), 2);
    await assert.rejects(inspector.countValues({ fields: ['metadata.score'] }), { code: 'INVALID_INPUT' });
});

test('inspection failures are not cached and a native cap is not described as complete', async () => {
    let calls = 0;
    const inspector = createInspector({ metadataSchema: {},
        describe: async () => ({ collection: { indexConfigs: { memId: { type: 'keyword' }, content: { type: 'text' }, embedding: { type: 'vector' }, timestamp: { type: 'datetime' } } } }),
        query: async () => {
            if (calls++ === 0) return {};
            return { facets: { memId: { buckets: Array.from({ length: 100 }, (_, i) => ({ value: String(i), count: 1 })) } } };
        },
    });
    await assert.rejects(inspector.countValues({ fields: ['id'], limit: 100 }), { code: 'INVALID_RESPONSE' });
    const result = await inspector.countValues({ fields: ['id'], limit: 100 });
    assert.equal(calls, 2);
    assert.equal(result.values.id.has_more, null);
});


test('value counts map public IDs to parent IDs and exclude caller Mems from the original-only population', async () => {
    let body;
    const inspector = createInspector({ metadataSchema: {},
        describe: async () => ({ collection: { indexConfigs: { memId: { type: 'keyword' }, content: { type: 'text' },
            embedding: { type: 'vector' }, timestamp: { type: 'datetime' } } } }),
        query: async request => { body = request; return { facets: { memId: { buckets: [{ value: 'included', count: 1 }] } } }; },
    });
    const result = await inspector.countValues({ fields: ['id'] }, undefined, operation => operation(), ['excluded']);
    assert.deepEqual(result.values.id.buckets, [{ value: 'included', count: 1 }]);
    assert.deepEqual(Object.keys(body.facets), ['memId']);
    assert.deepEqual(body.query.bool[1], { queryString: { defaultField: 'kind', query: '"mem"' }, occur: 'filter' });
    assert(JSON.stringify(body.query).includes('excluded'));
    const schema = await inspector.getSchema();
    assert.deepEqual(Object.keys(schema.fields), ['id', 'timestamp']);
});


test('search tools reject the exact match-all expression before database dispatch', async () => {
    const { args } = fixture();
    args.query = async () => assert.fail('Invalid query reached the database.');
    let step = 0;
    args.agent.model.respond = async request => {
        if (step++ === 0) return response(0, [
            ['search_keyword', { keywords: [' \n*:* '] }],
            ['search_semantic', { query: '*:*' }],
        ]);
        const outputs = request.input.filter(item => item.type === 'function_call_output');
        assert.equal(outputs.length, 2);
        for (const output of outputs) assert.match(JSON.parse(output.output).error, /\*:\*/);
        return response(1, [['report_helpful_ids', { ids: [] }]]);
    };
    assert.deepEqual(await runAgent(args), []);
});
