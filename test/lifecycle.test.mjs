import assert from 'node:assert/strict';
import test from 'node:test';
import { create, open, destroy, MemDrive, createFileTools } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

const name = 'lifecycle-store';
const edit = { op: 'create', path: '/note.md', content: 'Remember this.' };
const forkAt = refName => ({ kind: 'fork', name: refName });
const checkpointAt = refName => ({ kind: 'checkpoint', name: refName });
async function setup() {
    const fixture = fileClient();
    const connection = { client: fixture.client, name };
    const drive = await create(connection);
    const { at: fork } = await drive.fork({ name: 'draft' });
    await drive.write({ at: fork, ...edit });
    const { at: checkpoint } = await drive.checkpoint({ at: fork, name: 'saved' });
    return { ...fixture, fixture, connection, drive, fork, checkpoint };
}
const deletes = calls => calls.filter(call => call.kind.endsWith('-delete'));

test('create makes one collection with one-day native snapshot retention and no internal refs or journal', async () => {
    const { client, collections, calls } = fileClient();
    const drive = await create({ client, name, metadataSchema: { topic: { type: 'string' } } });
    assert.deepEqual([...collections.keys()], [name]);
    const { metadata, branches, tags } = collections.get(name);
    assert.equal(metadata.snapshotRetentionInDays, 1);
    assert.equal(metadata.tags['memdrive.format'], 'files-v1');
    assert.equal(metadata.description, 'memdrive-config-v1:{"chunking":{"strategy":"auto"}}');
    assert.equal(Object.hasOwn(metadata.indexConfigs, 'changed'), false);
    assert.deepEqual([...branches.keys()], ['main']);
    assert.equal(tags.size, 0);
    assert.deepEqual(calls, []);
    const description = await drive.describe();
    assert.equal(Object.hasOwn(description, 'retentionInDays'), false);
    assert.deepEqual(await (await open({ client, name })).describe(), description);
    for (const removed of ['configure', 'status', 'history', 'diff', 'merge']) assert.equal(drive[removed], undefined);
    await assert.rejects(create({ client, name: 'other-store', retentionInDays: 7 }), { code: 'INVALID_INPUT' });
    await assert.rejects(create({ client, name }), { code: 'STORE_EXISTS', status: 409 });

    const external = await create({ client, name: 'external-store',
        embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'fixture' } });
    assert.equal(collections.get('external-store').metadata.snapshotRetentionInDays, 1);
    assert.equal(collections.get('external-store').metadata.description, 'memdrive-config-v1:{}');
    assert.equal(Object.hasOwn(await external.describe(), 'retentionInDays'), false);
    await assert.rejects(open({ client, name: 'external-store' }), { code: 'INCOMPATIBLE_STORE' });
    await assert.rejects(open({ client, name, mode: 'external' }), { code: 'INCOMPATIBLE_STORE' });
});

const ats = list => (list.forks ?? list.checkpoints).map(entry => entry.at);

test('lists one name-ordered page of user forks or checkpoints with creation times, hides other refs and rejects malformed lists', async () => {
    const { fixture, drive, checkpoint, collections } = await setup();
    await drive.fork({ at: checkpoint, name: 'another' });
    await drive.checkpoint({ name: 'alpha' });
    await fixture.client.collection(name).branches.create({ branchName: 'unrelated', source: { kind: 'branch', name: 'main' } });
    assert(collections.get(name).branches.has('unrelated'));
    const forks = await drive.listForks();
    assert.deepEqual(ats(forks), [forkAt('another'), forkAt('draft')]);
    assert.equal(forks.next, undefined);
    const checkpoints = await drive.listCheckpoints({});
    assert.deepEqual(ats(checkpoints), [checkpointAt('alpha'), checkpointAt('saved')]);
    const tag = collections.get(name).tags.get('checkpoint-alpha').tag;
    assert.equal(checkpoints.checkpoints[0].createdAt, tag.createdAt.toISOString());
    for (const request of [{ at: forkAt('draft') }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: 'x', limit: 1 }])
        await assert.rejects(drive.listForks(request), { code: 'INVALID_INPUT' });
    fixture.listBranches = () => ({ branches: [{ name: 'fork-draft', createdAt: new Date() }, { name: 'fork-draft', createdAt: new Date() }] });
    await assert.rejects(drive.listForks(), { code: 'INVALID_RESULT' });
    fixture.listBranches = () => ({ branches: [{ name: 'fork-draft', createdAt: 'yesterday' }] });
    await assert.rejects(drive.listForks(), { code: 'INVALID_RESULT' });
    fixture.listTags = () => ({ tags: [null] });
    await assert.rejects(drive.listCheckpoints(), { code: 'INVALID_RESULT' });
    fixture.listTags = params => ({ tags: [], nextPageToken: params.pageToken ?? 'same' });
    const { next } = await drive.listCheckpoints();
    await assert.rejects(drive.listCheckpoints(next), { code: 'INVALID_RESULT' });
});

