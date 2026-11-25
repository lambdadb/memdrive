import assert from 'node:assert/strict';
import test from 'node:test';
import { create, open } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

const request = (path, content = '') => ({ op: 'create', path, content });
const fork = name => ({ kind: 'fork', name });
const checkpoint = name => ({ kind: 'checkpoint', name });
const research = fork('research');

test('file stores round-trip exact text and empty originals by path and stable ID', async () => {
    const fixture = fileClient();
    const { client, calls } = fixture;
    const drive = await create({ client, name: 'workspace' });
    assert.deepEqual(await drive.fork({ name: 'research' }), { at: research });
    const path = '/notes/한글 "draft":*?.md';
    const content = '﻿# Task\r\n  café\t😀\n\u0000\n';
    const file = await drive.write({ at: research, ...request(path, content) });
    const empty = await drive.write({ at: research, ...request('/empty.txt') });
    assert.notEqual(empty.fileId, file.fileId);
    assert.notEqual(file.fileId, path);
    assert.deepEqual(file, { fileId: file.fileId, modifiedAt: file.modifiedAt, path, content });
    assert.equal(empty.content, '');

    const otherClient = { ...client };
    const reopened = await open({ client: otherClient, name: 'workspace' });
    assert.notStrictEqual(reopened, drive);
    assert.deepEqual(await reopened.read({ at: research, path }), file);
    assert.deepEqual(await reopened.read({ at: research, fileId: file.fileId }), file);
    assert.deepEqual(await reopened.read({ at: research, path: empty.path }), empty);
    assert.equal(await drive.read({ fileId: file.fileId }), null);
    assert.equal(await drive.read({ at: { kind: 'main' }, fileId: file.fileId }), null);
    const { at: alternate } = await drive.fork({ name: 'alternate' });
    assert.equal(await drive.read({ at: alternate, path }), null);
    assert.notEqual((await drive.write({ at: alternate, ...request(path) })).fileId, file.fileId);

    const writes = calls.filter(call => call.kind === 'upsert');
    assert.deepEqual(writes.map(call => call.request.branch), ['fork-research', 'fork-research', 'fork-alternate']);
    const [chunk, original] = writes[0].request.docs;
    const { revision, chunking, ...storedOriginal } = original;
    assert.equal(typeof revision, 'string');
    assert.deepEqual(chunking, { strategy: 'boundary', version: '1' });
    assert.deepEqual(storedOriginal, {
        id: `file:${file.fileId}`, kind: 'file', fileId: file.fileId, path, body: content, modifiedAt: file.modifiedAt,
        fileName: '한글 "draft":*?.md', ancestorPaths: ['/', '/notes/'],
    });
    assert.equal(chunk.kind, 'chunk');
    assert.equal(chunk.content, content);
    assert.equal(chunk.start, 0);
    assert.equal(chunk.end, content.length);
    assert.deepEqual(writes[1].request.docs[0].ancestorPaths, ['/']);
    assert.equal(calls.filter(call => call.kind === 'fetch').every(call => call.request.consistentRead), true);
    const lookup = calls.find(call => call.kind === 'query').request;
    assert.deepEqual(lookup, {
        // Large enough to see every file at a destination, including ones that share it.
        size: 1000, ref: { kind: 'branch', name: 'fork-research' }, consistentRead: true, includeVectors: false,
        fields: { include: ['id', 'kind', 'fileId', 'path'] },
        query: { bool: [
            { queryString: { query: '"file"', defaultField: 'kind' }, occur: 'filter' },
            { queryString: { query: JSON.stringify(path), defaultField: 'path' }, occur: 'filter' },
        ] },
    });
});

test('omitted at reads and writes the main branch directly, isolated from forks', async () => {
    const fixture = fileClient();
    const { calls } = fixture;
    const drive = await create({ client: fixture.client, name: 'workspace' });
    const file = await drive.write(request('/main.txt', 'on main'));
    assert.deepEqual(calls.filter(call => call.kind === 'upsert').map(call => call.request.branch), ['main']);
    assert.deepEqual(await drive.read({ at: { kind: 'main' }, fileId: file.fileId }), await drive.read({ fileId: file.fileId }));
    assert.equal((await drive.read({ path: '/main.txt' })).content, 'on main');
    // Main reads are consistent branch reads; there is no published tag.
    assert.deepEqual(calls.filter(call => call.kind === 'fetch').map(call => [call.request.ref, call.request.consistentRead]).at(-1),
        [{ kind: 'branch', name: 'main' }, true]);
    assert.equal(calls.some(call => call.kind === 'tag-create' || call.kind === 'branch-create'), false);

    await drive.fork({ name: 'research' });
    await drive.write({ at: research, op: 'update', fileId: file.fileId, content: 'fork edit' });
    const added = await drive.write({ at: { kind: 'main' }, operations: [request('/later.txt', 'main only')] });
    assert.equal((await drive.read({ fileId: file.fileId })).content, 'on main');
    assert.equal((await drive.read({ at: research, fileId: file.fileId })).content, 'fork edit');
    assert.equal(await drive.read({ at: research, fileId: added[0].fileId }), null);
    assert.deepEqual(await drive.list(), await drive.list({ at: { kind: 'main' } }));
    assert.deepEqual((await drive.write({ op: 'delete', fileId: file.fileId })), { fileId: file.fileId });
    assert.equal(await drive.read({ fileId: file.fileId }), null);
    assert.equal((await drive.read({ at: research, fileId: file.fileId })).content, 'fork edit');
});

test('checkpoints reject writes before storage access', async () => {
    const fixture = fileClient();
    const drive = await create({ client: fixture.client, name: 'workspace' });
    await drive.checkpoint({ name: 'saved' });
    const before = fixture.calls.length;
    await assert.rejects(drive.write({ at: checkpoint('saved'), ...request('/x.txt') }), { code: 'INVALID_INPUT', message: /read-only/ });
    await assert.rejects(drive.write({ at: checkpoint('saved'), operations: [request('/x.txt')] }), { code: 'INVALID_INPUT' });
    await assert.rejects(drive.write({ at: research, operations: [request('/x.txt')], op: 'create' }), { code: 'INVALID_INPUT' });
    for (const removed of ['diff', 'merge', 'status', 'history', 'configure']) assert.equal(drive[removed], undefined);
    assert.equal(fixture.calls.length, before);
});

test('invalid at shapes are rejected before storage access', async () => {
    const fixture = fileClient();
    const drive = await create({ client: fixture.client, name: 'workspace' });
    await drive.fork({ name: 'research' });
    const before = fixture.calls.length;
    for (const at of [null, 'main', [], {}, { kind: 'main', name: 'main' }, { kind: 'fork' }, { kind: 'fork', name: 'main' },
        { kind: 'fork', name: 'ab' }, { kind: 'fork', name: 'x'.repeat(48) }, { kind: 'fork', name: 'bad/name' },
        { kind: 'checkpoint', name: 'x'.repeat(42) }, { kind: 'fork', name: 'research', extra: true },
        { fork: 'research' }, { kind: 'branch', name: 'research' }]) {
        await assert.rejects(drive.read({ at, path: '/a' }), { code: 'INVALID_INPUT' }, JSON.stringify(at));
        await assert.rejects(drive.list({ at }), { code: 'INVALID_INPUT' });
        await assert.rejects(drive.write({ at, ...request('/a') }), { code: 'INVALID_INPUT' });
    }
    assert.equal(fixture.calls.length, before);
});

test('path uniqueness is checked before writing but is best effort across concurrent writers', async () => {
    const fixture = fileClient();
    const { client, calls } = fixture;
    const drive = await create({ client, name: 'workspace' });
    await drive.write(request('/a.txt', 'first'));
    await assert.rejects(drive.write(request('/a.txt', 'second')), { code: 'PATH_EXISTS', details: { paths: ['/a.txt'] } });
    assert.equal(calls.filter(call => call.kind === 'upsert').length, 1);
    // Unserialized writers both pass the read-then-write check; nothing orders them.
    const reopened = await open({ client, name: 'workspace' });
    let arrived = 0, release;
    const bothChecked = new Promise(resolve => { release = resolve; });
    fixture.beforeUpsert = async () => { if (++arrived === 2) release(); await bothChecked; };
    const raced = await Promise.all([drive.write(request('/b.txt', 'one')), reopened.write(request('/b.txt', 'two'))]);
    assert.notEqual(raced[0].fileId, raced[1].fileId);
});

