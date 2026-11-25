import assert from 'node:assert/strict';
import test from 'node:test';
import { MemDrive } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

const name = 'checkpointed-store';
const main = { kind: 'main' };
const draft = { kind: 'fork', name: 'draft' };
const checkpointAt = label => ({ kind: 'checkpoint', name: label });
const create = (path, content = `Text of ${path}.`) => ({ op: 'create', path, content });
const refKinds = ['tag-create', 'tag-delete', 'alias-create', 'alias-retarget', 'alias-get', 'alias-delete', 'alias-list', 'branch-rollback'];
const failure = (statusCode, message = 'Injected failure') => Object.assign(new Error(message), statusCode === undefined ? {} : { statusCode });

async function setup() {
    const fixture = fileClient();
    const drive = await MemDrive.create({ client: fixture.client, name });
    const state = () => fixture.collections.get(name);
    const docs = (branch = 'main') => [...state().branches.get(branch).docs].sort(([a], [b]) => a < b ? -1 : 1);
    const tagDocs = label => [...state().tags.get(`checkpoint-${label}`).docs].sort(([a], [b]) => a < b ? -1 : 1);
    const since = start => fixture.calls.slice(start).map(call => call.kind);
    return { fixture, drive, state, docs, tagDocs, since };
}

/** A store whose main has one checkpointed write `one` holding /kept.md. */
async function withLatest() {
    const context = await setup();
    const { result: kept } = await context.drive.write({ ...create('/kept.md', 'Kept.'), checkpoint: { name: 'one' } });
    return { ...context, kept, start: context.fixture.calls.length };
}

test('a plain write sends no checkpoint, alias or rollback requests', async () => {
    const { drive, since } = await setup();
    const file = await drive.write(create('/plain.md'));
    // The same requests as before checkpointed writes existed: destination check, upsert, confirmation.
    assert.deepEqual(since(0).slice(-3), ['query', 'upsert', 'fetch']);
    const start = since(0).length;
    await drive.write({ operations: [{ op: 'update', fileId: file.fileId, content: 'Changed.' }, create('/second.md')] });
    await drive.write({ op: 'delete', fileId: file.fileId });
    assert(!since(start).some(kind => refKinds.includes(kind)));
    assert.equal((await drive.describe()).latestCheckpoint, null);
});

test('a checkpointed write sends the write, one tag creation and one alias retarget, creating the alias only on the first', async () => {
    const { fixture, drive, state, docs, tagDocs, since } = await setup();
    const plainStart = fixture.calls.length;
    await drive.write(create('/plain.md'));
    const plain = since(plainStart);
    let start = fixture.calls.length;
    const first = await drive.write({ ...create('/one.md'), checkpoint: { name: 'one' } });
    assert.deepEqual(since(start), [...plain, 'tag-create', 'alias-retarget', 'alias-create']);
    assert.deepEqual(first, { result: await drive.read({ path: '/one.md' }), checkpoint: { at: checkpointAt('one') } });
    start = fixture.calls.length;
    const second = await drive.write({ operations: [create('/two.md'), { op: 'update', fileId: first.result.fileId, content: 'Changed.' }],
        checkpoint: { name: 'two' } });
    assert.equal(second.result.length, 2);
    assert.deepEqual(second.checkpoint, { at: checkpointAt('two') });
    const kinds = since(start);
    assert.deepEqual(kinds.slice(-2), ['tag-create', 'alias-retarget']);
    assert(!kinds.slice(0, -2).some(kind => refKinds.includes(kind)), 'no alias read or other ref request on success');
    const refCalls = fixture.calls.slice(start).filter(call => refKinds.includes(call.kind));
    assert.deepEqual(refCalls, [
        { kind: 'tag-create', request: { tagName: 'checkpoint-two', source: { kind: 'branch', name: 'main' } }, retries: { strategy: 'none' } },
        { kind: 'alias-retarget', name: 'latest-main', target: { kind: 'tag', name: 'checkpoint-two' }, retries: { strategy: 'none' } },
    ]);
    assert.deepEqual(tagDocs('two'), docs());
    assert.equal(state().aliases.get('latest-main').targetName, 'checkpoint-two');
    // describe reads the alias once.
    start = fixture.calls.length;
    assert.deepEqual((await drive.describe()).latestCheckpoint, { at: checkpointAt('two') });
    assert.deepEqual(since(start), ['alias-get']);
    // The alias is not a checkpoint.
    assert.deepEqual((await drive.listCheckpoints()).checkpoints.map(entry => entry.at), [checkpointAt('one'), checkpointAt('two')]);
});

