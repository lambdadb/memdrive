import test from 'node:test';
import assert from 'node:assert/strict';
import { LambdaDBClient, HTTPClient } from '@functional-systems/lambdadb';
import { createBackend, openBackend, validateMem, sourceDocumentId, validateSource, validateChunk, validateVector, vectorSource, vectorMatch } from '../dist/esm/storage.js';

function fixture() {
    const calls = [], documents = new Map();
    let collection;
    const client = {
        async createCollection(input) {
            calls.push(['create', structuredClone(input)]);
            if (collection) throw Object.assign(new Error('exists'), { statusCode: 409 });
            collection = { ...structuredClone(input), defaultBranchName: 'main', numPartitions: 1 };
        },
        collection(name) {
            return {
                async get() {
                    calls.push(['get', name]);
                    if (!collection) throw Object.assign(new Error('missing'), { statusCode: 404 });
                    return { collection: structuredClone(collection) };
                },
                async update(body) {
                    calls.push(['update', structuredClone(body)]); Object.assign(collection, structuredClone(body));
                    await client.afterUpdate?.(collection);
                },
                async delete() { calls.push(['delete']); collection = undefined; },
                async query(body) { calls.push(['query', structuredClone(body)]); return { docs: [] }; },
                docs: {
                    async fetch(body) {
                        calls.push(['fetch', structuredClone(body)]);
                        return { isDocsInline: true, docs: body.ids.filter(id => documents.has(id))
                            .map(id => { const doc = structuredClone(documents.get(id)); delete doc.embedding; return { collection: name, doc }; }) };
                    },
                    async upsert(body) {
                        calls.push(['upsert', structuredClone(body)]);
                        if (client.failWrite?.()) throw new Error('Disconnected after dispatch');
                        for (const doc of body.docs) documents.set(doc.id, structuredClone(doc));
                    },
                    async delete(body) { calls.push(['forget', structuredClone(body)]); for (const id of body.ids ?? []) documents.delete(id); },
                },
            };
        },
    };
    return { client, calls, documents, get collection() { return collection; } };
}

test('reopening preserves declared arrays through sorted schema additions and replaces whole mems', async () => {
    const f = fixture();
    const first = await createBackend({ client: f.client, name: 'sample', metadataSchema: { tags: { type: 'string[]' } } });
    const result = await first.remember({ mems: [
        { id: 'known', content: 'Original.', timestamp: '2026-01-01T00:00:00Z', metadata: { tags: ['a', 'b'] } },
        { content: 'Generated ID.' },
    ] });
    assert.equal(result.ids[0], 'known'); assert.match(result.ids[1], /^[0-9a-f-]{36}$/);
    await first.remember({ mems: [{ id: 'known', content: 'Replacement.' }] });
    assert.deepEqual(await first.read({ ids: ['known', 'missing'] }), { mems: [{ id: 'known', content: 'Replacement.' }] });
    f.collection.tags.external = 'preserved';
    await first.configure({ metadataSchema: { tags: { type: 'string[]' }, author: { type: 'string' } } });
    const reopened = await openBackend({ client: f.client, name: 'sample' });
    assert.deepEqual(reopened.metadataSchema, { tags: { type: 'string[]' }, author: { type: 'string' } });
    assert.equal(f.collection.tags.external, 'preserved');
    assert.equal(f.collection.tags['memory.arrays'], 'Ag'); // author bit 0; tags bit 1.
    const detached = reopened.metadataSchema; detached.tags.type = 'string';
    assert.equal(reopened.metadataSchema.tags.type, 'string[]');
    await assert.rejects(reopened.configure({ metadataSchema: { tags: { type: 'string[]' } } }), { code: 'INVALID_INPUT' });
    await assert.rejects(reopened.configure({ metadataSchema: { author: { type: 'string' }, tags: { type: 'string' } } }), { code: 'INVALID_INPUT' });
    await assert.rejects(createBackend({ client: f.client, name: 'sample', metadataSchema: {} }), { code: 'STORE_EXISTS' });
});

