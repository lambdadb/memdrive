import test from 'node:test';
import assert from 'node:assert/strict';
import { create } from '../dist/esm/index.js';
import { createValueCounter } from '../dist/esm/values.js';
import { memdriveClient } from './helpers/memdrive-client.mjs';

const schema = { role: { type: 'string' }, tags: { type: 'string[]' }, score: { type: 'number' } };
const setup = async options => {
    const f = memdriveClient();
    const drive = await create({ client: f.client, name: 'values_test', metadataSchema: schema, ...options });
    return { f, drive };
};
const facets = (field, buckets) => ({ docs: [], facets: { [field]: { buckets } } });
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const aborted = signal => new Promise((_, reject) => {
    const stop = () => reject(new DOMException('Canceled by fixture', 'AbortError'));
    if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
});

test('counts scope public IDs, filters and exclusions to originals and return detached cached results', async () => {
    const { f, drive } = await setup();
    const filter = { field: 'metadata.role', op: 'eq', value: 'user' };
    const request = { fields: ['id'], filter, excludeIds: ['excluded'], limit: 1 };
    f.search = () => facets('memId', [{ value: 'first', count: 2 }, { value: 'second', count: 1 }]);
    const [first, second] = await Promise.all([drive.countValues(request), drive.countValues(request)]);
    assert.deepEqual(first.values.id, { buckets: [{ value: 'first', count: 2 }], hasMore: true });
    assert(Number.isFinite(Date.parse(first.asOf)));
    first.values.id.buckets[0].count = 999;
    assert.equal(second.values.id.buckets[0].count, 2);
    const queries = f.calls.filter(call => call.kind === 'query');
    assert.equal(queries.length, 1);
    const body = queries[0].request;
    assert.equal(body.size, 0); assert.equal(body.consistentRead, true);
    assert.deepEqual(body.facets, { memId: { size: 2 } });
    assert.deepEqual(body.ref, { kind: 'branch', name: 'main' });
    assert.deepEqual(body.query.bool[1], { queryString: { defaultField: 'kind', query: '"mem"' }, occur: 'filter' });
    const encoded = JSON.stringify(body.query);
    assert(encoded.includes('metadata.role') && encoded.includes('user') && encoded.includes('excluded'));
    await drive.countValues({ ...request, excludeIds: ['different'] });
    await drive.countValues({ ...request, filter: { ...filter, value: 'assistant' } });
    assert.equal(f.calls.filter(call => call.kind === 'query').length, 3);
});

test('counts include short and long originals once and ignore overwritten chunk slots', async () => {
    const { f, drive } = await setup();
    await drive.remember({ mems: [{ id: 'short', content: 'short' }, { id: 'long', content: 'z'.repeat(1700) }] });
    f.search = (request, docs) => {
        assert.deepEqual(request.query.bool[1], { queryString: { defaultField: 'kind', query: '"mem"' }, occur: 'filter' });
        return facets('memId', docs.map(doc => ({ value: doc.memId, count: 1 })).sort((a, b) => a.value.localeCompare(b.value)));
    };
    const before = await drive.countValues({ fields: ['id'] });
    await drive.remember({ mems: [{ id: 'long', content: 'now short' }] });
    const after = await drive.countValues({ fields: ['id'] });
    for (const result of [before, after])
        assert.deepEqual(result.values.id, { buckets: [{ value: 'long', count: 1 }, { value: 'short', count: 1 }], hasMore: false });
    assert.equal([...f.collections.get('values_test').docs.values()].filter(doc => doc.kind === 'chunk' && !Object.hasOwn(doc, 'content')).length, 3);
});

