import assert from 'node:assert/strict';
import test from 'node:test';
import { create, open } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

const request = (path, content = '') => ({ op: 'create', path, content });

test('file stores round-trip exact text and empty originals by path and stable ID', async () => {
    const fixture = fileClient();
    const { client, calls } = fixture;
    const main = await create({ client, name: 'workspace' });
    assert.equal('write' in main, false);
    assert.equal(calls.some(call => call.kind === 'upsert'), false);

    const fork = await main.fork({ name: 'research' });
    const path = '/notes/한글 "draft":*?.md';
    const content = '\uFEFF# Task\r\n  café\t😀\n\u0000\n';
    const file = await fork.write(request(path, content));
    const empty = await fork.write(request('/empty.txt'));
    assert.notEqual(empty.fileId, file.fileId);
    assert.notEqual(file.fileId, path);
    assert.deepEqual(file, { fileId: file.fileId, modifiedAt: file.modifiedAt, path, content });
    assert.equal(empty.content, '');

    const otherClient = { ...client };
    const reopened = await open({ client: otherClient, name: 'workspace', at: { fork: 'research' } });
    assert.deepEqual(await reopened.read({ path }), file);
    assert.deepEqual(await reopened.read({ fileId: file.fileId }), file);
    assert.deepEqual(await reopened.read({ path: empty.path }), empty);
    assert.strictEqual(await open({ client, name: 'workspace', at: { fork: 'research' } }), fork);
    assert.strictEqual(await open({ client, name: 'workspace' }), main);
    assert.equal(await main.read({ fileId: file.fileId }), null);
    const otherFork = await main.fork({ name: 'alternate' });
    assert.equal(await otherFork.read({ path }), null);
    assert.notEqual((await otherFork.write(request(path))).fileId, file.fileId);

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

test('parallel creates on the same fork share a queue and check paths before writing', async () => {
    const { client, calls } = fileClient();
    const main = await create({ client, name: 'workspace' });
    const fork = await main.fork({ name: 'research' });
    const reopened = await open({ client, name: 'workspace', at: { fork: 'research' } });

    const first = fork.write(request('/a.txt', 'first'));
    const second = reopened.write(request('/a.txt', 'second'));
    await assert.rejects(second, { code: 'PATH_EXISTS' });
    assert.equal((await first).content, 'first');
    assert.equal(calls.filter(call => call.kind === 'upsert').length, 1);
});

test('an uncertain create response is inspectable and a queued retry cannot duplicate it', async () => {
    const fixture = fileClient();
    const { client, calls } = fixture;
    const main = await create({ client, name: 'workspace' });
    const fork = await main.fork({ name: 'research' });
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
    await assert.rejects(fork.write(request('/a.txt', 'exact')), error => {
        assert.equal(error.code, 'WRITE_UNCONFIRMED');
        details = error.details;
        assert.equal(details.path, '/a.txt');
        return true;
    });
    await assert.rejects(fork.write(request('/a.txt', 'duplicate')), { code: 'WRITE_UNCONFIRMED',
        details: { fileId: details.fileId, path: details.path, targets: [{ fileId: details.fileId, path: details.path }], stage: 'write-original' } });
    assert.equal(calls.filter(call => call.kind === 'upsert').length, 1);
    releasePending();
    assert.equal((await fork.read({ fileId: details.fileId })).content, 'exact');
    await assert.rejects(fork.write(request('/a.txt')), { code: 'PATH_EXISTS' });
    assert.equal((await fork.write(request('/different.txt'))).path, '/different.txt');
});

test('invalid paths, unsupported targets and legacy collections fail without writes', async () => {
    const { client, calls } = fileClient();
    await client.createCollection({ collectionName: 'legacy', indexConfigs: { memId: { type: 'keyword' } },
        tags: { 'memory.format': 'mems-v0' } });
    await assert.rejects(open({ client, name: 'legacy' }), { code: 'INCOMPATIBLE_STORE' });
    await assert.rejects(open({ client, name: 'absent' }), { code: 'STORE_NOT_FOUND' });
    const main = await create({ client, name: 'workspace' });
    await assert.rejects(open({ client, name: 'workspace', at: { fork: 'absent' } }), { code: 'BRANCH_NOT_FOUND' });
    await assert.rejects(main.fork({ name: 'main' }), { code: 'INVALID_INPUT' });
    const fork = await main.fork({ name: 'research' });
    for (const path of ['relative', '/', '/a//b', '/a/../b', '/a/./b', '/a/', '/a\\b', '/a\n']) {
        await assert.rejects(fork.write(request(path)), { code: 'INVALID_INPUT' });
    }
    await assert.rejects(fork.write(request('/bad', '\uD800')), { code: 'INVALID_INPUT' });
    await assert.rejects(fork.read({ path: '/a', fileId: 'invalid' }), { code: 'INVALID_INPUT' });
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(fork.write(request('/valid'), { signal: stop.signal }), { code: 'ABORTED' });
    assert.equal(calls.some(call => call.kind === 'upsert'), false);
});

test('batched writes and reads share requests, propagate metadata, and validate before dispatch', async () => {
    const fixture = fileClient();
    const { client, calls } = fixture;
    const metadataSchema = { topic: { type: 'string', description: 'Original topic.' }, ordinal: { type: 'number' } };
    const labels = { 'eval.owner': 'test', 'eval.scope': 'synthetic' };
    const main = await create({ client, name: 'workspace', labels, metadataSchema, textSearch: { analyzers: ['english'] } });
    const fork = await main.fork({ name: 'research' });
    const before = calls.length;
    const [first, second] = await fork.write([
        { ...request('/first', 'Original content.'), metadata: { topic: 'math', ordinal: 2 } },
        request('/second', '   \n'),
    ]);
    assert.deepEqual(calls.slice(before).map(call => call.kind), ['query', 'upsert', 'fetch']);
    assert.deepEqual(first.metadata, { topic: 'math', ordinal: 2 });
    assert.equal(second.content, '   \n');
    const docs = calls.find(call => call.kind === 'upsert').request.docs;
    assert.equal(docs.length, 3);
    assert.deepEqual(docs[0].metadata, first.metadata);
    assert.equal(docs[2].kind, 'file');

    const reopened = await open({ client: { ...client }, name: 'workspace', at: { fork: 'research' } });
    const description = await reopened.describe();
    assert.deepEqual(description.labels, labels);
    assert.deepEqual(description.metadataSchema, metadataSchema);
    assert.deepEqual(description.textSearch, { analyzers: ['english'] });
    assert.deepEqual(fixture.collections.get('workspace').metadata.indexConfigs.embedding.embedding.sourceField, 'embeddingText');
    assert.deepEqual(await reopened.read({ paths: ['/second', '/missing', '/first'] }), [second, first]);

    await assert.rejects(reopened.write([request('/untouched'), request('/first')]), { code: 'PATH_EXISTS' });
    await assert.rejects(reopened.write([request('/untouched'), request('/untouched')]), { code: 'INVALID_INPUT' });
    await assert.rejects(reopened.write({ ...request('/invalid'), metadata: { ordinal: '2' } }), { code: 'INVALID_INPUT' });
    assert.equal(await reopened.read({ path: '/untouched' }), null);
    assert.equal(calls.filter(call => call.kind === 'upsert').length, 1);
});

test('ranked hybrid search verifies UTF-16 ranges and omits orphan chunks', async () => {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'workspace', metadataSchema: { topic: { type: 'string' } } });
    const fork = await main.fork({ name: 'research' });
    const text = '😀'.repeat(800) + 'A short final fragment.';
    const file = await fork.write({ ...request('/notes', text), metadata: { topic: 'fixture' } });
    fixture.rank = docs => [...docs].reverse();

    const result = await fork.search({ query: 'literal:*?', mode: 'hybrid', embeddingQuery: 'Semantic context', limit: 3,
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
    await fork.search({ query: 'notes', mode: 'hybrid', rerank: true, filter });
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
        await assert.rejects(fork.search({ query: 'notes', filter: invalid }), { code: 'INVALID_INPUT' });
    }
    assert.equal(fixture.calls.length, calls);

    const branch = fixture.collections.get('workspace').branches.get('fork-research');
    const firstChunk = [...branch.docs.values()].find(doc => doc.kind === 'chunk' && doc.start === 0);
    firstChunk.end++;
    const unverified = await fork.search({ query: 'notes', rerank: false });
    assert.equal(unverified.reranked, false);
    assert.equal(unverified.hits[1].range, undefined);

    fixture.rerank = { status: 'fallback', scoredCount: 0 };
    assert.equal((await fork.search({ query: 'notes', rerank: { onFailure: 'returnOriginal' } })).reranked, false);
    await assert.rejects(fork.search({ query: 'notes', rerank: true }), { code: 'RERANK_FAILED' });

    branch.docs.delete(`file:${file.fileId}`);
    assert.deepEqual(await fork.search({ query: 'notes', rerank: false }), { hits: [], reranked: false });
    fixture.rerank = undefined;
    assert.deepEqual(await main.search({ query: 'notes', rerank: true }), { hits: [], reranked: false });
});

test('text search defaults to semantic retrieval and keeps mode, reranking and filters independent', async () => {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'search-modes', metadataSchema: { topic: { type: 'string' } } });
    const fork = await main.fork({ name: 'draft' });
    const file = await fork.write({ ...request('/note', 'Preserve the draft before editing.'), metadata: { topic: 'checkpoint' } });
    const defaultResult = await fork.search({ query: 'preserve work' });
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
            const result = await fork.search({ query: 'checkpoint:*?', mode, limit: 201, filter, rerank,
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
    const main = await create({ client: fixture.client, name: 'invalid-search' });
    const fork = await main.fork({ name: 'draft' });
    const before = fixture.calls.length;
    for (const options of [
        { mode: 'auto' }, { mode: null }, { mode: 1 },
        { mode: 'keyword', embeddingQuery: 'unused' },
        { mode: 'keyword', rerank: false, embeddingQuery: 'unused' },
        { mode: 'semantic', embeddingQuery: '' }, { mode: 'hybrid', limit: 1001 },
        { mode: 'keyword', rerank: { fields: ['metadata.undeclared'] } },
    ]) await assert.rejects(fork.search({ query: 'checkpoint', ...options }), { code: 'INVALID_INPUT' });
    assert.equal(fixture.calls.length, before);
});

test('a large file publishes its original only after all chunk requests succeed', async () => {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'workspace' });
    const fork = await main.fork({ name: 'research' });
    const content = 'a'.repeat(310_000);
    let attempts = 0;
    fixture.beforeUpsert = () => {
        if (++attempts === 2) throw Object.assign(new Error('Embedding request rejected'), { statusCode: 400 });
    };
    await assert.rejects(fork.write(request('/large.txt', content)), error =>
        error.status === 400 && error.details.incompleteTargets[0].path === '/large.txt');
    const batches = fixture.calls.filter(call => call.kind === 'upsert');
    assert.equal(batches.length, 2);
    assert(batches[0].request.docs.every(doc => doc.kind === 'chunk'));
    assert(batches[1].request.docs.some(doc => doc.kind === 'file'));
    assert.equal(await fork.read({ path: '/large.txt' }), null);
    assert.deepEqual(await fork.search({ query: 'large', rerank: false }), { hits: [], reranked: false });

    const retried = await fork.write(request('/large.txt', content));
    assert.equal((await fork.read({ fileId: retried.fileId })).content, content);
});

