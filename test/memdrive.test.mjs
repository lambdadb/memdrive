import test from 'node:test';
import assert from 'node:assert/strict';
import { create, open, contextualQuery } from '../dist/esm/index.js';
import { sourceMatch, publicMatch } from '../dist/esm/storage.js';
import { memdriveClient } from './helpers/memdrive-client.mjs';

const schema = { tags: { type: 'string[]' }, role: { type: 'string' } };
const mem = { id: 'mem-1', content: 'My wrist needs support.', metadata: { role: 'user', tags: ['tennis', 'health'] } };

test('explicit managed embedding matches the omitted default and survives reopen', async () => {
    const configurations = [];
    for (const embedding of [undefined, { mode: 'managed' }]) {
        const f = memdriveClient();
        const drive = await create({ client: f.client, name: 'sdk_test', metadataSchema: {}, embedding });
        const reopened = await open({ client: f.client, name: 'sdk_test' });
        assert.deepEqual(reopened.embedding, drive.embedding);
        assert.equal(drive.embedding.mode, 'managed');
        configurations.push(f.calls.find(call => call.kind === 'create').request);
    }
    assert.deepEqual(configurations[0], configurations[1]);
});

test('managed recall applies rerank per batch item for vector and hybrid searches', async () => {
    for (const textSearch of [undefined, { analyzers: ['english'] }]) {
        const f = memdriveClient();
        const drive = await create({ client: f.client, name: 'sdk_test', metadataSchema: schema, textSearch });
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
        await assert.rejects(open({ client: f.client, name: 'sdk_test', rerank: false }), { code: 'INVALID_INPUT' });
        await assert.rejects(create({ client: f.client, name: 'other_test', rerank: false }), { code: 'INVALID_INPUT' });
        assert.equal(f.calls.length, before);
    }
});

test('recall uses one contextual native hybrid+rerank request and returns source-bound matches across reopen', async () => {
    const f = memdriveClient(), events = [];
    const drive = await create({ client: f.client, name: 'sdk_test', metadataSchema: schema, textSearch: { analyzers: ['english'] } });
    await drive.remember({ mems: [mem] });
    const opened = await open({ client: f.client, name: 'sdk_test', observe: e => events.push(e) });
    f.search = (_request, docs) => docs;
    const request = { query: 'What support?', recentDialogue: [{ role: 'user', content: 'For my tennis injury.' }],
        context: 'Plays tennis.', filter: { field: 'metadata.tags', op: 'eq', value: 'tennis' } };
    const result = await opened.recall(request);
    assert.deepEqual(result.matches, [publicMatch(await sourceMatch(mem))]);
    assert.equal(result.usage.databaseRequests, 1); assert.equal(Object.hasOwn(result.usage, 'models'), false);
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
    assert.deepEqual(events.map(({ type, matches }) => ({ type, matches })), [
        { type: 'retrieved', matches: result.matches }]);
});

test('recall rejects missing rerank confirmation and out-of-filter results, never silently degrades', async () => {
    const f = memdriveClient();
    const drive = await create({ client: f.client, name: 'sdk_test', metadataSchema: schema });
    await drive.remember({ mems: [mem] });
    f.search = (_request, docs) => ({ docs: [{ doc: docs[0] }], isDocsInline: true });
    await assert.rejects(drive.recall({ query: 'wrist' }), error => error.code === 'RERANK_FAILED' && error.usage.databaseRequests === 1);
    await assert.rejects(drive.recall({ query: 'wrist', filter: { field: 'metadata.role', op: 'eq', value: 'assistant' } }),
        error => error.code === 'INVALID_RESULT');
    await assert.rejects(drive.recall({ query: 'wrist', excludeIds: ['mem-1'] }), error => error.code === 'INVALID_RESULT');
});

test('invalid runtime options fail before creation and oversized recall context fails before querying', async () => {
    const f = memdriveClient();
    await assert.rejects(create({ client: f.client, name: 'sdk_test', metadataSchema: {}, mode: 'agentic' }), { code: 'INVALID_INPUT' });
    for (const invalid of [{ strategy: 'direct' }, { mode: 'single_pass' }, { mode: 'agentic' }, { agent: {} }]) {
        await assert.rejects(create({ client: f.client, name: 'sdk_test', metadataSchema: {}, ...invalid }), { code: 'INVALID_INPUT' });
        await assert.rejects(open({ client: f.client, name: 'sdk_test', ...invalid }), { code: 'INVALID_INPUT' });
    }
    assert.equal(f.calls.length, 0);
    const drive = await create({ client: f.client, name: 'sdk_test', metadataSchema: {} });
    for (const invalid of [{ strategy: 'direct' }, { mode: 'single_pass' }, { mode: 'agentic' }, { agent: {} }])
        await assert.rejects(drive.recall({ query: 'q', ...invalid }), { code: 'INVALID_INPUT' });
    await assert.rejects(drive.recall({ query: 'q', context: 'x'.repeat(8193) }), /8 KiB/);
    assert.equal(f.calls.filter(call => call.kind === 'query').length, 0);
    await assert.rejects(drive.recall({ query: 'q', mode: 'agentic' }), { code: 'INVALID_INPUT' });
});

