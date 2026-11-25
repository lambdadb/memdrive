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
    await assert.rejects(drive.write(request('/main.txt')), { code: 'INVALID_INPUT' });
    assert.equal(calls.some(call => call.kind === 'upsert'), false);

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
    assert.strictEqual(await open({ client, name: 'workspace' }), drive);
    assert.equal(await drive.read({ fileId: file.fileId }), null);
    assert.equal(await drive.read({ at: { kind: 'main' }, fileId: file.fileId }), null);
    const { at: alternate } = await drive.fork({ name: 'alternate' });
    assert.equal(await drive.read({ at: alternate, path }), null);
    assert.notEqual((await drive.write({ at: alternate, ...request(path) })).fileId, file.fileId);

    const writes = calls.filter(call => call.kind === 'upsert');
    assert.deepEqual(writes.map(call => call.request.branch), ['fork-research', 'fork-research', 'fork-alternate']);
    const [chunk, original] = writes[0].request.docs;
    const { revision, fingerprint, chunking, ...storedOriginal } = original;
    assert.equal(typeof revision, 'string');
    assert.match(fingerprint, /^[0-9a-f]{64}$/);
    assert.deepEqual(chunking, { strategy: 'boundary', version: '1' });
    assert.deepEqual(storedOriginal, {
        id: `file:${file.fileId}`, kind: 'file', fileId: file.fileId, path, body: content, modifiedAt: file.modifiedAt,
        fileName: '한글 "draft":*?.md', ancestorPaths: ['/', '/notes/'], changed: true,
    });
    assert.equal(chunk.kind, 'chunk');
    assert.equal(chunk.content, content);
    assert.equal(chunk.start, 0);
    assert.equal(chunk.end, content.length);
    assert.deepEqual(writes[1].request.docs[0].ancestorPaths, ['/']);
    assert.equal(calls.filter(call => call.kind === 'fetch').every(call => call.request.consistentRead), true);
    const lookup = calls.find(call => call.kind === 'query').request;
    assert.deepEqual(lookup, {
        size: 2, ref: { kind: 'branch', name: 'fork-research' }, consistentRead: true, includeVectors: false,
        fields: { include: ['id', 'kind', 'fileId', 'path'] },
        query: { bool: [
            { queryString: { query: '"file"', defaultField: 'kind' }, occur: 'filter' },
            { queryString: { query: JSON.stringify(path), defaultField: 'path' }, occur: 'filter' },
        ] },
    });
});

test('omitted at reads main and explicit main returns the same published view', async () => {
    const fixture = fileClient();
    const drive = await create({ client: fixture.client, name: 'workspace' });
    await drive.fork({ name: 'research' });
    const file = await drive.write({ at: research, ...request('/published.txt', 'published') });
    await drive.write({ at: research, ...request('/draft.txt', 'draft') });
    await drive.merge({ at: research, summary: 'Publish one file' });
    await drive.write({ at: research, op: 'update', fileId: file.fileId, content: 'unpublished edit' });
    assert.equal((await drive.read({ fileId: file.fileId })).content, 'published');
    assert.deepEqual(await drive.read({ at: { kind: 'main' }, fileId: file.fileId }), await drive.read({ fileId: file.fileId }));
    assert.deepEqual(await drive.list(), await drive.list({ at: { kind: 'main' } }));
    assert.deepEqual(await drive.status(), { at: { kind: 'main' }, mainVersion: 'v1' });
    assert.deepEqual(await drive.status({ at: research }), { at: research, mainVersion: 'v1' });
    assert.equal((await drive.read({ at: research, fileId: file.fileId })).content, 'unpublished edit');
});

test('write, diff and merge require an explicit working fork without storage calls or fallback', async () => {
    const fixture = fileClient();
    const drive = await create({ client: fixture.client, name: 'workspace' });
    await drive.fork({ name: 'research' });
    await drive.checkpoint({ name: 'saved' });
    const before = fixture.calls.length;
    for (const at of [undefined, { kind: 'main' }, checkpoint('saved')]) {
        const target = at === undefined ? {} : { at };
        await assert.rejects(drive.write({ ...target, ...request('/x.txt') }), { code: 'INVALID_INPUT' });
        await assert.rejects(drive.write({ ...target, operations: [request('/x.txt')] }), { code: 'INVALID_INPUT' });
        await assert.rejects(drive.diff(target), { code: 'INVALID_INPUT' });
        await assert.rejects(drive.merge({ ...target, summary: 'Publish' }), { code: 'INVALID_INPUT' });
    }
    await assert.rejects(drive.diff(), { code: 'INVALID_INPUT' });
    await assert.rejects(drive.diff({ at: research, limit: 1 }), { code: 'INVALID_INPUT' });
    await assert.rejects(drive.write({ at: research, operations: [request('/x.txt')], op: 'create' }), { code: 'INVALID_INPUT' });
    assert.equal(fixture.calls.length, before);
    assert.deepEqual((await drive.listForks()).forks, [{ at: research }]);
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
        await assert.rejects(drive.status({ at }), { code: 'INVALID_INPUT' });
        await assert.rejects(drive.write({ at, ...request('/a') }), { code: 'INVALID_INPUT' });
    }
    assert.equal(fixture.calls.length, before);
});