test('all mems validate before writes and write errors retain replay identities and outcomes', async () => {
    const f = fixture();
    const store = await createBackend({ client: f.client, name: 'sample', metadataSchema: { tags: { type: 'string[]' } } });
    await assert.rejects(store.remember({ mems: [{ content: 'valid' }, { content: 'bad', metadata: { tags: 'scalar' } }] }), { code: 'INVALID_INPUT' });
    await assert.rejects(store.remember({ mems: [{ id: 'x', content: 'one' }, { id: 'x', content: 'two' }] }), { code: 'INVALID_INPUT' });
    assert.equal(f.calls.filter(([kind]) => kind === 'upsert').length, 0);
    let writes = 0; f.client.failWrite = () => ++writes === 2;
    const mems = Array.from({ length: 7 }, (_, i) => ({ id: `item-${i}`, content: `Source ${i}`, metadata: { tags: Array(400).fill('x'.repeat(4000)) } }));
    await assert.rejects(store.remember({ mems }), error => {
        assert.equal(error.code, 'DATABASE_ERROR');
        assert.equal(error.details.ids.length, 7);
        assert.deepEqual(error.details.completedIds, ['item-0', 'item-1', 'item-2']);
        assert.deepEqual(error.details.uncertainIds, ['item-3', 'item-4', 'item-5']);
        assert.deepEqual(error.details.notAttemptedIds, mems.slice(6).map(x => x.id));
        return true;
    });
    assert.equal(f.documents.size, 3);
});

test('managed reads and explicit deletion retain their contracts', async () => {
    const f = fixture();
    const store = await createBackend({ client: f.client, name: 'sample', metadataSchema: {} });
    await store.query({ size: 1, query: { queryString: { query: '*:*' } } });
    const body = f.calls.find(([kind]) => kind === 'query')[1];
    assert.deepEqual(body.ref, { kind: 'branch', name: 'main' });
    assert.equal(body.consistentRead, true); assert.equal(body.includeVectors, false);
    await assert.rejects(store.query({ consistentRead: false }), { code: 'INVALID_INPUT' });
    await assert.rejects(store.forget({}), { code: 'INVALID_INPUT' });
    await assert.rejects(store.forget({ ids: ['x'], filter: { field: 'id', op: 'eq', value: 'x' } }), { code: 'INVALID_INPUT' });
    await store.forget({ ids: ['absent'] });
    await store.forget({ filter: { field: 'id', op: 'eq', value: '*:*' } });
    assert.deepEqual(f.calls.filter(([kind]) => kind === 'forget').at(-1)[1], {
        filter: { queryString: { query: '"*:*"', defaultField: 'memId' } }, branch: 'main',
    });
    await store.destroy();
    await assert.rejects(store.remember({ mems: [{ content: 'closed' }] }), { code: 'STORE_DELETED' });
    await assert.rejects(openBackend({ client: f.client, name: 'sample' }), { code: 'STORE_NOT_FOUND' });
});

test('opening rejects foreign formats, altered embedding models and noncanonical array tags', async () => {
    for (const alter of [
        c => { delete c.tags['memory.format']; },
        c => { c.tags['memory.format'] = 'other'; },
        c => { c.indexConfigs.embedding.embedding.model = 'other'; },
        c => { c.tags['memory.arrays'] = 'AQ'; }, // No fields, so no bits may be set.
        c => { c.partitionConfig = { field: 'tenant', numPartitions: 2 }; },
        ...[null, {}, { type: 'keyword' }, { type: 'text', analyzers: [] },
            { type: 'text', analyzers: ['unknown'] }, { type: 'text', analyzers: ['english', 'english'] }]
            .map(content => c => { c.indexConfigs.content = content; }),
    ]) {
        const f = fixture();
        await createBackend({ client: f.client, name: 'sample', metadataSchema: {} });
        alter(f.collection);
        await assert.rejects(openBackend({ client: f.client, name: 'sample' }), { code: 'INCOMPATIBLE_STORE' });
    }
    assert.throws(() => validateMem({ id: 'x', content: 'x', metadata: { tag: 'x'.repeat(4097) } }, { tag: { type: 'string' } }), { code: 'INVALID_INPUT' });
    assert.throws(() => validateMem({ content: 'x', timestamp: '2026-01-01T00:00:00.0001Z' }, {}), { code: 'INVALID_INPUT' });
    assert.equal(validateMem({ content: 'x', timestamp: '2026-01-01T00:00:00.001000Z' }, {}).timestamp, '2026-01-01T00:00:00.001000Z');
});

