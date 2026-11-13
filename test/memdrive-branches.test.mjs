import test from 'node:test';
import assert from 'node:assert/strict';
import { LambdaDBClient, HTTPClient } from '@functional-systems/lambdadb';
import * as memdrive from '../dist/esm/index.js';
import { createBackend, publicMatch, sourceMatch } from '../dist/esm/storage.js';
import { memdriveClient } from './helpers/memdrive-client.mjs';

const schema = { topic: { type: 'string' } };
const mem = (content, id = 'same') => ({ id, content, metadata: { topic: content } });
const create = (f, options = {}) => memdrive.create({ client: f.client, name: 'branches_test', metadataSchema: schema, ...options });

test('branch data is independent, opening selects existing data, and administration stays collection-scoped', async () => {
    const f = memdriveClient(), drive = await create(f);
    f.search = (_request, docs) => docs;
    await drive.remember({ mems: [mem('original')] });
    const details = await drive.branches.create({ name: 'alternate' });
    assert.equal(details.name, 'alternate'); assert(details.createdAt instanceof Date);
    assert.deepEqual((await drive.branches.list()).map(item => item.name), ['main', 'alternate']);
    const alternate = drive.at({ branch: 'alternate' });
    assert.deepEqual(Object.keys(alternate).sort(), ['countValues', 'embedding', 'forget', 'list', 'read', 'recall', 'remember']);
    await alternate.remember({ mems: [mem('x'.repeat(1700))] });
    await alternate.remember({ mems: [mem('alternate')] });
    assert.deepEqual((await drive.read({ ids: ['same'] })).mems, [mem('original')]);
    assert.deepEqual((await alternate.read({ ids: ['same'] })).mems, [mem('alternate')]);
    assert.equal([...f.collections.get('branches_test').branches.get('alternate').docs.values()]
        .filter(doc => doc.kind === 'chunk' && !Object.hasOwn(doc, 'content')).length, 3);
    assert.deepEqual((await drive.recall({ query: 'topic' })).matches, [publicMatch(await sourceMatch(mem('original')))]);
    assert.deepEqual((await alternate.recall({ query: 'topic' })).matches, [publicMatch(await sourceMatch(mem('alternate')))]);
    const opened = await memdrive.open({ client: f.client, name: 'branches_test', branch: 'alternate' });
    assert.deepEqual((await opened.recall({ query: 'topic' })).matches, [publicMatch(await sourceMatch(mem('alternate')))]);
    await assert.rejects(memdrive.open({ client: f.client, name: 'branches_test', branch: 'missing' }), { code: 'BRANCH_NOT_FOUND' });
    await opened.configure({ metadataSchema: { ...schema, label: { type: 'string' } } });
    // The new view shares this root's schema after collection-wide configuration.
    await opened.at({ branch: 'main' }).remember({ mems: [{ ...mem('updated'), metadata: { topic: 'updated', label: 'shared' } }] });
    await alternate.forget({ ids: ['same'] });
    assert.equal(f.collections.get('branches_test').branches.get('alternate').docs.size, 0);
    assert.deepEqual((await alternate.recall({ query: 'topic' })).matches, []);
    const main = opened.at({ branch: 'main' });
    assert.equal((await main.recall({ query: 'topic' })).matches.length, 1);
    await opened.branches.create({ name: 'third' });
    assert.equal(f.calls.findLast(call => call.kind === 'branch_create').request.source.name, 'main');
    await opened.destroy();
    await assert.rejects(main.recall({ query: 'topic' }), { code: 'STORE_DELETED' });
});

test('branch input errors and native missing/conflict errors never fall back or broaden the target', async () => {
    const f = memdriveClient(), drive = await create(f);
    const before = f.calls.length;
    for (const ref of [{}, { tag: 'saved' }, { alias: 'active' }, { branch: 'x' }, { branch: 'main', extra: true }])
        assert.throws(() => drive.at(ref), { code: 'INVALID_INPUT' });
    for (const request of [{ name: 'alternate', source: null }, { name: 'alternate', source: { tag: 'saved' } },
        { name: 'alternate', source: { branch: 'main', asOf: 1 } }])
        await assert.rejects(drive.branches.create(request), { code: 'INVALID_INPUT' });
    await assert.rejects(drive.branches.delete('main'), { code: 'INVALID_INPUT' });
    assert.equal(f.calls.length, before);
    await assert.rejects(drive.at({ branch: 'missing' }).remember({ mems: [mem('missing')] }), error => error.status === 404);
    await assert.rejects(drive.at({ branch: 'missing' }).recall({ query: 'topic' }), error => error.status === 404);
    await drive.branches.create({ name: 'alternate' });
    await assert.rejects(drive.branches.create({ name: 'alternate' }), { code: 'BRANCH_EXISTS' });
    f.beforeBranchDelete = () => { throw Object.assign(new Error('Referenced by alias'), { statusCode: 409 }); };
    await assert.rejects(drive.branches.delete('alternate'), error => error.code === 'BRANCH_CONFLICT' && error.status === 409);
    await drive.at({ branch: 'alternate' }).remember({ mems: [mem('still active')] });
    assert.equal(f.collections.get('branches_test').docs.size, 0);
    delete f.beforeBranchDelete;
    const stale = drive.at({ branch: 'alternate' });
    await drive.branches.delete('alternate');
    await drive.branches.create({ name: 'alternate' });
    await assert.rejects(stale.recall({ query: 'topic' }), { code: 'BRANCH_INVALIDATED' });
    await drive.at({ branch: 'alternate' }).remember({ mems: [mem('replacement')] });
});