test('count validation supports keyword fields only and failed facet responses are never cached', async () => {
    const { f, drive } = await setup();
    for (const request of [{ fields: [] }, { fields: ['id', 'id'] }, { fields: ['metadata.score'] }, { fields: ['timestamp'] },
        { fields: ['unknown'] }, { fields: ['a', 'b', 'c', 'd', 'e', 'f'] }, { fields: ['id'], limit: 0 }, { fields: ['id'], limit: 101 },
        { fields: ['id'], excludeIds: ['same', 'same'] }, { fields: ['id'], extra: true }])
        await assert.rejects(drive.countValues(request), { code: 'INVALID_INPUT' });
    assert.equal(f.calls.filter(call => call.kind === 'query').length, 0);
    for (const response of [{}, facets('memId', [{ value: 'x', count: -1 }]),
        facets('memId', [{ value: 'x', count: 1 }, { value: 'x', count: 2 }])]) {
        f.search = () => response;
        await assert.rejects(drive.countValues({ fields: ['id'], limit: 100 }), { code: 'INVALID_RESPONSE' });
    }
    f.search = () => facets('memId', Array.from({ length: 100 }, (_, index) => ({ value: String(index), count: 1 })));
    assert.equal((await drive.countValues({ fields: ['id'], limit: 100 })).values.id.hasMore, null);
    assert.equal(f.calls.filter(call => call.kind === 'query').length, 4);
});

test('count caches isolate branches and refresh after writes, schema changes and deletions', async () => {
    const { f, drive } = await setup();
    await drive.branches.create({ name: 'alternate' });
    const alternate = drive.at({ branch: 'alternate' });
    await drive.remember({ mems: [{ id: 'same', content: 'main', metadata: { role: 'main' } }] });
    await alternate.remember({ mems: [{ id: 'same', content: 'alternate', metadata: { role: 'alternate' } }] });
    f.search = (request, docs) => ({ docs: [], facets: Object.fromEntries(Object.keys(request.facets).map(field => [field, {
        buckets: docs.filter(doc => doc.metadata?.[field.slice(9)] !== undefined).map(doc => ({ value: doc.metadata[field.slice(9)], count: 1 })),
    }])) });
    assert.equal((await drive.countValues({ fields: ['metadata.role'] })).values['metadata.role'].buckets[0].value, 'main');
    assert.equal((await alternate.countValues({ fields: ['metadata.role'] })).values['metadata.role'].buckets[0].value, 'alternate');
    const count = f.calls.filter(call => call.kind === 'query').length;
    await alternate.countValues({ fields: ['metadata.role'] });
    assert.equal(f.calls.filter(call => call.kind === 'query').length, count);
    await drive.configure({ metadataSchema: { ...schema, label: { type: 'string' } } });
    await drive.at({ branch: 'alternate' }).remember({ mems: [{ id: 'new', content: 'new', metadata: { label: 'fresh' } }] });
    assert.deepEqual((await alternate.countValues({ fields: ['metadata.label'] })).values['metadata.label'].buckets, [{ value: 'fresh', count: 1 }]);
    assert(f.calls.filter(call => call.kind === 'query' && call.request.facets?.['metadata.label']).every(call => call.request.ref.name === 'alternate'));
    await alternate.forget({ ids: ['new'] });
    assert.deepEqual((await alternate.countValues({ fields: ['metadata.label'] })).values['metadata.label'].buckets, []);
    await drive.branches.delete('alternate');
    await drive.branches.create({ name: 'alternate' });
    await assert.rejects(alternate.countValues({ fields: ['metadata.role'] }), { code: 'BRANCH_INVALIDATED' });
    assert.equal((await drive.at({ branch: 'alternate' }).countValues({ fields: ['metadata.role'] })).values['metadata.role'].buckets[0].value, 'main');
});

test('a sibling write settling after a count load invalidates the old cached population', async () => {
    const { f, drive } = await setup();
    const reader = drive.at({ branch: 'main' }), writer = drive.at({ branch: 'main' });
    await writer.remember({ mems: [{ id: 'one', content: 'before', metadata: { role: 'before' } }] });
    f.search = (_request, docs) => facets('metadata.role', docs.map(doc => ({ value: doc.metadata.role, count: 1 })));
    const entered = gate(), release = gate();
    f.beforeUpsert = () => { entered.resolve(); return release.promise; };
    const write = writer.remember({ mems: [{ id: 'one', content: 'after', metadata: { role: 'after' } }] });
    await entered.promise;
    try { assert.equal((await reader.countValues({ fields: ['metadata.role'] })).values['metadata.role'].buckets[0].value, 'before'); }
    finally { release.resolve(); await write; }
    assert.equal((await reader.countValues({ fields: ['metadata.role'] })).values['metadata.role'].buckets[0].value, 'after');
});

