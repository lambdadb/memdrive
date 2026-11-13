import test from 'node:test';
import assert from 'node:assert/strict';
import { create, open } from '../dist/esm/index.js';
import { memdriveClient } from './helpers/memdrive-client.mjs';

const embedding = { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'application-vector-v1' };
const vector = Array.from({ length: 64 }, (_, index) => index === 0 ? 1 : 0);
const schema = { label: { type: 'string' } };
const createDrive = (fixture, options = {}) => create({ client: fixture.client, name: 'external_test',
    metadataSchema: schema, embedding, ...options });

test('external vectors round-trip IDs and metadata through reopen, branch recall and schema configuration', async () => {
    const f = memdriveClient(), events = [];
    const drive = await createDrive(f, { observe: event => events.push(event) });
    const input = { id: 'known', embedding: vector, timestamp: '2026-01-01T00:00:00Z', metadata: { label: 'first' } };
    assert(Object.isFrozen(drive.embedding));
    assert.deepEqual(drive.embedding, embedding);
    assert.throws(() => { drive.embedding.identity = 'changed'; }, TypeError);
    const remembered = await drive.remember({ mems: [input, { embedding: vector }] });
    assert.equal(remembered.ids[0], 'known'); assert.equal(remembered.ids.length, 2);
    const write = f.calls.find(call => call.kind === 'upsert').request;
    assert.equal(write.docs.length, 2);
    for (const doc of write.docs) {
        assert.deepEqual(doc.embedding, vector); assert.equal(doc.kind, 'mem');
        for (const field of ['content', 'memContent', 'start', 'end', 'chunkCount', 'chunkSlots']) assert.equal(doc[field], undefined);
    }
    const { embedding: _vector, ...original } = input;
    assert.deepEqual((await drive.read({ ids: ['missing', 'known'] })).mems, [original]);
    f.search = (_request, docs) => docs.filter(doc => doc.memId === 'known');
    const result = await drive.recall({ queryVector: vector, limit: 3,
        filter: { field: 'metadata.label', op: 'eq', value: 'first' }, excludeIds: ['other'] });
    assert.deepEqual(result.matches, [{ kind: 'mem', memId: 'known', timestamp: input.timestamp, metadata: input.metadata }]);
    assert.equal(result.usage.databaseRequests, 1); assert.equal(Object.hasOwn(result.usage, 'models'), false);
    const request = f.calls.findLast(call => call.kind === 'query').request;
    assert.deepEqual(request.query.knn.queryVector, vector); assert.equal(request.query.knn.k, 3);
    assert.equal(request.rerank, undefined); assert.equal(request.includeVectors, false);
    assert.deepEqual(events.map(event => event.matches), [result.matches]);
    await drive.branches.create({ name: 'alternate' });
    const reopened = await open({ client: f.client, name: 'external_test', branch: 'alternate' });
    assert.deepEqual(reopened.embedding, embedding);
    await reopened.configure({ metadataSchema: { ...schema, group: { type: 'number' } } });
    assert.deepEqual(reopened.at({ branch: 'main' }).embedding, embedding);
    assert.deepEqual((await reopened.recall({ queryVector: vector, rerank: false })).matches, result.matches);
    assert.equal(f.calls.findLast(call => call.kind === 'query').request.rerank, undefined);
    assert.equal(f.calls.findLast(call => call.kind === 'query').request.ref.name, 'alternate');
    const stored = f.collections.get('external_test').metadata;
    assert.deepEqual(stored.indexConfigs.embedding, { type: 'vector', dimensions: 64, similarity: 'cosine' });
    assert.equal(stored.tags['memory.embedding'], embedding.identity);
    assert.equal(stored.tags['memory.profile'], undefined);
});

test('invalid embedding configuration and unsupported external creation fail before native operations', async () => {
    const invalidConfigs = [null, {}, { mode: 'managed', dimensions: 64 }, { mode: 'managed', model: 'other' }, { ...embedding, dimensions: 63 },
        { ...embedding, dimensions: 4097 }, { ...embedding, dimensions: 64.5 }, { ...embedding, similarity: 'dot_product' },
        { ...embedding, identity: '' }, { ...embedding, identity: ' ' }, { ...embedding, identity: 'x'.repeat(128) },
        ...['a:b', 'a#b', 'a,b'].map(identity => ({ ...embedding, identity })), { ...embedding, extra: true }];
    for (const value of invalidConfigs) {
        const f = memdriveClient();
        await assert.rejects(createDrive(f, { embedding: value }), { code: 'INVALID_INPUT' });
        assert.equal(f.calls.length, 0);
    }
    for (const options of [{ textSearch: { analyzers: ['english'] } },
        { mode: 'agentic' }, { agent: {} }]) {
        const f = memdriveClient();
        await assert.rejects(createDrive(f, options), { code: 'INVALID_INPUT' });
        assert.equal(f.calls.length, 0);
    }
});