test('checkpointed writes on forks use the fork\'s own alias and describe reports it', async () => {
    const { fixture, drive, state } = await setup();
    await drive.fork({ name: 'draft' });
    await drive.write({ ...create('/main.md'), checkpoint: { name: 'main-one' } });
    await drive.write({ at: draft, ...create('/fork.md'), checkpoint: { name: 'fork-one' } });
    assert.deepEqual([...state().aliases.keys()].sort(), ['latest-fork-draft', 'latest-main']);
    assert.deepEqual((await drive.describe({ at: draft })).latestCheckpoint, { at: checkpointAt('fork-one') });
    assert.deepEqual((await drive.describe({ at: main })).latestCheckpoint, { at: checkpointAt('main-one') });
    // One alias read either way: a fork without checkpointed writes, or a missing fork, reports null.
    await drive.fork({ name: 'other' });
    const start = fixture.calls.length;
    assert.equal((await drive.describe({ at: { kind: 'fork', name: 'other' } })).latestCheckpoint, null);
    assert.equal((await drive.describe({ at: { kind: 'fork', name: 'missing' } })).latestCheckpoint, null);
    assert.deepEqual(fixture.calls.slice(start).map(call => call.kind), ['alias-get', 'alias-get']);
    for (const request of [{ at: checkpointAt('main-one') }, { signal: AbortSignal.abort() }, { at: main, extra: true }, null])
        await assert.rejects(drive.describe(request), { code: 'INVALID_INPUT' });
    // Fork names leave room for the reserved alias within LambdaDB's 52-character ref names.
    await drive.fork({ name: 'x'.repeat(40) });
    await assert.rejects(drive.fork({ name: 'x'.repeat(41) }), { code: 'INVALID_INPUT' });
    await drive.write({ at: { kind: 'fork', name: 'x'.repeat(40) }, ...create('/long.md'), checkpoint: { name: 'long-one' } });
    assert(state().aliases.has(`latest-fork-${'x'.repeat(40)}`));
});

test('invalid checkpointed writes and errors raised before any change send nothing beyond the plain write checks', async () => {
    const { fixture, drive, kept, start } = await withLatest();
    for (const request of [{ at: checkpointAt('one'), ...create('/x.md'), checkpoint: { name: 'cp' } }, { ...create('/x.md'), checkpoint: 'cp-1' },
        { ...create('/x.md'), checkpoint: { name: 'ab' } }, { ...create('/x.md'), checkpoint: { name: 'cp-1', at: main } },
        { operations: [create('/x.md')], checkpoint: { name: 'bad/name' } }])
        await assert.rejects(drive.write(request), { code: 'INVALID_INPUT' });
    assert.equal(fixture.calls.length, start);
    // PATH_EXISTS and EDIT_CONFLICT are raised before the first mutation and are thrown unchanged.
    await assert.rejects(drive.write({ ...create('/kept.md'), checkpoint: { name: 'two' } }), { code: 'PATH_EXISTS' });
    await assert.rejects(drive.write({ op: 'update', fileId: kept.fileId, edits: [{ oldText: 'absent', newText: 'x' }], checkpoint: { name: 'two' } }),
        { code: 'EDIT_CONFLICT' });
    assert(!fixture.calls.slice(start).some(call => refKinds.includes(call.kind)));
});

