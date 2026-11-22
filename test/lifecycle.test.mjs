import assert from 'node:assert/strict';
import test from 'node:test';
import { create, open, destroy, MemDrive, createFileTools } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

const name = 'lifecycle-store';
const edit = { op: 'create', path: '/note.md', content: 'Remember this.' };
const merge = { requestId: 'publish', summary: 'Publish note' };
async function setup(published = false) {
    const fixture = fileClient();
    const connection = { client: fixture.client, name };
    const main = await create(connection);
    const fork = await main.fork({ name: 'draft' });
    if (published) { await fork.write(edit); await fork.merge(merge); }
    const checkpoint = await fork.checkpoint({ name: 'saved' });
    return { ...fixture, fixture, connection, main, fork, checkpoint };
}
const fresh = connection => ({ ...connection, client: { ...connection.client } });
const deletes = calls => calls.filter(call => call.kind.endsWith('-delete'));

test('lists all user refs from every view, hides internal refs and rejects malformed lists', async () => {
    const { fixture, main, fork, checkpoint, collections } = await setup(true);
    await checkpoint.fork({ name: 'another' });
    await main.checkpoint({ name: 'alpha' });
    const storage = collections.get(name);
    assert([...storage.tags.keys()].some(key => key.startsWith('merge-capture-')));
    for (const drive of [main, fork, checkpoint]) {
        assert.deepEqual(await drive.listForks(), [{ name: 'another' }, { name: 'draft' }]);
        assert.deepEqual(await drive.listCheckpoints(), [{ name: 'alpha' }, { name: 'saved' }]);
    }
    fixture.listBranches = () => ({ branches: [{ name: 'fork-draft' }, { name: 'fork-draft' }] });
    await assert.rejects(main.listForks(), { code: 'INVALID_RESULT' });
    fixture.listTags = () => ({ tags: [null] });
    await assert.rejects(main.listCheckpoints(), { code: 'INVALID_RESULT' });
});

test('ref deletion preserves publication history and independent snapshots, and fences stale handles after name reuse', async () => {
    const { connection, main, fork, checkpoint, calls } = await setup(true);
    const child = await checkpoint.fork({ name: 'child' });
    const tools = createFileTools({ drive: fork, tools: ['read', 'write'] });
    assert.equal('delete' in main, false);
    await fork.delete();
    await checkpoint.delete();
    assert.deepEqual(await main.listForks(), [{ name: 'child' }]);
    assert.deepEqual(await main.listCheckpoints(), []);
    assert.equal((await main.history()).entries[0].summary, merge.summary);
    assert.equal((await child.read({ path: edit.path })).content, edit.content);
    const replacement = await main.fork({ name: 'draft' });
    const saved = await main.checkpoint({ name: 'saved' });
    await fork.delete(); // An old handle must not delete its replacement.
    await checkpoint.delete();
    assert.equal(await open({ ...connection, at: { fork: 'draft' } }), replacement);
    assert.equal(await open({ ...connection, at: { checkpoint: 'saved' } }), saved);
    await assert.rejects(fork.write(edit), { code: 'REF_DELETED' });
    await assert.rejects(fork.status(), { code: 'REF_DELETED' });
    await assert.rejects(checkpoint.read({ path: edit.path }), { code: 'REF_DELETED' });
    await assert.rejects(tools.execute('read', { path: edit.path }), { code: 'REF_DELETED' });
    assert(deletes(calls).every(call => call.retries.strategy === 'none'));
});

test('deletion excludes active operations and blocks new work while native deletion is pending', async () => {
    const { fixture, connection, main, fork } = await setup();
    let release, entered;
    const pending = new Promise(resolve => { entered = resolve; });
    fixture.beforeUpsert = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
    const writing = fork.write(edit);
    await pending;
    await assert.rejects(fork.delete(), { code: 'STORE_BUSY' });
    await assert.rejects(destroy(connection), { code: 'STORE_BUSY' });
    fixture.beforeUpsert = undefined;
    release();
    await writing;
    const deleting = new Promise(resolve => { entered = resolve; });
    fixture.beforeRefDelete = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
    const removal = fork.delete();
    await deleting;
    await assert.rejects(main.read({ path: edit.path }), { code: 'STORE_BUSY' });
    await assert.rejects(open(connection), { code: 'STORE_BUSY' });
    await assert.rejects(create(connection), { code: 'STORE_BUSY' });
    release();
    await removal;
});

test('uncertain ref deletion fences use and recreation until an explicit deletion retry', async () => {
    for (const kind of ['fork', 'checkpoint']) for (const applied of [false, true]) {
        const { fixture, connection, main, fork, checkpoint, calls } = await setup();
        const drive = kind === 'fork' ? fork : checkpoint;
        const refName = drive.at.name;
        const hook = applied ? 'afterRefDelete' : 'beforeRefDelete';
        fixture[hook] = () => { throw new Error('Connection lost'); };
        await assert.rejects(drive.delete(), { code: 'REF_DELETION_UNCONFIRMED' });
        assert.equal(deletes(calls).length, 1);
        await assert.rejects(drive.list(), { code: 'REF_DELETION_UNCONFIRMED' });
        await assert.rejects(destroy(connection), { code: 'REF_DELETION_UNCONFIRMED' });
        await assert.rejects(main[kind]({ name: refName }), { code: 'REF_DELETION_UNCONFIRMED' });
        await assert.rejects(open({ ...connection, at: { [kind]: refName } }), { code: 'REF_DELETION_UNCONFIRMED' });
        fixture[hook] = undefined; // Models the host fencing the outstanding request.
        await drive.delete();
        const replacement = await main[kind]({ name: refName });
        assert.notEqual(replacement, drive);
    }
});