test('external writes and recalls reject text, malformed vectors and model modes before dispatch', async () => {
    const f = memdriveClient(), drive = await createDrive(f);
    const invalidVectors = [[], vector.slice(1), [...vector, 1], Array(64).fill(0),
        [NaN, ...vector.slice(1)], [Infinity, ...vector.slice(1)], ['1', ...vector.slice(1)], new Float32Array(vector)];
    const before = f.calls.length;
    for (const value of invalidVectors) {
        await assert.rejects(drive.remember({ mems: [{ embedding: vector }, { embedding: value }] }), { code: 'INVALID_INPUT' });
        await assert.rejects(drive.recall({ queryVector: value }), error => error.code === 'INVALID_INPUT'
            && error.usage.databaseRequests === 0 && !Object.hasOwn(error.usage, 'models'));
    }
    for (const request of [{ query: 'text' }, { queryVector: vector, query: 'mixed' },
        { queryVector: vector, context: 'context' }, { queryVector: vector, recentDialogue: [] },
        { queryVector: vector, mode: 'agentic' }, { queryVector: vector, rerank: true }])
        await assert.rejects(drive.recall(request), { code: 'INVALID_INPUT' });
    await assert.rejects(drive.remember({ mems: [{ embedding: vector, content: 'unexpected text' }] }), { code: 'INVALID_INPUT' });
    assert.equal(f.calls.length, before);
    f.search = () => [{ id: 'wrong', kind: 'mem', memId: 'known', content: 'not an external Mem' }];
    await assert.rejects(drive.recall({ queryVector: vector }), { code: 'INVALID_RESULT' });
});

test('listing reads one physical page with a branch cursor and returns only original Mems without vectors', async () => {
    const f = memdriveClient();
    const drive = await createDrive(f, { embedding: undefined });
    await drive.remember({ mems: [{ id: 'long', content: 'x'.repeat(900) }, { id: 'short', content: 'last' }] });
    await drive.branches.create({ name: 'alternate' });
    const branch = drive.at({ branch: 'alternate' });
    const first = await branch.list({ limit: 1 });
    assert.deepEqual(first.mems, [{ id: 'long', content: 'x'.repeat(900) }]);
    assert.equal(typeof first.nextCursor, 'string');
    const second = await branch.list({ limit: 1, cursor: first.nextCursor });
    assert.deepEqual(second.mems, []); assert.equal(typeof second.nextCursor, 'string');
    const third = await branch.list({ limit: 1, cursor: second.nextCursor });
    assert.deepEqual(third.mems, []); assert.equal(typeof third.nextCursor, 'string');
    const last = await branch.list({ limit: 1, cursor: third.nextCursor });
    assert.deepEqual(last, { mems: [{ id: 'short', content: 'last' }] });
    assert.equal(f.calls.filter(call => call.kind === 'list').length, 4);
    const native = f.calls.findLast(call => call.kind === 'list').request;
    assert.deepEqual(native.ref, { kind: 'branch', name: 'alternate' });
    assert.equal(native.includeVectors, false); assert.equal(native.consistentRead, undefined);
    const before = f.calls.length;
    for (const request of [{ limit: 0 }, { limit: 1001 }, { cursor: '' }, { cursor: 1 }, { filter: {} }, null])
        await assert.rejects(drive.list(request), { code: 'INVALID_INPUT' });
    assert.equal(f.calls.length, before);
    f.list = () => ({ isDocsInline: true, docs: [{ doc: { id: 'wrong', kind: 'mem', memId: 'bad' } }] });
    await assert.rejects(branch.list(), { code: 'INVALID_RESULT' });
    f.list = () => ({ isDocsInline: true, docs: [], nextPageToken: 'stalled' });
    await assert.rejects(branch.list({ cursor: 'stalled' }), { code: 'INVALID_RESULT' });
    const e = memdriveClient(), external = await createDrive(e);
    await external.remember({ mems: [{ id: 'known', embedding: vector, metadata: { label: 'listed' } }] });
    assert.deepEqual(await external.list(), { mems: [{ id: 'known', metadata: { label: 'listed' } }] });
});