test('a failed or partial write restores the branch to its latest checkpoint', async () => {
    for (const inject of ['rejected', 'unconfirmed', 'partial']) {
        const { fixture, drive, kept, docs, tagDocs, state, start } = await withLatest();
        let upserts = 0;
        if (inject === 'rejected') fixture.beforeUpsert = () => { throw failure(400); };
        if (inject === 'unconfirmed') fixture.afterUpsert = () => { throw failure(undefined, 'Connection reset'); };
        if (inject === 'partial') fixture.beforeUpsert = () => { if (++upserts === 2) throw failure(503); };
        const error = await drive.write({ operations: [create('/new.md'), { op: 'update', fileId: kept.fileId, content: 'Overwritten.' },
            create('/later.md')], checkpoint: { name: 'two' } }).catch(cause => cause);
        fixture.beforeUpsert = fixture.afterUpsert = undefined;
        assert.equal(error.code, 'CHECKPOINT_WRITE_FAILED', inject);
        assert.equal(error.details.stage, 'write');
        assert.equal(error.details.restored, true);
        assert.deepEqual(error.details.restoredTo, checkpointAt('one'));
        assert.equal(error.details.cause.code, inject === 'rejected' ? 'DATABASE_ERROR' : 'WRITE_UNCONFIRMED');
        if (inject === 'partial') assert.deepEqual(error.details.cause.details.completedFileIds.length, 1);
        assert.deepEqual(docs(), tagDocs('one'));
        assert.equal(state().tags.has('checkpoint-two'), false);
        assert.equal(state().aliases.get('latest-main').targetName, 'checkpoint-one');
        // Restore: one alias read and one rollback; no tag was created, so none is deleted.
        assert.deepEqual(fixture.calls.slice(start).filter(call => refKinds.includes(call.kind)).map(call => call.kind), ['alias-get', 'branch-rollback']);
        assert.equal((await drive.read({ fileId: kept.fileId })).content, 'Kept.');
    }
});

test('an applied write whose checkpoint or alias move fails is rolled back and the new checkpoint removed', async () => {
    const cases = {
        'tag rejected': { hook: 'beforeTagCreate', error: failure(400), stage: 'checkpoint', refs: ['tag-create', 'alias-get', 'branch-rollback'] },
        'tag unknown, absent': { hook: 'beforeTagCreate', error: failure(503), stage: 'checkpoint', refs: ['tag-create', 'alias-get', 'branch-rollback', 'tag-delete'] },
        'tag unknown, created': { hook: 'afterTagCreate', error: failure(undefined, 'Lost response'), stage: 'checkpoint', refs: ['tag-create', 'alias-get', 'branch-rollback', 'tag-delete'] },
        'alias rejected': { hook: 'beforeAliasRetarget', error: failure(400), stage: 'alias', refs: ['tag-create', 'alias-retarget', 'alias-get', 'branch-rollback', 'tag-delete'] },
        'alias unknown, not moved': { hook: 'beforeAliasRetarget', error: failure(undefined, 'Lost response'), stage: 'alias', refs: ['tag-create', 'alias-retarget', 'alias-get', 'branch-rollback', 'tag-delete'] },
    };
    for (const [label, { hook, error: injected, stage, refs }] of Object.entries(cases)) {
        const { fixture, drive, docs, tagDocs, state, start } = await withLatest();
        fixture[hook] = () => { throw injected; };
        const error = await drive.write({ ...create('/new.md'), checkpoint: { name: 'two' } }).catch(cause => cause);
        fixture[hook] = undefined;
        assert.equal(error.code, 'CHECKPOINT_WRITE_FAILED', label);
        assert.equal(error.details.stage, stage, label);
        assert.equal(error.details.restored, true);
        assert.deepEqual(error.details.restoredTo, checkpointAt('one'));
        assert.equal(error.cause.cause, injected);
        assert.deepEqual(docs(), tagDocs('one'), label);
        assert.equal(state().tags.has('checkpoint-two'), false, label);
        assert.equal(state().aliases.get('latest-main').targetName, 'checkpoint-one');
        assert.deepEqual(fixture.calls.slice(start).filter(call => refKinds.includes(call.kind)).map(call => call.kind), refs, label);
        assert.equal(error.details.checkpointRemoved, refs.includes('tag-delete') ? true : undefined, label);
    }
});

test('an alias move with a lost response that did happen completes the checkpointed write', async () => {
    const { fixture, drive, state, start } = await withLatest();
    fixture.afterAliasRetarget = () => { throw failure(undefined, 'Lost response'); };
    const written = await drive.write({ ...create('/new.md'), checkpoint: { name: 'two' } });
    assert.deepEqual(written.checkpoint, { at: checkpointAt('two') });
    assert.equal((await drive.read({ path: '/new.md' })).content, written.result.content);
    assert.equal(state().aliases.get('latest-main').targetName, 'checkpoint-two');
    assert.deepEqual(fixture.calls.slice(start).filter(call => refKinds.includes(call.kind)).map(call => call.kind),
        ['tag-create', 'alias-retarget', 'alias-get']);
});