test('deleting and recreating a branch stops later write batches and preserves accepted-write details', async () => {
    const f = memdriveClient(), drive = await create(f, { metadataSchema: { payload: { type: 'string[]' } } });
    await drive.branches.create({ name: 'alternate' });
    const alternate = drive.at({ branch: 'alternate' });
    f.afterUpsert = async () => {
        delete f.afterUpsert;
        await drive.branches.delete('alternate');
        await drive.branches.create({ name: 'alternate' });
    };
    const mems = ['first', 'second'].map(id => ({ id, content: id,
        metadata: { payload: Array(800).fill('x'.repeat(4000)) } }));
    await assert.rejects(alternate.remember({ mems }), error => {
        assert.equal(error.code, 'BRANCH_INVALIDATED');
        assert.deepEqual(error.details.completedIds, mems.slice(0, 1).map(item => item.id));
        assert.deepEqual(error.details.uncertainIds, []);
        assert.deepEqual(error.details.notAttemptedIds, mems.slice(1).map(item => item.id));
        return true;
    });
    assert.equal(f.calls.filter(call => call.kind === 'upsert').length, 1);
    assert.equal(f.collections.get('branches_test').branches.get('alternate').docs.size, 0);
});

test('native SDK serializes branch management and data refs without network calls', async () => {
    const requests = [];
    let collection;
    const info = { name: 'alternate', parentBranch: { branchId: 'main-id', name: 'main' },
        headSnapshot: null, parentSnapshot: null, createdAt: 0 };
    const client = new LambdaDBClient({ baseUrl: 'https://drive.invalid', projectName: 'example', projectApiKey: 'synthetic',
        retryConfig: { strategy: 'none' }, debugLogger: { log() {}, group() {}, groupEnd() {} },
        httpClient: new HTTPClient({ fetcher: async request => {
            const path = new URL(request.url).pathname, body = request.body ? await request.json() : undefined;
            requests.push({ method: request.method, path, body });
            let response, status = 200;
            if (request.method === 'POST' && path.endsWith('/collections')) {
                collection = { ...body, projectName: 'example', description: '', numPartitions: 1, numDocs: 0,
                    defaultBranchName: 'main', snapshotRetentionInDays: 30, createdAt: 0, updatedAt: 0 };
                response = { collection }; status = 201;
            } else if (path.endsWith('/branches') && request.method === 'POST') { response = { branch: info }; status = 201; }
            else if (path.endsWith('/branches')) response = { branches: [info] };
            else if (request.method === 'DELETE') response = { message: 'deleted' };
            else if (path.endsWith('/docs/fetch')) response = { docs: [], isDocsInline: true, total: 0, took: 1 };
            else if (path.endsWith('/query')) response = { took: 1, total: 0, docs: [], isDocsInline: true };
            else if (path.endsWith('/docs/upsert') || path.endsWith('/docs/delete')) { response = { message: 'accepted' }; status = 202; }
            else response = { collection };
            return new Response(JSON.stringify(response), { status, headers: { 'content-type': 'application/json' } });
        } }),
    });
    const backend = await createBackend({ client, name: 'sample', metadataSchema: {} });
    const created = await backend.branches.create({ name: 'alternate', source: { branch: 'main' } });
    assert(created.createdAt instanceof Date); assert.equal(created.headSnapshot, null);
    assert.equal((await backend.branches.list())[0].name, 'alternate');
    const branch = backend.at('alternate');
    await branch.remember({ mems: [{ id: 'one', content: 'Original text' }] });
    await branch.query({ size: 1 });
    await branch.forget({ ids: ['one'] });
    await backend.branches.delete('alternate');
    assert.deepEqual(requests.find(item => item.path.endsWith('/branches') && item.method === 'POST').body,
        { branchName: 'alternate', source: { kind: 'branch', name: 'main' } });
    assert.equal(requests.find(item => item.path.endsWith('/docs/upsert')).body.branch, 'alternate');
    assert.deepEqual(requests.find(item => item.path.endsWith('/query')).body,
        { size: 1, ref: { kind: 'branch', name: 'alternate' }, consistentRead: true, includeVectors: false });
    assert.equal(requests.find(item => item.path.endsWith('/docs/delete')).body.branch, 'alternate');
    assert(requests.some(item => item.method === 'DELETE' && item.path.endsWith('/branches/alternate')));
});

test('branch-local filters remain isolated across concurrent recalls sharing the request bound', async () => {
    const f = memdriveClient(), drive = await create(f, { maxConcurrentRequests: 2 });
    await drive.branches.create({ name: 'alternate' });
    const alternate = drive.at({ branch: 'alternate' });
    await drive.remember({ mems: [mem('main')] });
    await alternate.remember({ mems: [mem('alternate')] });
    let active = 0, peak = 0;
    f.search = async (_request, docs) => {
        active++; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 2)); active--;
        return docs;
    };
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => (index % 2 ? alternate : drive).recall({
        query: 'topic', filter: { field: 'metadata.topic', op: 'eq', value: index % 2 ? 'alternate' : 'main' },
    })));
    assert.equal(peak, 2);
    assert.deepEqual(results.map(result => result.matches[0].content), ['main', 'alternate', 'main', 'alternate', 'main', 'alternate']);
    assert(f.calls.filter(call => call.kind === 'query').every(call => JSON.stringify(call.request.query).includes('metadata.topic')));
});
