import test from 'node:test';
import assert from 'node:assert/strict';
import { create, MemDriveError } from '../dist/esm/index.js';
import { memdriveClient, modelAdapter, modelResponse } from './helpers/memdrive-client.mjs';

const gate = () => {
    let open;
    const promise = new Promise(resolve => { open = resolve; });
    return { promise, open };
};
const setup = async options => {
    const fixture = memdriveClient();
    const drive = await create({ client: fixture.client, name: 'batch_test', metadataSchema: {}, mode: 'single_pass', ...options });
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
    assert(result.results.every(item => item.usage.models.length === 0));
    assert.deepEqual(result.results[2].error, { code: 'DATABASE_ERROR', message: 'MemDrive query failed.', status: 503 });
    const encoded = JSON.stringify(result);
    for (const text of ['private backend detail', 'private-token', 'cause', 'stack', 'details']) assert(!encoded.includes(text));
    await assert.rejects(drive.recall({ query: 'fail' }), error => error instanceof MemDriveError
        && error.code === 'DATABASE_ERROR' && error.usage.databaseRequests === 1);
    await assert.rejects(drive.recall({ query: () => 'uncloneable' }), error => error instanceof MemDriveError
        && error.code === 'INVALID_INPUT' && error.usage.databaseRequests === 0);
});

test('invalid outer batch envelopes reject before database or model work', async () => {
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

test('agent batches bound model calls and isolate histories, evidence aliases, callbacks and usage', async () => {
    const started = [gate(), gate(), gate()], releases = [gate(), gate(), gate()];
    const events = [], records = [], finalEvidence = [];
    let active = 0, peak = 0;
    const agent = { model: modelAdapter(async request => {
        const question = JSON.parse(request.input[0].content).question;
        const index = Number(question);
        active++; peak = Math.max(peak, active);
        try {
            const outputs = request.input.filter(item => item.type === 'function_call_output');
            if (!outputs.length) {
                assert.equal(request.input.length, 1);
                started[index].open(); await releases[index].promise;
                return modelResponse([['search_semantic', { query: question }]], { input_tokens: 10, output_tokens: 2 });
            }
            assert.equal(outputs.length, 1);
            const shown = JSON.parse(outputs[0].output).new_evidence;
            assert.equal(shown.length, 1); assert.equal(shown[0].id, 'e1');
            assert.equal(shown[0].content, question);
            finalEvidence.push(question);
            return modelResponse([['report_helpful_ids', { ids: ['e1'] }]], { input_tokens: 20, output_tokens: 3 });
        } finally { active--; }
    }) };
    const { fixture: f, drive } = await setup({ mode: 'agentic', agent, maxConcurrentRequests: 2,
        observe: event => events.push(event), record: event => records.push(event) });
    await drive.remember({ mems: ['0', '1', '2'].map(id => ({ id, content: id })) });
    f.search = (request, docs) => docs.filter(doc => doc.memId === request.query.knn.queryText);
    const batch = drive.recall({ requests: [{ query: '0' }, { query: '1' }, { query: '2' }] });
    await Promise.all([started[0].promise, started[1].promise]);
    assert.equal(active, 2); assert.equal(f.calls.filter(call => call.kind === 'query').length, 0);
    releases[1].open(); await started[2].promise;
    releases[2].open(); releases[0].open();
    const { results } = await batch;
    assert.equal(peak, 2); assert.equal(finalEvidence[0], '1');
    assert.deepEqual(results.map(result => result.matches[0].memId), ['0', '1', '2']);
    for (const result of results) {
        assert.equal(result.usage.databaseRequests, 1);
        assert.equal(result.usage.models[0].calls, 2);
        assert.equal(result.usage.models[0].inputTokens, 30);
    }
    assert(events.every(event => [0, 1, 2].includes(event.requestIndex)));
    assert(records.every(event => [0, 1, 2].includes(event.requestIndex)));
    assert.deepEqual(events.filter(event => event.type === 'selected').sort((a, b) => a.requestIndex - b.requestIndex)
        .map(event => event.matches[0].memId), ['0', '1', '2']);
    events.length = 0; records.length = 0;
    await drive.recall({ query: '0' });
    assert(events.every(event => !Object.hasOwn(event, 'requestIndex')));
    assert(records.every(event => !Object.hasOwn(event, 'requestIndex')));
});