test('a checkpoint name already in use restores the branch without deleting that checkpoint', async () => {
    const { drive, docs, tagDocs, state } = await withLatest();
    // A checkpoint taken from a checkpoint does not touch main's alias.
    await drive.checkpoint({ at: checkpointAt('one'), name: 'taken' });
    const taken = tagDocs('taken');
    const error = await drive.write({ ...create('/new.md'), checkpoint: { name: 'taken' } }).catch(cause => cause);
    assert.equal(error.code, 'CHECKPOINT_WRITE_FAILED');
    assert.equal(error.details.cause.code, 'CHECKPOINT_CONFLICT');
    assert.equal(error.details.checkpointRemoved, undefined);
    assert.deepEqual(docs(), tagDocs('one'));
    assert.deepEqual(tagDocs('taken'), taken);
    assert.equal(state().aliases.get('latest-main').targetName, 'checkpoint-one');
});

test('an explicit checkpoint of a branch becomes its latest checkpoint, and a failing checkpointed write rolls back to it', async () => {
    const { fixture, drive, docs, tagDocs, state } = await withLatest();
    await drive.fork({ name: 'draft' });
    // Forks and checkpoints of checkpoints leave every alias alone.
    await drive.fork({ at: checkpointAt('one'), name: 'copy' });
    await drive.checkpoint({ at: checkpointAt('one'), name: 'copy-of-one' });
    assert.deepEqual([...state().aliases.keys()], ['latest-main']);
    // A plain write, then an explicit checkpoint: one queue turn creates the tag and moves the alias.
    await drive.write(create('/plain.md', 'Plain.'));
    let start = fixture.calls.length;
    assert.deepEqual(await drive.checkpoint({ name: 'manual' }), { at: checkpointAt('manual') });
    assert.deepEqual(fixture.calls.slice(start).map(call => call.kind), ['tag-create', 'alias-retarget']);
    assert.deepEqual((await drive.describe()).latestCheckpoint, { at: checkpointAt('manual') });
    // A branch's first explicit checkpoint creates its alias.
    start = fixture.calls.length;
    await drive.checkpoint({ at: draft, name: 'draft-one' });
    assert.deepEqual(fixture.calls.slice(start).map(call => call.kind), ['tag-create', 'alias-retarget', 'alias-create']);
    assert.deepEqual((await drive.describe({ at: draft })).latestCheckpoint, { at: checkpointAt('draft-one') });
    // A failing checkpointed write restores the explicit checkpoint, which kept the plain write.
    fixture.beforeAliasRetarget = () => { throw failure(503); };
    const error = await drive.write({ ...create('/new.md'), checkpoint: { name: 'two' } }).catch(cause => cause);
    fixture.beforeAliasRetarget = undefined;
    assert.deepEqual(error.details.restoredTo, checkpointAt('manual'));
    assert.deepEqual(docs(), tagDocs('manual'));
    assert.equal((await drive.read({ path: '/plain.md' })).content, 'Plain.');
    // A plain write after the latest checkpoint is undone by the next failing checkpointed write.
    await drive.write(create('/unprotected.md', 'Unprotected.'));
    fixture.beforeTagCreate = () => { throw failure(400); };
    await assert.rejects(drive.write({ ...create('/new.md'), checkpoint: { name: 'two' } }), { code: 'CHECKPOINT_WRITE_FAILED' });
    fixture.beforeTagCreate = undefined;
    assert.equal(await drive.read({ path: '/unprotected.md' }), null);
});