test('lists matching file metadata and globally deduplicated prefixes across native pages', async () => {
    const fixture = fileClient();
    fixture.listPageSize = 2;
    const main = await create({ client: fixture.client, name: 'workspace', metadataSchema: { topic: { type: 'string' } } });
    const work = await main.fork({ name: 'research' });
    const alternate = await main.fork({ name: 'alternate' });
    const [root, direct] = await work.write([
        request('/Root.txt', 'include no body'),
        { ...request('/notes/B [x]*?.md'), metadata: { topic: 'synthetic' } },
        request('/notes/archive/alpha.txt'),
        request('/notes/archive/"quoted"/sample.txt'),
        request('/notes/Alpha.txt'),
        request('/notes/archive/B [x]*?.txt'),
        request('/notesish/B [x]*?.txt'),
    ]);
    await alternate.write(request('/alternate.txt'));
    assert.deepEqual(await main.list(), { files: [], prefixes: [], consistency: 'eventual' });
    assert.deepEqual((await alternate.list()).files.map(file => file.path), ['/alternate.txt']);
    const rootPage = await work.list({ delimiter: '/', limit: 2 });
    assert.deepEqual(rootPage.files, [{ fileId: root.fileId, path: root.path, modifiedAt: root.modifiedAt }]);
    assert.deepEqual(rootPage.prefixes, ['/notes/']);
    const last = await work.list({ cursor: rootPage.cursor });
    assert.deepEqual(last, { files: [], prefixes: ['/notesish/'], consistency: 'eventual' });
    assert.deepEqual(await work.list({ cursor: rootPage.cursor }), last);
    assert.deepEqual((await work.list({ prefix: '/notes/', delimiter: '/' })).prefixes, ['/notes/archive/']);

    const filtered = await work.list({ prefix: '/notes/', nameContains: 'B [x]*?', delimiter: '/' });
    assert.deepEqual(filtered, { files: [{ fileId: direct.fileId, path: direct.path, modifiedAt: direct.modifiedAt,
        metadata: { topic: 'synthetic' } }], prefixes: ['/notes/archive/'], consistency: 'eventual' });
    assert.deepEqual((await work.list({ prefix: '/notes/Al', nameContains: 'txt' })).files.map(file => file.path), ['/notes/Alpha.txt']);
    assert.deepEqual((await work.list({ prefix: '/notes/archive/"quoted"/' })).files.map(file => file.path),
        ['/notes/archive/"quoted"/sample.txt']);
    const quotedListing = fixture.calls.findLast(call => call.kind === 'list').request;
    assert.equal(quotedListing.filter.bool[1].queryString.query, '"/notes/archive/"');
    assert.deepEqual((await work.list({ prefix: '/notes/arch', nameContains: 'archive' })).files, []);
    assert.deepEqual((await work.list({ prefix: '/notes/', nameContains: 'alpha' })).files.map(file => file.path), ['/notes/archive/alpha.txt']);

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
    const main = await create({ client, name: 'workspace', metadataSchema: { note: { type: 'string' } } });
    const work = await main.fork({ name: 'research' });
    const [first, second] = await work.write([
        { ...request('/a.txt'), metadata: { note: 'before a' } },
        { ...request('/b.txt'), metadata: { note: 'before b' } },
        request('/group/c.txt'),
    ]);
    const page = await work.list({ delimiter: '/', limit: 1 });
    assert.deepEqual(page.files.map(file => file.fileId), [first.fileId]);
    page.files[0].metadata.note = 'caller mutation';
    const state = collections.get('workspace').branches.get('fork-research').docs;
    state.delete(`file:${second.fileId}`);
    await work.write({ ...request('/b2.txt'), metadata: { note: 'after' } });
    const listedBefore = calls.filter(call => call.kind === 'list').length;
    const next = await work.list({ cursor: page.cursor });
    assert.deepEqual(next.files, [{ fileId: second.fileId, path: '/b.txt', modifiedAt: second.modifiedAt, metadata: { note: 'before b' } }]);
    next.files[0].metadata.note = 'caller mutation';
    assert.equal((await work.list({ cursor: page.cursor })).files[0].metadata.note, 'before b');
    const final = await work.list({ cursor: next.cursor });
    assert.deepEqual(final, { files: [], prefixes: ['/group/'], consistency: 'eventual' });
    assert.deepEqual(await work.list({ cursor: next.cursor }), final);
    assert.equal(calls.filter(call => call.kind === 'list').length, listedBefore);

    await assert.rejects(work.list({ cursor: page.cursor, limit: 2 }), { code: 'INVALID_INPUT' });
    await assert.rejects(main.list({ cursor: page.cursor }), { code: 'LIST_CURSOR_UNAVAILABLE' });
    await assert.rejects((await main.fork({ name: 'alternate' })).list({ cursor: page.cursor }), { code: 'LIST_CURSOR_UNAVAILABLE' });
    const restarted = await open({ client: { ...client }, name: 'workspace', at: { fork: 'research' } });
    await assert.rejects(restarted.list({ cursor: page.cursor }), { code: 'LIST_CURSOR_UNAVAILABLE' });
    assert.deepEqual((await work.list()).files.map(file => file.path), ['/a.txt', '/b2.txt', '/group/c.txt']);

    const now = Date.now();
    t.mock.method(Date, 'now', () => now + 5 * 60 * 1000 + 1);
    await assert.rejects(work.list({ cursor: page.cursor }), { code: 'LIST_CURSOR_UNAVAILABLE' });
});