test('canceling one count does not cancel another signal during schema or facet loading', async () => {
    for (const stage of ['schema', 'query']) {
        const { f, drive } = await setup();
        const first = new AbortController(), second = new AbortController(), entered = gate(), release = gate();
        let calls = 0;
        const load = async options => {
            if (++calls === 2) entered.resolve();
            if (options.signal === first.signal) return aborted(options.signal);
            await release.promise;
        };
        if (stage === 'schema') f.beforeGet = (_name, options) => load(options);
        f.search = async (_request, _docs, _name, options) => {
            if (stage === 'query') await load(options);
            return facets('memId', [{ value: 'one', count: 1 }]);
        };
        const a = drive.countValues({ fields: ['id'] }, { signal: first.signal });
        const b = drive.countValues({ fields: ['id'] }, { signal: second.signal });
        await entered.promise; first.abort();
        await assert.rejects(a, { code: 'ABORTED' });
        release.resolve(); assert.deepEqual((await b).values.id.buckets, [{ value: 'one', count: 1 }]);
        assert.equal(calls, 2);
        const before = f.calls.length;
        await assert.rejects(drive.countValues({ fields: ['id'] }, { signal: first.signal }), { code: 'ABORTED' });
        assert.equal(f.calls.length, before);
    }
});

test('count cache TTLs refresh values and externally changed metadata without real-time waits', async () => {
    let now = 0, descriptions = 0, queries = 0, schema = {};
    const counter = createValueCounter({ now: () => now, schemaTtlMs: 100, valuesTtlMs: 20,
        metadataSchema: () => schema,
        describe: async () => { descriptions++; if (now >= 100) schema = { label: { type: 'string' } }; },
        query: async request => {
            queries++;
            return { facets: Object.fromEntries(Object.keys(request.facets).map(field => [field, {
                buckets: [{ value: String(now), count: 1 }],
            }])) };
        },
    });
    const first = await counter.countValues({ fields: ['id'] });
    now = 19;
    assert.deepEqual(await counter.countValues({ fields: ['id'] }), first);
    assert.equal(queries, 1); assert.equal(descriptions, 1);
    now = 20;
    assert.equal((await counter.countValues({ fields: ['id'] })).values.id.buckets[0].value, '20');
    assert.equal(queries, 2); assert.equal(descriptions, 1);
    now = 100;
    assert.equal((await counter.countValues({ fields: ['metadata.label'] })).values['metadata.label'].buckets[0].value, '100');
    assert.equal(descriptions, 2);
});

test('external memories support keyword counts without text or embedding search', async () => {
    const { f, drive } = await setup({ embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'test-v1' } });
    await drive.remember({ mems: [{ id: 'one', embedding: [1, ...Array(63).fill(0)], metadata: { tags: ['music', 'practice'] } }] });
    f.search = (request, docs) => {
        assert.equal(request.rerank, undefined);
        assert.equal(request.query.knn, undefined);
        assert(!JSON.stringify(request.query).includes('embedding'));
        assert.equal(docs.length, 1); assert.equal(docs[0].kind, 'mem');
        return facets('metadata.tags', [{ value: 'music', count: 1 }, { value: 'practice', count: 1 }]);
    };
    const result = await drive.countValues({ fields: ['metadata.tags'] });
    assert.deepEqual(result.values['metadata.tags'], { buckets: [{ value: 'music', count: 1 }, { value: 'practice', count: 1 }], hasMore: false });
    assert.equal((await drive.describe()).textSearch, undefined);
});

test('a queued count aborts without dispatch while a recall holds the shared database queue', { timeout: 2000 }, async () => {
    const { f, drive } = await setup({ maxConcurrentRequests: 1 });
    const entered = gate(), release = gate(), controller = new AbortController();
    f.search = async () => { entered.resolve(); await release.promise; return []; };
    const recall = drive.recall({ query: 'blocking' });
    await entered.promise;
    const before = f.calls.length;
    const count = drive.countValues({ fields: ['id'] }, { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(count, { code: 'ABORTED' });
    assert.equal(f.calls.length, before);
    release.resolve(); await recall;
    f.search = () => facets('memId', []);
    assert.deepEqual((await drive.countValues({ fields: ['id'] })).values.id.buckets, []);
});
