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
    assert.deepEqual(original, {
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
        details: { fileId: details.fileId, path: details.path } });
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
    assert.deepEqual(fixture.collections.get('workspace').metadata.indexConfigs.embedding.embedding.sourceField, 'content');
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

    const result = await fork.search({ query: 'literal:*?', embeddingQuery: 'Semantic context', limit: 3,
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

    const branch = fixture.collections.get('workspace').branches.get('fork-research');
    const firstChunk = [...branch.docs.values()].find(doc => doc.kind === 'chunk' && doc.start === 0);
    firstChunk.end++;
    const unverified = await fork.search({ query: 'notes', rerank: false });
    assert.equal(unverified.reranked, false);
    assert.equal(unverified.hits[1].range, undefined);

    fixture.rerank = { status: 'fallback', scoredCount: 0 };
    assert.equal((await fork.search({ query: 'notes', rerank: { onFailure: 'returnOriginal' } })).reranked, false);
    await assert.rejects(fork.search({ query: 'notes' }), { code: 'RERANK_FAILED' });

    branch.docs.delete(`file:${file.fileId}`);
    assert.deepEqual(await fork.search({ query: 'notes', rerank: false }), { hits: [], reranked: false });
    fixture.rerank = undefined;
    assert.deepEqual(await main.search({ query: 'notes' }), { hits: [], reranked: false });
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