test('an uncertain write is reported with its targets and does not block later writes', async () => {
    const fixture = fileClient();
    const { client, calls } = fixture;
    const drive = await create({ client, name: 'workspace' });
    await drive.fork({ name: 'research' });
    fixture.beforeUpsert = body => {
        if (body.docs[0].path === '/a.txt') throw new Error('Connection lost');
    };
    let details;
    await assert.rejects(drive.write({ at: research, ...request('/a.txt', 'exact') }), error => {
        assert.equal(error.code, 'WRITE_UNCONFIRMED');
        assert.equal(error.status, undefined);
        details = error.details;
        assert.equal(details.path, '/a.txt');
        assert.equal(details.stage, 'write-original');
        return true;
    });
    // No fence: the caller inspects and decides. A retry is an ordinary new write.
    fixture.beforeUpsert = undefined;
    assert.equal(await drive.read({ at: research, fileId: details.fileId }), null);
    assert.equal((await drive.write({ at: research, ...request('/a.txt', 'retried') })).content, 'retried');
    assert.equal(calls.filter(call => call.kind === 'upsert').length, 2);
    // A definite rejection keeps its status and is not reported as uncertain.
    fixture.beforeUpsert = () => { throw Object.assign(new Error('Too large'), { statusCode: 413 }); };
    await assert.rejects(drive.write({ at: research, ...request('/b.txt') }), { code: 'DATABASE_ERROR', status: 413 });
});

test('invalid paths, unsupported targets and legacy collections fail without writes', async () => {
    const { client, calls } = fileClient();
    await client.createCollection({ collectionName: 'legacy', indexConfigs: { memId: { type: 'keyword' } },
        tags: { 'memory.format': 'mems-v0' } });
    await assert.rejects(open({ client, name: 'legacy' }), { code: 'INCOMPATIBLE_STORE' });
    await assert.rejects(open({ client, name: 'absent' }), { code: 'STORE_NOT_FOUND' });
    const drive = await create({ client, name: 'workspace' });
    await assert.rejects(open({ client, name: 'workspace', at: research }), { code: 'INVALID_INPUT' });
    await assert.rejects(drive.read({ at: fork('absent'), path: '/a' }), { code: 'BRANCH_NOT_FOUND', status: 404 });
    await assert.rejects(drive.write({ at: fork('absent'), ...request('/a') }), { code: 'BRANCH_NOT_FOUND', status: 404 });
    await assert.rejects(drive.read({ at: checkpoint('absent'), path: '/a' }), { code: 'CHECKPOINT_NOT_FOUND', status: 404 });
    await assert.rejects(drive.fork({ name: 'main' }), { code: 'INVALID_INPUT' });
    await drive.fork({ name: 'research' });
    for (const path of ['relative', '/', '/a//b', '/a/../b', '/a/./b', '/a/', '/a\\b', '/a\n']) {
        await assert.rejects(drive.write({ at: research, ...request(path) }), { code: 'INVALID_INPUT' });
    }
    await assert.rejects(drive.write({ at: research, ...request('/bad', '\uD800') }), { code: 'INVALID_INPUT' });
    await assert.rejects(drive.read({ at: research, path: '/a', fileId: 'invalid' }), { code: 'INVALID_INPUT' });
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(drive.write({ at: research, ...request('/valid') }, { signal: stop.signal }), { code: 'ABORTED' });
    assert.equal(calls.some(call => call.kind === 'upsert'), false);
});

test('batched writes and reads share requests, propagate metadata, and validate before dispatch', async () => {
    const fixture = fileClient();
    const { client, calls } = fixture;
    const metadataSchema = { topic: { type: 'string', description: 'Original topic.' }, ordinal: { type: 'number' } };
    const labels = { 'eval.owner': 'test', 'eval.scope': 'synthetic' };
    const drive = await create({ client, name: 'workspace', labels, metadataSchema, textSearch: { analyzers: ['english'] } });
    await drive.fork({ name: 'research' });
    const before = calls.length;
    const [first, second] = await drive.write({ at: research, operations: [
        { ...request('/first', 'Original content.'), metadata: { topic: 'math', ordinal: 2 } },
        request('/second', '   \n'),
    ] });
    assert.deepEqual(calls.slice(before).map(call => call.kind), ['query', 'upsert', 'fetch']);
    assert.deepEqual(first.metadata, { topic: 'math', ordinal: 2 });
    assert.equal(second.content, '   \n');
    const docs = calls.find(call => call.kind === 'upsert').request.docs;
    assert.equal(docs.length, 3);
    assert.deepEqual(docs[0].metadata, first.metadata);
    assert.equal(docs[2].kind, 'file');

    const reopened = await open({ client: { ...client }, name: 'workspace' });
    const description = await reopened.describe();
    assert.deepEqual(description.labels, labels);
    assert.deepEqual(description.metadataSchema, metadataSchema);
    assert.deepEqual(description.textSearch, { analyzers: ['english'] });
    assert.deepEqual(fixture.collections.get('workspace').metadata.indexConfigs.embedding.embedding.sources, [{ field: 'embeddingText', type: 'text' }]);
    assert.deepEqual(await reopened.read({ at: research, paths: ['/second', '/missing', '/first'] }), [second, first]);

    await assert.rejects(reopened.write({ at: research, operations: [request('/untouched'), request('/first')] }), { code: 'PATH_EXISTS' });
    await assert.rejects(reopened.write({ at: research, operations: [request('/untouched'), request('/untouched')] }), { code: 'INVALID_INPUT' });
    await assert.rejects(reopened.write({ at: research, ...request('/invalid'), metadata: { ordinal: '2' } }), { code: 'INVALID_INPUT' });
    assert.equal(await reopened.read({ at: research, path: '/untouched' }), null);
    assert.equal(calls.filter(call => call.kind === 'upsert').length, 1);
});

test('managed stores leave original bodies and embedding text unindexed and reject either index', async () => {
    const fixture = fileClient();
    const drive = await create({ client: fixture.client, name: 'workspace', textSearch: { analyzers: ['english'] } });
    const configs = () => fixture.collections.get('workspace').metadata.indexConfigs;
    assert.equal(Object.hasOwn(configs(), 'body'), false);
    assert.deepEqual(configs().content, { type: 'text', analyzers: ['english'] });
    assert.equal(Object.hasOwn(configs(), 'embeddingText'), false);
    // Unindexed originals still round-trip and serve literal scans, including Korean text.
    await drive.fork({ name: 'research' });
    const content = '회의록: 한글 검색과 한글 원문';
    const file = await drive.write({ at: research, ...request('/notes/회의.md', content) });
    assert.equal((await drive.read({ at: research, fileId: file.fileId })).content, content);
    assert.deepEqual((await drive.findText({ at: research, query: '한글' })).hits.map(hit => hit.range.start), [5, 12]);
    const original = structuredClone(configs());
    for (const change of [
        indexes => { indexes.body = { type: 'text', analyzers: ['english'] }; },
        indexes => { indexes.body = { type: 'keyword' }; },
        indexes => { indexes.embeddingText = { type: 'text', analyzers: ['english'] }; },
    ]) {
        change(configs());
        await assert.rejects(open({ client: { ...fixture.client }, name: 'workspace' }), { code: 'INCOMPATIBLE_STORE' });
        fixture.collections.get('workspace').metadata.indexConfigs = structuredClone(original);
    }
    assert.deepEqual((await open({ client: { ...fixture.client }, name: 'workspace' }).then(store => store.describe())).textSearch, { analyzers: ['english'] });
});