test('an explicit checkpoint whose alias move fails keeps the checkpoint, changes no files and reports it', async () => {
    const { fixture, drive, docs, state } = await withLatest();
    const before = docs();
    fixture.beforeAliasRetarget = () => { throw failure(503); };
    const start = fixture.calls.length;
    const error = await drive.checkpoint({ name: 'manual' }).catch(cause => cause);
    fixture.beforeAliasRetarget = undefined;
    assert.equal(error.code, 'LATEST_CHECKPOINT_NOT_MOVED');
    assert.deepEqual(error.details.at, main);
    assert.deepEqual(error.details.checkpoint, checkpointAt('manual'));
    assert.deepEqual(error.details.latestCheckpoint, checkpointAt('one'));
    assert.equal(error.details.checkpointCreated, true);
    assert.equal(error.details.cause.status, 503);
    assert(state().tags.has('checkpoint-manual'));
    assert.deepEqual(docs(), before);
    assert.deepEqual(fixture.calls.slice(start).map(call => call.kind), ['tag-create', 'alias-retarget', 'alias-get']);
    // A lost response of a move that happened is resolved by reading the alias back.
    fixture.afterAliasRetarget = () => { throw failure(undefined, 'Lost response'); };
    assert.deepEqual(await drive.checkpoint({ name: 'second' }), { at: checkpointAt('second') });
    fixture.afterAliasRetarget = undefined;
    assert.deepEqual((await drive.describe()).latestCheckpoint, { at: checkpointAt('second') });
});

test('a failed restore is reported once with what is known and is never retried', async () => {
    const { fixture, drive, state, start } = await withLatest();
    fixture.beforeAliasRetarget = () => { throw failure(503); };
    // Until LambdaDB publishes a just-created checkpoint's snapshot, rollback to it is rejected with 400.
    const notPublished = failure(400, 'Rollback requires a tag with a published snapshot');
    fixture.beforeRollback = () => { throw notPublished; };
    const error = await drive.write({ ...create('/new.md'), checkpoint: { name: 'two' } }).catch(cause => cause);
    assert.equal(error.code, 'CHECKPOINT_RESTORE_FAILED');
    assert.equal(error.details.stage, 'alias');
    assert.equal(error.details.restored, false);
    assert.deepEqual(error.details.previousCheckpoint, checkpointAt('one'));
    assert.equal(error.details.checkpointCreated, true);
    assert.equal(error.details.restoreCause.status, 400);
    assert.equal(error.details.cause.status, 503);
    assert.equal(fixture.calls.slice(start).filter(call => call.kind === 'branch-rollback').length, 1);
    // The branch keeps the write; the new tag stays for inspection.
    assert.notEqual(await drive.read({ path: '/new.md' }), null);
    assert(state().tags.has('checkpoint-two'));
    // An unreadable alias is also a restore failure.
    fixture.beforeRollback = undefined;
    fixture.beforeAliasGet = () => { throw failure(503); };
    const unread = await drive.write({ ...create('/other.md'), checkpoint: { name: 'three' } }).catch(cause => cause);
    fixture.beforeAliasGet = fixture.beforeAliasRetarget = undefined;
    assert.equal(unread.code, 'CHECKPOINT_RESTORE_FAILED');
    assert.equal(unread.details.checkpointCreated, true);
});

test('without an earlier checkpoint the files the write created are removed, and other changes are reported', async () => {
    const { fixture, drive, state, docs } = await setup();
    const existing = await drive.write(create('/existing.md', 'Existing.'));
    const before = docs();
    fixture.beforeAliasCreate = () => { throw failure(503); };
    const error = await drive.write({ operations: [create('/a.md'), create('/b.md')], checkpoint: { name: 'one' } }).catch(cause => cause);
    assert.equal(error.code, 'CHECKPOINT_WRITE_FAILED');
    assert.equal(error.details.stage, 'alias');
    assert.equal(error.details.restored, true);
    assert.equal(error.details.restoredTo, null);
    assert.equal(error.details.checkpointRemoved, true);
    assert.deepEqual(docs(), before, 'created originals and chunks are gone');
    assert.equal(state().tags.size, 0);
    assert.equal(state().aliases.size, 0);
    // A first checkpointed write that changed an existing file cannot undo that change.
    const mixed = await drive.write({ operations: [create('/c.md'), { op: 'update', fileId: existing.fileId, content: 'Changed.' }],
        checkpoint: { name: 'one' } }).catch(cause => cause);
    fixture.beforeAliasCreate = undefined;
    assert.equal(mixed.code, 'CHECKPOINT_RESTORE_FAILED');
    assert.equal(mixed.details.restored, false);
    assert.equal(mixed.details.restoredTo, null);
    assert.deepEqual(mixed.details.unrestoredFileIds, [existing.fileId]);
    assert.equal(await drive.read({ path: '/c.md' }), null);
    assert.equal((await drive.read({ fileId: existing.fileId })).content, 'Changed.');
    // A failed first write only reports the existing files it reached.
    fixture.beforeUpsert = () => { throw failure(400); };
    const rejected = await drive.write({ operations: [create('/d.md'), { op: 'update', fileId: existing.fileId, content: 'Again.' }],
        checkpoint: { name: 'one' } }).catch(cause => cause);
    fixture.beforeUpsert = undefined;
    assert.equal(rejected.code, 'CHECKPOINT_WRITE_FAILED');
    assert.equal(rejected.details.restoredTo, null);
});

