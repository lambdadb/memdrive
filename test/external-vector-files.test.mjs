import assert from 'node:assert/strict';
import test from 'node:test';
import { MemDrive } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

const name = 'external-files';
const embedding = { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'caller-model-v1' };
const vector = (head = 0.123456789) => [head, ...Array(63).fill(0)];
const metadataSchema = { topic: { type: 'string' }, ordinal: { type: 'number' } };

test('external file reads and vector searches return references from the selected view', async () => {
    const { client, calls, collections } = fileClient();
    const open = options => MemDrive.open({ client: { ...client }, name, mode: 'external', ...options });
    const main = await MemDrive.create({ client, name, embedding, metadataSchema, labels: { app: 'fixture' } });
    const { indexConfigs, tags } = collections.get(name).metadata;
    assert.deepEqual(indexConfigs.embedding, { type: 'vector', dimensions: 64, similarity: 'cosine' });
    assert.equal(indexConfigs.body, undefined);
    assert.equal(indexConfigs.content, undefined);
    assert.equal(tags['memdrive.embedding'], embedding.identity);
    assert.deepEqual(await (await open()).describe(), { name, labels: { app: 'fixture' }, metadataSchema, retentionInDays: 30, embedding });
    await assert.rejects(MemDrive.open({ client, name }), { code: 'INCOMPATIBLE_STORE' });

    const { at: work } = await main.fork({ name: 'vector-draft' });
    const metadata = { topic: 'owner "one" *', ordinal: 4 };
    const file = await main.write({ at: work, op: 'create', path: '/local/note', content: vector(), metadata });
    assert.deepEqual(file, { fileId: file.fileId, path: '/local/note', modifiedAt: file.modifiedAt, metadata });
    const writes = calls.filter(({ kind }) => kind === 'upsert');
    assert.equal(writes.length, 1);
    const [doc] = writes[0].request.docs;
    assert.equal(writes[0].request.docs.length, 1);
    assert.equal(doc.kind, 'file');
    assert.deepEqual(doc.embedding, vector().map(Math.fround));
    assert.equal(Object.hasOwn(doc, 'body'), false);
    assert.equal(Object.hasOwn(doc, 'content'), false);

    const { at: saved } = await main.checkpoint({ at: work, name: 'before-move' });
    const moved = await main.write({ at: work, op: 'update', fileId: file.fileId, newPath: '/local/updated', metadata: {} });
    assert.deepEqual(moved, { fileId: file.fileId, path: '/local/updated', modifiedAt: moved.modifiedAt });
    const persisted = collections.get(name).branches.get('fork-vector-draft').docs.get(doc.id);
    assert.deepEqual(persisted.embedding, doc.embedding);
    assert.deepEqual(await main.read({ at: work, paths: [file.path, moved.path] }), [moved]);
    assert.deepEqual(await main.read({ at: work, fileId: file.fileId }), moved);
    assert.deepEqual((await main.list({ at: work })).files, [moved]);
    assert.deepEqual(await main.read({ at: saved, path: file.path }), file);

    const pinned = await open();
    for (const drive of [main, pinned]) assert.equal(drive.findText, undefined);
    assert.deepEqual(await pinned.search({ at: saved, query: vector(), filter: { and: [
        { field: 'metadata.topic', op: 'eq', value: metadata.topic },
        { field: 'metadata.ordinal', op: 'gte', value: 2 },
        { field: 'metadata.ordinal', op: 'lt', value: 5 },
    ] }, limit: 1 }), { hits: [file], reranked: false });
    const request = calls.at(-1).request;
    assert.deepEqual(request.ref, { kind: 'tag', name: 'checkpoint-before-move' });
    assert.equal(request.includeVectors, false);
    assert.equal(request.rerank, undefined);
    assert.equal(request.query.knn.k, 1);
    assert.deepEqual(request.query.knn.queryVector, vector().map(Math.fround));
    assert.deepEqual(request.query.knn.filter.bool, [
        { queryString: { query: '"file"', defaultField: 'kind' }, occur: 'filter' },
        { bool: [
            { queryString: { query: JSON.stringify(metadata.topic), defaultField: 'metadata.topic' }, occur: 'filter' },
            { queryString: { query: '[2 TO *]', defaultField: 'metadata.ordinal' }, occur: 'filter' },
            { queryString: { query: '{* TO 5}', defaultField: 'metadata.ordinal' }, occur: 'filter' },
        ], occur: 'filter' },
    ]);
});

test('external inputs and incompatible modes fail before dispatch', async () => {
    const { client, calls, collections } = fileClient();
    for (const options of [
        { embedding: { ...embedding, dimensions: 63 } },
        { embedding: { ...embedding, identity: 'model:invalid' } },
        { embedding, textSearch: { analyzers: ['standard'] } },
        { embedding, labels: { one: 'x', two: 'y', three: 'z', four: 'w' } },
    ]) {
        await assert.rejects(MemDrive.create({ client, name, ...options }), { code: 'INVALID_INPUT' });
    }
    assert.equal(collections.size, 0);
    const main = await MemDrive.create({ client, name, embedding });
    const { at } = await main.fork({ name: 'vector-draft' });
    const work = {
        write: request => main.write({ at, ...request }),
        search: request => main.search({ at, ...request }),
    };
    const file = await work.write({ op: 'create', path: '/file', content: vector() });
    const remoteCalls = calls.length;
    const badVectors = [[1], Array(64).fill(0), vector(1e-80), vector(1e80), vector(Infinity), vector(NaN), [1, ...Array(62).fill(0), '2']];
    const sparse = vector();
    delete sparse[1];
    for (const invalid of [...badVectors, sparse]) {
        await assert.rejects(work.write({ op: 'create', path: '/bad', content: invalid }), { code: 'INVALID_INPUT' });
        await assert.rejects(work.write({ op: 'update', fileId: file.fileId, content: invalid }), { code: 'INVALID_INPUT' });
        await assert.rejects(work.search({ query: invalid }), { code: 'INVALID_INPUT' });
    }
    await assert.rejects(work.write({ op: 'create', path: '/bad', embedding: vector() }), { code: 'INVALID_INPUT' });
    await assert.rejects(work.write({ op: 'update', fileId: file.fileId, embedding: vector() }), { code: 'INVALID_INPUT' });
    await assert.rejects(work.search({ queryVector: vector() }), { code: 'INVALID_INPUT' });
    await assert.rejects(work.write({ op: 'create', path: '/bad', content: 'text' }), { code: 'INVALID_INPUT' });
    await assert.rejects(work.write({ op: 'update', fileId: file.fileId, edits: [] }), { code: 'INVALID_INPUT' });
    await assert.rejects(work.search({ query: 'text' }), { code: 'INVALID_INPUT' });
    await assert.rejects(work.search({ query: vector(), mode: 'semantic' }), { code: 'INVALID_INPUT' });
    await assert.rejects(work.search({ query: vector(), rerank: false }), { code: 'INVALID_INPUT' });
    await assert.rejects(work.search({ query: vector(), filter: { field: 'metadata.undeclared', op: 'eq', value: 5 } }),
        { code: 'INVALID_INPUT' });
    assert.equal(calls.length, remoteCalls);

    await MemDrive.create({ client, name: 'managed-files' });
    await assert.rejects(MemDrive.open({ client, name: 'managed-files', mode: 'external' }), { code: 'INCOMPATIBLE_STORE' });
});