test('schema updates serialize per handle and reject observed cardinality races', async () => {
    const f = fixture();
    const store = await createBackend({ client: f.client, name: 'sample', metadataSchema: {} });
    const results = await Promise.allSettled([
        store.configure({ metadataSchema: { tags: { type: 'string' } } }),
        store.configure({ metadataSchema: { tags: { type: 'string[]' } } }),
    ]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].reason.code, 'INVALID_INPUT');
    assert.equal(f.calls.filter(([kind]) => kind === 'update').length, 1);
    // A rejected update must not poison the per-handle queue.
    await store.configure({ metadataSchema: { count: { type: 'number' }, tags: { type: 'string' } } });
    f.client.afterUpdate = collection => { collection.tags['memory.arrays'] = 'AQ'; };
    await assert.rejects(store.configure({ metadataSchema: { tags: { type: 'string' }, count: { type: 'number' } } }), { code: 'SCHEMA_CONFLICT' });
});

test('native SDK serializes managed schema, whole upserts and consistent queries without credentials in artifacts', async () => {
    const requests = [];
    let collection;
    const client = new LambdaDBClient({
        baseUrl: 'https://drive.invalid', projectName: 'example', projectApiKey: 'synthetic-test-key',
        retryConfig: { strategy: 'none' }, debugLogger: { log() {}, group() {}, groupEnd() {} },
        httpClient: new HTTPClient({ fetcher: async request => {
            const url = new URL(request.url), body = request.body ? await request.json() : undefined;
            requests.push({ method: request.method, path: url.pathname, body });
            let response, status = 200;
            if (request.method === 'POST' && url.pathname.endsWith('/collections')) {
                collection = { ...body, projectName: 'example', description: '', numPartitions: 1, numDocs: 0,
                    defaultBranchName: 'main', snapshotRetentionInDays: 30, createdAt: 0, updatedAt: 0 };
                response = { collection };
                status = 201;
            } else if (url.pathname.endsWith('/query')) response = { took: 1, total: 0, docs: [], isDocsInline: true };
            else if (url.pathname.endsWith('/docs/fetch')) response = { took: 1, total: 0, docs: [], isDocsInline: true };
            else if (url.pathname.endsWith('/docs/upsert')) { response = { message: 'accepted' }; status = 202; }
            else response = { collection };
            return new Response(JSON.stringify(response), { status, headers: { 'content-type': 'application/json' } });
        } }),
    });
    const store = await createBackend({ client, name: 'sample', metadataSchema: { tags: { type: 'string[]' } } });
    await store.remember({ mems: [{ id: 'one', content: 'Original text', metadata: { tags: ['alpha', 'beta'] } }] });
    await store.query({ size: 2, query: { queryString: { query: '*:*' } } });
    assert.equal(requests[0].body.indexConfigs.embedding.embedding.sourceField, 'content');
    assert.equal(requests[0].body.indexConfigs.embedding.embedding.dimensions, 1536);
    const write = requests.find(r => r.path.endsWith('/docs/upsert')).body;
    assert.equal(write.branch, 'main');
    assert.equal(write.docs.length, 1);
    assert.deepEqual(await validateSource(write.docs[0], store.metadataSchema), { id: 'one', content: 'Original text', metadata: { tags: ['alpha', 'beta'] } });
    assert.equal((await validateChunk(write.docs[0], store.metadataSchema)).content, 'Original text');
    assert.equal(requests.at(-1).body.consistentRead, true);
});