test('ranked hybrid search verifies UTF-16 ranges and omits orphan chunks', async () => {
    const fixture = fileClient();
    const drive = await create({ client: fixture.client, name: 'workspace', metadataSchema: { topic: { type: 'string' } } });
    const at = fork('research');
    await drive.fork({ name: 'research' });
    const text = '😀'.repeat(800) + 'A short final fragment.';
    const file = await drive.write({ at, ...request('/notes', text), metadata: { topic: 'fixture' } });
    fixture.rank = docs => [...docs].reverse();

    const result = await drive.search({ at, query: 'literal:*?', mode: 'hybrid', embeddingQuery: 'Semantic context', limit: 3,
        rerank: { fields: ['content', 'metadata.topic'], onFailure: 'returnOriginal' } });
    assert.equal(result.reranked, true);
    assert.equal(result.hits.length, 2);
    assert.deepEqual(result.hits[0], { ...file, content: 'A short final fragment.', range: { start: 1600, end: text.length } });
    assert.deepEqual(result.hits[1].range, { start: 0, end: 1600 });
    const lookup = fixture.calls.find(call => call.kind === 'query' && call.request.query.bayesian).request;
    assert.deepEqual(lookup.query.bayesian[0], { knn: { field: 'embedding', queryText: 'Semantic context', k: 200,
        filter: { queryString: { query: '"chunk"', defaultField: 'kind' } } } });
    assert.deepEqual(lookup.query.bayesian[1].bool[1].queryString,
        { query: 'literal:*?', defaultField: 'content', skipSyntax: true });
    assert.deepEqual(lookup.rerank.fields, ['content', 'metadata.topic']);
    assert.equal(lookup.consistentRead, true);
    assert.equal(lookup.ref.name, 'fork-research');

    const filter = { and: [
        { field: 'metadata.topic', op: 'eq', value: 'fixture' },
        { field: 'metadata.topic', op: 'exists', value: true },
    ] };
    await drive.search({ at, query: 'notes', mode: 'hybrid', rerank: true, filter });
    const filtered = fixture.calls.findLast(call => call.kind === 'query' && call.request.query.bayesian).request;
    const [knn, lexical] = filtered.query.bayesian;
    assert.deepEqual(knn.knn.filter, { bool: [
        { queryString: { query: '"chunk"', defaultField: 'kind' }, occur: 'filter' },
        { bool: [
            { queryString: { query: '"fixture"', defaultField: 'metadata.topic' }, occur: 'filter' },
            { queryString: { query: '[* TO *]', defaultField: 'metadata.topic' }, occur: 'filter' },
        ], occur: 'filter' },
    ] });
    assert.deepEqual(lexical.bool, [
        ...knn.knn.filter.bool,
        { queryString: { query: 'notes', defaultField: 'content', skipSyntax: true }, occur: 'must' },
    ]);
    assert.equal(filtered.rerank.candidateSize, lookup.rerank.candidateSize);
    const calls = fixture.calls.length;
    for (const invalid of [null, { field: 'metadata.notDeclared', op: 'exists', value: false },
        { field: 'metadata.topic', op: 'eq', value: null }]) {
        await assert.rejects(drive.search({ at, query: 'notes', filter: invalid }), { code: 'INVALID_INPUT' });
    }
    assert.equal(fixture.calls.length, calls);

    const branch = fixture.collections.get('workspace').branches.get('fork-research');
    const firstChunk = [...branch.docs.values()].find(doc => doc.kind === 'chunk' && doc.start === 0);
    firstChunk.end++;
    const unverified = await drive.search({ at, query: 'notes', rerank: false });
    assert.equal(unverified.reranked, false);
    assert.equal(unverified.hits[1].range, undefined);

    fixture.rerank = { status: 'fallback', scoredCount: 0 };
    assert.equal((await drive.search({ at, query: 'notes', rerank: { onFailure: 'returnOriginal' } })).reranked, false);
    await assert.rejects(drive.search({ at, query: 'notes', rerank: true }), { code: 'RERANK_FAILED' });

    branch.docs.delete(`file:${file.fileId}`);
    assert.deepEqual(await drive.search({ at, query: 'notes', rerank: false }), { hits: [], reranked: false });
    fixture.rerank = undefined;
    assert.deepEqual(await drive.search({ query: 'notes', rerank: true }), { hits: [], reranked: false });
});

test('text search defaults to semantic retrieval and keeps mode, reranking and filters independent', async () => {
    const fixture = fileClient();
    const drive = await create({ client: fixture.client, name: 'search-modes', metadataSchema: { topic: { type: 'string' } } });
    const at = fork('draft');
    await drive.fork({ name: 'draft' });
    const file = await drive.write({ at, ...request('/note', 'Preserve the draft before editing.'), metadata: { topic: 'checkpoint' } });
    const defaultResult = await drive.search({ at, query: 'preserve work' });
    assert.equal(defaultResult.reranked, false);
    assert.deepEqual(defaultResult.hits, [{ ...file, range: { start: 0, end: file.content.length } }]);
    const initial = fixture.calls.findLast(call => call.kind === 'query').request;
    assert.deepEqual(initial.query, { knn: { field: 'embedding', queryText: 'preserve work', k: 200,
        filter: { queryString: { query: '"chunk"', defaultField: 'kind' } } } });
    assert.equal(initial.size, 10);
    assert.equal(initial.rerank, undefined);
    assert.equal(initial.candidateSize, undefined);

    const filter = { field: 'metadata.topic', op: 'eq', value: 'checkpoint' };
    const clauses = [
        { queryString: { query: '"chunk"', defaultField: 'kind' }, occur: 'filter' },
        { queryString: { query: '"checkpoint"', defaultField: 'metadata.topic' }, occur: 'filter' },
    ];
    const semantic = { knn: { field: 'embedding', queryText: 'Preserve work before editing', k: 201,
        filter: { bool: clauses } } };
    const keyword = { bool: [...clauses,
        { queryString: { query: 'checkpoint:*?', defaultField: 'content', skipSyntax: true }, occur: 'must' }] };
    for (const mode of ['semantic', 'keyword', 'hybrid']) {
        for (const rerank of [false, true, { fields: ['content', 'metadata.topic'], onFailure: 'returnOriginal' }]) {
            const before = fixture.calls.length;
            const result = await drive.search({ at, query: 'checkpoint:*?', mode, limit: 201, filter, rerank,
                ...(mode !== 'keyword' || rerank !== false ? { embeddingQuery: 'Preserve work before editing' } : {}) });
            assert.deepEqual(result.hits, defaultResult.hits);
            assert.equal(result.reranked, rerank !== false);
            const searches = fixture.calls.slice(before).filter(call => call.kind === 'query');
            assert.equal(searches.length, 1, 'Each search performs one retrieval without automatic fallback');
            const actual = searches[0].request;
            assert.deepEqual(actual.query, mode === 'semantic' ? semantic : mode === 'keyword' ? keyword : { bayesian: [semantic, keyword] });
            assert.equal(actual.size, 201);
            assert.deepEqual(actual.ref, { kind: 'branch', name: 'fork-draft' });
            assert.equal(actual.consistentRead, true);
            assert.equal(actual.candidateSize, mode === 'hybrid' && rerank === false ? 201 : undefined);
            if (rerank === false) assert.equal(actual.rerank, undefined);
            else assert.deepEqual(actual.rerank, { provider: 'typesafe', model: 'jev-1.13.0',
                queryText: 'Preserve work before editing', candidateSize: 201,
                fields: typeof rerank === 'object' ? ['content', 'metadata.topic'] : ['content'],
                onFailure: typeof rerank === 'object' ? 'returnOriginal' : 'error' });
        }
    }
});

test('invalid search modes and unused keyword context fail before database calls', async () => {
    const fixture = fileClient();
    const drive = await create({ client: fixture.client, name: 'invalid-search' });
    const at = fork('draft');
    await drive.fork({ name: 'draft' });
    const before = fixture.calls.length;
    for (const options of [
        { mode: 'auto' }, { mode: null }, { mode: 1 },
        { mode: 'keyword', embeddingQuery: 'unused' },
        { mode: 'keyword', rerank: false, embeddingQuery: 'unused' },
        { mode: 'semantic', embeddingQuery: '' }, { mode: 'hybrid', limit: 1001 },
        { mode: 'keyword', rerank: { fields: ['metadata.undeclared'] } },
    ]) await assert.rejects(drive.search({ at, query: 'checkpoint', ...options }), { code: 'INVALID_INPUT' });
    assert.equal(fixture.calls.length, before);
});

test('a large file publishes its original only after all chunk requests succeed', async () => {
    const fixture = fileClient();
    const drive = await create({ client: fixture.client, name: 'workspace' });
    const at = fork('research');
    await drive.fork({ name: 'research' });
    const content = 'a'.repeat(310_000);
    let attempts = 0;
    fixture.beforeUpsert = () => {
        if (++attempts === 2) throw Object.assign(new Error('Embedding request rejected'), { statusCode: 400 });
    };
    await assert.rejects(drive.write({ at, ...request('/large.txt', content) }), error =>
        error.status === 400 && error.details.incompleteTargets[0].path === '/large.txt');
    const batches = fixture.calls.filter(call => call.kind === 'upsert');
    assert.equal(batches.length, 2);
    assert(batches[0].request.docs.every(doc => doc.kind === 'chunk'));
    assert(batches[1].request.docs.some(doc => doc.kind === 'file'));
    assert.equal(await drive.read({ at, path: '/large.txt' }), null);
    assert.deepEqual(await drive.search({ at, query: 'large', rerank: false }), { hits: [], reranked: false });

    const retried = await drive.write({ at, ...request('/large.txt', content) });
    assert.equal((await drive.read({ at, fileId: retried.fileId })).content, content);
});

