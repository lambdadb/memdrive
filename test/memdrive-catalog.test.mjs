import test from 'node:test';
import assert from 'node:assert/strict';
import { LambdaDBClient, HTTPClient } from '@functional-systems/lambdadb';
import { create, open, list } from '../dist/esm/index.js';
import { memdriveClient } from './helpers/memdrive-client.mjs';

const external = { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'client-model-v1' };
const createOptions = (client, name, options = {}) => ({ client, name, mode: 'single_pass', metadataSchema: {}, ...options });

test('labels reserve native capacity and descriptors revalidate fresh collection metadata', async () => {
    const f = memdriveClient();
    const drive = await create(createOptions(f.client, 'sample', { labels: { app: 'sillymemory', owner: 'test', purpose: 'catalog' } }));
    const tags = structuredClone(f.collections.get('sample').metadata.tags);
    assert.equal(Object.keys(tags).length, 5);
    const first = await drive.describe();
    assert.deepEqual(first.labels, { app: 'sillymemory', owner: 'test', purpose: 'catalog' });
    assert.deepEqual(first.metadataSchema, {});
    assert.equal(first.textSearch, undefined);
    assert.equal(first.embedding.mode, 'managed');
    first.labels.app = 'mutated';
    await drive.configure({ metadataSchema: { role: { type: 'string' } } });
    assert.deepEqual(f.collections.get('sample').metadata.tags, { ...tags, 'memory.arrays': 'AA' });
    const before = f.calls.filter(call => call.kind === 'get').length;
    const second = await drive.describe();
    assert.equal(f.calls.filter(call => call.kind === 'get').length, before + 1);
    assert.equal(second.labels.app, 'sillymemory');
    assert.deepEqual(second.metadataSchema, { role: { type: 'string' } });
    f.collections.get('sample').metadata.indexConfigs.embedding.embedding.model = 'foreign-model';
    await assert.rejects(drive.describe(), { code: 'INCOMPATIBLE_STORE' });

    for (const options of [
        { labels: { 'memory.format': 'override' } }, { labels: { 'memory.custom': 'reserved' } },
        { labels: { 'bad key': 'value' } }, { labels: { app: 'bad:value' } }, { labels: { app: ' '.repeat(2) } },
        { labels: { app: 'x'.repeat(128) } }, { labels: { a: 'a', b: 'b', c: 'c', d: 'd' } },
        { embedding: external, labels: { a: 'a', b: 'b', c: 'c' } },
    ]) {
        const invalid = memdriveClient();
        await assert.rejects(create(createOptions(invalid.client, 'invalid', options)), { code: 'INVALID_INPUT' });
        assert.equal(invalid.calls.length, 0);
    }
    const allowed = memdriveClient();
    const vectorDrive = await create(createOptions(allowed.client, 'external', { embedding: external, labels: { app: 'sillymemory', owner: 'test' } }));
    assert.deepEqual((await vectorDrive.describe()).embedding, external);
});

test('catalog returns one physical page and validates only marked label-matching candidates', async () => {
    const f = memdriveClient();
    await create(createOptions(f.client, 'matching', { labels: { app: 'sillymemory' } }));
    await create(createOptions(f.client, 'different', { labels: { app: 'other' }, embedding: external }));
    const matching = structuredClone(f.collections.get('matching').metadata);
    const different = structuredClone(f.collections.get('different').metadata);
    const foreign = { ...structuredClone(matching), collectionName: 'foreign', tags: {} };
    f.listCollections = request => request.pageToken === undefined
        ? { collections: [foreign, different], nextPageToken: 'next' }
        : { collections: [{ collectionName: matching.collectionName, tags: matching.tags }] };
    f.calls.length = 0;
    const controller = new AbortController();
    assert.deepEqual(await list({ client: f.client, limit: 2, labels: { app: 'sillymemory' } }, { signal: controller.signal }),
        { drives: [], nextCursor: 'next' });
    assert.deepEqual(f.calls.map(call => call.kind), ['listCollections']);
    const result = await list({ client: f.client, cursor: 'next', limit: 2, labels: { app: 'sillymemory' } }, { signal: controller.signal });
    assert.deepEqual(result.drives.map(drive => drive.name), ['matching']);
    assert.deepEqual(f.calls.map(call => call.kind), ['listCollections', 'listCollections', 'get']);
    assert(f.calls.every(call => call.signal === controller.signal));
    assert.deepEqual(f.calls[1].request, { size: 2, pageToken: 'next' });
    f.calls.length = 0;
    f.listCollections = () => ({ collections: [matching, different] });
    assert.deepEqual((await list({ client: f.client })).drives.map(drive => drive.embedding.mode), ['managed', 'external']);
    assert.deepEqual(f.calls.map(call => call.kind), ['listCollections']);
    assert.equal(f.calls[0].request.size, 10);
});