test('complete originals grow, shrink and reuse separate slots atomically across reopen', async () => {
    const f = fixture();
    const schema = { tags: { type: 'string[]' } };
    const store = await createBackend({ client: f.client, name: 'sample', metadataSchema: schema });
    const short = '😀'.repeat(800);
    await store.remember({ mems: [{ id: 'long', content: short }] });
    const inline = f.calls.filter(([kind]) => kind === 'upsert').at(-1)[1].docs;
    assert.equal(inline.length, 1); assert.equal(inline[0].kind, 'mem');
    assert.equal(inline[0].chunkSlots, 0); assert.equal(inline[0].memContent, undefined);
    assert.equal(inline[0].start, undefined); assert.equal(inline[0].end, undefined);
    assert.deepEqual(await validateChunk(inline[0], schema), { id: await sourceDocumentId('long'), kind: 'mem', memId: 'long', content: short, start: 0, end: 1600 });
    const original = '😀'.repeat(1700);
    await store.remember({ mems: [{ id: 'long', content: original, metadata: { tags: ['old'] } }] });
    const first = f.calls.filter(([kind]) => kind === 'upsert').at(-1)[1].docs;
    assert.equal(first.length, 4); assert.equal(first[0].id, inline[0].id); assert.equal(first[0].kind, 'mem');
    assert.deepEqual(first.slice(1).map(doc => [doc.start, doc.end]), [[0, 1600], [1600, 3200], [3200, 3400]]);
    assert.equal((await Promise.all(first.slice(1).map(doc => validateChunk(doc, schema)))).map(doc => doc.content).join(''), original);
    assert.equal(first[0].content, undefined); // Full original is never an embedding source.
    const reopened = await openBackend({ client: f.client, name: 'sample' });
    await reopened.remember({ mems: [{ id: 'long', content: 'short', metadata: { tags: ['current'] } }] });
    const shrunk = f.calls.filter(([kind]) => kind === 'upsert').at(-1)[1].docs;
    assert.equal(shrunk.length, 4);
    assert.equal(shrunk[0].chunkCount, 1); assert.equal(shrunk[0].chunkSlots, 3);
    assert.equal(shrunk[0].kind, 'mem'); assert.equal(shrunk[0].id, inline[0].id);
    assert.equal(shrunk[0].content, 'short'); assert.equal(shrunk[0].memContent, undefined);
    assert.deepEqual(shrunk.slice(1).map(doc => doc.kind), ['chunk', 'chunk', 'chunk']);
    for (const doc of shrunk.slice(1)) {
        assert.equal(doc.content, undefined); assert.equal(doc.embedding, undefined);
        assert.equal(doc.start, undefined); assert.equal(doc.end, undefined);
        assert.deepEqual(doc.metadata, { tags: ['current'] });
    }
    await reopened.remember({ mems: [{ id: 'long', content: 'z'.repeat(900) }] });
    const grown = f.calls.filter(([kind]) => kind === 'upsert').at(-1)[1].docs;
    assert.equal(grown.length, 4); assert.equal(grown[2].id, first[2].id);
    assert.equal(grown[2].kind, 'chunk'); assert.equal(grown[3].kind, 'chunk');
    assert(grown.every(doc => doc.metadata === undefined));
    assert.equal(grown[3].content, undefined);
    assert.equal(grown[0].memContent, 'z'.repeat(900));
    assert.deepEqual(await reopened.read({ ids: ['missing', 'long'] }), { mems: [{ id: 'long', content: 'z'.repeat(900) }] });
    assert.equal(f.documents.get(await sourceDocumentId('long')).chunkSlots, 3);
});

test('whitespace-only spans stay in the original without triggering empty native embeddings', async () => {
    const f = fixture();
    const store = await createBackend({ client: f.client, name: 'sample', metadataSchema: {} });
    const content = ' '.repeat(1700) + 'retained';
    await store.remember({ mems: [{ id: 'spaces', content }] });
    const docs = f.calls.find(([kind]) => kind === 'upsert')[1].docs;
    assert.equal(docs.length, 2); assert.equal(docs[0].kind, 'mem');
    assert.equal(docs[0].chunkCount, 1);
    assert.equal(docs[1].start, 1600); assert.equal(docs[1].end, content.length);
    assert.equal(docs[1].content, content.slice(1600));
    assert.equal((await store.read({ ids: ['spaces'] })).mems[0].content, content);
});