test('one opened handle bounds concurrent recalls rather than creating a queue per question', async () => {
    const f = memdriveClient();
    const drive = await create({ client: f.client, name: 'sdk_test', metadataSchema: {}, maxConcurrentRequests: 2 });
    let active = 0, peak = 0;
    f.search = async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return []; };
    await Promise.all(Array.from({ length: 6 }, () => drive.recall({ query: 'q' })));
    assert.equal(peak, 2);
});

test('recall hybrid search has no kind filter and rejects nonsearchable sources or retired slots', async () => {
    const f = memdriveClient();
    const drive = await create({ client: f.client, name: 'sdk_test', metadataSchema: schema, textSearch: { analyzers: ['english'] } });
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

test('stored analyzer configuration determines retrieval across reopen, branch views and schema updates', async () => {
    for (const analyzers of [undefined, ['standard'], ['english'], ['english', 'korean']]) {
        const f = memdriveClient();
        const drive = await create({ client: f.client, name: 'sdk_test', metadataSchema: {},
            ...(analyzers === undefined ? {} : { textSearch: { analyzers } }) });
        const contentIndex = f.calls.find(call => call.kind === 'create').request.indexConfigs.content;
        assert.deepEqual(contentIndex, analyzers === undefined ? undefined : { type: 'text', analyzers });
        const reopened = await open({ client: f.client, name: 'sdk_test' });
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
        await assert.rejects(create({ client: f.client, name: 'sdk_test', metadataSchema: {}, textSearch }),
            { code: 'INVALID_INPUT' });
        assert.equal(f.calls.length, 0);
    }
    const f = memdriveClient();
    const drive = await create({ client: f.client, name: 'sdk_test', metadataSchema: {} });
    const before = f.calls.length;
    await assert.rejects(open({ client: f.client, name: 'sdk_test', textSearch: { analyzers: ['standard'] } }),
        { code: 'INVALID_INPUT' });
    await assert.rejects(drive.configure({ textSearch: { analyzers: ['standard'] } }), { code: 'INVALID_INPUT' });
    assert.equal(f.calls.length, before);
});

test('ordinary searches cannot return replaced text from bodyless retired slots', async () => {
    const f = memdriveClient();
    const drive = await create({ client: f.client, name: 'sdk_test', metadataSchema: {} });
    await drive.remember({ mems: [{ id: 'changing', content: 'obsolete '.repeat(200) }] });
    f.search = (_request, docs) => docs.filter(doc => doc.content.includes('obsolete'));
    assert((await drive.recall({ query: 'obsolete' })).matches.length > 0);
    await drive.remember({ mems: [{ id: 'changing', content: 'replacement' }] });
    assert.deepEqual((await drive.recall({ query: 'obsolete' })).matches, []);
});

test('exact match-all queries reject before database dispatch', async () => {
    const f = memdriveClient();
    const drive = await create({ client: f.client, name: 'sdk_test', metadataSchema: {} });
    const before = f.calls.length;
    for (const query of ['*:*', ' \n*:*\t'])
        await assert.rejects(drive.recall({ query }), { code: 'INVALID_INPUT' });
    assert.equal(f.calls.length, before);
});

test('recall exposes source spans and read returns the complete original for caller assembly', async () => {
    const f = memdriveClient();
    const drive = await create({ client: f.client, name: 'sdk_test', metadataSchema: {} });
    const original = { id: 'long', content: 'a'.repeat(800) + 'b'.repeat(100) };
    await drive.remember({ mems: [original] });
    f.search = (_request, docs) => docs.slice(-1);
    const result = await drive.recall({ query: 'b' });
    assert.deepEqual(result.matches, [{ kind: 'chunk', memId: 'long', start: 800, end: 900, content: 'b'.repeat(100) }]);
    assert.deepEqual((await drive.read({ ids: [result.matches[0].memId, 'missing'] })).mems, [original]);
});

test('diagnostic callback failures reject explicitly and do not return partial results', async () => {
    for (const hook of ['record', 'observe']) {
        const f = memdriveClient();
        const drive = await create({ client: f.client, name: 'hooks_test', metadataSchema: {},
            [hook]: () => { throw new Error('Cannot record.'); } });
        await assert.rejects(drive.recall({ query: 'fact' }), error => error.code === 'RECALL_FAILED'
            && error.cause.message === 'Cannot record.' && error.usage.databaseRequests === (hook === 'record' ? 0 : 1));
    }
});