test('definite ref rejection leaves the handle usable and unconfirmed writes block deletion', async () => {
    const { fixture, fork, connection, calls } = await setup();
    fixture.beforeRefDelete = () => { throw Object.assign(new Error('Forbidden'), { statusCode: 403 }); };
    await assert.rejects(fork.delete(), { status: 403 });
    assert.deepEqual(await fork.listForks(), [{ name: 'draft' }]);
    fixture.beforeRefDelete = undefined;
    fixture.beforeUpsert = () => { throw new Error('Unconfirmed write'); };
    await assert.rejects(fork.write(edit), { code: 'WRITE_UNCONFIRMED' });
    const before = deletes(calls).length;
    await assert.rejects(fork.delete(), { code: 'WRITE_UNCONFIRMED' });
    await assert.rejects(destroy(connection), { code: 'WRITE_UNCONFIRMED' });
    assert.equal(deletes(calls).length, before);
});

test('an unfinished durable merge blocks ref and store deletion on fresh clients', async () => {
    const { fixture, fork, connection, calls } = await setup();
    await fork.write(edit);
    fixture.beforeTagCreate = tag => { if (tag === 'md-main-v1') throw Object.assign(new Error('Forbidden'), { statusCode: 403 }); };
    await assert.rejects(fork.merge(merge), { code: 'MERGE_RESUMABLE' });
    const remote = fresh(connection);
    const reopened = await open({ ...remote, at: { fork: 'draft' } });
    await assert.rejects(reopened.delete(), { code: 'MERGE_BLOCKED' });
    await assert.rejects(destroy(fresh(connection)), { code: 'MERGE_BLOCKED' });
    assert.equal(deletes(calls).length, 0);
    fixture.beforeTagCreate = undefined;
    await open({ ...remote, recover: true });
    await reopened.delete();
});

test('destroy removes only owned resources, invalidates handles, and permits a fresh store generation', async () => {
    const { connection, main, fork, checkpoint, collections, calls } = await setup(true);
    await create({ ...connection, name: 'unrelated' });
    assert.equal(MemDrive.destroy, destroy);
    await destroy(connection);
    assert.deepEqual([...collections.keys()], ['unrelated']);
    assert(deletes(calls)[0].collection.startsWith('md-journal-'));
    assert.equal(deletes(calls)[1].collection, name);
    await destroy(connection);
    const replacement = await create(connection);
    assert.notEqual(replacement, main);
    for (const drive of [main, fork, checkpoint]) await assert.rejects(drive.status(), { code: 'STORE_DELETED' });
    await assert.rejects(fork.delete(), { code: 'STORE_DELETED' });
    assert.deepEqual(await replacement.listForks(), []);
});

test('marked partial destruction resumes on a fresh client after either collection deletion fails', async () => {
    for (const stage of ['journal', 'content']) {
        const { fixture, connection, main, collections } = await setup(true);
        fixture.beforeCollectionDelete = collection => {
            if ((collection === name) === (stage === 'content')) throw new Error('Deletion interrupted');
        };
        await assert.rejects(destroy(connection), { code: 'STORE_DELETION_UNCONFIRMED' });
        assert.equal(collections.get(name).metadata.tags['memdrive.format'], 'files-deleting-v0');
        await assert.rejects(main.read({ path: edit.path }), { code: 'STORE_DELETED' });
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
    const { connection, main, collections, calls } = await setup(true);
    const journal = [...collections.entries()].find(([key]) => key.startsWith('md-journal-'))[1];
    journal.metadata.tags['memdrive.owner'] = 'another-owner';
    await assert.rejects(destroy(connection), { code: 'INCOMPATIBLE_STORE' });
    assert.equal(calls.filter(call => call.kind === 'collection-update').length, 0);
    assert.equal(deletes(calls).length, 0);
    assert.deepEqual(await main.listForks(), [{ name: 'draft' }]);
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
    const { fixture, connection, fork, collections, calls } = await setup();
    fixture.getCollection = () => ({});
    await assert.rejects(destroy(connection), { code: 'INVALID_RESULT' });
    assert.equal(deletes(calls).length, 0);
    fixture.getCollection = undefined;
    const branches = collections.get(name).branches;
    const original = branches.get('fork-draft');
    fixture.afterRefDelete = () => { branches.set('fork-draft', original); };
    await assert.rejects(fork.delete(), { code: 'REF_DELETION_UNCONFIRMED' });
    fixture.afterRefDelete = undefined;
    await fork.delete();
});

test('destroy preserves the tag budget and works with external stores and no journal', async () => {
    const { client, collections, calls } = fileClient();
    const connection = { client, name };
    const main = await create({ ...connection, labels: { a: 'one', b: 'two', c: 'three' },
        embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'fixture' } });
    const fork = await main.fork({ name: 'draft' });
    const checkpoint = await fork.checkpoint({ name: 'saved' });
    await checkpoint.delete();
    await fork.delete();
    await destroy(connection);
    const tags = calls.find(call => call.kind === 'collection-update').request.tags;
    assert.equal(Object.keys(tags).length, 5);
    assert.equal(tags.a, 'one');
    assert.equal(collections.size, 0);
});

test('invalid and pre-aborted lifecycle requests do not submit mutations', async () => {
    const { connection, main, fork, calls } = await setup();
    const options = { signal: AbortSignal.abort() };
    await assert.rejects(fork.delete({ force: true }), { code: 'INVALID_INPUT' });
    await assert.rejects(destroy({ ...connection, at: { fork: 'draft' } }), { code: 'INVALID_INPUT' });
    await assert.rejects(destroy(connection, options), { code: 'ABORTED' });
    await assert.rejects(fork.delete(options), { code: 'ABORTED' });
    await assert.rejects(main.listForks(options), { code: 'ABORTED' });
    assert.equal(deletes(calls).length, 0);
});