test('list returns one native page per call in native order, with prefixes computed per page', async () => {
    const fixture = fileClient();
    const drive = await create({ client: fixture.client, name: 'workspace', metadataSchema: { topic: { type: 'string' } } });
    await drive.fork({ name: 'research' });
    const { at: alternate } = await drive.fork({ name: 'alternate' });
    const [root, direct] = await drive.write({ at: research, operations: [
        request('/Root.txt', 'include no body'),
        { ...request('/notes/B [x]*?.md'), metadata: { topic: 'synthetic' } },
        request('/notes/archive/alpha.txt'),
        request('/notes/archive/"quoted"/sample.txt'),
        request('/notes/Alpha.txt'),
        request('/notes/archive/B [x]*?.txt'),
        request('/notesish/B [x]*?.txt'),
    ] });
    await drive.write({ at: alternate, ...request('/alternate.txt') });
    assert.deepEqual(await drive.list(), { files: [], prefixes: [], consistency: 'eventual' });
    assert.deepEqual((await drive.list({ at: alternate })).files.map(file => file.path), ['/alternate.txt']);

    // Each call is one native page of `limit` documents; a prefix repeats on later pages.
    const pages = [];
    for (let page = await drive.list({ at: research, delimiter: '/', limit: 2 }); ; page = await drive.list(page.next)) {
        pages.push(page);
        if (!page.next) break;
        assert.deepEqual(Object.keys(page.next), ['at', 'cursor']);
        assert.deepEqual(page.next.at, research);
    }
    assert.deepEqual(pages.map(page => [page.files.map(file => file.path), page.prefixes]), [
        [['/Root.txt'], ['/notes/']],
        [[], ['/notes/']],
        [[], ['/notes/']],
        [[], ['/notesish/']],
    ]);
    assert.deepEqual(pages[0].files, [{ fileId: root.fileId, path: root.path, modifiedAt: root.modifiedAt }]);
    // Files keep native order rather than path order.
    assert.deepEqual((await drive.list({ at: research, prefix: '/notes/' })).files.map(file => file.path), [
        '/notes/B [x]*?.md', '/notes/archive/alpha.txt', '/notes/archive/"quoted"/sample.txt', '/notes/Alpha.txt', '/notes/archive/B [x]*?.txt',
    ]);
    assert.deepEqual((await drive.list({ at: research, prefix: '/notes/', delimiter: '/' })).prefixes, ['/notes/archive/']);

    const filtered = await drive.list({ at: research, prefix: '/notes/', nameContains: 'B [x]*?', delimiter: '/' });
    assert.deepEqual(filtered, { files: [{ fileId: direct.fileId, path: direct.path, modifiedAt: direct.modifiedAt,
        metadata: { topic: 'synthetic' } }], prefixes: ['/notes/archive/'], consistency: 'eventual' });
    assert.deepEqual((await drive.list({ at: research, prefix: '/notes/Al', nameContains: 'txt' })).files.map(file => file.path), ['/notes/Alpha.txt']);
    assert.deepEqual((await drive.list({ at: research, prefix: '/notes/archive/"quoted"/' })).files.map(file => file.path),
        ['/notes/archive/"quoted"/sample.txt']);
    const quotedListing = fixture.calls.findLast(call => call.kind === 'list').request;
    assert.equal(quotedListing.filter.bool[1].queryString.query, '"/notes/archive/"');
    assert.deepEqual((await drive.list({ at: research, prefix: '/notes/arch', nameContains: 'archive' })).files, []);
    assert.deepEqual((await drive.list({ at: research, prefix: '/notes/', nameContains: 'alpha' })).files.map(file => file.path), ['/notes/archive/alpha.txt']);

    const lists = fixture.calls.filter(call => call.kind === 'list');
    assert(lists.some(({ request }) => request.pageToken !== undefined));
    for (const { request } of lists) {
        assert.equal('consistentRead' in request, false);
        assert.equal(request.includeVectors, false);
        assert.deepEqual(request.fields.include, ['id', 'kind', 'fileId', 'path', 'modifiedAt', 'metadata']);
        assert.equal(request.filter.bool[0].queryString.query, '"file"');
    }
});

test('list cursors are stateless tokens that continue on a fresh drive object and stay bound to their view and store', async t => {
    const fixture = fileClient();
    const { client, calls } = fixture;
    const drive = await create({ client, name: 'workspace', metadataSchema: { note: { type: 'string' } } });
    await drive.fork({ name: 'research' });
    await drive.write({ at: research, operations: [
        { ...request('/a.txt'), metadata: { note: 'a' } }, request('/b.txt'), request('/c.txt'),
    ] });
    const page = await drive.list({ at: research, limit: 1 });
    assert.deepEqual(page.files.map(file => file.path), ['/a.txt']);
    // No time-based expiry and no process state: a new client continues the same cursor.
    t.mock.method(Date, 'now', () => Date.UTC(2100, 0, 1));
    const fresh = await open({ client: { ...client }, name: 'workspace' });
    const second = await fresh.list(page.next);
    assert.deepEqual(second.files.map(file => file.path), ['/b.txt']);
    assert.deepEqual(await drive.list(page.next), second);
    assert.equal(calls.findLast(call => call.kind === 'list').request.pageToken, '1');
    assert.deepEqual((await fresh.list(second.next)).files.map(file => file.path), ['/c.txt']);

    const { cursor } = page.next;
    await assert.rejects(drive.list({ ...page.next, limit: 2 }), { code: 'INVALID_INPUT' });
    await assert.rejects(drive.list({ cursor }), { code: 'CURSOR_VIEW_MISMATCH' });
    await assert.rejects(drive.list({ at: { kind: 'main' }, cursor }), { code: 'CURSOR_VIEW_MISMATCH' });
    await assert.rejects(drive.list({ at: checkpoint('research'), cursor }), { code: 'CURSOR_VIEW_MISMATCH' });
    await assert.rejects(drive.list({ at: research, cursor: 'invalid' }), { code: 'LIST_CURSOR_UNAVAILABLE' });
    const tampered = `l1.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(cursor.slice(3), 'base64url')), l: 5000 })).toString('base64url')}`;
    await assert.rejects(drive.list({ at: research, cursor: tampered }), { code: 'LIST_CURSOR_UNAVAILABLE' });
    const other = await create({ client, name: 'other-store' });
    await other.fork({ name: 'research' });
    await assert.rejects(other.list(page.next), { code: 'LIST_CURSOR_UNAVAILABLE' });

    // Checkpoints list their tag snapshot with the same cursors.
    const { at: saved } = await drive.checkpoint({ at: research, name: 'saved' });
    await drive.write({ at: research, ...request('/d.txt') });
    const first = await drive.list({ at: saved, limit: 2 });
    assert.deepEqual(calls.findLast(call => call.kind === 'list').request.ref, { kind: 'tag', name: 'checkpoint-saved' });
    assert.deepEqual([...first.files, ...(await drive.list(first.next)).files].map(file => file.path), ['/a.txt', '/b.txt', '/c.txt']);
});

test('listing fails closed for invalid input, aborts and nonprogress, and passes short pages through', async () => {
    const fixture = fileClient();
    const drive = await create({ client: fixture.client, name: 'workspace' });
    await drive.fork({ name: 'research' });
    const [file] = await drive.write({ at: research, operations: [request('/foo/a.txt')] });
    for (const options of [{ prefix: 'relative' }, { prefix: '/foo//bar' }, { prefix: '/foo/../bar' },
        { nameContains: '\uD800' }, { delimiter: '!' }, { limit: 0 }, { limit: 1001 }]) {
        await assert.rejects(drive.list({ at: research, ...options }), { code: 'INVALID_INPUT' });
    }
    await assert.rejects(drive.list({ at: research, cursor: 'invalid' }), { code: 'LIST_CURSOR_UNAVAILABLE' });
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(drive.list({ at: research }, { signal: ctrl.signal }), { code: 'ABORTED' });
    assert.equal(fixture.calls.filter(call => call.kind === 'list').length, 0);

    const rows = [{ collection: 'workspace', doc: { ...file, kind: 'file', id: `file:${file.fileId}` } }];
    fixture.listPage = ({ pageToken }) => ({ isDocsInline: true, docs: rows, nextPageToken: pageToken ?? 'first' });
    const first = await drive.list({ at: research });
    await assert.rejects(drive.list(first.next), { code: 'INVALID_RESULT' });
    // An empty native page with a token is returned as an empty page with next.
    fixture.listPage = ({ pageToken }) => pageToken === undefined
        ? { isDocsInline: true, docs: [], nextPageToken: 'empty' }
        : { isDocsInline: true, docs: rows };
    const empty = await drive.list({ at: research });
    assert.deepEqual([empty.files, empty.prefixes], [[], []]);
    assert.deepEqual((await drive.list(empty.next)).files.map(item => item.fileId), [file.fileId]);

    const background = new AbortController();
    fixture.listPage = () => {
        background.abort();
        return { isDocsInline: true, docs: [] };
    };
    await assert.rejects(drive.list({ at: research }, { signal: background.signal }), { code: 'ABORTED' });
    assert.strictEqual(fixture.calls.at(-1).signal, background.signal);
});