test('listing fails closed for invalid input, aborts, nonprogress, and scan overflow', async () => {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'workspace' });
    const work = await main.fork({ name: 'research' });
    const [file] = await work.write([request('/foo/a.txt')]);
    for (const options of [{ prefix: 'relative' }, { prefix: '/foo//bar' }, { prefix: '/foo/../bar' },
        { nameContains: '\uD800' }, { delimiter: '!' }, { limit: 0 }, { limit: 1001 }]) {
        await assert.rejects(work.list(options), { code: 'INVALID_INPUT' });
    }
    await assert.rejects(work.list({ cursor: 'invalid' }), { code: 'LIST_CURSOR_UNAVAILABLE' });
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(work.list({}, { signal: ctrl.signal }), { code: 'ABORTED' });
    assert.equal(fixture.calls.filter(call => call.kind === 'list').length, 0);

    const rows = [{ collection: 'workspace', doc: { ...file, kind: 'file', id: `file:${file.fileId}` } }];
    fixture.listPage = () => ({ isDocsInline: true, docs: rows, nextPageToken: 'repeated' });
    await assert.rejects(work.list(), { code: 'INVALID_RESULT' });
    fixture.listPage = ({ pageToken }) => pageToken === undefined
        ? { isDocsInline: true, docs: [], nextPageToken: 'empty' }
        : { isDocsInline: true, docs: rows };
    assert.deepEqual((await work.list()).files.map(item => item.fileId), [file.fileId]);

    const background = new AbortController();
    fixture.listPage = () => {
        background.abort();
        return { isDocsInline: true, docs: [] };
    };
    await assert.rejects(work.list({}, { signal: background.signal }), { code: 'ABORTED' });
    assert.strictEqual(fixture.calls.at(-1).signal, background.signal);

    fixture.listPage = ({ pageToken }) => ({
        isDocsInline: true, docs: Array.from({ length: 500 }, () => rows[0]),
        nextPageToken: String(Number(pageToken ?? 0) + 1),
    });
    await assert.rejects(work.list(), { code: 'LIST_SCAN_LIMIT' });
});

