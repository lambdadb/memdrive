import assert from 'node:assert/strict';
import test from 'node:test';
import { MemDrive } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

const name = 'workspace';
const request = requestId => ({ requestId, summary: `Publish ${requestId}` });
const dimensions = 64;
const vector = (x, y) => [x, y, ...Array(dimensions - 2).fill(0)];
const originalVector = vector(0.1, 0.2);
const capturedVector = vector(0.3, 0.4);
const laterVector = vector(0.5, 0.6);

test('external vector publication replays the pinned vector and rebases later edits on the published vector', async () => {
    const fixture = fileClient();
    const main = await MemDrive.create({ client: fixture.client, name,
        metadataSchema: { label: { type: 'string' } },
        embedding: { mode: 'external', dimensions, similarity: 'cosine', identity: 'fixture' } });
    const { at } = await main.fork({ name: 'research' });
    const bind = drive => ({
        write: request => drive.write({ at, ...request }),
        diff: () => drive.diff({ at }),
        merge: request => drive.merge({ at, ...request }),
        status: () => drive.status({ at }),
    });
    const work = bind(main);
    const { fileId } = await work.write({ op: 'create', path: '/notes', content: originalVector, metadata: { label: 'old' } });
    const id = `file:${fileId}`;
    const state = fixture.collections.get(name);

    function published(version) {
        return state.tags.get(`md-main-${version}`).docs.get(id);
    }

    // A native vector fetch can return the shortest decimal encoding of float32.
    fixture.afterUpsert = ({ docs }, persisted) => {
        const vector = docs[0].embedding;
        if (vector?.every((component, index) => component === Math.fround(capturedVector[index])))
            persisted.get(id).embedding = capturedVector;
    };

    await work.merge(request('first'));
    const { at: staleAt } = await main.fork({ name: 'stale' });
    await work.write({ op: 'update', fileId, content: capturedVector });
    assert.deepEqual(await work.diff(), [{ op: 'update', fileId, path: '/notes' }]);

    fixture.beforeUpsert = ({ branch, docs }) => {
        if (branch === 'main' && docs[0].id === id)
            throw Object.assign(new Error('Rejected before dispatch'), { statusCode: 400 });
    };
    await assert.rejects(work.merge(request('replace')), { code: 'MERGE_RESUMABLE' });
    await work.write({ op: 'update', fileId, content: laterVector });
    assert.deepEqual(published('v1').embedding, originalVector.map(Math.fround));

    fixture.beforeUpsert = undefined;
    const fresh = await MemDrive.open({ client: { ...fixture.client }, name, mode: 'external' });
    const reopened = bind(fresh);
    await reopened.merge(request('replace'));
    assert.deepEqual(published('v2').embedding.map(Math.fround), capturedVector.map(Math.fround));
    assert.deepEqual(await reopened.diff(), [{ op: 'update', fileId, path: '/notes' }]);

    // Reverting only the vector clears the net change against the new baseline.
    await reopened.write({ op: 'update', fileId, content: capturedVector });
    assert.deepEqual(await reopened.diff(), []);
    await main.write({ at: staleAt, op: 'update', fileId, content: laterVector });
    await assert.rejects(main.merge({ at: staleAt, ...request('stale') }), { code: 'MERGE_CONFLICT',
        details: { fileIds: [fileId], paths: [], requestId: 'stale' } });

    await reopened.write({ op: 'update', fileId, newPath: '/renamed', metadata: {} });
    const { version } = await reopened.merge(request('move'));
    assert.equal(published(version).path, '/renamed');
    assert.equal(published(version).metadata, undefined);
    assert.deepEqual(published(version).embedding.map(Math.fround), capturedVector.map(Math.fround));
    assert.equal(state.tags.get(`md-main-${version}`).docs.size, 1);
    for (const field of ['body', 'content', 'changed', 'baseline', 'fingerprint'])
        assert.equal(Object.hasOwn(published(version), field), false);
    const { path, ...reference } = await main.read({ fileId });
    assert.equal(path, '/renamed');
    assert.equal(Object.hasOwn(reference, 'embedding'), false);
    assert.equal(Object.hasOwn(reference, 'content'), false);

    await reopened.write({ op: 'delete', fileId });
    assert.deepEqual(await reopened.diff(), [{ op: 'delete', fileId, previousPath: '/renamed' }]);
    const deleted = await reopened.merge(request('delete'));
    assert.deepEqual(await reopened.status(), { at: { kind: 'fork', name: 'research' }, mainVersion: deleted.version });
    assert.deepEqual((await fresh.history({ sinceVersion: 'v1' })).entries.map(entry => [entry.version, entry.fileIds]),
        [['v2', [fileId]], [version, [fileId]], [deleted.version, [fileId]]]);
    assert.equal(state.tags.get(`md-main-${deleted.version}`).docs.size, 0);
    assert.equal(await main.read({ fileId }), null);
    assert.deepEqual(await reopened.diff(), []);
});
