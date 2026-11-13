import test from 'node:test';
import assert from 'node:assert/strict';
import { create, open, contextualQuery } from '../dist/esm/index.js';
import { sourceMatch, publicMatch } from '../dist/esm/storage.js';
import { memdriveClient, modelAdapter, modelResponse } from './helpers/memdrive-client.mjs';

const schema = { tags: { type: 'string[]' }, role: { type: 'string' } };
const mem = { id: 'mem-1', content: 'My wrist needs support.', metadata: { role: 'user', tags: ['tennis', 'health'] } };

test('model usage keeps a string identity when an adapter omits or malforms its model field', async () => {
    const f = memdriveClient();
    let returnedModel;
    const agent = { maxSteps: 0, model: modelAdapter(async () => ({
        ...modelResponse([['report_helpful_ids', { ids: [] }]]), model: returnedModel,
    })) };
    const drive = await create({ client: f.client, name: 'usage_test', mode: 'agentic', metadataSchema: {}, agent });
    for (const [value, expected] of [[undefined, 'synthetic-model'], [123, 'synthetic-model'], ['reported-model', 'reported-model']]) {
        returnedModel = value;
        const result = await drive.recall({ query: 'Any evidence?' });
        assert.deepEqual(result.usage.models, [{ provider: 'synthetic', model: expected, calls: 1,
            inputTokens: null, cachedInputTokens: null, outputTokens: null }]);
    }
});

test('explicit managed embedding matches the omitted default and survives reopen', async () => {
    const configurations = [];
    for (const embedding of [undefined, { mode: 'managed' }]) {
        const f = memdriveClient();
        const drive = await create({ client: f.client, name: 'sdk_test', mode: 'single_pass', metadataSchema: {}, embedding });
        const reopened = await open({ client: f.client, name: 'sdk_test', mode: 'single_pass' });
        assert.deepEqual(reopened.embedding, drive.embedding);
        assert.equal(drive.embedding.mode, 'managed');
        configurations.push(f.calls.find(call => call.kind === 'create').request);
    }
    assert.deepEqual(configurations[0], configurations[1]);
});

test('managed recall applies rerank per batch item for vector and hybrid searches', async () => {
    for (const textSearch of [undefined, { analyzers: ['english'] }]) {
        const f = memdriveClient();
        const drive = await create({ client: f.client, name: 'sdk_test', mode: 'single_pass', metadataSchema: schema, textSearch });
        await drive.remember({ mems: [mem] });
        f.search = (request, docs) => request.rerank ? docs
            : { isDocsInline: true, docs: docs.map(doc => ({ doc, score: 12 })) };
        const requests = [{ query: 'default' }, { query: 'disabled', rerank: false }, { query: 'enabled', rerank: true }];
        const { results } = await drive.at({ branch: 'main' }).recall({ requests });
        const expected = [publicMatch(await sourceMatch(mem))];
        assert.deepEqual(results.map(result => result.matches), requests.map(() => expected));
        const queries = f.calls.filter(call => call.kind === 'query').map(call => call.request);
        assert.equal(queries.length, 3);
        for (const body of queries) {
            const knn = textSearch ? body.query.bayesian[0].knn : body.query.knn;
            assert.equal(knn.k, 200); assert.equal(body.size, 10);
            assert.equal(Object.hasOwn(body, 'rerank'), knn.queryText !== 'disabled');
            assert.equal(body.consistentRead, true);
            assert.equal(body.ref.name, 'main');
        }
        const before = f.calls.length;
        for (const rerank of [null, 'false', 0, {}])
            await assert.rejects(drive.recall({ query: 'invalid', rerank }), { code: 'INVALID_INPUT' });
        await assert.rejects(drive.configure({ rerank: false }), { code: 'INVALID_INPUT' });
        await assert.rejects(open({ client: f.client, name: 'sdk_test', mode: 'single_pass', rerank: false }), { code: 'INVALID_INPUT' });
        await assert.rejects(create({ client: f.client, name: 'other_test', mode: 'single_pass', rerank: false }), { code: 'INVALID_INPUT' });
        assert.equal(f.calls.length, before);
    }
});