test('catalog skips incompatible stores but propagates native inspection failures', async () => {
    const f = memdriveClient();
    await create(createOptions(f.client, 'sample'));
    const collection = structuredClone(f.collections.get('sample').metadata);
    const incompatible = { ...structuredClone(collection), collectionName: 'incompatible' };
    incompatible.indexConfigs.embedding.embedding.model = 'other';
    f.listCollections = () => ({ collections: [incompatible] });
    assert.deepEqual(await list({ client: f.client }), { drives: [] });
    f.listCollections = () => ({ collections: [{ collectionName: 'sample', tags: collection.tags }] });
    f.beforeGet = () => { throw Object.assign(new Error('Unavailable'), { statusCode: 503 }); };
    await assert.rejects(list({ client: f.client }), { code: 'DATABASE_ERROR', status: 503 });
    f.beforeGet = undefined;
    f.collections.get('sample').metadata.indexConfigs.embedding.embedding.model = 'other';
    assert.deepEqual(await list({ client: f.client }), { drives: [] });
});

test('catalog rejects malformed pages and cursors without walking further pages', async () => {
    const f = memdriveClient();
    await create(createOptions(f.client, 'sample'));
    const collection = structuredClone(f.collections.get('sample').metadata);
    for (const page of [
        { collections: [collection, collection] }, { collections: [null] }, { collections: [], nextPageToken: '' },
        { collections: [], nextPageToken: 'same' }, { collections: [collection], nextPageToken: 1 },
    ]) {
        f.listCollections = () => page;
        await assert.rejects(list({ client: f.client, cursor: 'same' }), { code: 'INVALID_RESULT' });
    }
    const before = f.calls.length;
    for (const request of [{ limit: 0 }, { limit: 101 }, { cursor: '' }, { labels: { 'memory.format': 'mems-v0' } }])
        await assert.rejects(list({ client: f.client, ...request }), { code: 'INVALID_INPUT' });
    assert.equal(f.calls.length, before);
});