test('working edits preserve identity, resolve substitutions against the original, and replace metadata', async () => {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'workspace', metadataSchema: { topic: { type: 'string' } } });
    const work = await main.fork({ name: 'research' });
    const first = await work.write({ ...request('/notes/a.txt', 'The 😀 sky is gray. The sea is blue.\r\n'), metadata: { topic: 'test' } });
    const docs = fixture.collections.get('workspace').branches.get('fork-research').docs;
    const originalChunkIds = [...docs.values()].filter(doc => doc.kind === 'chunk').map(doc => doc.id);

    const moved = await work.write({ op: 'update', fileId: first.fileId, newPath: '/archive/"draft".txt' });
    assert.equal(moved.fileId, first.fileId);
    assert.equal(moved.content, first.content);
    assert.deepEqual(moved.metadata, first.metadata);
    assert.equal(await work.read({ path: first.path }), null);
    assert.deepEqual(await work.read({ path: moved.path }), moved);
    const move = fixture.calls.find(call => call.kind === 'update');
    assert(move.request.docs.every(doc => !Object.hasOwn(doc, 'body') && !Object.hasOwn(doc, 'content')));
    assert.deepEqual([...docs.values()].filter(doc => doc.kind === 'chunk').map(doc => doc.id), originalChunkIds);

    const changed = await work.write({ op: 'update', fileId: first.fileId, metadata: {}, edits: [
        { oldText: 'blue', newText: 'navy' },
        { oldText: 'gray', newText: 'blue' },
    ] });
    assert.equal(changed.content, 'The 😀 sky is blue. The sea is navy.\r\n');
    assert.equal(Object.hasOwn(changed, 'metadata'), false);
    assert.deepEqual(await work.read({ fileId: first.fileId }), changed);
    assert(originalChunkIds.every(id => !docs.has(id)));
    const ranked = await work.search({ query: 'navy', rerank: false });
    assert.deepEqual(ranked.hits, [{ ...changed, range: { start: 0, end: changed.content.length } }]);

    const empty = await work.write({ op: 'update', fileId: first.fileId, content: '' });
    assert.equal(empty.content, '');
    assert.equal([...docs.values()].filter(doc => doc.kind === 'chunk').length, 0);
    assert.deepEqual(await work.write({ op: 'delete', fileId: first.fileId }), { fileId: first.fileId });
    assert.deepEqual(await work.write({ op: 'delete', fileId: first.fileId }), { fileId: first.fileId });
    assert.equal(await work.read({ fileId: first.fileId }), null);
    assert(fixture.calls.filter(call => ['upsert', 'update', 'delete'].includes(call.kind)).every(call =>
        call.request.branch === 'fork-research' && call.retries.strategy === 'none'));
});

test('edit conflicts and invalid operations fail before the first mutation of a mixed batch', async () => {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'workspace' });
    const work = await main.fork({ name: 'research' });
    const [a, b] = await work.write([request('/a', 'aaa abcdef'), request('/b', 'source')]);
    const writes = () => fixture.calls.filter(call => ['upsert', 'update', 'delete'].includes(call.kind)).length;
    const before = writes();
    const edit = edits => ({ op: 'update', fileId: a.fileId, edits });
    await assert.rejects(work.write([request('/new'), edit([{ oldText: 'aa', newText: 'b' }])]), { code: 'EDIT_CONFLICT' });
    await assert.rejects(work.write(edit([{ oldText: 'abc', newText: 'x' }, { oldText: 'cdef', newText: 'y' }])), { code: 'EDIT_CONFLICT' });
    await assert.rejects(work.write(edit([{ oldText: 'absent', newText: '' }])), { code: 'EDIT_CONFLICT' });
    await assert.rejects(work.write(edit([{ oldText: 'abc', newText: 'x' }, { oldText: 'abc', newText: 'y' }])), { code: 'INVALID_INPUT' });
    await assert.rejects(work.write({ ...edit([{ oldText: 'abc', newText: 'x' }]), content: 'other' }), { code: 'INVALID_INPUT' });
    await assert.rejects(work.write([{ op: 'delete', fileId: a.fileId }, { op: 'update', fileId: a.fileId, content: 'new' }]), { code: 'INVALID_INPUT' });
    await assert.rejects(work.write([{ op: 'delete', fileId: a.fileId }, { op: 'update', fileId: b.fileId, newPath: '/a' }]), { code: 'PATH_EXISTS' });
    await assert.rejects(work.write([{ op: 'update', fileId: a.fileId, newPath: '/same' }, request('/same')]), { code: 'INVALID_INPUT' });
    assert.equal(writes(), before);
    assert.equal(await work.read({ path: '/new' }), null);
    assert.deepEqual(await work.read({ fileId: a.fileId }), a);

    const [created, updated, deleted] = await work.write([
        request('/new', 'new'), { op: 'update', fileId: b.fileId, content: 'changed' }, { op: 'delete', fileId: a.fileId },
    ]);
    assert.equal(created.path, '/new');
    assert.equal(updated.content, 'changed');
    assert.deepEqual(deleted, { fileId: a.fileId });
    await assert.rejects(work.write({ op: 'update', fileId: a.fileId, content: 'later' }), { code: 'FILE_NOT_FOUND' });
});

