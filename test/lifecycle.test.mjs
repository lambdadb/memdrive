import assert from 'node:assert/strict';
import test from 'node:test';
import { create, open, destroy, MemDrive, createFileTools } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

const name = 'lifecycle-store';
const edit = { op: 'create', path: '/note.md', content: 'Remember this.' };
const merge = { requestId: 'publish', summary: 'Publish note' };
const forkAt = refName => ({ kind: 'fork', name: refName });
const checkpointAt = refName => ({ kind: 'checkpoint', name: refName });
async function setup(published = false) {
    const fixture = fileClient();
    const connection = { client: fixture.client, name };
    const drive = await create(connection);
    const { at: fork } = await drive.fork({ name: 'draft' });
    if (published) { await drive.write({ at: fork, ...edit }); await drive.merge({ at: fork, ...merge }); }
    const { at: checkpoint } = await drive.checkpoint({ at: fork, name: 'saved' });
    return { ...fixture, fixture, connection, drive, fork, checkpoint };
}
const fresh = connection => ({ ...connection, client: { ...connection.client } });
const deletes = calls => calls.filter(call => call.kind.endsWith('-delete'));

test('lists all user forks and checkpoints as sorted at values, hides internal refs and rejects malformed lists', async () => {
    const { fixture, drive, checkpoint, collections } = await setup(true);
    await drive.fork({ at: checkpoint, name: 'another' });
    await drive.checkpoint({ name: 'alpha' });
    const storage = collections.get(name);
    assert(storage.branches.has('md-main-v0'));
    assert(storage.tags.has('md-main-v1'));
    assert.deepEqual(await drive.listForks(), { forks: [{ at: forkAt('another') }, { at: forkAt('draft') }] });
    assert.deepEqual(await drive.listCheckpoints({}), { checkpoints: [{ at: checkpointAt('alpha') }, { at: checkpointAt('saved') }] });
    await assert.rejects(drive.listForks({ at: forkAt('draft') }), { code: 'INVALID_INPUT' });
    fixture.listBranches = () => ({ branches: [{ name: 'fork-draft' }, { name: 'fork-draft' }] });
    await assert.rejects(drive.listForks(), { code: 'INVALID_RESULT' });
    fixture.listTags = () => ({ tags: [null] });
    await assert.rejects(drive.listCheckpoints(), { code: 'INVALID_RESULT' });
});