test('oversized complete replacements reject before any Mem is written', async () => {
    const f = fixture();
    const store = await createBackend({ client: f.client, name: 'sample', metadataSchema: { tags: { type: 'string[]' } } });
    await assert.rejects(store.remember({ mems: [{ id: 'small', content: 'valid' },
        { id: 'too-large', content: 'a'.repeat(8000), metadata: { tags: Array(225).fill('x'.repeat(4000)) } },
    ] }), { code: 'INVALID_INPUT' });
    assert.equal(f.calls.filter(([kind]) => kind === 'upsert').length, 0);
    assert.equal(f.documents.size, 0);
});

test('complete source and search validation reject ambiguous, malformed or oversized representations', async () => {
    const f = fixture();
    const store = await createBackend({ client: f.client, name: 'sample', metadataSchema: {} });
    await store.remember({ mems: [{ id: 'inline', content: 'exact original' }] });
    const original = f.documents.get(await sourceDocumentId('inline'));
    assert.equal(original.kind, 'mem');
    for (const alter of [
        doc => { doc.id = 'wrong'; }, doc => { delete doc.content; }, doc => { doc.memContent = doc.content; },
        doc => { doc.start = 0; doc.end = doc.content.length; }, doc => { doc.content = '😀'.repeat(801); },
        doc => { doc.chunkCount = 2; }, doc => { doc.chunkSlots = -1; }, doc => { doc.chunkingPolicy = 'unknown'; },
    ]) {
        const changed = structuredClone(original); alter(changed);
        await assert.rejects(validateSource(changed, {}), { code: 'INVALID_INPUT' });
        await assert.rejects(validateChunk(changed, {}), { code: 'INVALID_INPUT' });
    }
    const content = 'kept' + ' '.repeat(1700);
    await store.remember({ mems: [{ id: 'trailing', content }] });
    const source = f.documents.get(await sourceDocumentId('trailing'));
    assert.equal(source.kind, 'mem'); assert.equal(source.chunkCount, 1);
    assert.equal(source.memContent, content);
    await assert.rejects(validateChunk(source, {}), { code: 'INVALID_INPUT' });
    assert.equal((await store.read({ ids: ['trailing'] })).mems[0].content, content);
});

const externalEmbedding = { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'client-model-v1' };
const sampleVector = () => [1, ...Array(63).fill(0)];
const jsonBytes = value => new TextEncoder().encode(JSON.stringify(value)).length;

// Fill a keyword array to an exact additional JSON byte count. Expected request
// boundaries below are calculated by serializing the actual native requests.
function paddedTags(additionalBytes) {
    const count = Math.ceil((additionalBytes + 1) / 4099);
    const characters = additionalBytes + 1 - 3 * count;
    return Array.from({ length: count }, (_, i) => 'x'.repeat(i < count - 1 ? 4096 : characters - 4096 * (count - 1)));
}

test('greedy writes fit the exact native byte boundary in managed and external modes', async () => {
    const limit = 6029312;
    for (const external of [false, true]) {
        const f = fixture();
        const store = await createBackend({ client: f.client, name: 'sample', metadataSchema: { tags: { type: 'string[]' } },
            ...(external ? { embedding: externalEmbedding } : {}) });
        const input = id => ({ id, ...(external ? { embedding: sampleVector() } : { content: 'x' }), metadata: { tags: [] } });
        await store.remember({ mems: [input('a')] });
        const firstDoc = f.calls.find(([kind]) => kind === 'upsert')[1].docs[0];
        const pairBytes = limit - jsonBytes({ docs: [], branch: 'main' }) - 1;
        const sizes = [Math.floor(pairBytes / 2), Math.ceil(pairBytes / 2)];
        const mems = ['a', 'b'].map((id, i) => ({ ...input(id), metadata: { tags: paddedTags(sizes[i] - jsonBytes(firstDoc)) } }));
        f.calls.length = 0;
        await store.remember({ mems: [...mems, input('c')] });
        const writes = f.calls.filter(([kind]) => kind === 'upsert').map(([, body]) => body);
        assert.equal(writes.length, 2);
        assert.equal(jsonBytes(writes[0]), limit);
        assert.deepEqual(writes[0].docs.map(doc => doc.memId), ['a', 'b']);
        assert.deepEqual(writes[1].docs.map(doc => doc.memId), ['c']);
        assert(writes.flatMap(body => body.docs).every(doc => jsonBytes(doc) <= 5 * 1024 * 1024));
        if (external) assert.equal(f.calls.filter(([kind]) => kind === 'fetch').length, 0);
    }
});