test('lost update acknowledgements fence an unchanged original and resume when its revision is observed', async () => {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'workspace' });
    const work = await main.fork({ name: 'research' });
    const file = await work.write(request('/a', 'first'));
    const docs = fixture.collections.get('workspace').branches.get('fork-research').docs;
    let release;
    fixture.beforeUpsert = request => {
        release = () => { for (const doc of request.docs) docs.set(doc.id, doc); };
        throw new Error('Response lost');
    };
    const update = { op: 'update', fileId: file.fileId, content: 'second' };
    await assert.rejects(work.write(update), { code: 'WRITE_UNCONFIRMED' });
    assert.equal((await work.read({ fileId: file.fileId })).content, 'first');
    await assert.rejects(work.write(update), { code: 'WRITE_UNCONFIRMED' });
    release();
    fixture.beforeUpsert = undefined;
    const recovered = await work.write(update);
    assert.equal(recovered.content, 'second');
    assert.equal([...docs.values()].filter(doc => doc.kind === 'chunk').length, 1);
});

test('an applied update or deletion resumes chunk cleanup after reopening', async () => {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'workspace' });
    const work = await main.fork({ name: 'research' });
    const file = await work.write(request('/a', 'first'));
    const orig = fixture.collections.get('workspace').branches.get('fork-research').docs;
    const oldChunks = [...orig.values()].filter(doc => doc.kind === 'chunk').map(doc => doc.id);
    const reject = () => { throw Object.assign(new Error('Rejected'), { statusCode: 400 }); };
    fixture.beforeDelete = reject;
    await assert.rejects(work.write({ op: 'update', fileId: file.fileId, content: 'second' }), error =>
        error.status === 400 && error.details.stage === 'cleanup-chunks' && error.details.appliedFileIds.includes(file.fileId));
    assert.equal((await work.read({ fileId: file.fileId })).content, 'second');
    assert(oldChunks.every(id => orig.has(id)));
    assert.deepEqual((await work.search({ query: 'first', rerank: false })).hits.map(hit => hit.content), ['second']);
    fixture.beforeDelete = undefined;
    const reopened = await open({ client: { ...fixture.client }, name: 'workspace', at: { fork: 'research' } });
    const restored = await reopened.write({ op: 'update', fileId: file.fileId, content: 'second' });
    assert.equal(restored.content, 'second');
    assert(oldChunks.every(id => !orig.has(id)));

    fixture.beforeDelete = reject;
    await assert.rejects(reopened.write({ op: 'delete', fileId: file.fileId }), error =>
        error.status === 400 && error.details.stage === 'cleanup-chunks' && error.details.appliedFileIds.includes(file.fileId));
    assert.equal(await reopened.read({ fileId: file.fileId }), null);
    assert.equal((await reopened.search({ query: 'second', rerank: false })).hits.length, 0);
    fixture.beforeDelete = undefined;
    const retry = await open({ client: { ...fixture.client }, name: 'workspace', at: { fork: 'research' } });
    await retry.write({ op: 'delete', fileId: file.fileId });
    assert.equal(orig.size, 0);
});

test('a lost cleanup request can be retried on the same live handle', async () => {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'workspace' });
    const work = await main.fork({ name: 'research' });
    const file = await work.write(request('/a', 'first'));
    const docs = fixture.collections.get('workspace').branches.get('fork-research').docs;
    const oldId = [...docs.values()].find(doc => doc.kind === 'chunk').id;
    fixture.beforeDelete = () => { throw new Error('Lost before applying'); };
    const change = { op: 'update', fileId: file.fileId, content: 'second' };
    await assert.rejects(work.write(change), error =>
        error.code === 'WRITE_UNCONFIRMED' && error.details.stage === 'cleanup-chunks');
    assert(docs.has(oldId));
    assert.equal((await work.read({ fileId: file.fileId })).content, 'second');
    fixture.beforeDelete = undefined;
    assert.equal((await work.write(change)).content, 'second');
    assert.equal(docs.has(oldId), false);
});

test('reintroducing identical text uses new chunk IDs even if an earlier delete is replayed', async () => {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'workspace' });
    const work = await main.fork({ name: 'research' });
    const file = await work.write(request('/a', 'first'));
    await work.write({ op: 'update', fileId: file.fileId, content: 'second' });
    const deletion = fixture.calls.find(call => call.kind === 'delete').request;
    await work.write({ op: 'update', fileId: file.fileId, content: 'first' });
    await fixture.client.collection('workspace').docs.delete(deletion);
    const hits = (await work.search({ query: 'first', rerank: false })).hits;
    assert.equal(hits.length, 1);
    assert.equal(hits[0].content, 'first');
});

test('an inherited published baseline is preserved through edits and a backed tombstone', async () => {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'workspace' });
    const work = await main.fork({ name: 'research' });
    const file = await work.write(request('/published', 'source'));
    const docs = fixture.collections.get('workspace').branches.get('fork-research').docs;
    const key = `file:${file.fileId}`;
    docs.get(key).version = 'published-version';
    delete docs.get(key).changed;

    await work.write({ op: 'update', fileId: file.fileId, newPath: '/working', content: 'working' });
    const baseline = docs.get(key).baseline;
    assert.equal(baseline.version, 'published-version');
    assert.equal(baseline.path, '/published');
    assert.match(baseline.fingerprint, /^[0-9a-f]{64}$/);
    await work.write({ op: 'update', fileId: file.fileId, newPath: file.path, content: file.content });
    assert.deepEqual(docs.get(key).baseline, baseline);
    assert.equal(docs.get(key).changed, false);

    await work.write({ op: 'delete', fileId: file.fileId });
    assert.deepEqual(docs.get(key).baseline, baseline);
    assert.equal(docs.get(key).kind, 'tombstone');
    assert.equal(docs.size, 1);
    const reopened = await open({ client: { ...fixture.client }, name: 'workspace', at: { fork: 'research' } });
    assert.equal(await reopened.read({ fileId: file.fileId }), null);
    assert.equal(await reopened.read({ path: file.path }), null);
    assert.deepEqual(await reopened.write({ op: 'delete', fileId: file.fileId }), { fileId: file.fileId });
    assert.equal(docs.size, 1);
});