test('working edits preserve identity, resolve substitutions against the original, and replace metadata', async () => {
    const fixture = fileClient();
    const drive = await create({ client: fixture.client, name: 'workspace', metadataSchema: { topic: { type: 'string' } } });
    await drive.fork({ name: 'research' });
    const first = await drive.write({ at: research, ...request('/notes/a.txt', 'The 😀 sky is gray. The sea is blue.\r\n'), metadata: { topic: 'test' } });
    const docs = fixture.collections.get('workspace').branches.get('fork-research').docs;
    const originalChunkIds = [...docs.values()].filter(doc => doc.kind === 'chunk').map(doc => doc.id);

    const moved = await drive.write({ at: research, op: 'update', fileId: first.fileId, newPath: '/archive/"draft".txt' });
    assert.equal(moved.fileId, first.fileId);
    assert.equal(moved.content, first.content);
    assert.deepEqual(moved.metadata, first.metadata);
    assert.equal(await drive.read({ at: research, path: first.path }), null);
    assert.deepEqual(await drive.read({ at: research, path: moved.path }), moved);
    const move = fixture.calls.find(call => call.kind === 'update');
    assert(move.request.docs.every(doc => !Object.hasOwn(doc, 'body') && !Object.hasOwn(doc, 'content')));
    assert.deepEqual([...docs.values()].filter(doc => doc.kind === 'chunk').map(doc => doc.id), originalChunkIds);

    const changed = await drive.write({ at: research, op: 'update', fileId: first.fileId, metadata: {}, edits: [
        { oldText: 'blue', newText: 'navy' },
        { oldText: 'gray', newText: 'blue' },
    ] });
    assert.equal(changed.content, 'The 😀 sky is blue. The sea is navy.\r\n');
    assert.equal(Object.hasOwn(changed, 'metadata'), false);
    assert.deepEqual(await drive.read({ at: research, fileId: first.fileId }), changed);
    assert(originalChunkIds.every(id => !docs.has(id)));
    const ranked = await drive.search({ at: research, query: 'navy', rerank: false });
    assert.deepEqual(ranked.hits, [{ ...changed, range: { start: 0, end: changed.content.length } }]);

    const empty = await drive.write({ at: research, op: 'update', fileId: first.fileId, content: '' });
    assert.equal(empty.content, '');
    assert.equal([...docs.values()].filter(doc => doc.kind === 'chunk').length, 0);
    assert.deepEqual(await drive.write({ at: research, op: 'delete', fileId: first.fileId }), { fileId: first.fileId });
    assert.deepEqual(await drive.write({ at: research, op: 'delete', fileId: first.fileId }), { fileId: first.fileId });
    assert.equal(await drive.read({ at: research, fileId: first.fileId }), null);
    assert(fixture.calls.filter(call => ['upsert', 'update', 'delete'].includes(call.kind)).every(call =>
        call.request.branch === 'fork-research' && call.retries.strategy === 'none'));
});

test('edit conflicts and invalid operations fail before the first mutation of a mixed batch', async () => {
    const fixture = fileClient();
    const drive = await create({ client: fixture.client, name: 'workspace' });
    await drive.fork({ name: 'research' });
    const [a, b] = await drive.write({ at: research, operations: [request('/a', 'aaa abcdef'), request('/b', 'source')] });
    const writes = () => fixture.calls.filter(call => ['upsert', 'update', 'delete'].includes(call.kind)).length;
    const before = writes();
    const edit = edits => ({ op: 'update', fileId: a.fileId, edits });
    await assert.rejects(drive.write({ at: research, operations: [request('/new'), edit([{ oldText: 'aa', newText: 'b' }])] }), { code: 'EDIT_CONFLICT' });
    await assert.rejects(drive.write({ at: research, ...edit([{ oldText: 'abc', newText: 'x' }, { oldText: 'cdef', newText: 'y' }]) }), { code: 'EDIT_CONFLICT' });
    await assert.rejects(drive.write({ at: research, ...edit([{ oldText: 'absent', newText: '' }]) }), { code: 'EDIT_CONFLICT' });
    await assert.rejects(drive.write({ at: research, ...edit([{ oldText: 'abc', newText: 'x' }, { oldText: 'abc', newText: 'y' }]) }), { code: 'INVALID_INPUT' });
    await assert.rejects(drive.write({ at: research, ...edit([{ oldText: 'abc', newText: 'x' }]), content: 'other' }), { code: 'INVALID_INPUT' });
    await assert.rejects(drive.write({ at: research, operations: [{ op: 'delete', fileId: a.fileId }, { op: 'update', fileId: a.fileId, content: 'new' }] }), { code: 'INVALID_INPUT' });
    await assert.rejects(drive.write({ at: research, operations: [{ op: 'delete', fileId: a.fileId }, { op: 'update', fileId: b.fileId, newPath: '/a' }] }), { code: 'PATH_EXISTS' });
    await assert.rejects(drive.write({ at: research, operations: [{ op: 'update', fileId: a.fileId, newPath: '/same' }, request('/same')] }), { code: 'INVALID_INPUT' });
    assert.equal(writes(), before);
    assert.equal(await drive.read({ at: research, path: '/new' }), null);
    assert.deepEqual(await drive.read({ at: research, fileId: a.fileId }), a);

    const [created, updated, deleted] = await drive.write({ at: research, operations: [
        request('/new', 'new'), { op: 'update', fileId: b.fileId, content: 'changed' }, { op: 'delete', fileId: a.fileId },
    ] });
    assert.equal(created.path, '/new');
    assert.equal(updated.content, 'changed');
    assert.deepEqual(deleted, { fileId: a.fileId });
    await assert.rejects(drive.write({ at: research, op: 'update', fileId: a.fileId, content: 'later' }), { code: 'FILE_NOT_FOUND' });
});

test('a lost update acknowledgement is reported without fencing, and an identical retry converges', async () => {
    const fixture = fileClient();
    const drive = await create({ client: fixture.client, name: 'workspace' });
    await drive.fork({ name: 'research' });
    const file = await drive.write({ at: research, ...request('/a', 'first') });
    const docs = fixture.collections.get('workspace').branches.get('fork-research').docs;
    fixture.beforeUpsert = request => {
        for (const doc of request.docs) docs.set(doc.id, doc);
        throw new Error('Response lost');
    };
    const update = { op: 'update', fileId: file.fileId, content: 'second' };
    await assert.rejects(drive.write({ at: research, ...update }), { code: 'WRITE_UNCONFIRMED' });
    fixture.beforeUpsert = undefined;
    // The write landed; the caller inspects, then an identical retry replaces it and cleans the old generation.
    assert.equal((await drive.read({ at: research, fileId: file.fileId })).content, 'second');
    assert.equal((await drive.write({ at: research, ...update })).content, 'second');
    assert.equal([...docs.values()].filter(doc => doc.kind === 'chunk').length, 1);
});

test('an applied update or deletion resumes chunk cleanup after reopening', async () => {
    const fixture = fileClient();
    const drive = await create({ client: fixture.client, name: 'workspace' });
    await drive.fork({ name: 'research' });
    const file = await drive.write({ at: research, ...request('/a', 'first') });
    const orig = fixture.collections.get('workspace').branches.get('fork-research').docs;
    const oldChunks = [...orig.values()].filter(doc => doc.kind === 'chunk').map(doc => doc.id);
    const reject = () => { throw Object.assign(new Error('Rejected'), { statusCode: 400 }); };
    fixture.beforeDelete = reject;
    await assert.rejects(drive.write({ at: research, op: 'update', fileId: file.fileId, content: 'second' }), error =>
        error.status === 400 && error.details.stage === 'cleanup-chunks' && error.details.targets[0].fileId === file.fileId
        // The original is written, so the update is reported as applied.
        && error.details.completedFileIds.includes(file.fileId));
    assert.equal((await drive.read({ at: research, fileId: file.fileId })).content, 'second');
    assert(oldChunks.every(id => orig.has(id)));
    assert.deepEqual((await drive.search({ at: research, query: 'first', rerank: false })).hits.map(hit => hit.content), ['second']);
    fixture.beforeDelete = undefined;
    const reopened = await open({ client: { ...fixture.client }, name: 'workspace' });
    const restored = await reopened.write({ at: research, op: 'update', fileId: file.fileId, content: 'second' });
    assert.equal(restored.content, 'second');
    assert(oldChunks.every(id => !orig.has(id)));

    // The original goes first; a rejected chunk cleanup leaves invisible orphans that a repeated delete removes.
    fixture.beforeDelete = request => request.ids.some(id => id.startsWith('chunk:')) && reject();
    await assert.rejects(reopened.write({ at: research, op: 'delete', fileId: file.fileId }), error =>
        error.status === 400 && error.details.stage === 'cleanup-chunks' && error.details.targets[0].fileId === file.fileId
        && error.details.completedFileIds.includes(file.fileId));
    assert.equal(await reopened.read({ at: research, fileId: file.fileId }), null);
    assert.equal((await reopened.search({ at: research, query: 'second', rerank: false })).hits.length, 0);
    fixture.beforeDelete = undefined;
    const retry = await open({ client: { ...fixture.client }, name: 'workspace' });
    await retry.write({ at: research, op: 'delete', fileId: file.fileId });
    assert.equal(orig.size, 0);
});