test('native SDK roundtrips collection and field descriptions without exposing retention', async () => {
    const requests = [];
    let collection;
    const client = new LambdaDBClient({ baseUrl: 'https://catalog.invalid', projectName: 'example', projectApiKey: 'synthetic-test-key',
        retryConfig: { strategy: 'none' }, debugLogger: { log() {}, group() {}, groupEnd() {} },
        httpClient: new HTTPClient({ fetcher: async request => {
            const url = new URL(request.url), body = request.body ? await request.json() : undefined;
            requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
            let result, status = 200;
            if (request.method === 'POST' && url.pathname.endsWith('/collections')) {
                collection = { description: '', ...body, projectName: 'example', numPartitions: 1, numDocs: 0,
                    defaultBranchName: 'main', snapshotRetentionInDays: body.snapshotRetentionInDays ?? 30, createdAt: 0, updatedAt: 0 };
                result = { collection }; status = 201;
            } else if (request.method === 'PATCH') {
                Object.assign(collection, body);
                // Native reads omit cleared field descriptions.
                for (const config of Object.values(collection.indexConfigs.metadata?.objectIndexConfigs ?? {}))
                    if (config.description === '') delete config.description;
                result = { collection };
            }
            else if (url.pathname.endsWith('/collections')) result = { collections: [collection], nextPageToken: 'native-next' };
            else result = { collection };
            return new Response(JSON.stringify(result), { status, headers: { 'content-type': 'application/json' } });
        } }),
    });
    const drive = await create(createOptions(client, 'sample', { embedding: external, labels: { app: 'sillymemory' },
        description: 'Private chat memories.', metadataSchema: { role: { type: 'string', description: 'Message role.' } } }));
    assert.equal(requests[0].body.description, 'Private chat memories.');
    assert.equal(requests[0].body.indexConfigs.metadata.objectIndexConfigs.role.description, 'Message role.');
    await drive.configure({ description: 'Conversation archive.' });
    assert.deepEqual(requests.find(request => request.method === 'PATCH').body, { description: 'Conversation archive.' });
    await drive.configure({ metadataSchema: { role: { type: 'string', description: 'Author role: user or assistant.' } } });
    await drive.configure({ metadataSchema: { role: { type: 'string' }, topic: { type: 'string[]', description: 'Topics mentioned.' } } });
    const preserved = await drive.describe();
    assert.equal(preserved.description, 'Conversation archive.');
    assert.deepEqual(preserved.metadataSchema, { role: { type: 'string', description: 'Author role: user or assistant.' },
        topic: { type: 'string[]', description: 'Topics mentioned.' } });
    await drive.configure({ description: '', metadataSchema: { role: { type: 'string', description: '' }, topic: { type: 'string[]' } } });
    const described = await drive.describe();
    const result = await list({ client, limit: 3 });
    assert.deepEqual(result, { drives: [described], nextCursor: 'native-next' });
    assert.equal(Object.hasOwn(requests[0].body, 'snapshotRetentionInDays'), false);
    assert.equal(Object.hasOwn(described, 'snapshotRetentionInDays'), false);
    assert.equal(described.description, '');
    assert.equal(Object.hasOwn(described.metadataSchema.role, 'description'), false);
    assert.equal(described.metadataSchema.topic.description, 'Topics mentioned.');
    assert.deepEqual(await (await open({ client, name: 'sample', mode: 'single_pass' })).describe(), described);
    assert.equal(requests[0].body.tags.app, 'sillymemory');
    assert.equal(requests[0].body.tags['memory.embedding'], external.identity);
    assert.equal(requests.find(request => request.method === 'GET' && request.path.endsWith('/collections')).query.size, '3');
    assert.equal(requests.filter(request => request.method === 'POST').length, 1);
});


test('descriptions validate before mutation while schema types and native tag limits remain fixed', async () => {
    const f = memdriveClient();
    for (const description of [null, 1, {}, 'x'.repeat(256), '😀'.repeat(128)]) {
        await assert.rejects(create(createOptions(f.client, 'invalid', { description })), { code: 'INVALID_INPUT' });
        await assert.rejects(create(createOptions(f.client, 'invalid', { metadataSchema: { role: { type: 'string', description } } })), { code: 'INVALID_INPUT' });
    }
    await assert.rejects(create(createOptions(f.client, 'invalid', { snapshotRetentionInDays: 1 })), { code: 'INVALID_INPUT' });
    assert.equal(f.calls.length, 0);
    const maxDescription = '😀'.repeat(127) + 'x';
    const drive = await create(createOptions(f.client, 'sample', { description: maxDescription,
        metadataSchema: { role: { type: 'string', description: maxDescription } } }));
    assert.equal((await drive.describe()).description, maxDescription);
    const before = f.calls.length;
    for (const request of [{}, { description: null }, { description: 'x'.repeat(256) },
        { snapshotRetentionInDays: 1 }, { metadataSchema: { role: { type: 'string', description: null } } }])
        await assert.rejects(drive.configure(request), { code: 'INVALID_INPUT' });
    assert.equal(f.calls.length, before);
    for (const metadataSchema of [{}, { role: { type: 'number', description: 'Changed type.' } }])
        await assert.rejects(drive.configure({ metadataSchema }), { code: 'INVALID_INPUT' });
    assert.equal(f.calls.filter(call => call.kind === 'update').length, 0);
    // Retention belongs to the native collection and is outside the MemDrive descriptor.
    f.collections.get('sample').metadata.snapshotRetentionInDays = 0;
    assert.equal(Object.hasOwn(await drive.describe(), 'snapshotRetentionInDays'), false);
    for (const alter of [
        collection => { collection.description = null; },
        collection => { collection.indexConfigs.metadata.objectIndexConfigs.role.description = 'x'.repeat(256); },
    ]) {
        const collection = f.collections.get('sample').metadata;
        const saved = structuredClone(collection);
        alter(collection);
        await assert.rejects(drive.describe(), { code: 'INCOMPATIBLE_STORE' });
        f.collections.get('sample').metadata = saved;
    }
});