test('edit preflight rejects an ambiguous identity and cancellation after dispatch leaves a recoverable revision', async () => {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'workspace' });
    const work = await main.fork({ name: 'research' });
    const [file, other] = await work.write([request('/a', 'before'), request('/b', 'other')]);
    const update = { op: 'update', fileId: file.fileId, content: 'after' };
    fixture.beforeFetch = (_request, docs) => ({ isDocsInline: true, total: 1,
        docs: [{ collection: 'workspace', doc: docs.get(`file:${other.fileId}`) }] });
    await assert.rejects(work.write(update), { code: 'INVALID_RESULT' });
    fixture.beforeFetch = undefined;
    const controller = new AbortController();
    fixture.afterUpsert = () => controller.abort();
    await assert.rejects(work.write(update, { signal: controller.signal }), error =>
        error.code === 'WRITE_UNCONFIRMED' && error.details.stage === 'write-original');
    fixture.afterUpsert = undefined;
    assert.deepEqual(await work.read({ fileId: file.fileId }), await work.write(update));
});

test('moves patch persisted chunks across fallback and segmented runtimes in both directions', async () => {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'workspace' });
    const work = await main.fork({ name: 'research' });
    const text = 'a'.repeat(500) + ' Mr. ' + 'b'.repeat(160) + ' final ' + 'c'.repeat(500);
    const docs = fixture.collections.get('workspace').branches.get('fork-research').docs;
    const chunks = file => [...docs.values()].filter(doc => doc.kind === 'chunk' && doc.fileId === file.fileId);
    const segmenter = Intl.Segmenter;
    try {
        Intl.Segmenter = undefined;
        const fallback = await work.write(request('/fallback.txt', text));
        const fallbackIds = chunks(fallback).map(doc => doc.id);
        Intl.Segmenter = segmenter;
        const segmented = await work.write(request('/segmented.txt', text));
        const segmentedIds = chunks(segmented).map(doc => doc.id);
        assert.notDeepEqual(chunks(fallback).map(doc => doc.end), chunks(segmented).map(doc => doc.end));
        await work.write({ op: 'update', fileId: fallback.fileId, newPath: '/fallback-moved.txt' });
        assert.deepEqual(chunks(fallback).map(doc => doc.id), fallbackIds);
        assert(chunks(fallback).every(doc => doc.path === '/fallback-moved.txt'));

        Intl.Segmenter = undefined;
        await work.write({ op: 'update', fileId: segmented.fileId, newPath: '/segmented-moved.txt' });
        await work.write({ op: 'update', fileId: segmented.fileId, content: text });
        assert.deepEqual(chunks(segmented).map(doc => doc.id), segmentedIds);
        assert(chunks(segmented).every(doc => doc.path === '/segmented-moved.txt'));
        assert.deepEqual(await work.read({ fileId: segmented.fileId }).then(file => file.content), text);
        assert.equal(fixture.calls.filter(call => call.kind === 'upsert').length, 2);
    } finally {
        Intl.Segmenter = segmenter;
    }
});

test('move scans every page of persisted chunk IDs with the same hash and writes the original last', async () => {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'workspace' });
    const work = await main.fork({ name: 'research' });
    const file = await work.write(request('/old.txt', 'source'));
    const docs = fixture.collections.get('workspace').branches.get('fork-research').docs;
    const template = [...docs.values()].find(doc => doc.kind === 'chunk');
    const base = template.id.slice(0, -1);
    for (let i = 1000; i >= 1; i--) {
        const id = base + i;
        docs.set(id, { ...template, id });
    }
    await work.write({ op: 'update', fileId: file.fileId, newPath: '/new.txt' });

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
    const main = await create({ client, name: 'workspace' });
    assert.equal('diff' in main, false);
    const work = await main.fork({ name: 'research' });
    const alternate = await main.fork({ name: 'alternate' });
    assert.deepEqual(await work.diff(), []);
    const [created, moved, body, deleted, restored, removed, interrupted] = await work.write([
        request('/create', 'created'), request('/move', 'move'), request('/body', 'old'),
        request('/delete', 'remove'), request('/restore', 'baseline'), request('/gone', ''), request('/interrupted', 'unfinished'),
    ]);
    const docs = collections.get('workspace').branches.get('fork-research').docs;
    for (const file of [moved, body, deleted, restored]) {
        const record = docs.get(`file:${file.fileId}`);
        delete record.changed;
        record.version = 'published';
    }
    await work.write([
        { op: 'update', fileId: created.fileId, newPath: '/created-moved' },
        { op: 'update', fileId: moved.fileId, newPath: '/moved-once' },
        { op: 'update', fileId: body.fileId, content: 'new' },
        { op: 'update', fileId: deleted.fileId, newPath: '/previously-moved' },
        { op: 'update', fileId: restored.fileId, content: 'edited' },
        { op: 'delete', fileId: removed.fileId },
    ]);
    await work.write([
        { op: 'update', fileId: moved.fileId, newPath: '/moved-again' },
        { op: 'delete', fileId: deleted.fileId },
        { op: 'update', fileId: restored.fileId, content: restored.content },
    ]);
    fixture.beforeDelete = () => { throw Object.assign(new Error('Chunk cleanup rejected'), { statusCode: 400 }); };
    await assert.rejects(work.write({ op: 'delete', fileId: interrupted.fileId }), { code: 'DATABASE_ERROR' });
    fixture.beforeDelete = undefined;
    // Defensive equality also omits an exact revert if the candidate was marked changed.
    docs.get(`file:${restored.fileId}`).changed = true;
    await alternate.write(request('/other-fork'));
    const reusedPath = await work.write(request('/delete'));

    const reopened = await open({ client: { ...client }, name: 'workspace', at: { fork: 'research' } });
    const before = calls.length;
    const expected = [
        { op: 'create', fileId: created.fileId, path: '/created-moved' },
        { op: 'update', fileId: moved.fileId, path: '/moved-again', previousPath: '/move' },
        { op: 'update', fileId: body.fileId, path: '/body' },
        { op: 'delete', fileId: deleted.fileId, previousPath: '/delete' },
        { op: 'create', fileId: reusedPath.fileId, path: '/delete' },
    ].sort((a, b) => a.fileId.localeCompare(b.fileId));
    assert.deepEqual(await reopened.diff(), expected);
    const call = calls.slice(before);
    assert.equal(call.length, 1);
    assert.equal(call[0].kind, 'query');
    assert.equal(call[0].request.consistentRead, true);
    assert.equal(call[0].request.includeVectors, false);
    assert.deepEqual(call[0].request.ref, { kind: 'branch', name: 'fork-research' });
    assert.deepEqual(call[0].request.fields.include, ['id', 'kind', 'fileId', 'path', 'changed', 'baseline', 'fingerprint', 'version']);
    assert.deepEqual((await alternate.diff()).map(change => change.path), ['/other-fork']);
});

