import test from 'node:test';
import assert from 'node:assert/strict';
import { create, open, list } from '../dist/esm/index.js';
import { memdriveClient, modelAdapter, modelResponse } from './helpers/memdrive-client.mjs';

const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const aborted = signal => new Promise((_, reject) => {
    const stop = () => reject(new DOMException('Canceled by fixture', 'AbortError'));
    if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
});
const config = f => ({ client: f.client, name: 'cancel_test', mode: 'single_pass', metadataSchema: {} });

test('operation signals stay outside payloads and reach storage, metadata, catalog and branch transports', async () => {
    const f = memdriveClient(), controller = new AbortController(), options = { signal: controller.signal };
    const drive = await create({ ...config(f), labels: { application: 'test', owner: 'owner' } }, options);
    await open({ client: f.client, name: 'cancel_test', mode: 'single_pass' }, options);
    await drive.describe(options);
    await list({ client: f.client }, options);
    await drive.configure({ metadataSchema: { label: { type: 'string' } } }, options);
    await drive.branches.create({ name: 'alternate' }, options);
    await drive.branches.list(options);
    const branch = drive.at({ branch: 'alternate' });
    await branch.remember({ mems: [{ id: 'one', content: 'text' }] }, options);
    await branch.read({ ids: ['one'] }, options);
    await branch.list({}, options);
    await branch.recall({ query: 'text' }, options);
    await branch.forget({ ids: ['one'] }, options);
    await drive.branches.delete('alternate', options);
    assert(f.calls.every(call => call.signal === controller.signal));
    assert(f.calls.every(call => !JSON.stringify(call.request)?.includes('"signal"')));
    const before = f.calls.length;
    controller.abort();
    for (const operation of [
        () => create(config(f), options), () => open({ client: f.client, name: 'cancel_test', mode: 'single_pass' }, options),
        () => list({ client: f.client }, options), () => drive.describe(options), () => drive.configure({ metadataSchema: {} }, options),
        () => drive.remember({ mems: [{ content: 'x' }] }, options), () => drive.read({ ids: ['one'] }, options),
        () => drive.recall({ query: 'x' }, options), () => drive.list({}, options), () => drive.forget({ ids: ['one'] }, options),
        () => drive.branches.create({ name: 'another' }, options), () => drive.branches.list(options),
        () => drive.branches.delete('another', options), () => drive.destroy(options),
    ]) await assert.rejects(operation(), { code: 'ABORTED' });
    assert.equal(f.calls.length, before);
    await assert.rejects(drive.recall({ query: 'x' }, { signal: {} }), { code: 'INVALID_INPUT' });
    const final = new AbortController();
    await drive.destroy({ signal: final.signal });
    assert.equal(f.calls.at(-1).signal, final.signal);
});

test('queued recalls abort promptly without dispatch or leaked waiters and other queued work proceeds', { timeout: 2000 }, async () => {
    const f = memdriveClient(), drive = await create({ ...config(f), maxConcurrentRequests: 1 });
    const started = gate(), release = gate();
    f.search = async request => {
        if (request.query.knn.queryText === 'first') { started.resolve(); await release.promise; }
        return [];
    };
    const first = drive.recall({ query: 'first' }); await started.promise;
    const controller = new AbortController(), signal = controller.signal;
    let added = 0, removed = 0;
    const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...args) => { added++; return add(...args); };
    signal.removeEventListener = (...args) => { removed++; return remove(...args); };
    const queued = drive.recall({ query: 'canceled' }, { signal });
    const third = drive.recall({ query: 'third' });
    controller.abort();
    await assert.rejects(queued, error => error.code === 'ABORTED' && error.usage.databaseRequests === 0);
    assert.equal(added, 1); assert.equal(removed, 1);
    assert.equal(f.calls.filter(call => call.kind === 'query').length, 1);
    release.resolve(); await Promise.all([first, third]);
    assert.deepEqual(f.calls.filter(call => call.kind === 'query').map(call => call.request.query.knn.queryText), ['first', 'third']);
});

test('model and parallel tool cancellation propagate the signal and prevent further model or queued database calls', async () => {
    for (const duringModel of [true, false]) {
        const f = memdriveClient(), controller = new AbortController(), started = gate();
        let modelCalls = 0;
        const model = modelAdapter(async (_request, options) => {
            modelCalls++; assert.equal(options.signal, controller.signal);
            if (duringModel) { started.resolve(); return aborted(options.signal); }
            return modelResponse([['search_semantic', { query: 'first' }], ['search_semantic', { query: 'queued' }]]);
        });
        const drive = await create({ ...config(f), mode: 'agentic', agent: { model }, maxConcurrentRequests: 1 });
        f.search = async (_request, _docs, _name, options) => { started.resolve(); return aborted(options.signal); };
        const result = drive.recall({ query: 'test' }, { signal: controller.signal });
        await started.promise; controller.abort();
        await assert.rejects(result, error => error.code === 'ABORTED' && error.usage.models[0].calls === 1
            && error.usage.databaseRequests === (duringModel ? 0 : 1));
        assert.equal(modelCalls, 1);
        assert.equal(f.calls.filter(call => call.kind === 'query').length, duringModel ? 0 : 1);
    }
});

test('write cancellation distinguishes accepted batches from an uncertain in-flight batch', async () => {
    for (const duringRequest of [false, true]) {
        const f = memdriveClient(), controller = new AbortController();
        const drive = await create({ ...config(f), metadataSchema: { payload: { type: 'string[]' } },
            embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'test' } });
        const mems = ['first', 'second', 'third'].map(id => ({ id, embedding: [1, ...Array(63).fill(0)],
            metadata: { payload: Array(800).fill('x'.repeat(4000)) } }));
        if (duringRequest) {
            let writes = 0;
            f.beforeUpsert = (_request, options) => {
                if (++writes === 2) { controller.abort(); return aborted(options.signal); }
            };
        } else f.afterUpsert = () => controller.abort();
        await assert.rejects(drive.remember({ mems }, { signal: controller.signal }), error => {
            assert.equal(error.code, 'ABORTED');
            assert.deepEqual(error.details.completedIds, ['first']);
            assert.deepEqual(error.details.uncertainIds, duringRequest ? ['second'] : []);
            assert.deepEqual(error.details.notAttemptedIds, duringRequest ? ['third'] : ['second', 'third']);
            return true;
        });
        assert.equal(f.calls.filter(call => call.kind === 'upsert').length, duringRequest ? 2 : 1);
    }
});

test('canceling one schema inspection does not cancel another recall sharing the cache', async () => {
    const f = memdriveClient(), first = new AbortController(), second = new AbortController();
    const entered = gate(), release = gate();
    const model = modelAdapter(async request => request.input.some(item => item.type === 'function_call_output')
        ? modelResponse([['report_helpful_ids', { ids: [] }]]) : modelResponse([['get_schema', {}]]));
    const drive = await create({ ...config(f), mode: 'agentic', agent: { model } });
    let calls = 0;
    f.beforeGet = async (_name, options) => {
        if (++calls === 2) entered.resolve();
        if (options.signal === first.signal) return aborted(options.signal);
        await release.promise;
    };
    const a = drive.recall({ query: 'one' }, { signal: first.signal });
    const b = drive.recall({ query: 'two' }, { signal: second.signal });
    await entered.promise; first.abort();
    await assert.rejects(a, { code: 'ABORTED' });
    release.resolve(); assert.deepEqual((await b).matches, []);
    assert.equal(calls, 2);
});