test('a lost cleanup request can be retried on the same live handle', async () => {
    const fixture = fileClient();
    const drive = await create({ client: fixture.client, name: 'workspace' });
    await drive.fork({ name: 'research' });
    const file = await drive.write({ at: research, ...request('/a', 'first') });
    const docs = fixture.collections.get('workspace').branches.get('fork-research').docs;
    const oldId = [...docs.values()].find(doc => doc.kind === 'chunk').id;
    fixture.beforeDelete = () => { throw new Error('Lost before applying'); };
    const change = { op: 'update', fileId: file.fileId, content: 'second' };
    await assert.rejects(drive.write({ at: research, ...change }), error =>
        error.code === 'WRITE_UNCONFIRMED' && error.details.stage === 'cleanup-chunks');
    assert(docs.has(oldId));
    assert.equal((await drive.read({ at: research, fileId: file.fileId })).content, 'second');
    fixture.beforeDelete = undefined;
    assert.equal((await drive.write({ at: research, ...change })).content, 'second');
    assert.equal(docs.has(oldId), false);
});

test('reintroducing identical text uses new chunk IDs even if an earlier delete is replayed', async () => {
    const fixture = fileClient();
    const drive = await create({ client: fixture.client, name: 'workspace' });
    await drive.fork({ name: 'research' });
    const file = await drive.write({ at: research, ...request('/a', 'first') });
    await drive.write({ at: research, op: 'update', fileId: file.fileId, content: 'second' });
    const deletion = fixture.calls.find(call => call.kind === 'delete').request;
    await drive.write({ at: research, op: 'update', fileId: file.fileId, content: 'first' });
    await fixture.client.collection('workspace').docs.delete(deletion);
    const hits = (await drive.search({ at: research, query: 'first', rerank: false })).hits;
    assert.equal(hits.length, 1);
    assert.equal(hits[0].content, 'first');
});

test('chunk cleanup keeps the generation of the original it reads back, so a concurrent update keeps its chunks', async () => {
    const fixture = fileClient();
    const drive = await create({ client: fixture.client, name: 'workspace' });
    const file = await drive.write(request('/a.txt', 'zero'));
    const other = await open({ client: { ...fixture.client }, name: 'workspace' });
    let originalFetches = 0;
    fixture.beforeFetch = async request => {
        if (request.fields || request.ids.length !== 1 || request.ids[0] !== `file:${file.fileId}`) return;
        // The second plain original fetch of the first update is its pre-cleanup read:
        // let another writer replace the file completely at that moment.
        if (++originalFetches === 2) await other.write({ op: 'update', fileId: file.fileId, content: 'second writer' });
    };
    await drive.write({ op: 'update', fileId: file.fileId, content: 'first writer' });
    fixture.beforeFetch = undefined;
    assert.equal((await drive.read({ fileId: file.fileId })).content, 'second writer');
    assert.deepEqual((await drive.search({ query: 'second writer', rerank: false })).hits.map(hit => hit.content), ['second writer']);
});

test('racing updates that remove each other\'s chunks are repaired by resending an update', async () => {
    const fixture = fileClient();
    const { collections } = fixture;
    const drive = await create({ client: fixture.client, name: 'workspace' });
    const file = await drive.write(request('/a.txt', 'zero'));
    const other = await open({ client: { ...fixture.client }, name: 'workspace' });
    const docs = collections.get('workspace').branches.get('main').docs;
    // The first update reads its own original back before cleanup; the second
    // update then completes entirely before the first deletes stale chunks.
    let originalFetches = 0;
    fixture.beforeFetch = async (request, current) => {
        if (request.fields || request.ids.length !== 1 || request.ids[0] !== `file:${file.fileId}` || ++originalFetches !== 2) return;
        const observed = { isDocsInline: true, total: 1, docs: [{ collection: 'workspace', doc: structuredClone(current.get(request.ids[0])) }] };
        await other.write({ op: 'update', fileId: file.fileId, content: 'second' });
        return observed;
    };
    await drive.write({ op: 'update', fileId: file.fileId, content: 'first' });
    fixture.beforeFetch = undefined;
    assert.equal((await drive.read({ fileId: file.fileId })).content, 'second');
    const chunks = () => [...docs.values()].filter(doc => doc.kind === 'chunk' && doc.fileId === file.fileId);
    // The first writer's cleanup read its own original and removed the second writer's chunks.
    assert.deepEqual(chunks(), []);
    assert.deepEqual((await drive.search({ query: 'second', rerank: false })).hits, []);
    // Resending the same content, or moving the file, chunks it again instead of failing.
    const repaired = await drive.write({ op: 'update', fileId: file.fileId, content: 'second' });
    assert.equal(repaired.content, 'second');
    assert.equal(chunks().length, 1);
    assert.deepEqual((await drive.search({ query: 'second', rerank: false })).hits.map(hit => hit.content), ['second']);
    for (const doc of chunks()) docs.delete(doc.id);
    assert.equal((await drive.write({ op: 'update', fileId: file.fileId, newPath: '/moved.txt' })).path, '/moved.txt');
    assert.deepEqual((await drive.search({ query: 'second', rerank: false })).hits.map(hit => hit.path), ['/moved.txt']);
});

test('files sharing a path after racing creates stay readable and writable by fileId', async () => {
    const fixture = fileClient();
    const { client } = fixture;
    const drive = await create({ client, name: 'workspace' });
    const other = await open({ client: { ...client }, name: 'workspace' });
    let arrived = 0, release;
    const bothChecked = new Promise(resolve => { release = resolve; });
    fixture.beforeUpsert = async () => { if (++arrived === 2) release(); await bothChecked; };
    const [one, two] = await Promise.all([drive.write(request('/same.txt', 'one')), other.write(request('/same.txt', 'two'))]);
    fixture.beforeUpsert = undefined;
    const fileIds = [one.fileId, two.fileId].sort();
    const ambiguous = { code: 'PATH_AMBIGUOUS', details: { paths: [{ path: '/same.txt', fileIds }] } };
    await assert.rejects(drive.read({ path: '/same.txt' }), ambiguous);
    await assert.rejects(drive.read({ paths: ['/same.txt', '/missing.txt'] }), ambiguous);
    await assert.rejects(drive.read({ path: '/same.txt', maxChars: 10 }), ambiguous);
    assert.equal((await drive.read({ fileId: one.fileId })).content, 'one');
    // Updates that keep the path, moves and deletes by fileId keep working.
    assert.equal((await drive.write({ op: 'update', fileId: one.fileId, content: 'one, edited' })).content, 'one, edited');
    assert.equal((await drive.write({ op: 'update', fileId: two.fileId, metadata: {} })).path, '/same.txt');
    await assert.rejects(drive.write(request('/same.txt', 'three')), { code: 'PATH_EXISTS', details: { paths: ['/same.txt'] } });
    assert.equal((await drive.write({ op: 'update', fileId: two.fileId, newPath: '/two.txt' })).path, '/two.txt');
    assert.equal((await drive.read({ path: '/same.txt' })).fileId, one.fileId);
    await assert.rejects(drive.write({ op: 'update', fileId: two.fileId, newPath: '/same.txt' }), { code: 'PATH_EXISTS' });
    assert.deepEqual(await drive.write({ op: 'delete', fileId: one.fileId }), { fileId: one.fileId });
    assert.equal(await drive.read({ path: '/same.txt' }), null);
});