test('diff pages across the generated ID boundary and queues following writes', async () => {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'workspace' });
    const work = await main.fork({ name: 'research' });
    const docs = fixture.collections.get('workspace').branches.get('fork-research').docs;
    const synthetic = Array.from({ length: 1001 }, (_, i) => {
        const fileId = `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
        return { fileId, id: `file:${fileId}`, kind: 'file', changed: true, path: `/synthetic/${i}` };
    });
    for (const doc of [...synthetic].reverse()) docs.set(doc.id, doc);
    let entered, release;
    const active = new Promise(resolve => { entered = resolve; });
    const pause = new Promise(resolve => { release = resolve; });
    fixture.diffPage = async request => {
        if (request.query.bool.length === 2) { entered(); await pause; }
    };
    const scanning = work.diff();
    await active;
    const queued = work.write(request('/queued'));
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
    assert.equal((await work.diff()).length, 1002);
});

test('diff rejects invalid records, nonprogress and incomplete pages and recovers after abort', async () => {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'workspace' });
    const work = await main.fork({ name: 'research' });
    await work.write(request('/a'));
    const records = fixture.collections.get('workspace').branches.get('fork-research').docs;
    const original = [...records.values()][0];
    const wrap = (...docs) => ({ isDocsInline: true, total: docs.length, docs: docs.map(doc => ({ collection: 'workspace', doc })) });
    for (const invalid of [
        { ...original, kind: 'chunk' },
        { ...original, changed: false },
        { ...original, id: 'wrong' },
        { ...original, baseline: { version: 'v1', path: '/before', fingerprint: 'bad' } },
        { ...original, version: 'v1' },
        { ...original, baseline: { version: 'v1', path: '/before', fingerprint: '0'.repeat(64) }, fingerprint: '0'.repeat(64) },
    ]) {
        fixture.diffPage = () => wrap(invalid);
        await assert.rejects(work.diff(), { code: 'INVALID_RESULT' });
    }
    fixture.diffPage = () => wrap(original, original);
    await assert.rejects(work.diff(), { code: 'INVALID_RESULT' });
    fixture.diffPage = () => ({ ...wrap(original), total: 2 });
    await assert.rejects(work.diff(), { code: 'INVALID_RESULT' });
    const controller = new AbortController();
    fixture.diffPage = (_request, options) => {
        assert.strictEqual(options.signal, controller.signal);
        controller.abort();
        return wrap(original);
    };
    await assert.rejects(work.diff({ signal: controller.signal }), { code: 'ABORTED' });
    fixture.diffPage = undefined;
    assert.deepEqual(await work.diff(), [{ op: 'create', fileId: original.fileId, path: '/a' }]);
    await assert.rejects(work.diff({ limit: 1 }), { code: 'INVALID_INPUT' });
});

test('checkpoints reopen as read-only tag views and fork independent working state', async () => {
    const fixture = fileClient();
    const { client, calls, collections } = fixture;
    const main = await create({ client, name: 'workspace' });
    const work = await main.fork({ name: 'saved' });
    const [file, deleted] = await work.write([request('/file.txt', 'before'), request('/removed.txt', 'remove')]);
    const docs = collections.get('workspace').branches.get('fork-saved').docs;
    docs.get(`file:${deleted.fileId}`).version = 'baseline-version';
    delete docs.get(`file:${deleted.fileId}`).changed;
    await work.write({ op: 'delete', fileId: deleted.fileId });
    const saved = await work.checkpoint({ name: 'saved' });
    assert.deepEqual(saved.at, { kind: 'checkpoint', name: 'saved' });
    for (const method of ['write', 'diff']) assert.equal(method in saved, false);
    assert.throws(() => { saved.at.name = 'changed'; }, TypeError);
    assert.deepEqual(await saved.describe(), await work.describe());
    assert.strictEqual(await open({ client, name: 'workspace', at: { checkpoint: 'saved' } }), saved);
    assert.strictEqual(await open({ client, name: 'workspace', at: { fork: 'saved' } }), work);
    const reopened = await open({ client: { ...client }, name: 'workspace', at: { checkpoint: 'saved' } });
    assert.notEqual(reopened, saved);
    assert(calls.some(call => call.kind === 'tag-get' && call.tagName === 'checkpoint-saved'));

    await work.write({ op: 'update', fileId: file.fileId, content: 'after', newPath: '/after.txt' });
    assert.equal(await reopened.read({ fileId: deleted.fileId }), null);
    assert.deepEqual(await reopened.read({ fileId: file.fileId }), file);
    assert.deepEqual(await reopened.read({ path: file.path }), file);
    assert.deepEqual(await reopened.read({ paths: [file.path, '/after.txt'] }), [file]);
    assert.deepEqual((await reopened.list()).files.map(entry => entry.fileId), [file.fileId]);
    assert.deepEqual((await reopened.search({ query: 'before', rerank: false })).hits,
        [{ ...file, range: { start: 0, end: file.content.length } }]);
    const tagReads = calls.filter(call => call.request?.ref?.kind === 'tag');
    assert(tagReads.some(call => call.kind === 'list' && !('consistentRead' in call.request)));
    assert(tagReads.some(call => call.kind === 'fetch' && call.request.consistentRead === false));
    assert(tagReads.some(call => call.kind === 'query' && call.request.consistentRead === false));
    assert(tagReads.every(call => call.request.ref.name === 'checkpoint-saved'));

    const copied = await saved.checkpoint({ name: 'copied' });
    assert.deepEqual(await copied.read({ fileId: file.fileId }), file);
    const child = await saved.fork({ name: 'child' });
    const nested = await work.fork({ name: 'nested' });
    assert.deepEqual(await child.read({ fileId: file.fileId }), file);
    assert.equal(await child.read({ fileId: deleted.fileId }), null);
    assert.equal((await nested.read({ fileId: file.fileId })).content, 'after');
    assert.deepEqual((await child.diff()).find(change => change.fileId === deleted.fileId),
        { op: 'delete', fileId: deleted.fileId, previousPath: deleted.path });
    await child.write({ op: 'update', fileId: file.fileId, newPath: '/child.txt' });
    assert.equal((await child.diff()).find(change => change.fileId === file.fileId).path, '/child.txt');
    assert.equal((await work.read({ fileId: file.fileId })).path, '/after.txt');
    assert.equal((await saved.read({ fileId: file.fileId })).path, file.path);
    assert(calls.filter(call => ['tag-create', 'branch-create'].includes(call.kind)).every(call => call.retries.strategy === 'none'));
    assert(calls.some(call => call.kind === 'branch-create' && call.request.source.kind === 'tag'));
    assert(calls.some(call => call.kind === 'tag-create' && call.request.source.kind === 'tag'));
});

test('checkpoint names are store-scoped and absent or invalid lookups are not cached', async () => {
    const fixture = fileClient();
    const { client } = fixture;
    const main = await create({ client, name: 'workspace' });
    const work = await main.fork({ name: 'research' });
    const nativeError = Object.assign(new Error('Source is temporarily unavailable'), { statusCode: 400 });
    fixture.beforeTagCreate = () => { throw nativeError; };
    await assert.rejects(work.checkpoint({ name: 'saved' }), { code: 'DATABASE_ERROR', status: 400, cause: nativeError });
    assert.equal(fixture.calls.filter(call => call.kind === 'tag-create').length, 1);
    fixture.beforeTagCreate = undefined;
    await assert.rejects(open({ client, name: 'workspace', at: { fork: 'saved', checkpoint: 'saved' } }), { code: 'INVALID_INPUT' });
    await assert.rejects(open({ client, name: 'workspace', at: { checkpoint: 'x'.repeat(42) } }), { code: 'INVALID_INPUT' });
    await assert.rejects(open({ client, name: 'workspace', at: { checkpoint: 'saved' } }), { code: 'CHECKPOINT_NOT_FOUND' });
    fixture.getTag = () => ({ tag: { name: 'checkpoint-unrelated' } });
    await assert.rejects(open({ client, name: 'workspace', at: { checkpoint: 'saved' } }), { code: 'INVALID_RESULT' });
    fixture.getTag = undefined;

    await work.write(request('/file.txt'));
    const saved = await work.checkpoint({ name: 'saved' });
    assert.strictEqual(await open({ client, name: 'workspace', at: { checkpoint: 'saved' } }), saved);
    await assert.rejects(work.checkpoint({ name: 'saved' }), { code: 'CHECKPOINT_CONFLICT' });
    await assert.rejects(saved.fork({ name: 'research' }), { code: 'BRANCH_CONFLICT' });
    await create({ client, name: 'another' });
    await assert.rejects(open({ client, name: 'another', at: { checkpoint: 'saved' } }), { code: 'CHECKPOINT_NOT_FOUND' });
});

test('ref creation queues with writes and diff and protects against retries after a lost acknowledgement', async () => {
    const fixture = fileClient();
    const { client, calls } = fixture;
    const main = await create({ client, name: 'workspace' });
    const work = await main.fork({ name: 'research' });
    let release;
    const held = new Promise(resolve => { release = resolve; });
    fixture.beforeUpsert = () => held;
    const writing = work.write(request('/before.txt', 'before'));
    const scanning = work.diff();
    const captured = work.checkpoint({ name: 'queued' });
    const child = work.fork({ name: 'child' });
    const later = work.write(request('/later.txt', 'after'));
    await new Promise(resolve => setImmediate(resolve));
    assert(!calls.some(call => call.kind === 'tag-create' || call.request?.branchName === 'fork-child'));
    fixture.beforeUpsert = undefined;
    release();
    const before = await writing;
    assert.deepEqual(await scanning, [{ op: 'create', fileId: before.fileId, path: before.path }]);
    const saved = await captured;
    const branch = await child;
    await later;
    assert.deepEqual(await saved.read({ fileId: before.fileId }), before);
    assert.equal(await branch.read({ path: '/later.txt' }), null);

    fixture.afterTagCreate = () => { throw new Error('Response lost after acceptance'); };
    await assert.rejects(work.checkpoint({ name: 'lost' }), { code: 'REF_CREATION_UNCONFIRMED' });
    fixture.afterTagCreate = undefined;
    await work.write(request('/later-again.txt'));
    await assert.rejects(work.checkpoint({ name: 'lost' }), { code: 'REF_CREATION_UNCONFIRMED' });
    assert.equal(calls.filter(call => call.request?.tagName === 'checkpoint-lost').length, 1);
    const reopened = await open({ client, name: 'workspace', at: { checkpoint: 'lost' } });
    assert.equal(await reopened.read({ path: '/later-again.txt' }), null);
});

test('working ref creation waits for an unconfirmed source mutation to settle', async () => {
    const fixture = fileClient();
    const { client, calls, collections } = fixture;
    const main = await create({ client, name: 'workspace' });
    const work = await main.fork({ name: 'research' });
    const docs = collections.get('workspace').branches.get('fork-research').docs;
    let settle;
    fixture.beforeUpsert = request => {
        settle = () => { for (const doc of request.docs) docs.set(doc.id, doc); };
        throw new Error('Lost before confirmation');
    };
    await assert.rejects(work.write(request('/uncertain.txt')), { code: 'WRITE_UNCONFIRMED' });
    await assert.rejects(work.checkpoint({ name: 'saved' }), { code: 'WRITE_UNCONFIRMED' });
    await assert.rejects(work.fork({ name: 'child' }), { code: 'WRITE_UNCONFIRMED' });
    assert.equal(calls.filter(call => call.kind === 'tag-create' || call.request?.branchName === 'fork-child').length, 0);
    settle();
    fixture.beforeUpsert = undefined;
    const saved = await work.checkpoint({ name: 'saved' });
    assert.equal((await saved.read({ path: '/uncertain.txt' })).content, '');
});