test('agentic rejects rerank true before dispatch and uses the effective recall mode', async () => {
    const f = memdriveClient();
    let modelCalls = 0;
    const agent = { maxSteps: 0, model: modelAdapter(async () => {
        modelCalls++; return modelResponse([['report_helpful_ids', { ids: [] }]]);
    }) };
    const drive = await create({ client: f.client, name: 'sdk_test', mode: 'agentic', metadataSchema: {}, agent });
    const before = f.calls.length;
    await assert.rejects(drive.recall({ query: 'q', rerank: true }), error => error.code === 'INVALID_INPUT'
        && error.usage.databaseRequests === 0 && error.usage.models.length === 0);
    assert.equal(modelCalls, 0); assert.equal(f.calls.length, before);
    for (const rerank of [undefined, false]) await drive.recall({ query: 'q', rerank });
    assert.equal(modelCalls, 2);
    await drive.recall({ query: 'q', mode: 'single_pass', rerank: true });
    assert.equal(modelCalls, 2);
    assert.equal(f.calls.findLast(call => call.kind === 'query').request.rerank.model, 'jev-1.13.0');
    const reopened = await open({ client: f.client, name: 'sdk_test', mode: 'single_pass', agent });
    await assert.rejects(reopened.recall({ query: 'q', mode: 'agentic', rerank: true }), { code: 'INVALID_INPUT' });
    assert.equal(modelCalls, 2);
});

test('single-pass uses one contextual native hybrid+rerank request and returns source-bound matches across reopen', async () => {
    const f = memdriveClient(), events = [];
    const drive = await create({ client: f.client, name: 'sdk_test', metadataSchema: schema, textSearch: { analyzers: ['english'] }, mode: 'single_pass' });
    await drive.remember({ mems: [mem] });
    const opened = await open({ client: f.client, name: 'sdk_test', mode: 'single_pass', observe: e => events.push(e) });
    f.search = (_request, docs) => docs;
    const request = { query: 'What support?', recentDialogue: [{ role: 'user', content: 'For my tennis injury.' }],
        context: 'Plays tennis.', filter: { field: 'metadata.tags', op: 'eq', value: 'tennis' } };
    const result = await opened.recall(request);
    assert.deepEqual(result.matches, [publicMatch(await sourceMatch(mem))]);
    assert.equal(result.usage.databaseRequests, 1); assert.deepEqual(result.usage.models, []);
    const queries = f.calls.filter(call => call.kind === 'query');
    assert.equal(queries.length, 1);
    const body = queries[0].request;
    assert.deepEqual(body.ref, { kind: 'branch', name: 'main' });
    assert.equal(body.consistentRead, true); assert.equal(body.includeVectors, false);
    assert.equal(body.size, 10); assert.equal(body.query.bayesian[0].knn.k, 200);
    assert.equal(body.query.bayesian[0].knn.queryText, contextualQuery(request));
    assert.equal(body.query.bayesian[1].bool[1].queryString.query, 'What support?');
    assert.deepEqual(body.rerank, { provider: 'typesafe', model: 'jev-1.13.0', queryText: contextualQuery(request),
        fields: ['content'], candidateSize: 200, onFailure: 'error' });
    assert.deepEqual(events.map(({ type, matches, completion }) => ({ type, matches, completion })), [
        { type: 'retrieved', matches: result.matches, completion: undefined }, { type: 'selected', matches: result.matches, completion: 'single_pass' }]);
});

test('single-pass rejects missing rerank confirmation and out-of-filter results, never silently degrades', async () => {
    const f = memdriveClient();
    const drive = await create({ client: f.client, name: 'sdk_test', metadataSchema: schema, mode: 'single_pass' });
    await drive.remember({ mems: [mem] });
    f.search = (_request, docs) => ({ docs: [{ doc: docs[0] }], isDocsInline: true });
    await assert.rejects(drive.recall({ query: 'wrist' }), error => error.code === 'RERANK_FAILED' && error.usage.databaseRequests === 1);
    await assert.rejects(drive.recall({ query: 'wrist', filter: { field: 'metadata.role', op: 'eq', value: 'assistant' } }),
        error => error.code === 'INVALID_RESULT');
    await assert.rejects(drive.recall({ query: 'wrist', excludeIds: ['mem-1'] }), error => error.code === 'INVALID_RESULT');
});

