import test from 'node:test';
import assert from 'node:assert/strict';
import { create, MemDriveError } from '../dist/esm/index.js';
import { memdriveClient } from './helpers/memdrive-client.mjs';

const gate = () => {
    let open;
    const promise = new Promise(resolve => { open = resolve; });
    return { promise, open };
};
const setup = async options => {
    const fixture = memdriveClient();
    const drive = await create({ client: fixture.client, name: 'batch_test', metadataSchema: {}, ...options });
    return { fixture, drive };
};

test('batches and singles share a bounded queue across branch views and retain input order', async () => {
    const { fixture: f, drive } = await setup({ maxConcurrentRequests: 2 });
    await drive.remember({ mems: ['a', 'b', 'c', 'd'].map(id => ({ id, content: id })) });
    await drive.branches.create({ name: 'alternate' });
    const alternate = drive.at({ branch: 'alternate' });
    const started = Object.fromEntries(['a', 'b', 'c', 'd'].map(id => [id, gate()]));
    const release = Object.fromEntries(['a', 'b', 'c', 'd'].map(id => [id, gate()]));
    let active = 0, peak = 0;
    const completed = [];
    f.search = async (request, docs) => {
        const id = request.query.knn.queryText;
        active++; peak = Math.max(peak, active); started[id].open();
        await release[id].promise;
        active--; completed.push(id);
        return docs.filter(doc => doc.memId === id);
    };
    const first = drive.recall({ requests: [{ query: 'a' }, { query: 'b' }] });
    const single = alternate.recall({ query: 'c' });
    const second = alternate.recall({ requests: [{ query: 'd' }] });
    await Promise.all([started.a.promise, started.b.promise]);
    assert.equal(active, 2);
    assert.equal(f.calls.filter(call => call.kind === 'query').length, 2);
    release.b.open(); await started.c.promise;
    release.c.open(); await started.d.promise;
    release.d.open(); release.a.open();
    const [a, c, d] = await Promise.all([first, single, second]);
    assert.deepEqual(a.results.map(result => result.matches[0].memId), ['a', 'b']);
    assert.equal(c.matches[0].memId, 'c'); assert.equal(c.results, undefined);
    assert.equal(d.results[0].matches[0].memId, 'd');
    assert.equal(completed[0], 'b'); assert.equal(peak, 2);
    assert(a.results.every(result => result.usage.databaseRequests === 1));
    assert.deepEqual(f.calls.filter(call => call.kind === 'query').map(call => call.request.ref.name),
        ['main', 'main', 'alternate', 'alternate']);
});

test('partial failures have safe serializable errors and independent usage while other items finish', async () => {
    const { fixture: f, drive } = await setup();
    f.search = async request => {
        if (request.query.knn.queryText === 'fail')
            throw Object.assign(new Error('private backend detail'), { statusCode: 503, secret: 'private-token' });
        return [];
    };
    const result = await drive.recall({ requests: [
        { query: 'success' }, { query: '' }, { query: 'fail' }, { query: () => 'uncloneable' }, { query: 'success' },
    ] });
    assert.deepEqual(result.results.map(item => item.error?.code ?? 'ok'),
        ['ok', 'INVALID_INPUT', 'DATABASE_ERROR', 'INVALID_INPUT', 'ok']);
    assert.deepEqual(result.results.map(item => item.usage.databaseRequests), [1, 0, 1, 0, 1]);
    assert(result.results.every(item => !Object.hasOwn(item.usage, 'models')));
    assert.deepEqual(result.results[2].error, { code: 'DATABASE_ERROR', message: 'MemDrive query failed.', status: 503 });
    const encoded = JSON.stringify(result);
    for (const text of ['private backend detail', 'private-token', 'cause', 'stack', 'details']) assert(!encoded.includes(text));
    await assert.rejects(drive.recall({ query: 'fail' }), error => error instanceof MemDriveError
        && error.code === 'DATABASE_ERROR' && error.usage.databaseRequests === 1);
    await assert.rejects(drive.recall({ query: () => 'uncloneable' }), error => error instanceof MemDriveError
        && error.code === 'INVALID_INPUT' && error.usage.databaseRequests === 0);
});

test('invalid outer batch envelopes reject before database work', async () => {
    const { fixture: f, drive } = await setup();
    const before = f.calls.length;
    for (const request of [{ requests: [] }, { requests: null }, { requests: {} },
        { requests: [{ query: 'valid' }], query: 'mixed' }, { requests: [{ query: 'valid' }], extra: true }])
        await assert.rejects(drive.recall(request), { code: 'INVALID_INPUT' });
    assert.equal(f.calls.length, before);
});

test('queued inputs are detached and an invalidated branch cannot dispatch queued work', async () => {
    const { fixture: f, drive } = await setup({ maxConcurrentRequests: 1 });
    await drive.branches.create({ name: 'alternate' });
    const alternate = drive.at({ branch: 'alternate' });
    const entered = gate(), release = gate();
    f.search = async request => {
        if (request.query.knn.queryText === 'blocking') { entered.open(); await release.promise; }
        return [];
    };
    const blocker = drive.recall({ query: 'blocking' });
    await entered.promise;
    const input = { query: 'before', recentDialogue: [{ role: 'user', content: 'original' }] };
    const queued = drive.recall({ requests: [input] });
    const stale = alternate.recall({ requests: [{ query: 'stale' }] });
    input.query = 'after'; input.recentDialogue[0].content = 'changed';
    await drive.branches.delete('alternate');
    await drive.branches.create({ name: 'alternate' });
    release.open();
    const [, result, invalidated] = await Promise.all([blocker, queued, stale]);
    assert.equal(result.results[0].error, undefined);
    const requests = f.calls.filter(call => call.kind === 'query');
    assert.equal(requests.length, 2);
    assert.deepEqual(JSON.parse(requests[1].request.query.knn.queryText), {
        question: 'before', recent_dialogue: [{ role: 'user', content: 'original' }],
    });
    assert.equal(invalidated.results[0].error.code, 'BRANCH_INVALIDATED');
    assert.equal(invalidated.results[0].usage.databaseRequests, 0);
});

test('batch callbacks identify each request while singles omit the batch index', async () => {
    const events = [], records = [];
    const { fixture: f, drive } = await setup({
        observe: event => events.push(event), record: event => records.push(event),
    });
    await drive.remember({ mems: ['a', 'b'].map(id => ({ id, content: id })) });
    f.search = (request, docs) => docs.filter(doc => doc.memId === request.query.knn.queryText);
    const { results } = await drive.recall({ requests: [{ query: 'a' }, { query: 'b' }] });
    assert.deepEqual(events.sort((a, b) => a.requestIndex - b.requestIndex).map(event => ({
        index: event.requestIndex, type: event.type, memId: event.matches[0].memId,
    })), [{ index: 0, type: 'retrieved', memId: 'a' }, { index: 1, type: 'retrieved', memId: 'b' }]);
    assert(records.every(event => [0, 1].includes(event.requestIndex) && !Object.hasOwn(event, 'mode')));
    assert.deepEqual([...new Set(records.map(event => event.phase))].sort(), ['query', 'query_result']);
    assert(results.every(result => result.usage.databaseRequests === 1));
    events.length = 0; records.length = 0;
    await drive.recall({ query: 'a' });
    assert(events.every(event => !Object.hasOwn(event, 'requestIndex')));
    assert(records.every(event => !Object.hasOwn(event, 'requestIndex')));
});
