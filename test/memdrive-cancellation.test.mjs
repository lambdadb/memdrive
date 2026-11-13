import test from 'node:test';
import assert from 'node:assert/strict';
import { create, open, list } from '../dist/esm/index.js';
import { memdriveClient } from './helpers/memdrive-client.mjs';

const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const aborted = signal => new Promise((_, reject) => {
    const stop = () => reject(new DOMException('Canceled by fixture', 'AbortError'));
    if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
});
const config = f => ({ client: f.client, name: 'cancel_test', metadataSchema: {} });

test('operation signals stay outside payloads and reach storage, metadata, catalog and branch transports', async () => {
    const f = memdriveClient(), controller = new AbortController(), options = { signal: controller.signal };
    const drive = await create({ ...config(f), labels: { application: 'test', owner: 'owner' } }, options);
    f.search = request => request.facets ? { facets: { memId: { buckets: [] } } } : [];
    await open({ client: f.client, name: 'cancel_test' }, options);
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
    await branch.countValues({ fields: ['id'] }, options);
    await branch.forget({ ids: ['one'] }, options);
    await drive.branches.delete('alternate', options);
    assert(f.calls.every(call => call.signal === controller.signal));
    assert(f.calls.every(call => !JSON.stringify(call.request)?.includes('"signal"')));
    const before = f.calls.length;
    controller.abort();
    for (const operation of [
        () => create(config(f), options), () => open({ client: f.client, name: 'cancel_test' }, options),
        () => list({ client: f.client }, options), () => drive.describe(options), () => drive.configure({ metadataSchema: {} }, options),
        () => drive.remember({ mems: [{ content: 'x' }] }, options), () => drive.read({ ids: ['one'] }, options),
        () => drive.recall({ query: 'x' }, options), () => drive.countValues({ fields: ['id'] }, options), () => drive.list({}, options), () => drive.forget({ ids: ['one'] }, options),
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

test('an in-flight recall propagates its signal and accounts for the attempted database request', async () => {
    const f = memdriveClient(), controller = new AbortController(), entered = gate();
    const drive = await create(config(f));
    f.search = async (_request, _docs, _name, options) => {
        assert.equal(options.signal, controller.signal);
        entered.resolve(); return aborted(options.signal);
    };
    const result = drive.recall({ query: 'test' }, { signal: controller.signal });
    await entered.promise; controller.abort();
    await assert.rejects(result, error => error.code === 'ABORTED' && error.usage.databaseRequests === 1);
    assert.equal(f.calls.filter(call => call.kind === 'query').length, 1);
});
