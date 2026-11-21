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
    assert.deepEqual(file, { fileId: file.fileId, path, content });
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
    assert.deepEqual(writes[0].request.docs, [{
        id: `file:${file.fileId}`, kind: 'file', fileId: file.fileId, path, content,
        fileName: '한글 "draft":*?.md', ancestorPaths: ['/', '/notes/'], changed: true,
    }]);
    assert.deepEqual(writes[1].request.docs[0].ancestorPaths, ['/']);
    assert.equal(calls.filter(call => call.kind === 'fetch').every(call => call.request.consistentRead), true);
    const lookup = calls.find(call => call.kind === 'query').request;
    assert.deepEqual(lookup, {
        size: 2, ref: { kind: 'branch', name: 'fork-research' }, consistentRead: true, includeVectors: false,
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
            fixture.collections.get('workspace').branches.get(body.branch).docs.set(body.docs[0].id, body.docs[0]);
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
    await assert.rejects(fork.write(request('/a.txt', 'duplicate')), { code: 'WRITE_UNCONFIRMED', details });
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