test('invalid runtime options fail before creation and oversized single-pass context fails before querying', async () => {
    const f = memdriveClient();
    await assert.rejects(create({ client: f.client, name: 'sdk_test', metadataSchema: {}, mode: 'agentic' }), /adapter/);
    for (const invalid of [{ strategy: 'direct' }, { mode: 'direct' }]) {
        await assert.rejects(create({ client: f.client, name: 'sdk_test', metadataSchema: {}, ...invalid }), { code: 'INVALID_INPUT' });
        await assert.rejects(open({ client: f.client, name: 'sdk_test', ...invalid }), { code: 'INVALID_INPUT' });
    }
    assert.equal(f.calls.length, 0);
    const drive = await create({ client: f.client, name: 'sdk_test', metadataSchema: {}, mode: 'single_pass' });
    for (const invalid of [{ strategy: 'direct' }, { mode: 'direct' }])
        await assert.rejects(drive.recall({ query: 'q', ...invalid }), { code: 'INVALID_INPUT' });
    await assert.rejects(drive.recall({ query: 'q', context: 'x'.repeat(8193) }), /8 KiB/);
    assert.equal(f.calls.filter(call => call.kind === 'query').length, 0);
    await assert.rejects(drive.recall({ query: 'q', mode: 'agentic' }), /adapter/);
});

test('agentic shares the public match contract and records cached tokens without adding them to input', async () => {
    const f = memdriveClient();
    let step = 0;
    const agent = { model: modelAdapter(async () => modelResponse(step++ === 0
        ? [['search_semantic', { query: 'wrist support' }]]
        : [['report_helpful_ids', { ids: ['e1'] }]],
    { input_tokens: 100, input_tokens_details: { cached_tokens: 60 }, output_tokens: 5 })) };
    const drive = await create({ client: f.client, name: 'sdk_test', metadataSchema: schema, mode: 'agentic', agent });
    await drive.remember({ mems: [mem] });
    f.search = (_request, docs) => docs;
    const result = await drive.recall({ query: 'What support?' });
    assert.deepEqual(result.matches, [publicMatch(await sourceMatch(mem))]);
    assert.deepEqual(result.usage.models, [{ provider: 'synthetic', model: 'synthetic-model', calls: 2,
        inputTokens: 200, cachedInputTokens: 120, outputTokens: 10 }]);
    assert.equal(result.usage.databaseRequests, 1);
    assert.equal(f.calls.find(call => call.kind === 'query').request.rerank, undefined);
});

test('unknown model usage remains null and model failure exposes accrued usage', async () => {
    const f = memdriveClient();
    let failure = false;
    const drive = await create({ client: f.client, name: 'sdk_test', metadataSchema: {}, mode: 'agentic',
        agent: { maxSteps: 0, model: modelAdapter(async () => {
            if (failure) throw new Error('provider unavailable');
            return modelResponse([['report_helpful_ids', { ids: [] }]]);
        }) } });
    const result = await drive.recall({ query: 'q' });
    assert.equal(result.usage.models[0].inputTokens, null);
    failure = true;
    await assert.rejects(drive.recall({ query: 'q' }), error => error.code === 'MODEL_ERROR'
        && error.usage.models[0].calls === 1 && error.usage.models[0].outputTokens === null);
});

test('one opened handle bounds concurrent recalls rather than creating a queue per question', async () => {
    const f = memdriveClient();
    const drive = await create({ client: f.client, name: 'sdk_test', metadataSchema: {}, mode: 'single_pass', maxConcurrentRequests: 2 });
    let active = 0, peak = 0;
    f.search = async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return []; };
    await Promise.all(Array.from({ length: 6 }, () => drive.recall({ query: 'q' })));
    assert.equal(peak, 2);
});