test('ref listings page with stateless cursors bound to the store and listing kind', async () => {
    const { drive, calls, connection } = await setup();
    for (const label of ['b-one', 'c-two', 'd-three']) await drive.checkpoint({ name: label });
    const seen = [];
    let page = await drive.listCheckpoints({ limit: 2 });
    for (;;) {
        seen.push(...ats(page));
        if (!page.next) break;
        assert.deepEqual(Object.keys(page.next), ['cursor']);
        page = await (await open(connection)).listCheckpoints(page.next);
    }
    // Name order across pages, as LambdaDB lists tags.
    assert.deepEqual(seen.map(at => at.name), ['b-one', 'c-two', 'd-three', 'saved']);
    assert.deepEqual(calls.filter(call => call.kind === 'tag-list').map(call => call.params), [{ size: 2 }, { size: 2, pageToken: '2' }]);
    const { next } = await drive.listCheckpoints({ limit: 1 });
    await assert.rejects(drive.listForks(next), { code: 'LIST_CURSOR_UNAVAILABLE' });
    await assert.rejects(drive.listCheckpoints({ cursor: 'r1.e30' }), { code: 'LIST_CURSOR_UNAVAILABLE' });
    const other = await create({ client: connection.client, name: 'other-store' });
    await other.checkpoint({ name: 'one' });
    await assert.rejects(other.listCheckpoints(next), { code: 'LIST_CURSOR_UNAVAILABLE' });
    // Main is not a fork: a page can hold fewer forks than its native size, even none.
    await drive.fork({ name: 'zeta' });
    const first = await drive.listForks({ limit: 2 });
    assert.deepEqual(ats(first), [forkAt('draft'), forkAt('zeta')]);
    assert.deepEqual(await drive.listForks(first.next), { forks: [] });
});

test('ref deletion returns at, keeps independent snapshots, and later uses report absence', async () => {
    const { connection, drive, fork, checkpoint, calls } = await setup();
    const { at: child } = await drive.fork({ at: checkpoint, name: 'child' });
    const tools = createFileTools({ drive, tools: ['read', 'write'] });
    assert.deepEqual(await drive.deleteFork({ at: fork }), { at: fork });
    assert.deepEqual(await drive.deleteCheckpoint({ at: checkpoint }), { at: checkpoint });
    assert.deepEqual(ats(await drive.listForks()), [child]);
    assert.deepEqual(ats(await drive.listCheckpoints()), []);
    assert.equal((await drive.read({ at: child, path: edit.path })).content, edit.content);
    await assert.rejects(drive.write({ at: fork, ...edit }), { code: 'BRANCH_NOT_FOUND' });
    await assert.rejects(drive.read({ at: checkpoint, path: edit.path }), { code: 'CHECKPOINT_NOT_FOUND' });
    await assert.rejects(drive.deleteFork({ at: fork }), { code: 'BRANCH_NOT_FOUND' });
    await assert.rejects(drive.deleteCheckpoint({ at: checkpoint }), { code: 'CHECKPOINT_NOT_FOUND' });
    // A recreated name is a new view without the deleted fork's state.
    await drive.fork({ name: 'draft' });
    assert.equal(await drive.read({ at: fork, path: edit.path }), null);
    assert.equal(await tools.execute('read', { path: edit.path }), null);
    const reopened = await open(connection);
    assert.notEqual(reopened, drive);
    assert.deepEqual(await reopened.deleteFork({ at: fork }), { at: fork });
    assert(deletes(calls).every(call => call.retries.strategy === 'none'));
    // A fork deletion removes its reserved alias first (absent here), then the branch; no confirmation reads.
    assert.deepEqual(deletes(calls).map(call => call.kind), ['alias-delete', 'branch-delete', 'tag-delete',
        'alias-delete', 'branch-delete', 'tag-delete', 'alias-delete', 'branch-delete']);
});