test('an abort after the write still restores the branch', async () => {
    const { fixture, drive, docs, tagDocs, state } = await withLatest();
    const controller = new AbortController();
    // The caller aborts while the checkpoint is being created.
    fixture.beforeTagCreate = () => { controller.abort(); throw Object.assign(new Error('Aborted'), { name: 'AbortError' }); };
    const error = await drive.write({ ...create('/new.md'), checkpoint: { name: 'two' } }, { signal: controller.signal }).catch(cause => cause);
    fixture.beforeTagCreate = undefined;
    assert.equal(error.code, 'CHECKPOINT_WRITE_FAILED');
    assert.equal(error.details.stage, 'checkpoint');
    assert.equal(error.details.cause.code, 'ABORTED');
    assert.deepEqual(docs(), tagDocs('one'));
    assert.equal(state().tags.has('checkpoint-two'), false);
});

test('the latest checkpoint cannot be deleted, rollback moves it and deleting a fork removes its alias', async () => {
    const { fixture, drive, state, docs, tagDocs } = await withLatest();
    await drive.write({ ...create('/two.md'), checkpoint: { name: 'two' } });
    await drive.fork({ name: 'draft' });
    await drive.write({ at: draft, ...create('/fork.md'), checkpoint: { name: 'fork-one' } });
    const start = fixture.calls.length;
    const error = await drive.deleteCheckpoint({ at: checkpointAt('two') }).catch(cause => cause);
    assert.equal(error.code, 'CHECKPOINT_IN_USE');
    assert.deepEqual(error.details.latestOf, [main]);
    assert.deepEqual(fixture.calls.slice(start).map(call => call.kind), ['alias-list']);
    await assert.rejects(drive.deleteCheckpoint({ at: checkpointAt('fork-one') }), error => error.code === 'CHECKPOINT_IN_USE'
        && JSON.stringify(error.details.latestOf) === JSON.stringify([draft]));
    // Rolling main back to `one` makes `one` its latest checkpoint, so `two` can go.
    await drive.rollback({ at: main, to: checkpointAt('one') });
    assert.deepEqual(docs(), tagDocs('one'));
    assert.deepEqual((await drive.describe()).latestCheckpoint, { at: checkpointAt('one') });
    assert.deepEqual(await drive.deleteCheckpoint({ at: checkpointAt('two') }), { at: checkpointAt('two') });
    await assert.rejects(drive.deleteCheckpoint({ at: checkpointAt('one') }), { code: 'CHECKPOINT_IN_USE' });
    // A failed alias move after a successful rollback is reported with the rollback applied.
    await drive.checkpoint({ name: 'manual' });
    fixture.beforeAliasRetarget = () => { throw failure(503); };
    await assert.rejects(drive.rollback({ at: main, to: checkpointAt('one') }), error => error.code === 'LATEST_CHECKPOINT_NOT_MOVED'
        && error.details.rolledBack === true && error.details.latestCheckpoint.name === 'manual');
    fixture.beforeAliasRetarget = undefined;
    assert.deepEqual(docs(), tagDocs('one'));
    // Deleting the fork removes its alias first; a recreated fork starts without a latest checkpoint.
    await drive.deleteFork({ at: draft });
    assert.equal(state().aliases.has('latest-fork-draft'), false);
    assert.deepEqual(await drive.deleteCheckpoint({ at: checkpointAt('fork-one') }), { at: checkpointAt('fork-one') });
    await drive.fork({ name: 'draft' });
    assert.equal((await drive.describe({ at: draft })).latestCheckpoint, null);
});