test('parallel creates on the same fork share a queue and check paths before writing', async () => {
    const { client, calls } = fileClient();
    const drive = await create({ client, name: 'workspace' });
    await drive.fork({ name: 'research' });
    const reopened = await open({ client, name: 'workspace' });

    const first = drive.write({ at: research, ...request('/a.txt', 'first') });
    const second = reopened.write({ at: research, ...request('/a.txt', 'second') });
    await assert.rejects(second, { code: 'PATH_EXISTS' });
    assert.equal((await first).content, 'first');
    assert.equal(calls.filter(call => call.kind === 'upsert').length, 1);
});

test('an uncertain create response is inspectable and a queued retry cannot duplicate it', async () => {
    const fixture = fileClient();
    const { client, calls } = fixture;
    const drive = await create({ client, name: 'workspace' });
    await drive.fork({ name: 'research' });
    let releasePending;
    fixture.beforeUpsert = body => {
        if (body.docs[0].path !== '/a.txt') return;
        releasePending = () => {
            const docs = fixture.collections.get('workspace').branches.get(body.branch).docs;
            for (const doc of body.docs) docs.set(doc.id, doc);
        };
        throw new Error('Connection lost');
    };
    let details;
    await assert.rejects(drive.write({ at: research, ...request('/a.txt', 'exact') }), error => {
        assert.equal(error.code, 'WRITE_UNCONFIRMED');
        details = error.details;
        assert.equal(details.path, '/a.txt');
        return true;
    });
    await assert.rejects(drive.write({ at: research, ...request('/a.txt', 'duplicate') }), { code: 'WRITE_UNCONFIRMED',
        details: { fileId: details.fileId, path: details.path, targets: [{ fileId: details.fileId, path: details.path }], stage: 'write-original' } });
    assert.equal(calls.filter(call => call.kind === 'upsert').length, 1);
    releasePending();
    assert.equal((await drive.read({ at: research, fileId: details.fileId })).content, 'exact');
    await assert.rejects(drive.write({ at: research, ...request('/a.txt') }), { code: 'PATH_EXISTS' });
    assert.equal((await drive.write({ at: research, ...request('/different.txt') })).path, '/different.txt');
});