test('delete requests require an existing at of the matching kind and main cannot be deleted', async () => {
    const { drive, fork, checkpoint, calls } = await setup();
    for (const request of [{}, { at: { kind: 'main' } }, { at: checkpoint }, { at: fork, name: 'draft' }, { name: 'draft' }, { at: { kind: 'fork' } }])
        await assert.rejects(drive.deleteFork(request), { code: 'INVALID_INPUT' });
    for (const request of [{}, { at: { kind: 'main' } }, { at: fork }, { at: { kind: 'checkpoint', name: 'x' } }])
        await assert.rejects(drive.deleteCheckpoint(request), { code: 'INVALID_INPUT' });
    assert.equal(deletes(calls).length, 0);
    assert.equal('delete' in drive, false);
});

test('a fork deletion waits for a write to that fork in flight in this process', async () => {
    const { fixture, drive, fork, calls } = await setup();
    let release, entered;
    const pending = new Promise(resolve => { entered = resolve; });
    fixture.beforeUpsert = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
    const writing = drive.write({ at: fork, op: 'create', path: '/late.md', content: 'late' });
    await pending;
    const deleting = drive.deleteFork({ at: fork });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(deletes(calls).length, 0);
    fixture.beforeUpsert = undefined;
    release();
    assert.equal((await writing).path, '/late.md');
    assert.deepEqual(await deleting, { at: fork });
});

test('destroy deletes only the content collection, is idempotent, and refuses foreign collections', async () => {
    const { connection, drive, fork, checkpoint, collections, calls, client } = await setup();
    await create({ ...connection, name: 'unrelated' });
    const listed = await drive.list({ at: fork, limit: 1 });
    assert.equal(MemDrive.destroy, destroy);
    await destroy(connection);
    assert.deepEqual([...collections.keys()], ['unrelated']);
    assert.deepEqual(deletes(calls).map(call => [call.kind, call.collection, call.retries]),
        [['collection-delete', name, { strategy: 'none' }]]);
    await destroy(connection);
    assert.equal(deletes(calls).length, 1);
    for (const at of [undefined, fork, checkpoint]) await assert.rejects(drive.read({ at, path: edit.path }), { code: 'STORE_NOT_FOUND' });
    await assert.rejects(open(connection), { code: 'STORE_NOT_FOUND', status: 404 });

    const replacement = await create(connection);
    assert.deepEqual(await replacement.listForks(), { forks: [] });
    await replacement.fork({ name: 'draft' });
    await replacement.write({ at: fork, ...edit });
    // A cursor from the destroyed generation never continues on the new store.
    if (listed.next) await assert.rejects(replacement.list(listed.next), { code: 'LIST_CURSOR_UNAVAILABLE' });

    await client.createCollection({ collectionName: 'foreign', indexConfigs: { memId: { type: 'keyword' } }, tags: {} });
    await assert.rejects(destroy({ client, name: 'foreign' }), { code: 'INCOMPATIBLE_STORE' });
    assert(collections.has('foreign'));
});

test('destroy passes native deletion errors through', async () => {
    const { fixture, connection, collections } = await setup();
    const rejected = Object.assign(new Error('Forbidden'), { statusCode: 403 });
    fixture.beforeCollectionDelete = () => { throw rejected; };
    await assert.rejects(destroy(connection), { code: 'DATABASE_ERROR', status: 403, cause: rejected });
    fixture.beforeCollectionDelete = () => { throw new Error('Connection reset'); };
    await assert.rejects(destroy(connection), error => error.code === 'DATABASE_ERROR' && error.status === undefined);
    assert(collections.has(name));
    fixture.beforeCollectionDelete = undefined;
    await destroy(connection);
    assert.equal(collections.has(name), false);
});

test('invalid and pre-aborted lifecycle requests do not submit mutations', async () => {
    const { connection, drive, fork, calls } = await setup();
    const options = { signal: AbortSignal.abort() };
    await assert.rejects(drive.deleteFork({ at: fork }, { force: true }), { code: 'INVALID_INPUT' });
    await assert.rejects(destroy({ ...connection, at: fork }), { code: 'INVALID_INPUT' });
    await assert.rejects(open({ ...connection, at: fork }), { code: 'INVALID_INPUT' });
    await assert.rejects(destroy(connection, options), { code: 'ABORTED' });
    await assert.rejects(drive.deleteFork({ at: fork }, options), { code: 'ABORTED' });
    await assert.rejects(drive.listForks({}, options), { code: 'ABORTED' });
    await assert.rejects(drive.rollback({ at: fork, to: checkpointAt('saved') }, options), { code: 'ABORTED' });
    assert.equal(deletes(calls).length, 0);
    assert.equal(calls.some(call => call.kind === 'branch-rollback'), false);
});