test('delete removes the original before its chunks and leaves no tombstone', async () => {
    const fixture = fileClient();
    const { calls } = fixture;
    const drive = await create({ client: fixture.client, name: 'workspace', chunking: { strategy: 'boundary' } });
    const [file, kept] = await drive.write({ operations: [request('/a.md', '# A\n\nfirst part\n\n# B\n\nsecond part'), request('/b', 'kept')] });
    const docs = fixture.collections.get('workspace').branches.get('main').docs;
    const owned = id => id === `file:${file.fileId}` || id.startsWith(`chunk:${file.fileId}:`);
    assert([...docs.keys()].filter(owned).length > 1);
    const before = calls.length;
    assert.deepEqual(await drive.write({ op: 'delete', fileId: file.fileId }), { fileId: file.fileId });
    assert.deepEqual([...docs.keys()].filter(owned), []);
    assert([...docs.keys()].some(id => id === `file:${kept.fileId}`));
    const deletes = calls.slice(before).filter(call => call.kind === 'delete').map(call => call.request.ids);
    assert.deepEqual(deletes[0], [`file:${file.fileId}`]);
    assert(deletes.slice(1).flat().every(id => id.startsWith(`chunk:${file.fileId}:`)));
    assert.equal(await drive.read({ fileId: file.fileId }), null);
    // Deleting again is a no-op that only checks for leftover chunks.
    assert.deepEqual(await drive.write({ op: 'delete', fileId: file.fileId }), { fileId: file.fileId });
    await assert.rejects(drive.write({ op: 'update', fileId: file.fileId, content: 'again' }), { code: 'FILE_NOT_FOUND' });
});

test('edit preflight rejects an ambiguous identity and cancellation after dispatch leaves a recoverable revision', async () => {
    const fixture = fileClient();
    const drive = await create({ client: fixture.client, name: 'workspace' });
    await drive.fork({ name: 'research' });
    const [file, other] = await drive.write({ at: research, operations: [request('/a', 'before'), request('/b', 'other')] });
    const update = { op: 'update', fileId: file.fileId, content: 'after' };
    fixture.beforeFetch = (_request, docs) => ({ isDocsInline: true, total: 1,
        docs: [{ collection: 'workspace', doc: docs.get(`file:${other.fileId}`) }] });
    await assert.rejects(drive.write({ at: research, ...update }), { code: 'INVALID_RESULT' });
    fixture.beforeFetch = undefined;
    const controller = new AbortController();
    fixture.afterUpsert = () => controller.abort();
    await assert.rejects(drive.write({ at: research, ...update }, { signal: controller.signal }), error =>
        error.code === 'WRITE_UNCONFIRMED' && error.details.stage === 'write-original');
    fixture.afterUpsert = undefined;
    assert.deepEqual(await drive.read({ at: research, fileId: file.fileId }), await drive.write({ at: research, ...update }));
});

test('moves patch persisted chunks across fallback and segmented runtimes in both directions', async () => {
    const fixture = fileClient();
    const drive = await create({ client: fixture.client, name: 'workspace' });
    await drive.fork({ name: 'research' });
    const text = 'a'.repeat(500) + ' Mr. ' + 'b'.repeat(160) + ' final ' + 'c'.repeat(500);
    const docs = fixture.collections.get('workspace').branches.get('fork-research').docs;
    const chunks = file => [...docs.values()].filter(doc => doc.kind === 'chunk' && doc.fileId === file.fileId);
    const segmenter = Intl.Segmenter;
    try {
        Intl.Segmenter = undefined;
        const fallback = await drive.write({ at: research, ...request('/fallback.txt', text) });
        const fallbackIds = chunks(fallback).map(doc => doc.id);
        Intl.Segmenter = segmenter;
        const segmented = await drive.write({ at: research, ...request('/segmented.txt', text) });
        const segmentedIds = chunks(segmented).map(doc => doc.id);
        assert.notDeepEqual(chunks(fallback).map(doc => doc.end), chunks(segmented).map(doc => doc.end));
        await drive.write({ at: research, op: 'update', fileId: fallback.fileId, newPath: '/fallback-moved.txt' });
        assert.deepEqual(chunks(fallback).map(doc => doc.id), fallbackIds);
        assert(chunks(fallback).every(doc => doc.path === '/fallback-moved.txt'));

        Intl.Segmenter = undefined;
        await drive.write({ at: research, op: 'update', fileId: segmented.fileId, newPath: '/segmented-moved.txt' });
        await drive.write({ at: research, op: 'update', fileId: segmented.fileId, content: text });
        assert.deepEqual(chunks(segmented).map(doc => doc.id), segmentedIds);
        assert(chunks(segmented).every(doc => doc.path === '/segmented-moved.txt'));
        assert.deepEqual(await drive.read({ at: research, fileId: segmented.fileId }).then(file => file.content), text);
        assert.equal(fixture.calls.filter(call => call.kind === 'upsert').length, 2);
    } finally {
        Intl.Segmenter = segmenter;
    }
});

test('move scans every page of persisted chunk IDs with the same hash and writes the original last', async () => {
    const fixture = fileClient();
    const drive = await create({ client: fixture.client, name: 'workspace' });
    await drive.fork({ name: 'research' });
    const file = await drive.write({ at: research, ...request('/old.txt', 'source') });
    const docs = fixture.collections.get('workspace').branches.get('fork-research').docs;
    const template = [...docs.values()].find(doc => doc.kind === 'chunk');
    const base = template.id.slice(0, -1);
    for (let i = 1000; i >= 1; i--) {
        const id = base + i;
        docs.set(id, { ...template, id });
    }
    await drive.write({ at: research, op: 'update', fileId: file.fileId, newPath: '/new.txt' });

    const query = fixture.calls.filter(call => call.kind === 'query' && call.request.sort);
    assert.equal(query.length, 2);
    assert.deepEqual(query[0].request.sort, [{ id: 'asc' }]);
    assert.equal(query[1].request.query.bool[2].queryString.query, `{${[...docs.keys()].filter(id => id.startsWith(base)).sort()[999]} TO *}`);
    assert(query.every(call => call.request.consistentRead && call.request.ref.name === 'fork-research'));
    const patches = fixture.calls.filter(call => call.kind === 'update').flatMap(call => call.request.docs);
    assert.equal(patches.length, 1002);
    assert.equal(patches.at(-1).id, `file:${file.fileId}`);
    assert.equal(new Set(patches.map(doc => doc.id)).size, 1002);
    assert([...docs.values()].every(doc => doc.path === '/new.txt'));
});

test('checkpoints are read-only tag views and forks copy independent state from fork and checkpoint sources', async () => {
    const fixture = fileClient();
    const { client, calls } = fixture;
    const drive = await create({ client, name: 'workspace' });
    const work = fork('saved');
    await drive.fork({ name: 'saved' });
    const [file, deleted] = await drive.write({ at: work, operations: [request('/file.txt', 'before'), request('/removed.txt', 'remove')] });
    await drive.write({ at: work, op: 'delete', fileId: deleted.fileId });
    const created = await drive.checkpoint({ at: work, name: 'saved' });
    assert.deepEqual(created, { at: checkpoint('saved') });
    assert.deepEqual(JSON.parse(JSON.stringify(created)), created);
    // The returned at is a plain value; changing it cannot redirect the store.
    created.at.name = 'changed';
    const saved = checkpoint('saved');
    const reopened = await open({ client: { ...client }, name: 'workspace' });
    assert.equal(await reopened.read({ at: saved, fileId: deleted.fileId }), null);

    await drive.write({ at: work, op: 'update', fileId: file.fileId, content: 'after', newPath: '/after.txt' });
    assert.deepEqual(await reopened.read({ at: saved, fileId: file.fileId }), file);
    assert.deepEqual(await reopened.read({ at: saved, path: file.path }), file);
    assert.deepEqual(await reopened.read({ at: saved, paths: [file.path, '/after.txt'] }), [file]);
    assert.deepEqual((await reopened.list({ at: saved })).files.map(entry => entry.fileId), [file.fileId]);
    assert.deepEqual((await reopened.search({ at: saved, query: 'before', rerank: false })).hits,
        [{ ...file, range: { start: 0, end: file.content.length } }]);
    const tagReads = calls.filter(call => call.request?.ref?.kind === 'tag');
    assert(tagReads.some(call => call.kind === 'list' && !('consistentRead' in call.request)));
    assert(tagReads.some(call => call.kind === 'fetch' && call.request.consistentRead === false));
    assert(tagReads.some(call => call.kind === 'query' && call.request.consistentRead === false));
    assert(tagReads.every(call => call.request.ref.name === 'checkpoint-saved'));

    assert.deepEqual(await drive.checkpoint({ at: saved, name: 'copied' }), { at: checkpoint('copied') });
    assert.deepEqual(await drive.read({ at: checkpoint('copied'), fileId: file.fileId }), file);
    assert.deepEqual(await drive.fork({ at: saved, name: 'child' }), { at: fork('child') });
    assert.deepEqual(await drive.fork({ at: work, name: 'nested' }), { at: fork('nested') });
    const child = fork('child');
    assert.deepEqual(await drive.read({ at: child, fileId: file.fileId }), file);
    assert.equal(await drive.read({ at: child, fileId: deleted.fileId }), null);
    assert.equal((await drive.read({ at: fork('nested'), fileId: file.fileId })).content, 'after');
    await drive.write({ at: child, op: 'update', fileId: file.fileId, newPath: '/child.txt' });
    assert.equal((await drive.read({ at: work, fileId: file.fileId })).path, '/after.txt');
    assert.equal((await drive.read({ at: saved, fileId: file.fileId })).path, file.path);
    const creations = calls.filter(call => ['tag-create', 'branch-create'].includes(call.kind));
    assert(creations.every(call => call.retries.strategy === 'none'));
    // Main is a branch source; a checkpoint source is its tag. Each creation is one native call.
    assert.deepEqual(creations.map(call => [call.kind, call.request.source]), [
        ['branch-create', { kind: 'branch', name: 'main' }],
        ['tag-create', { kind: 'branch', name: 'fork-saved' }],
        ['tag-create', { kind: 'tag', name: 'checkpoint-saved' }],
        ['branch-create', { kind: 'tag', name: 'checkpoint-saved' }],
        ['branch-create', { kind: 'branch', name: 'fork-saved' }],
    ]);
});