test('agent reads full originals and can still search unseen siblings with separate evidence and parent aliases', async () => {
    const f = memdriveClient(), requests = [], events = [];
    const original = { id: 'long', content: 'a'.repeat(800) + 'b'.repeat(100), metadata: { role: 'user' } };
    let step = 0, searches = 0;
    const agent = { model: modelAdapter(async request => {
        requests.push(request);
        const output = request.input.at(-1).type === 'function_call_output' ? JSON.parse(request.input.at(-1).output) : null;
        switch (step++) {
            case 0: return modelResponse([['search_keyword', { keywords: ['a'] }]]);
            case 1:
                assert.equal(output.new_evidence[0].id, 'e1');
                assert.equal(output.new_evidence[0].mem_id, 'm1');
                assert.equal(output.new_evidence[0].content.length, 800);
                assert.equal(output.new_evidence[0].kind, 'chunk');
                return modelResponse([['read_mems', { ids: ['m1'] }]]);
            case 2:
                assert.equal(output.new_evidence[0].id, 'e2');
                assert.equal(output.new_evidence[0].content, original.content);
                assert.equal(output.new_evidence[0].kind, 'mem');
                return modelResponse([['search_semantic', { query: 'b' }]]);
            default:
                assert.equal(output.new_evidence[0].id, 'e3');
                assert.equal(output.new_evidence[0].mem_id, 'm1');
                return modelResponse([['report_helpful_ids', { ids: ['e2', 'e3'] }]]);
        }
    }) };
    const drive = await create({ client: f.client, name: 'sdk_test', metadataSchema: schema, textSearch: { analyzers: ['english'] }, mode: 'agentic', agent,
        observe: event => events.push(event) });
    await drive.remember({ mems: [original] });
    f.search = (request, docs) => {
        const selected = docs[searches++];
        if (searches === 2) {
            const query = JSON.stringify(request.query);
            assert(query.includes(docs[0].id));
            assert(!query.includes(docs[1].id));
        }
        return [selected];
    };
    const result = await drive.recall({ query: 'all details', filter: { field: 'id', op: 'eq', value: 'long' } });
    assert.deepEqual(result.matches, [publicMatch(await sourceMatch(original)), {
        kind: 'chunk', memId: 'long', content: 'b'.repeat(100), start: 800, end: 900, metadata: { role: 'user' },
    }]);
    assert.equal(result.usage.databaseRequests, 3);
    assert.equal(events.filter(event => event.type === 'retrieved').length, 3);
    assert.deepEqual((await drive.read({ ids: ['missing', 'long'] })).mems, [original]);
    assert.equal(requests.length, 4);
});

test('reading a single-chunk original reuses its evidence body and unknown parent aliases never fetch', async () => {
    const f = memdriveClient();
    let step = 0;
    const agent = { model: modelAdapter(async request => {
        switch (step++) {
            case 0: return modelResponse([['read_mems', { ids: ['m1'] }]]);
            case 1:
                assert.match(JSON.parse(request.input.at(-1).output).error, /previously shown/);
                return modelResponse([['search_semantic', { query: 'wrist' }]]);
            case 2: return modelResponse([['read_mems', { ids: ['m1'] }]]);
            case 3:
                assert.deepEqual(JSON.parse(request.input.at(-1).output), { matches: ['e1'], new_evidence: [] });
                return modelResponse([['search_semantic', { query: 'more wrist' }]]);
            default:
                assert.deepEqual(JSON.parse(request.input.at(-1).output), { matches: [], new_evidence: [] });
                return modelResponse([['report_helpful_ids', { ids: ['e1'] }]]);
        }
    }) };
    const drive = await create({ client: f.client, name: 'sdk_test', metadataSchema: schema, mode: 'agentic', agent });
    await drive.remember({ mems: [mem] });
    let searches = 0;
    f.search = (request, docs) => {
        assert.equal(docs[0].kind, 'mem');
        if (searches++ === 0) return docs;
        assert(request.query.knn.filter.bool.some(clause => clause.occur === 'must_not'
            && clause.queryString?.defaultField === 'id' && JSON.parse(clause.queryString.query) === docs[0].id));
        return [];
    };
    const result = await drive.recall({ query: 'support' });
    assert.deepEqual(result.matches, [publicMatch(await sourceMatch(mem))]);
    assert.equal(result.usage.databaseRequests, 3);
});

test('agent original reads recheck caller filters while public reads remain independent', async () => {
    const f = memdriveClient();
    let step = 0, drive;
    const agent = { model: modelAdapter(async request => {
        switch (step++) {
            case 0: return modelResponse([['search_semantic', { query: 'wrist' }]]);
            case 1:
                await drive.remember({ mems: [{ ...mem, metadata: { role: 'assistant' } }] });
                return modelResponse([['read_mems', { ids: ['m1'] }]]);
            default:
                assert.deepEqual(JSON.parse(request.input.at(-1).output), { matches: [], new_evidence: [] });
                return modelResponse([['report_helpful_ids', { ids: [] }]]);
        }
    }) };
    drive = await create({ client: f.client, name: 'sdk_test', metadataSchema: schema, mode: 'agentic', agent });
    await drive.remember({ mems: [mem] });
    f.search = (_request, docs) => docs;
    assert.deepEqual((await drive.recall({ query: 'support', filter: { field: 'metadata.role', op: 'eq', value: 'user' } })).matches, []);
    assert.equal((await drive.read({ ids: [mem.id] })).mems[0].metadata.role, 'assistant');
});