test('ref deletion returns at, preserves publication history and independent snapshots, and later uses report absence', async () => {
    const { connection, drive, fork, checkpoint, calls } = await setup(true);
    const { at: child } = await drive.fork({ at: checkpoint, name: 'child' });
    const tools = createFileTools({ drive, tools: ['read', 'write', 'deleteFork'] });
    assert.deepEqual(await drive.deleteFork({ at: fork }), { at: fork });
    assert.deepEqual(await drive.deleteCheckpoint({ at: checkpoint }), { at: checkpoint });
    assert.deepEqual(await drive.listForks(), { forks: [{ at: child }] });
    assert.deepEqual(await drive.listCheckpoints(), { checkpoints: [] });
    assert.equal((await drive.history()).entries[0].summary, merge.summary);
    assert.equal((await drive.read({ at: child, path: edit.path })).content, edit.content);
    await assert.rejects(drive.write({ at: fork, ...edit }), { code: 'BRANCH_NOT_FOUND' });
    await assert.rejects(drive.status({ at: fork }), { code: 'BRANCH_NOT_FOUND' });
    await assert.rejects(drive.read({ at: checkpoint, path: edit.path }), { code: 'CHECKPOINT_NOT_FOUND' });
    await assert.rejects(tools.execute('read', { at: fork, path: edit.path }), { code: 'BRANCH_NOT_FOUND' });
    await assert.rejects(drive.deleteFork({ at: fork }), { code: 'BRANCH_NOT_FOUND' });
    await assert.rejects(drive.deleteCheckpoint({ at: checkpoint }), { code: 'CHECKPOINT_NOT_FOUND' });
    // A recreated name is a new view without the deleted fork's state.
    await drive.fork({ name: 'draft' });
    assert.equal((await drive.read({ at: fork, path: edit.path })).content, edit.content);
    assert.equal(await open(connection), drive);
    assert.deepEqual(await tools.execute('deleteFork', { at: fork }), { at: fork });
    assert(deletes(calls).every(call => call.retries.strategy === 'none'));
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

test('fork and checkpoint creation from a fork source waits for that fork\'s in-flight writes', async () => {
    const { fixture, drive, fork, calls } = await setup();
    let release, entered;
    const pending = new Promise(resolve => { entered = resolve; });
    fixture.beforeUpsert = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
    const writing = drive.write({ at: fork, ...edit });
    await pending;
    const saving = drive.checkpoint({ at: fork, name: 'after-write' });
    const copying = drive.fork({ at: fork, name: 'copy-after-write' });
    const independent = await drive.checkpoint({ name: 'from-main' }); // Main is not queued behind the fork.
    await new Promise(resolve => setTimeout(resolve, 10));
    const created = () => calls.filter(call => ['tag-create', 'branch-create'].includes(call.kind)
        && [call.request.tagName, call.request.branchName].some(ref => ref?.endsWith('after-write')));
    assert.equal(created().length, 0);
    fixture.beforeUpsert = undefined;
    release();
    const file = await writing;
    assert.deepEqual(await saving, { at: { kind: 'checkpoint', name: 'after-write' } });
    assert.deepEqual(await copying, { at: { kind: 'fork', name: 'copy-after-write' } });
    assert.equal(created().length, 2);
    for (const { at } of [await saving, await copying])
        assert.equal((await drive.read({ at, fileId: file.fileId })).content, edit.content);
    assert.equal(await drive.read({ at: independent.at, fileId: file.fileId }), null);
});

test('deletion excludes active operations and blocks new work while native deletion is pending', async () => {
    const { fixture, connection, drive, fork } = await setup();
    let release, entered;
    const pending = new Promise(resolve => { entered = resolve; });
    fixture.beforeUpsert = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
    const writing = drive.write({ at: fork, ...edit });
    await pending;
    await assert.rejects(drive.deleteFork({ at: fork }), { code: 'STORE_BUSY' });
    await assert.rejects(destroy(connection), { code: 'STORE_BUSY' });
    fixture.beforeUpsert = undefined;
    release();
    await writing;
    const deleting = new Promise(resolve => { entered = resolve; });
    fixture.beforeRefDelete = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
    const removal = drive.deleteFork({ at: fork });
    await deleting;
    await assert.rejects(drive.read({ path: edit.path }), { code: 'STORE_BUSY' });
    await assert.rejects(open(connection), { code: 'STORE_BUSY' });
    await assert.rejects(create(connection), { code: 'STORE_BUSY' });
    release();
    await removal;
});

test('uncertain ref deletion fences every use of that at and recreation until an explicit deletion retry', async () => {
    for (const kind of ['fork', 'checkpoint']) for (const applied of [false, true]) {
        const { fixture, connection, drive, fork, checkpoint, calls } = await setup();
        const at = kind === 'fork' ? fork : checkpoint;
        const remove = kind === 'fork' ? 'deleteFork' : 'deleteCheckpoint';
        const hook = applied ? 'afterRefDelete' : 'beforeRefDelete';
        fixture[hook] = () => { throw new Error('Connection lost'); };
        await assert.rejects(drive[remove]({ at }), { code: 'REF_DELETION_UNCONFIRMED' });
        assert.equal(deletes(calls).length, 1);
        for (const use of [() => drive.list({ at }), () => drive.read({ at, path: edit.path }), () => drive.status({ at }),
            () => drive.fork({ at, name: 'from-fenced' }), () => drive.checkpoint({ at, name: 'from-fenced' }),
            () => drive.write({ at: fork, ...edit })].slice(0, kind === 'fork' ? 6 : 5))
            await assert.rejects(use(), { code: 'REF_DELETION_UNCONFIRMED' });
        await assert.rejects(destroy(connection), { code: 'REF_DELETION_UNCONFIRMED' });
        await assert.rejects(drive[kind]({ name: at.name }), { code: 'REF_DELETION_UNCONFIRMED' });
        assert.equal(deletes(calls).length, 1);
        fixture[hook] = undefined; // Models the host fencing the outstanding request.
        assert.deepEqual(await drive[remove]({ at }), { at });
        assert.deepEqual(await drive[kind]({ name: at.name }), { at });
        assert.deepEqual((await drive.status({ at })).at, at);
    }
});

test('definite ref rejection leaves the at usable and unconfirmed writes block deletion', async () => {
    const { fixture, drive, fork, connection, calls } = await setup();
    fixture.beforeRefDelete = () => { throw Object.assign(new Error('Forbidden'), { statusCode: 403 }); };
    await assert.rejects(drive.deleteFork({ at: fork }), { status: 403 });
    assert.deepEqual(await drive.listForks(), { forks: [{ at: fork }] });
    assert.deepEqual((await drive.status({ at: fork })).at, fork);
    fixture.beforeRefDelete = undefined;
    fixture.beforeUpsert = () => { throw new Error('Unconfirmed write'); };
    await assert.rejects(drive.write({ at: fork, ...edit }), { code: 'WRITE_UNCONFIRMED' });
    const before = deletes(calls).length;
    await assert.rejects(drive.deleteFork({ at: fork }), { code: 'WRITE_UNCONFIRMED' });
    await assert.rejects(destroy(connection), { code: 'WRITE_UNCONFIRMED' });
    assert.equal(deletes(calls).length, before);
});

test('an unfinished durable merge blocks ref and store deletion on fresh clients', async () => {
    const { fixture, drive, fork, connection, calls } = await setup();
    await drive.write({ at: fork, ...edit });
    fixture.beforeTagCreate = tag => { if (tag === 'md-main-v1') throw Object.assign(new Error('Forbidden'), { statusCode: 403 }); };
    await assert.rejects(drive.merge({ at: fork, ...merge }), { code: 'MERGE_RESUMABLE' });
    const remote = fresh(connection);
    const reopened = await open(remote);
    await assert.rejects(reopened.deleteFork({ at: fork }), { code: 'MERGE_BLOCKED' });
    await assert.rejects(destroy(fresh(connection)), { code: 'MERGE_BLOCKED' });
    assert.equal(deletes(calls).length, 0);
    fixture.beforeTagCreate = undefined;
    assert.equal(await open({ ...remote, recover: true }), reopened);
    await reopened.deleteFork({ at: fork });
});

test('destroy removes only owned resources, invalidates the drive, and permits a fresh store generation', async () => {
    const { connection, drive, fork, checkpoint, collections, calls } = await setup(true);
    await create({ ...connection, name: 'unrelated' });
    assert.equal(MemDrive.destroy, destroy);
    await destroy(connection);
    assert.deepEqual([...collections.keys()], ['unrelated']);
    assert(deletes(calls)[0].collection.startsWith('md-journal-'));
    assert.equal(deletes(calls)[1].collection, name);
    await destroy(connection);
    const replacement = await create(connection);
    assert.notEqual(replacement, drive);
    for (const at of [undefined, fork, checkpoint]) await assert.rejects(drive.status({ at }), { code: 'STORE_DELETED' });
    await assert.rejects(drive.deleteFork({ at: fork }), { code: 'STORE_DELETED' });
    assert.deepEqual(await replacement.listForks(), { forks: [] });
});

test('marked partial destruction resumes on a fresh client after either collection deletion fails', async () => {
    for (const stage of ['journal', 'content']) {
        const { fixture, connection, drive, collections } = await setup(true);
        fixture.beforeCollectionDelete = collection => {
            if ((collection === name) === (stage === 'content')) throw new Error('Deletion interrupted');
        };
        await assert.rejects(destroy(connection), { code: 'STORE_DELETION_UNCONFIRMED' });
        assert.equal(collections.get(name).metadata.tags['memdrive.format'], 'files-deleting-v0');
        await assert.rejects(drive.read({ path: edit.path }), { code: 'STORE_DELETED' });
        await assert.rejects(open(fresh(connection)), { code: 'STORE_DELETING' });
        fixture.beforeCollectionDelete = undefined;
        await destroy(fresh(connection));
        assert.equal(collections.size, 0);
    }
});

test('lost marker or final deletion responses remain resumable without an orphaned journal', async () => {
    for (const stage of ['marker', 'content']) {
        const { fixture, connection, collections } = await setup(true);
        if (stage === 'marker') fixture.afterCollectionUpdate = () => { throw new Error('Lost marker response'); };
        else fixture.afterCollectionDelete = collection => { if (collection === name) throw new Error('Lost delete response'); };
        await assert.rejects(destroy(connection), { code: 'STORE_DELETION_UNCONFIRMED' });
        fixture.afterCollectionUpdate = undefined;
        fixture.afterCollectionDelete = undefined;
        await destroy(fresh(connection));
        assert.equal(collections.size, 0);
    }
});

test('destroy rejects foreign journal ownership before marking or deleting any resource', async () => {
    const { connection, drive, fork, collections, calls } = await setup(true);
    const journal = [...collections.entries()].find(([key]) => key.startsWith('md-journal-'))[1];
    journal.metadata.tags['memdrive.owner'] = 'another-owner';
    await assert.rejects(destroy(connection), { code: 'INCOMPATIBLE_STORE' });
    assert.equal(calls.filter(call => call.kind === 'collection-update').length, 0);
    assert.equal(deletes(calls).length, 0);
    assert.deepEqual(await drive.listForks(), { forks: [{ at: fork }] });
});

test('a lost unapplied marker fences even a previously unopened client until destroy is retried', async () => {
    const { fixture, connection } = await setup();
    const remote = fresh(connection);
    fixture.beforeCollectionUpdate = () => { throw new Error('Marker outcome unknown'); };
    await assert.rejects(destroy(remote), { code: 'STORE_DELETION_UNCONFIRMED' });
    await assert.rejects(open(remote), { code: 'STORE_DELETED' });
    await assert.rejects(create(remote), { code: 'STORE_DELETED' });
    fixture.beforeCollectionUpdate = undefined;
    await destroy(remote);
    await create(remote);
});

test('malformed collection lookup cannot acknowledge destruction and ref absence must be confirmed', async () => {
    const { fixture, connection, drive, fork, collections, calls } = await setup();
    fixture.getCollection = () => ({});
    await assert.rejects(destroy(connection), { code: 'INVALID_RESULT' });
    assert.equal(deletes(calls).length, 0);
    fixture.getCollection = undefined;
    const branches = collections.get(name).branches;
    const original = branches.get('fork-draft');
    fixture.afterRefDelete = () => { branches.set('fork-draft', original); };
    await assert.rejects(drive.deleteFork({ at: fork }), { code: 'REF_DELETION_UNCONFIRMED' });
    fixture.afterRefDelete = undefined;
    await drive.deleteFork({ at: fork });
});

test('destroy preserves the tag budget and works with external stores and no journal', async () => {
    const { client, collections, calls } = fileClient();
    const connection = { client, name };
    const drive = await create({ ...connection, labels: { a: 'one', b: 'two', c: 'three' },
        embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'fixture' } });
    const { at: fork } = await drive.fork({ name: 'draft' });
    const { at: checkpoint } = await drive.checkpoint({ at: fork, name: 'saved' });
    await drive.deleteCheckpoint({ at: checkpoint });
    await drive.deleteFork({ at: fork });
    await destroy(connection);
    const tags = calls.find(call => call.kind === 'collection-update').request.tags;
    assert.equal(Object.keys(tags).length, 5);
    assert.equal(tags.a, 'one');
    assert.equal(collections.size, 0);
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
    assert.equal(deletes(calls).length, 0);
});