test('external writes prevalidate vectors and retain whole-batch failure identities', async () => {
    const f = fixture();
    const store = await createBackend({ client: f.client, name: 'sample', metadataSchema: { tags: { type: 'string[]' } }, embedding: externalEmbedding });
    assert.deepEqual(store.embedding, externalEmbedding); assert(Object.isFrozen(store.embedding));
    assert.equal(f.collection.tags['memory.profile'], undefined);
    assert.equal(f.collection.tags['memory.embedding'], externalEmbedding.identity);
    assert.deepEqual(f.collection.indexConfigs.embedding, { type: 'vector', dimensions: 64, similarity: 'cosine' });
    for (const embedding of [Array(64).fill(0), Array(64), [1], [...Array(63).fill(1), Infinity]]) {
        await assert.rejects(store.remember({ mems: [{ id: 'valid', embedding: sampleVector() }, { embedding }] }), { code: 'INVALID_INPUT' });
    }
    await assert.rejects(store.remember({ mems: [{ content: 'not a vector', embedding: sampleVector() }] }), { code: 'INVALID_INPUT' });
    assert.equal(f.calls.filter(([kind]) => kind === 'upsert').length, 0);
    const mems = Array.from({ length: 7 }, (_, i) => ({ id: `item-${i}`, embedding: sampleVector(),
        metadata: { tags: Array(400).fill('x'.repeat(4000)) } }));
    let writes = 0; f.client.failWrite = () => ++writes === 2;
    await assert.rejects(store.remember({ mems }), error => {
        assert.deepEqual(error.details.completedIds, ['item-0', 'item-1', 'item-2']);
        assert.deepEqual(error.details.uncertainIds, ['item-3', 'item-4', 'item-5']);
        assert.deepEqual(error.details.notAttemptedIds, ['item-6']);
        return error.code === 'DATABASE_ERROR';
    });
    const reopened = await openBackend({ client: f.client, name: 'sample' });
    assert.deepEqual(reopened.embedding, externalEmbedding);
    const { mems: read } = await reopened.read({ ids: ['item-0', 'missing'] });
    assert.deepEqual(read, [{ id: 'item-0', metadata: mems[0].metadata }]);
    const stored = structuredClone(f.documents.get(await sourceDocumentId('item-0'))); delete stored.embedding;
    assert.deepEqual(await vectorSource(stored, reopened.metadataSchema), read[0]);
    assert.equal((await vectorMatch(stored, reopened.metadataSchema)).memId, 'item-0');
    assert.deepEqual(validateVector(sampleVector(), reopened.embedding), sampleVector());
});

test('greedy batching never splits a source and its chunk replacements', async () => {
    const f = fixture();
    const store = await createBackend({ client: f.client, name: 'sample', metadataSchema: { tags: { type: 'string[]' } } });
    await store.remember({ mems: [
        { id: 'first', content: 'short', metadata: { tags: Array(500).fill('x'.repeat(4000)) } },
        { id: 'second', content: 'a'.repeat(900), metadata: { tags: Array(375).fill('x'.repeat(4000)) } },
    ] });
    const writes = f.calls.filter(([kind]) => kind === 'upsert').map(([, body]) => body);
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0].docs.map(doc => doc.memId), ['first']);
    assert.deepEqual(writes[1].docs.map(doc => doc.memId), ['second', 'second', 'second']);
    assert.deepEqual(writes[1].docs.map(doc => doc.kind), ['mem', 'chunk', 'chunk']);
    assert(writes.every(body => jsonBytes(body) <= 6029312));
    await store.remember({ mems: [{ id: 'first', content: 'updated' }, { id: 'second', content: 'short now' }] });
    const replacement = f.calls.filter(([kind]) => kind === 'upsert').at(-1)[1];
    assert.deepEqual(replacement.docs.map(doc => doc.memId), ['first', 'second', 'second', 'second']);
    assert(replacement.docs.slice(2).every(doc => doc.kind === 'chunk' && !Object.hasOwn(doc, 'content')));
});