test('single-pass hybrid search has no kind filter and rejects nonsearchable sources or retired slots', async () => {
    const f = memdriveClient();
    const drive = await create({ client: f.client, name: 'sdk_test', metadataSchema: schema, textSearch: { analyzers: ['english'] }, mode: 'single_pass' });
    await drive.remember({ mems: [mem] });
    f.search = (request, docs) => {
        for (const filter of [request.query.bayesian[0].knn.filter, request.query.bayesian[1].bool[0]]) {
            const encoded = JSON.stringify(filter);
            assert(!encoded.includes('"defaultField":"kind"'));
        }
        return docs;
    };
    await drive.recall({ query: 'wrist' });
    const original = [...f.collections.get('sdk_test').docs.values()][0];
    const { content, ...source } = original;
    for (const doc of [{ ...source, memContent: content, chunkSlots: 1 },
        { id: 'chunk:retired:0', memId: mem.id, kind: 'chunk' }]) {
        f.search = () => [doc];
        await assert.rejects(drive.recall({ query: 'wrist' }), { code: 'INVALID_RESULT' });
    }
});

test('stored analyzer configuration determines single-pass retrieval across reopen, branch views and schema updates', async () => {
    for (const analyzers of [undefined, ['standard'], ['english'], ['english', 'korean']]) {
        const f = memdriveClient();
        const drive = await create({ client: f.client, name: 'sdk_test', metadataSchema: {}, mode: 'single_pass',
            ...(analyzers === undefined ? {} : { textSearch: { analyzers } }) });
        const contentIndex = f.calls.find(call => call.kind === 'create').request.indexConfigs.content;
        assert.deepEqual(contentIndex, analyzers === undefined ? undefined : { type: 'text', analyzers });
        const reopened = await open({ client: f.client, name: 'sdk_test', mode: 'single_pass' });
        await reopened.branches.create({ name: 'alternate' });
        await reopened.configure({ metadataSchema: { label: { type: 'string' } } });
        const query = { query: 'relevant fact', context: 'Additional context.' };
        for (const handle of [drive, reopened, reopened.at({ branch: 'alternate' })]) await handle.recall(query);
        assert.deepEqual(f.calls.findLast(call => call.kind === 'update').request.indexConfigs.content, contentIndex);
        for (const { request } of f.calls.filter(call => call.kind === 'query')) {
            const knn = analyzers === undefined ? request.query.knn : request.query.bayesian[0].knn;
            assert.equal(knn.queryText, contextualQuery(query));
            assert.equal(knn.k, 200);
            assert.equal(request.rerank.model, 'jev-1.13.0');
            assert.equal(request.rerank.onFailure, 'error');
            if (analyzers === undefined) assert.equal(request.query.bayesian, undefined);
            else assert.equal(request.query.bayesian[1].bool[1].queryString.defaultField, 'content');
        }
    }
});

test('text search configuration rejects malformed or unsupported inputs before creating a collection', async () => {
    for (const textSearch of [null, {}, 'english', { analyzer: 'english' }, { analyzers: 'english' }, { analyzers: null },
        { analyzers: [] }, { analyzers: [''] }, { analyzers: ['English'] }, { analyzers: ['unsupported'] },
        { analyzers: ['english', 'english'] }, { analyzers: ['english', 'English'] },
        { analyzers: ['standard'], extra: true }]) {
        const f = memdriveClient();
        await assert.rejects(create({ client: f.client, name: 'sdk_test', metadataSchema: {}, mode: 'single_pass', textSearch }),
            { code: 'INVALID_INPUT' });
        assert.equal(f.calls.length, 0);
    }
    const f = memdriveClient();
    const drive = await create({ client: f.client, name: 'sdk_test', metadataSchema: {}, mode: 'single_pass' });
    const before = f.calls.length;
    await assert.rejects(open({ client: f.client, name: 'sdk_test', mode: 'single_pass', textSearch: { analyzers: ['standard'] } }),
        { code: 'INVALID_INPUT' });
    await assert.rejects(drive.configure({ textSearch: { analyzers: ['standard'] } }), { code: 'INVALID_INPUT' });
    assert.equal(f.calls.length, before);
});