test('invalid paths, unsupported targets and legacy collections fail without writes', async () => {
    const { client, calls } = fileClient();
    await client.createCollection({ collectionName: 'legacy', indexConfigs: { memId: { type: 'keyword' } },
        tags: { 'memory.format': 'mems-v0' } });
    await assert.rejects(open({ client, name: 'legacy' }), { code: 'INCOMPATIBLE_STORE' });
    await assert.rejects(open({ client, name: 'absent' }), { code: 'STORE_NOT_FOUND' });
    const drive = await create({ client, name: 'workspace' });
    await assert.rejects(open({ client, name: 'workspace', at: research }), { code: 'INVALID_INPUT' });
    await assert.rejects(drive.read({ at: fork('absent'), path: '/a' }), { code: 'BRANCH_NOT_FOUND' });
    await assert.rejects(drive.write({ at: fork('absent'), ...request('/a') }), { code: 'BRANCH_NOT_FOUND' });
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

test('lists matching file metadata and globally deduplicated prefixes across native pages', async () => {
    const fixture = fileClient();
    fixture.listPageSize = 2;
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
    const rootPage = await drive.list({ at: research, delimiter: '/', limit: 2 });
    assert.deepEqual(rootPage.files, [{ fileId: root.fileId, path: root.path, modifiedAt: root.modifiedAt }]);
    assert.deepEqual(rootPage.prefixes, ['/notes/']);
    assert.deepEqual(Object.keys(rootPage.next), ['at', 'cursor']);
    assert.deepEqual(rootPage.next.at, research);
    const last = await drive.list(rootPage.next);
    assert.deepEqual(last, { files: [], prefixes: ['/notesish/'], consistency: 'eventual' });
    assert.deepEqual(await drive.list(rootPage.next), last);
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

test('listing continuation freezes groups and cloned metadata, including a repeatable last page', async t => {
    const fixture = fileClient();
    fixture.listPageSize = 1;
    const { client, collections, calls } = fixture;
    const drive = await create({ client, name: 'workspace', metadataSchema: { note: { type: 'string' } } });
    await drive.fork({ name: 'research' });
    const [first, second] = await drive.write({ at: research, operations: [
        { ...request('/a.txt'), metadata: { note: 'before a' } },
        { ...request('/b.txt'), metadata: { note: 'before b' } },
        request('/group/c.txt'),
    ] });
    const page = await drive.list({ at: research, delimiter: '/', limit: 1 });
    assert.deepEqual(page.files.map(file => file.fileId), [first.fileId]);
    page.files[0].metadata.note = 'caller mutation';
    const state = collections.get('workspace').branches.get('fork-research').docs;
    state.delete(`file:${second.fileId}`);
    await drive.write({ at: research, ...request('/b2.txt'), metadata: { note: 'after' } });
    const listedBefore = calls.filter(call => call.kind === 'list').length;
    const next = await drive.list(page.next);
    assert.deepEqual(next.files, [{ fileId: second.fileId, path: '/b.txt', modifiedAt: second.modifiedAt, metadata: { note: 'before b' } }]);
    next.files[0].metadata.note = 'caller mutation';
    assert.equal((await drive.list(page.next)).files[0].metadata.note, 'before b');
    const final = await drive.list(next.next);
    assert.deepEqual(final, { files: [], prefixes: ['/group/'], consistency: 'eventual' });
    assert.deepEqual(await drive.list(next.next), final);
    assert.equal(calls.filter(call => call.kind === 'list').length, listedBefore);

    const { cursor } = page.next;
    await assert.rejects(drive.list({ ...page.next, limit: 2 }), { code: 'INVALID_INPUT' });
    // A cursor stays bound to its view: other views reject it without consuming it.
    await assert.rejects(drive.list({ cursor }), { code: 'CURSOR_VIEW_MISMATCH' });
    await assert.rejects(drive.list({ at: { kind: 'main' }, cursor }), { code: 'CURSOR_VIEW_MISMATCH' });
    const { at: alternate } = await drive.fork({ name: 'alternate' });
    await assert.rejects(drive.list({ at: alternate, cursor }), { code: 'CURSOR_VIEW_MISMATCH' });
    assert.equal((await drive.list(page.next)).files[0].path, '/b.txt');
    await assert.rejects(drive.list({ at: research, cursor: 'invalid' }), { code: 'LIST_CURSOR_UNAVAILABLE' });
    const restarted = await open({ client: { ...client }, name: 'workspace' });
    await assert.rejects(restarted.list(page.next), { code: 'LIST_CURSOR_UNAVAILABLE' });
    assert.deepEqual((await drive.list({ at: research })).files.map(file => file.path), ['/a.txt', '/b2.txt', '/group/c.txt']);

    const now = Date.now();
    t.mock.method(Date, 'now', () => now + 5 * 60 * 1000 + 1);
    await assert.rejects(drive.list(page.next), { code: 'LIST_CURSOR_UNAVAILABLE' });
    // An expired cursor is unavailable everywhere rather than reported as a mismatch.
    await assert.rejects(drive.list({ cursor }), { code: 'LIST_CURSOR_UNAVAILABLE' });
});

test('list scan caches share one process-wide budget across stores and evict the least recently used scan', async t => {
    const fixture = fileClient();
    const first = await create({ client: fixture.client, name: 'first-store' });
    const second = await create({ client: fixture.client, name: 'second-store' });
    for (const drive of [first, second]) {
        await drive.fork({ name: 'research' });
        await drive.write({ at: research, operations: [request('/a.txt'), request('/b.txt')] });
    }
    // Start from an empty process-wide cache: an expired-clock listing sweeps earlier tests' scans.
    const now = Date.now();
    const clock = t.mock.method(Date, 'now', () => now + 5 * 60 * 1000 + 1);
    await first.list({ at: research });
    clock.mock.restore();
    const oldest = await first.list({ at: research, limit: 1 });
    const recent = await first.list({ at: research, limit: 1 });
    // A continuation refreshes recency, and a mismatch does not consume the cursor.
    await assert.rejects(first.list({ cursor: oldest.next.cursor }), { code: 'CURSOR_VIEW_MISMATCH' });
    assert.equal((await first.list(oldest.next)).files[0].path, '/b.txt');
    // Another store's scans fill the shared count budget (128 scans).
    for (let i = 0; i < 127; i++) await second.list({ at: research, limit: 1 });
    await assert.rejects(first.list(recent.next), { code: 'LIST_CURSOR_UNAVAILABLE' });
    assert.equal((await first.list(oldest.next)).files[0].path, '/b.txt');
    // A store never continues another store's cursor.
    await assert.rejects(second.list({ at: research, cursor: oldest.next.cursor }), { code: 'LIST_CURSOR_UNAVAILABLE' });
});

test('listing fails closed for invalid input, aborts, nonprogress, and scan overflow', async () => {
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
    fixture.listPage = () => ({ isDocsInline: true, docs: rows, nextPageToken: 'repeated' });
    await assert.rejects(drive.list({ at: research }), { code: 'INVALID_RESULT' });
    fixture.listPage = ({ pageToken }) => pageToken === undefined
        ? { isDocsInline: true, docs: [], nextPageToken: 'empty' }
        : { isDocsInline: true, docs: rows };
    assert.deepEqual((await drive.list({ at: research })).files.map(item => item.fileId), [file.fileId]);

    const background = new AbortController();
    fixture.listPage = () => {
        background.abort();
        return { isDocsInline: true, docs: [] };
    };
    await assert.rejects(drive.list({ at: research }, { signal: background.signal }), { code: 'ABORTED' });
    assert.strictEqual(fixture.calls.at(-1).signal, background.signal);

    fixture.listPage = ({ pageToken }) => ({
        isDocsInline: true, docs: Array.from({ length: 500 }, () => rows[0]),
        nextPageToken: String(Number(pageToken ?? 0) + 1),
    });
    await assert.rejects(drive.list({ at: research }), { code: 'LIST_SCAN_LIMIT' });
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

test('lost update acknowledgements fence an unchanged original and resume when its revision is observed', async () => {
    const fixture = fileClient();
    const drive = await create({ client: fixture.client, name: 'workspace' });
    await drive.fork({ name: 'research' });
    const file = await drive.write({ at: research, ...request('/a', 'first') });
    const docs = fixture.collections.get('workspace').branches.get('fork-research').docs;
    let release;
    fixture.beforeUpsert = request => {
        release = () => { for (const doc of request.docs) docs.set(doc.id, doc); };
        throw new Error('Response lost');
    };
    const update = { op: 'update', fileId: file.fileId, content: 'second' };
    await assert.rejects(drive.write({ at: research, ...update }), { code: 'WRITE_UNCONFIRMED' });
    assert.equal((await drive.read({ at: research, fileId: file.fileId })).content, 'first');
    await assert.rejects(drive.write({ at: research, ...update }), { code: 'WRITE_UNCONFIRMED' });
    release();
    fixture.beforeUpsert = undefined;
    const recovered = await drive.write({ at: research, ...update });
    assert.equal(recovered.content, 'second');
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
        error.status === 400 && error.details.stage === 'cleanup-chunks' && error.details.appliedFileIds.includes(file.fileId));
    assert.equal((await drive.read({ at: research, fileId: file.fileId })).content, 'second');
    assert(oldChunks.every(id => orig.has(id)));
    assert.deepEqual((await drive.search({ at: research, query: 'first', rerank: false })).hits.map(hit => hit.content), ['second']);
    fixture.beforeDelete = undefined;
    const reopened = await open({ client: { ...fixture.client }, name: 'workspace' });
    const restored = await reopened.write({ at: research, op: 'update', fileId: file.fileId, content: 'second' });
    assert.equal(restored.content, 'second');
    assert(oldChunks.every(id => !orig.has(id)));

    fixture.beforeDelete = reject;
    await assert.rejects(reopened.write({ at: research, op: 'delete', fileId: file.fileId }), error =>
        error.status === 400 && error.details.stage === 'cleanup-chunks' && error.details.appliedFileIds.includes(file.fileId));
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

test('an inherited published baseline is preserved through edits and a backed tombstone', async () => {
    const fixture = fileClient();
    const drive = await create({ client: fixture.client, name: 'workspace' });
    await drive.fork({ name: 'research' });
    const file = await drive.write({ at: research, ...request('/published', 'source') });
    const docs = fixture.collections.get('workspace').branches.get('fork-research').docs;
    const key = `file:${file.fileId}`;
    docs.get(key).version = 'published-version';
    delete docs.get(key).changed;

    await drive.write({ at: research, op: 'update', fileId: file.fileId, newPath: '/working', content: 'working' });
    const baseline = docs.get(key).baseline;
    assert.equal(baseline.version, 'published-version');
    assert.equal(baseline.path, '/published');
    assert.match(baseline.fingerprint, /^[0-9a-f]{64}$/);
    await drive.write({ at: research, op: 'update', fileId: file.fileId, newPath: file.path, content: file.content });
    assert.deepEqual(docs.get(key).baseline, baseline);
    assert.equal(docs.get(key).changed, false);

    await drive.write({ at: research, op: 'delete', fileId: file.fileId });
    assert.deepEqual(docs.get(key).baseline, baseline);
    assert.equal(docs.get(key).kind, 'tombstone');
    assert.equal(docs.size, 1);
    const reopened = await open({ client: { ...fixture.client }, name: 'workspace' });
    assert.equal(await reopened.read({ at: research, fileId: file.fileId }), null);
    assert.equal(await reopened.read({ at: research, path: file.path }), null);
    assert.deepEqual(await reopened.write({ at: research, op: 'delete', fileId: file.fileId }), { fileId: file.fileId });
    assert.equal(docs.size, 1);
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

test('working diff reports net creates, body edits, moves and deletions using only changed originals', async () => {
    const fixture = fileClient();
    const { client, calls, collections } = fixture;
    const drive = await create({ client, name: 'workspace' });
    await assert.rejects(drive.diff({ at: { kind: 'main' } }), { code: 'INVALID_INPUT' });
    await drive.fork({ name: 'research' });
    const { at: alternate } = await drive.fork({ name: 'alternate' });
    assert.deepEqual(await drive.diff({ at: research }), []);
    const [created, moved, body, deleted, restored, removed, interrupted] = await drive.write({ at: research, operations: [
        request('/create', 'created'), request('/move', 'move'), request('/body', 'old'),
        request('/delete', 'remove'), request('/restore', 'baseline'), request('/gone', ''), request('/interrupted', 'unfinished'),
    ] });
    const docs = collections.get('workspace').branches.get('fork-research').docs;
    for (const file of [moved, body, deleted, restored]) {
        const record = docs.get(`file:${file.fileId}`);
        delete record.changed;
        record.version = 'published';
    }
    await drive.write({ at: research, operations: [
        { op: 'update', fileId: created.fileId, newPath: '/created-moved' },
        { op: 'update', fileId: moved.fileId, newPath: '/moved-once' },
        { op: 'update', fileId: body.fileId, content: 'new' },
        { op: 'update', fileId: deleted.fileId, newPath: '/previously-moved' },
        { op: 'update', fileId: restored.fileId, content: 'edited' },
        { op: 'delete', fileId: removed.fileId },
    ] });
    await drive.write({ at: research, operations: [
        { op: 'update', fileId: moved.fileId, newPath: '/moved-again' },
        { op: 'delete', fileId: deleted.fileId },
        { op: 'update', fileId: restored.fileId, content: restored.content },
    ] });
    fixture.beforeDelete = () => { throw Object.assign(new Error('Chunk cleanup rejected'), { statusCode: 400 }); };
    await assert.rejects(drive.write({ at: research, op: 'delete', fileId: interrupted.fileId }), { code: 'DATABASE_ERROR' });
    fixture.beforeDelete = undefined;
    // Defensive equality also omits an exact revert if the candidate was marked changed.
    docs.get(`file:${restored.fileId}`).changed = true;
    await drive.write({ at: alternate, ...request('/other-fork') });
    const reusedPath = await drive.write({ at: research, ...request('/delete') });

    const reopened = await open({ client: { ...client }, name: 'workspace' });
    // The first use of a fork on a fresh client verifies that it exists.
    assert.deepEqual(await reopened.status({ at: research }), { at: research, mainVersion: 'v0' });
    const before = calls.length;
    const expected = [
        { op: 'create', fileId: created.fileId, path: '/created-moved' },
        { op: 'update', fileId: moved.fileId, path: '/moved-again', previousPath: '/move' },
        { op: 'update', fileId: body.fileId, path: '/body' },
        { op: 'delete', fileId: deleted.fileId, previousPath: '/delete' },
        { op: 'create', fileId: reusedPath.fileId, path: '/delete' },
    ].sort((a, b) => a.fileId.localeCompare(b.fileId));
    assert.deepEqual(await reopened.diff({ at: research }), expected);
    const call = calls.slice(before);
    assert.equal(call.length, 1);
    assert.equal(call[0].kind, 'query');
    assert.equal(call[0].request.consistentRead, true);
    assert.equal(call[0].request.includeVectors, false);
    assert.deepEqual(call[0].request.ref, { kind: 'branch', name: 'fork-research' });
    assert.deepEqual(call[0].request.fields.include, ['id', 'kind', 'fileId', 'path', 'changed', 'baseline', 'fingerprint', 'version']);
    assert.deepEqual((await drive.diff({ at: alternate })).map(change => change.path), ['/other-fork']);
});

test('diff pages across the generated ID boundary and queues following writes', async () => {
    const fixture = fileClient();
    const drive = await create({ client: fixture.client, name: 'workspace' });
    await drive.fork({ name: 'research' });
    const docs = fixture.collections.get('workspace').branches.get('fork-research').docs;
    const synthetic = Array.from({ length: 1001 }, (_, i) => {
        const fileId = `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
        return { fileId, id: `file:${fileId}`, kind: 'file', changed: true, fingerprint: '0'.repeat(64), path: `/synthetic/${i}` };
    });
    for (const doc of [...synthetic].reverse()) docs.set(doc.id, doc);
    let entered, release;
    const active = new Promise(resolve => { entered = resolve; });
    const pause = new Promise(resolve => { release = resolve; });
    fixture.diffPage = async request => {
        if (request.query.bool.length === 2) { entered(); await pause; }
    };
    const scanning = drive.diff({ at: research });
    await active;
    const queued = drive.write({ at: research, ...request('/queued') });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.calls.some(call => call.kind === 'upsert'), false);
    release();
    const changes = await scanning;
    await queued;
    assert.deepEqual(changes, synthetic.map(({ fileId, path }) => ({ op: 'create', fileId, path })));
    const scans = fixture.calls.filter(call => call.kind === 'query' && call.request.sort);
    assert.equal(scans.length, 2);
    assert.equal(scans[1].request.query.bool[2].queryString.query, `{${synthetic[999].id} TO *}`);
    fixture.diffPage = undefined;
    assert.equal((await drive.diff({ at: research })).length, 1002);
});

test('diff rejects invalid records, nonprogress and incomplete pages and recovers after abort', async () => {
    const fixture = fileClient();
    const drive = await create({ client: fixture.client, name: 'workspace' });
    await drive.fork({ name: 'research' });
    await drive.write({ at: research, ...request('/a') });
    const records = fixture.collections.get('workspace').branches.get('fork-research').docs;
    const original = [...records.values()][0];
    const wrap = (...docs) => ({ isDocsInline: true, total: docs.length, docs: docs.map(doc => ({ collection: 'workspace', doc })) });
    // Every write of a changed live original persists its fingerprint.
    const { fingerprint: _fingerprint, ...withoutFingerprint } = original;
    for (const invalid of [
        withoutFingerprint,
        { ...original, fingerprint: 'bad' },
        { ...original, kind: 'chunk' },
        { ...original, changed: false },
        { ...original, id: 'wrong' },
        { ...original, baseline: { version: 'v1', path: '/before', fingerprint: 'bad' } },
        { ...original, version: 'v1' },
        { ...original, baseline: { version: 'v1', path: '/before', fingerprint: '0'.repeat(64) }, fingerprint: '0'.repeat(64) },
    ]) {
        fixture.diffPage = () => wrap(invalid);
        await assert.rejects(drive.diff({ at: research }), { code: 'INVALID_RESULT' });
    }
    fixture.diffPage = () => wrap(original, original);
    await assert.rejects(drive.diff({ at: research }), { code: 'INVALID_RESULT' });
    fixture.diffPage = () => ({ ...wrap(original), total: 2 });
    await assert.rejects(drive.diff({ at: research }), { code: 'INVALID_RESULT' });
    const controller = new AbortController();
    fixture.diffPage = (_request, options) => {
        assert.strictEqual(options.signal, controller.signal);
        controller.abort();
        return wrap(original);
    };
    await assert.rejects(drive.diff({ at: research }, { signal: controller.signal }), { code: 'ABORTED' });
    fixture.diffPage = undefined;
    assert.deepEqual(await drive.diff({ at: research }), [{ op: 'create', fileId: original.fileId, path: '/a' }]);
    await assert.rejects(drive.diff({ at: research, limit: 1 }), { code: 'INVALID_INPUT' });
});

test('checkpoints are read-only tag views and fork independent working state from fork and checkpoint sources', async () => {
    const fixture = fileClient();
    const { client, calls, collections } = fixture;
    const drive = await create({ client, name: 'workspace' });
    const work = fork('saved');
    await drive.fork({ name: 'saved' });
    const [file, deleted] = await drive.write({ at: work, operations: [request('/file.txt', 'before'), request('/removed.txt', 'remove')] });
    const docs = collections.get('workspace').branches.get('fork-saved').docs;
    docs.get(`file:${deleted.fileId}`).version = 'baseline-version';
    delete docs.get(`file:${deleted.fileId}`).changed;
    await drive.write({ at: work, op: 'delete', fileId: deleted.fileId });
    const created = await drive.checkpoint({ at: work, name: 'saved' });
    assert.deepEqual(created, { at: checkpoint('saved') });
    assert.deepEqual(JSON.parse(JSON.stringify(created)), created);
    // The returned at is a plain value; changing it cannot redirect the store.
    created.at.name = 'changed';
    const saved = checkpoint('saved');
    assert.deepEqual((await drive.status({ at: saved })).at, saved);
    const reopened = await open({ client: { ...client }, name: 'workspace' });
    assert.notEqual(reopened, drive);
    assert.equal(await reopened.read({ at: saved, fileId: deleted.fileId }), null);
    assert(calls.some(call => call.kind === 'tag-get' && call.tagName === 'checkpoint-saved'));

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
    assert.deepEqual((await drive.diff({ at: child })).find(change => change.fileId === deleted.fileId),
        { op: 'delete', fileId: deleted.fileId, previousPath: deleted.path });
    await drive.write({ at: child, op: 'update', fileId: file.fileId, newPath: '/child.txt' });
    assert.equal((await drive.diff({ at: child })).find(change => change.fileId === file.fileId).path, '/child.txt');
    assert.equal((await drive.read({ at: work, fileId: file.fileId })).path, '/after.txt');
    assert.equal((await drive.read({ at: saved, fileId: file.fileId })).path, file.path);
    assert(calls.filter(call => ['tag-create', 'branch-create'].includes(call.kind)).every(call => call.retries.strategy === 'none'));
    assert(calls.some(call => call.kind === 'branch-create' && call.request.source.kind === 'tag'));
    assert(calls.some(call => call.kind === 'tag-create' && call.request.source.kind === 'tag'));
});

test('ref creation accepts version only from a main source and validates locally', async () => {
    const fixture = fileClient();
    const drive = await create({ client: fixture.client, name: 'workspace' });
    await drive.fork({ name: 'research' });
    await drive.write({ at: research, ...request('/later.txt', 'later') });
    await drive.checkpoint({ at: research, name: 'saved' });
    const before = fixture.calls.length;
    for (const kind of ['fork', 'checkpoint']) {
        for (const at of [research, checkpoint('saved')])
            await assert.rejects(drive[kind]({ at, name: 'copy', version: 'v0' }), { code: 'INVALID_INPUT' });
        for (const input of [{}, { name: 'ab' }, { name: 'copy', version: 'v01' }, { name: 'copy', asOf: '2026-01-01T00:00:00.000Z' },
            { name: 'copy', at: { kind: 'fork' } }, { name: 'copy', at: research, extra: true }, { at: research }])
            await assert.rejects(drive[kind](input), { code: 'INVALID_INPUT' });
    }
    assert.equal(fixture.calls.length, before);
    assert.deepEqual(await drive.fork({ name: 'initial', version: 'v0' }), { at: fork('initial') });
    assert.deepEqual(await drive.checkpoint({ at: { kind: 'main' }, name: 'initial', version: 'v0' }), { at: checkpoint('initial') });
    for (const at of [fork('initial'), checkpoint('initial')])
        assert.equal(await drive.read({ at, path: '/later.txt' }), null);
    assert.equal((await drive.read({ at: checkpoint('saved'), path: '/later.txt' })).content, 'later');
});

test('checkpoint names are store-scoped and absent or invalid lookups are not cached', async () => {
    const fixture = fileClient();
    const { client } = fixture;
    const drive = await create({ client, name: 'workspace' });
    await drive.fork({ name: 'research' });
    const nativeError = Object.assign(new Error('Source is temporarily unavailable'), { statusCode: 400 });
    fixture.beforeTagCreate = () => { throw nativeError; };
    await assert.rejects(drive.checkpoint({ at: research, name: 'saved' }), { code: 'DATABASE_ERROR', status: 400, cause: nativeError });
    assert.equal(fixture.calls.filter(call => call.kind === 'tag-create').length, 1);
    fixture.beforeTagCreate = undefined;
    const saved = checkpoint('saved');
    await assert.rejects(drive.read({ at: { ...saved, fork: 'saved' }, path: '/file.txt' }), { code: 'INVALID_INPUT' });
    await assert.rejects(drive.read({ at: checkpoint('x'.repeat(42)), path: '/file.txt' }), { code: 'INVALID_INPUT' });
    await assert.rejects(drive.read({ at: saved, path: '/file.txt' }), { code: 'CHECKPOINT_NOT_FOUND' });
    fixture.getTag = () => ({ tag: { name: 'checkpoint-unrelated' } });
    await assert.rejects(drive.read({ at: saved, path: '/file.txt' }), { code: 'INVALID_RESULT' });
    fixture.getTag = undefined;

    await drive.write({ at: research, ...request('/file.txt') });
    assert.deepEqual(await drive.checkpoint({ at: research, name: 'saved' }), { at: saved });
    const lookups = () => fixture.calls.filter(call => call.kind === 'tag-get').length;
    const lookedUp = lookups();
    assert.equal((await drive.read({ at: saved, path: '/file.txt' })).path, '/file.txt');
    assert.equal(lookups(), lookedUp, 'A created checkpoint is already known to this store object');
    await assert.rejects(drive.checkpoint({ at: research, name: 'saved' }), { code: 'CHECKPOINT_CONFLICT' });
    await assert.rejects(drive.fork({ at: saved, name: 'research' }), { code: 'BRANCH_CONFLICT' });
    const another = await create({ client, name: 'another' });
    await assert.rejects(another.read({ at: saved, path: '/file.txt' }), { code: 'CHECKPOINT_NOT_FOUND' });
});

test('ref creation queues with writes and diff and protects against retries after a lost acknowledgement', async () => {
    const fixture = fileClient();
    const { client, calls } = fixture;
    const drive = await create({ client, name: 'workspace' });
    await drive.fork({ name: 'research' });
    let release;
    const held = new Promise(resolve => { release = resolve; });
    fixture.beforeUpsert = () => held;
    const writing = drive.write({ at: research, ...request('/before.txt', 'before') });
    const scanning = drive.diff({ at: research });
    const captured = drive.checkpoint({ at: research, name: 'queued' });
    const child = drive.fork({ at: research, name: 'child' });
    const later = drive.write({ at: research, ...request('/later.txt', 'after') });
    await new Promise(resolve => setImmediate(resolve));
    assert(!calls.some(call => call.kind === 'tag-create' || call.request?.branchName === 'fork-child'));
    fixture.beforeUpsert = undefined;
    release();
    const before = await writing;
    assert.deepEqual(await scanning, [{ op: 'create', fileId: before.fileId, path: before.path }]);
    const { at: saved } = await captured;
    const { at: branch } = await child;
    await later;
    assert.deepEqual(await drive.read({ at: saved, fileId: before.fileId }), before);
    assert.equal(await drive.read({ at: branch, path: '/later.txt' }), null);

    fixture.afterTagCreate = () => { throw new Error('Response lost after acceptance'); };
    await assert.rejects(drive.checkpoint({ at: research, name: 'lost' }), { code: 'REF_CREATION_UNCONFIRMED' });
    fixture.afterTagCreate = undefined;
    await drive.write({ at: research, ...request('/later-again.txt') });
    await assert.rejects(drive.checkpoint({ at: research, name: 'lost' }), { code: 'REF_CREATION_UNCONFIRMED' });
    assert.equal(calls.filter(call => call.request?.tagName === 'checkpoint-lost').length, 1);
    assert.deepEqual((await drive.listCheckpoints()).checkpoints.map(entry => entry.at.name), ['lost', 'queued']);
    assert.equal(await drive.read({ at: checkpoint('lost'), path: '/later-again.txt' }), null);
});

test('working ref creation waits for an unconfirmed source mutation to settle', async () => {
    const fixture = fileClient();
    const { client, calls, collections } = fixture;
    const drive = await create({ client, name: 'workspace' });
    await drive.fork({ name: 'research' });
    const docs = collections.get('workspace').branches.get('fork-research').docs;
    let settle;
    fixture.beforeUpsert = request => {
        settle = () => { for (const doc of request.docs) docs.set(doc.id, doc); };
        throw new Error('Lost before confirmation');
    };
    await assert.rejects(drive.write({ at: research, ...request('/uncertain.txt') }), { code: 'WRITE_UNCONFIRMED' });
    await assert.rejects(drive.checkpoint({ at: research, name: 'saved' }), { code: 'WRITE_UNCONFIRMED' });
    await assert.rejects(drive.fork({ at: research, name: 'child' }), { code: 'WRITE_UNCONFIRMED' });
    assert.equal(calls.filter(call => call.kind === 'tag-create' || call.request?.branchName === 'fork-child').length, 0);
    settle();
    fixture.beforeUpsert = undefined;
    const { at: saved } = await drive.checkpoint({ at: research, name: 'saved' });
    assert.equal((await drive.read({ at: saved, path: '/uncertain.txt' })).content, '');
});