test('ref creation validates locally, rejects version, and passes native outcomes through without fencing', async () => {
    const fixture = fileClient();
    const { client, calls } = fixture;
    const drive = await create({ client, name: 'workspace' });
    await drive.fork({ name: 'research' });
    await drive.write({ at: research, ...request('/file.txt') });
    const before = calls.length;
    for (const kind of ['fork', 'checkpoint']) {
        for (const input of [{}, { name: 'ab' }, { name: 'copy', version: 'v0' }, { name: 'copy', asOf: '2026-01-01T00:00:00.000Z' },
            { name: 'copy', at: { kind: 'fork' } }, { name: 'copy', at: research, extra: true }, { at: research }])
            await assert.rejects(drive[kind](input), { code: 'INVALID_INPUT' });
    }
    await assert.rejects(drive.fork({ name: 'main' }), { code: 'INVALID_INPUT' });
    assert.equal(calls.length, before);

    const nativeError = Object.assign(new Error('Source is temporarily unavailable'), { statusCode: 400 });
    fixture.beforeTagCreate = () => { throw nativeError; };
    await assert.rejects(drive.checkpoint({ at: research, name: 'saved' }), { code: 'DATABASE_ERROR', status: 400, cause: nativeError });
    fixture.beforeTagCreate = undefined;
    const saved = checkpoint('saved');
    await assert.rejects(drive.read({ at: saved, path: '/file.txt' }), { code: 'CHECKPOINT_NOT_FOUND', status: 404 });
    await assert.rejects(drive.checkpoint({ at: checkpoint('absent'), name: 'copy' }), { code: 'CHECKPOINT_NOT_FOUND' });
    await assert.rejects(drive.fork({ at: fork('absent'), name: 'copy' }), { code: 'BRANCH_NOT_FOUND' });
    assert.deepEqual(await drive.checkpoint({ at: research, name: 'saved' }), { at: saved });
    assert.equal((await drive.read({ at: saved, path: '/file.txt' })).path, '/file.txt');
    await assert.rejects(drive.checkpoint({ at: research, name: 'saved' }), { code: 'CHECKPOINT_CONFLICT', status: 409 });
    await assert.rejects(drive.fork({ at: saved, name: 'research' }), { code: 'BRANCH_CONFLICT', status: 409 });
    const another = await create({ client, name: 'another' });
    await assert.rejects(another.read({ at: saved, path: '/file.txt' }), { code: 'CHECKPOINT_NOT_FOUND' });

    // A lost reply is an ordinary error without a status; nothing is fenced and the caller inspects.
    fixture.afterTagCreate = () => { throw new Error('Response lost after acceptance'); };
    await assert.rejects(drive.checkpoint({ at: research, name: 'lost' }), error => error.code === 'DATABASE_ERROR' && error.status === undefined);
    fixture.afterTagCreate = undefined;
    assert.deepEqual((await drive.listCheckpoints()).checkpoints.map(entry => entry.at.name), ['lost', 'saved']);
    await drive.write({ at: research, ...request('/later.txt') });
    assert.equal(await drive.read({ at: checkpoint('lost'), path: '/later.txt' }), null);
    await assert.rejects(drive.checkpoint({ at: research, name: 'lost' }), { code: 'CHECKPOINT_CONFLICT' });
});

test('rollback sends one native rollback of main or a fork to a checkpoint tag and passes errors through', async () => {
    const fixture = fileClient();
    const { client, calls } = fixture;
    const drive = await create({ client, name: 'workspace' });
    const kept = await drive.write(request('/kept.txt', 'kept'));
    await drive.fork({ name: 'research' });
    const { at: saved } = await drive.checkpoint({ name: 'saved' });
    const later = await drive.write(request('/later.txt', 'later'));
    await drive.write({ op: 'update', fileId: kept.fileId, content: 'changed' });
    await drive.write({ at: research, ...request('/fork.txt', 'fork') });

    const before = calls.length;
    for (const input of [{}, { at: research }, { to: saved }, { at: saved, to: saved }, { at: research, to: research },
        { at: research, to: { kind: 'main' } }, { at: research, to: saved, extra: true }])
        await assert.rejects(drive.rollback(input), { code: 'INVALID_INPUT' });
    assert.equal(calls.length, before);

    assert.deepEqual(await drive.rollback({ at: { kind: 'main' }, to: saved }), { at: { kind: 'main' } });
    assert.deepEqual(calls.slice(before), [{ kind: 'branch-rollback', name: 'main', tag: 'checkpoint-saved', retries: { strategy: 'none' } }]);
    assert.equal((await drive.read({ fileId: kept.fileId })).content, 'kept');
    assert.equal(await drive.read({ fileId: later.fileId }), null);
    // The fork is a separate branch: rolling back main leaves it alone, and the fork can roll back too.
    assert.equal((await drive.read({ at: research, path: '/fork.txt' })).content, 'fork');
    assert.deepEqual(await drive.rollback({ at: research, to: saved }), { at: research });
    assert.equal(await drive.read({ at: research, path: '/fork.txt' }), null);
    assert.equal(calls.filter(call => call.kind === 'branch-rollback').at(-1).name, 'fork-research');

    // A definite rejection keeps its status and is never retried by the SDK.
    const notPublished = Object.assign(new Error('Rollback requires a tag with a published snapshot'), { statusCode: 400 });
    fixture.beforeRollback = () => { throw notPublished; };
    const rollbacks = () => calls.filter(call => call.kind === 'branch-rollback').length;
    const sent = rollbacks();
    await assert.rejects(drive.rollback({ at: research, to: saved }), { code: 'DATABASE_ERROR', status: 400, cause: notPublished });
    fixture.beforeRollback = () => { throw new Error('Connection reset'); };
    await assert.rejects(drive.rollback({ at: research, to: saved }), error => error.code === 'DATABASE_ERROR' && error.status === undefined);
    assert.equal(rollbacks(), sent + 2);
    fixture.beforeRollback = undefined;
    await assert.rejects(drive.rollback({ at: research, to: checkpoint('absent') }), { code: 'CHECKPOINT_NOT_FOUND', status: 404 });
    await assert.rejects(drive.rollback({ at: fork('absent'), to: saved }), { code: 'BRANCH_NOT_FOUND', status: 404 });
});

test('deleted refs and stores report not found on later use', async () => {
    const fixture = fileClient();
    const { client } = fixture;
    const drive = await create({ client, name: 'workspace' });
    await drive.fork({ name: 'research' });
    await drive.checkpoint({ name: 'saved' });
    assert.deepEqual(await drive.deleteFork({ at: research }), { at: research });
    assert.deepEqual(await drive.deleteCheckpoint({ at: checkpoint('saved') }), { at: checkpoint('saved') });
    await assert.rejects(drive.read({ at: research, path: '/a' }), { code: 'BRANCH_NOT_FOUND' });
    await assert.rejects(drive.write({ at: research, ...request('/a') }), { code: 'BRANCH_NOT_FOUND' });
    await assert.rejects(drive.list({ at: checkpoint('saved') }), { code: 'CHECKPOINT_NOT_FOUND' });
    await assert.rejects(drive.deleteFork({ at: research }), { code: 'BRANCH_NOT_FOUND', status: 404 });
    await assert.rejects(drive.deleteCheckpoint({ at: checkpoint('saved') }), { code: 'CHECKPOINT_NOT_FOUND', status: 404 });
    fixture.collections.delete('workspace');
    await assert.rejects(drive.read({ path: '/a' }), { code: 'STORE_NOT_FOUND', status: 404 });
    await assert.rejects(drive.read({ at: research, path: '/a' }), { code: 'STORE_NOT_FOUND', status: 404 });
});