test('vector-only agent omits keyword search and rejects invented keyword calls before database dispatch', async () => {
    const f = memdriveClient();
    let step = 0;
    const agent = { model: modelAdapter(async request => {
        assert(!request.tools.some(tool => tool.name === 'search_keyword'));
        switch (step++) {
            case 0: return modelResponse([['search_keyword', { keywords: ['fact'] }]]);
            case 1:
                assert.equal(f.calls.filter(call => call.kind === 'query').length, 0);
                assert.match(JSON.parse(request.input.at(-1).output).error, /documented tool/);
                return modelResponse([['get_schema', {}]]);
            case 2: {
                const output = JSON.parse(request.input.at(-1).output);
                assert.equal(output.search_indexes.content, undefined);
                assert.equal(output.search_indexes.embedding.type, 'vector');
                return modelResponse([['search_semantic', { query: 'fact' }]]);
            }
            default: return modelResponse([['report_helpful_ids', { ids: [] }]]);
        }
    }) };
    const drive = await create({ client: f.client, name: 'sdk_test', metadataSchema: {}, mode: 'agentic', agent });
    const result = await drive.recall({ query: 'fact' });
    assert.deepEqual(result.matches, []);
    const queries = f.calls.filter(call => call.kind === 'query');
    assert.equal(queries.length, 1);
    assert.equal(queries[0].request.rerank, undefined);
    assert.equal(queries[0].request.query.knn.queryText, 'fact');
});

test('value counts include complete and separate originals exactly once and ignore retired slots', async () => {
    const f = memdriveClient(), counts = [];
    const agent = { model: modelAdapter(async request => {
        const output = request.input.find(item => item.type === 'function_call_output');
        if (!output) return modelResponse([['count_values', { fields: ['id'] }]]);
        counts.push(JSON.parse(output.output).values.id.buckets);
        return modelResponse([['report_helpful_ids', { ids: [] }]]);
    }) };
    const drive = await create({ client: f.client, name: 'sdk_test', metadataSchema: {}, mode: 'agentic', agent });
    await drive.remember({ mems: [{ id: 'short', content: 'short' }, { id: 'long', content: 'z'.repeat(1700) }] });
    f.search = (_request, docs) => ({ docs: [], facets: { memId: {
        buckets: docs.map(doc => ({ value: doc.memId, count: 1 })).sort((a, b) => a.value.localeCompare(b.value)),
    } } });
    await drive.recall({ query: 'counts' });
    await drive.remember({ mems: [{ id: 'long', content: 'now short' }] });
    await drive.recall({ query: 'counts' });
    assert.deepEqual(counts, Array.from({ length: 2 }, () => [{ value: 'long', count: 1 }, { value: 'short', count: 1 }]));
    assert.equal([...f.collections.get('sdk_test').docs.values()].filter(doc => doc.kind === 'chunk' && !Object.hasOwn(doc, 'content')).length, 3);
});


test('exact match-all queries reject before database or model dispatch in either mode', async () => {
    const f = memdriveClient();
    const agent = { model: modelAdapter(async () => assert.fail('Invalid query reached the model.')) };
    const drive = await create({ client: f.client, name: 'sdk_test', metadataSchema: {}, mode: 'single_pass', agent });
    const before = f.calls.length;
    for (const mode of ['single_pass', 'agentic']) for (const query of ['*:*', ' \n*:*\t']) {
        await assert.rejects(drive.recall({ query, mode }), { code: 'INVALID_INPUT' });
    }
    assert.equal(f.calls.length, before);
});

test('ordinary searches cannot return replaced text from bodyless retired slots', async () => {
    const f = memdriveClient();
    const drive = await create({ client: f.client, name: 'sdk_test', metadataSchema: {}, mode: 'single_pass' });
    await drive.remember({ mems: [{ id: 'changing', content: 'obsolete '.repeat(200) }] });
    f.search = (_request, docs) => docs.filter(doc => doc.content.includes('obsolete'));
    assert((await drive.recall({ query: 'obsolete' })).matches.length > 0);
    await drive.remember({ mems: [{ id: 'changing', content: 'replacement' }] });
    assert.deepEqual((await drive.recall({ query: 'obsolete' })).matches, []);
});
