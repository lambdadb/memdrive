import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { create, open, destroy } from '@functional-systems/memdrive';
import { lifecycle, weakRegistry } from '../dist/esm/lifecycle.js';
import { fileClient } from './helpers/file-client.mjs';

// Each test file runs in its own process, so exposing gc here affects no other test.
setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc');

const name = 'release-store';
const draft = { kind: 'fork', name: 'draft' };
const lost = () => new Error('Response lost');

/** Whether the target is collected once nothing but the weak reference can reach it. */
async function collected(ref) {
    for (let attempt = 0; attempt < 50; attempt++) {
        // deref keeps its target alive until the current job ends. setImmediate
        // also works while a test replaces setTimeout with a mock clock.
        await new Promise(resolve => setImmediate(resolve));
        gc();
        await new Promise(resolve => setImmediate(resolve));
        if (ref.deref() === undefined) return true;
    }
    return false;
}

async function setup() {
    const fixture = fileClient();
    const connection = { client: fixture.client, name };
    await (await create(connection)).fork({ name: 'draft' });
    return { fixture, connection };
}

/** Run a scenario on a drive that only this call references, and return a weak reference to it. */
async function scenario(connection, run = async () => {}) {
    const drive = await open(connection);
    await run(drive);
    return new WeakRef(drive);
}

test('a weak registry returns the same object while it is alive and keeps a held one', async () => {
    const registry = weakRegistry();
    let ref = (() => {
        const value = { label: 'idle' };
        registry.set('idle', value);
        assert.equal(registry.get('idle'), value);
        return new WeakRef(value);
    })();
    assert(await collected(ref));
    assert.equal(registry.get('idle'), undefined);

    ref = (() => {
        const value = { label: 'held' };
        registry.set('held', value);
        registry.hold('held', value, true);
        // Only the current entry of a name can be held.
        registry.hold('held', { label: 'stranger' }, false);
        return new WeakRef(value);
    })();
    assert(!await collected(ref));
    assert.equal(registry.get('held'), ref.deref());
    registry.hold('held', ref.deref(), false);
    assert(await collected(ref));

    ref = (() => {
        const value = { label: 'removed' };
        registry.set('removed', value);
        registry.hold('removed', value, true);
        registry.delete('removed');
        registry.hold('removed', value, true);
        return new WeakRef(value);
    })();
    assert.equal(registry.get('removed'), undefined);
    assert(await collected(ref));
});

test('a dropped drive is collected and a later open builds a working one from the journal', async () => {
    const { fixture, connection } = await setup();
    const ref = await scenario(connection, async drive => {
        assert.equal(await open(connection), drive);
        await drive.write({ at: draft, op: 'create', path: '/note', content: 'kept' });
        await drive.merge({ at: draft, requestId: 'first', summary: 'Publish note' });
        assert.deepEqual((await drive.list()).files.map(file => file.path), ['/note']);
    });
    assert(await collected(ref), 'An idle store stayed registered after its drive was dropped.');
    const reopened = await open(connection);
    assert.deepEqual(await reopened.status(), { at: { kind: 'main' }, mainVersion: 'v1' });
    assert.equal((await reopened.read({ path: '/note' })).content, 'kept');
    assert.deepEqual(await reopened.merge({ at: draft, requestId: 'first', summary: 'Publish note' }),
        { requestId: 'first', status: 'published', version: 'v1' });
    assert.equal(await open(connection), reopened);
    assert.equal(fixture.calls.filter(call => call.kind === 'tag-create' && call.request.tagName === 'md-main-v1').length, 1);
});

test('a referenced drive survives collection and same-store opens keep returning it', async () => {
    const { connection } = await setup();
    const drive = await open(connection);
    assert(!await collected(new WeakRef(drive)));
    assert.equal(await open(connection), drive);
    assert.notEqual(await open({ ...connection, client: { ...connection.client } }), drive);
});

test('an unconfirmed reference deletion keeps the store and its fence after the drive is dropped', async () => {
    const { fixture, connection } = await setup();
    const ref = await scenario(connection, async drive => {
        fixture.afterRefDelete = () => { throw lost(); };
        await assert.rejects(drive.deleteFork({ at: draft }), { code: 'REF_DELETION_UNCONFIRMED' });
        fixture.afterRefDelete = undefined;
    });
    assert(!await collected(ref), 'A store with a deletion fence was released.');
    await (async () => {
        const reopened = await open(connection);
        assert.equal(reopened, ref.deref());
        const deletes = fixture.calls.filter(call => call.kind === 'branch-delete').length;
        await assert.rejects(reopened.status({ at: draft }), { code: 'REF_DELETION_UNCONFIRMED' });
        await assert.rejects(reopened.fork({ name: 'draft' }), { code: 'REF_DELETION_UNCONFIRMED' });
        await assert.rejects(destroy(connection), { code: 'REF_DELETION_UNCONFIRMED' });
        assert.equal(fixture.calls.filter(call => call.kind === 'branch-delete').length, deletes);
        // Settling the fence releases the store again.
        assert.deepEqual(await reopened.deleteFork({ at: draft }), { at: draft });
    })();
    assert(await collected(ref), 'A settled store stayed pinned.');
});

test('pending configuration, reference creation, merge and write outcomes pin the store until they settle', async () => {
    const cases = {
        async configuration(fixture, drive) {
            fixture.beforeCollectionUpdate = () => { throw lost(); };
            await assert.rejects(drive.configure({ retentionInDays: 7 }), { code: 'CONFIGURATION_UNCONFIRMED' });
            fixture.beforeCollectionUpdate = undefined;
            return async reopened => {
                await assert.rejects(reopened.configure({ retentionInDays: 14 }), { code: 'CONFIGURATION_UNCONFIRMED' });
                assert.equal((await reopened.configure({ retentionInDays: 7 })).retentionInDays, 7);
            };
        },
        async creation(fixture, drive) {
            fixture.afterTagCreate = () => { throw lost(); };
            await assert.rejects(drive.checkpoint({ name: 'saved' }), { code: 'REF_CREATION_UNCONFIRMED' });
            fixture.afterTagCreate = undefined;
            return async reopened => {
                const creations = fixture.calls.filter(call => call.kind === 'tag-create').length;
                await assert.rejects(reopened.checkpoint({ name: 'saved' }), { code: 'REF_CREATION_UNCONFIRMED' });
                assert.equal(fixture.calls.filter(call => call.kind === 'tag-create').length, creations);
                // Inspecting the uncertain checkpoint clears its creation fence.
                assert.deepEqual((await reopened.status({ at: { kind: 'checkpoint', name: 'saved' } })).at, { kind: 'checkpoint', name: 'saved' });
            };
        },
        async merge(fixture, drive) {
            await drive.write({ at: draft, op: 'create', path: '/note', content: 'pending' });
            await drive.fork({ name: 'other' });
            fixture.beforeUpsert = ({ docs }) => { if (docs[0].kind === 'merge-reservation-v1') throw lost(); };
            await assert.rejects(drive.merge({ at: draft, requestId: 'first', summary: 'Publish note' }), { code: 'MERGE_RESUMABLE' });
            fixture.beforeUpsert = undefined;
            return async reopened => {
                // The unconfirmed reservation still blocks other requests on this client.
                await assert.rejects(reopened.merge({ at: { kind: 'fork', name: 'other' }, requestId: 'second', summary: 'Other' }),
                    { code: 'MERGE_BLOCKED', details: { requestId: 'first' } });
                assert.deepEqual(await reopened.merge({ at: draft, requestId: 'first', summary: 'Publish note' }),
                    { requestId: 'first', status: 'published', version: 'v1' });
            };
        },
        async write(fixture, drive) {
            fixture.afterUpsert = () => { throw lost(); };
            await assert.rejects(drive.write({ at: draft, op: 'create', path: '/note', content: '' }), { code: 'WRITE_UNCONFIRMED' });
            fixture.afterUpsert = undefined;
            return async reopened => {
                // The fence still requires the write to be confirmed before a ref of the fork is created.
                fixture.beforeFetch = ({ ref }) => ref.name === 'fork-draft' ? { isDocsInline: true, total: 0, docs: [] } : undefined;
                await assert.rejects(reopened.checkpoint({ at: draft, name: 'during' }), { code: 'WRITE_UNCONFIRMED' });
                fixture.beforeFetch = undefined;
                assert.deepEqual(await reopened.checkpoint({ at: draft, name: 'during' }), { at: { kind: 'checkpoint', name: 'during' } });
            };
        },
    };
    for (const [label, arrange] of Object.entries(cases)) {
        const { fixture, connection } = await setup();
        let settle;
        const ref = await scenario(connection, async drive => { settle = await arrange(fixture, drive); });
        assert(!await collected(ref), `${label}: a store with pending state was released.`);
        await (async () => {
            const reopened = await open(connection);
            assert.equal(reopened, ref.deref(), label);
            await settle(reopened);
        })();
        settle = undefined;
        assert(await collected(ref), `${label}: a settled store stayed pinned.`);
    }
});

test('an operation in flight and an unexpired list cursor keep the same store reachable', async () => {
    const { fixture, connection } = await setup();
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    fixture.beforeUpsert = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
    let writing;
    let ref = await scenario(connection, async drive => {
        writing = drive.write({ at: draft, operations: [1, 2, 3].map(n => ({ op: 'create', path: `/file-${n}`, content: '' })) });
        await started;
    });
    assert(!await collected(ref), 'A store with a running write was released.');
    // A reopened store shares the running write's queue instead of starting a second one.
    assert.equal(await open(connection), ref.deref());
    fixture.beforeUpsert = undefined;
    release();
    assert.equal((await writing).length, 3);
    writing = undefined;
    assert(await collected(ref));

    let next;
    ref = await scenario(connection, async drive => {
        const page = await drive.list({ at: draft, limit: 2 });
        assert.equal(page.files.length, 2);
        ({ next } = page);
    });
    assert(!await collected(ref), 'A store with a live list cursor was released.');
    const reopened = await open(connection);
    assert.deepEqual((await reopened.list(next)).files.map(file => file.path), ['/file-3']);
    // Leave the process-wide cache empty for the tests that control its clock.
    await reopened.deleteFork({ at: draft });
});

test('an idle lifecycle coordinator is released and an invalidated one is kept', async () => {
    const client = fileClient().client;
    let ref = (() => new WeakRef(lifecycle({ client, name })))();
    assert(await collected(ref));
    ref = (() => {
        const gate = lifecycle({ client, name });
        gate.invalidate();
        return new WeakRef(gate);
    })();
    assert(!await collected(ref));
    assert.equal(lifecycle({ client, name }), ref.deref());
    await assert.rejects(open({ client, name }), { code: 'STORE_DELETED' });
    ref.deref().reset();
    assert(await collected(ref));
    await assert.rejects(open({ client, name }), { code: 'STORE_NOT_FOUND' });
});

test('an expired list cursor is removed by the cache timer and frees its store and client', async t => {
    const { fixture } = await setup();
    await (await open({ client: fixture.client, name })).write({ at: draft,
        operations: [1, 2, 3].map(n => ({ op: 'create', path: `/file-${n}`, content: '' })) });
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    const held = { client: { ...fixture.client } };
    const client = new WeakRef(held.client);
    let next;
    const ref = await scenario({ client: held.client, name }, async drive => {
        ({ next } = await drive.list({ at: draft, limit: 2 }));
    });
    // Inside the window the dropped drive stays registered and continues its listing.
    t.mock.timers.tick(4 * 60_000);
    assert(!await collected(ref), 'A store with a live list cursor was released.');
    await (async () => {
        const reopened = await open({ client: held.client, name });
        assert.equal(reopened, ref.deref());
        assert.deepEqual((await reopened.list(next)).files.map(file => file.path), ['/file-3']);
    })();
    held.client = undefined;
    assert(!await collected(client), 'The pinned store no longer reached its client.');
    // At expiry the timer removes the scan with no further list call, and nothing
    // in the process-wide cache reaches the store or its client any more.
    const lists = fixture.calls.filter(call => call.kind === 'list').length;
    t.mock.timers.tick(60_000);
    assert(await collected(ref), 'An expired list cursor kept its store.');
    assert(await collected(client), 'An expired list cursor kept its client.');
    assert.equal(fixture.calls.filter(call => call.kind === 'list').length, lists);
});

test('deleting a fork drops its list cursors and releases the store at once', async () => {
    const { connection } = await setup();
    const ref = await scenario(connection, async drive => {
        await drive.write({ at: draft, operations: [1, 2].map(n => ({ op: 'create', path: `/file-${n}`, content: '' })) });
        assert((await drive.list({ at: draft, limit: 1 })).next);
        await drive.deleteFork({ at: draft });
    });
    assert(await collected(ref), 'A deleted fork\'s list cursor kept its store.');
});

test('the list cache timer does not keep a process alive', () => {
    const sdk = new URL('../dist/esm/index.js', import.meta.url).href;
    const helper = new URL('./helpers/file-client.mjs', import.meta.url).href;
    const script = `
        import { create } from ${JSON.stringify(sdk)};
        import { fileClient } from ${JSON.stringify(helper)};
        const drive = await create({ client: fileClient().client, name: 'unref-store' });
        const { at } = await drive.fork({ name: 'draft' });
        await drive.write({ at, operations: [1, 2].map(n => ({ op: 'create', path: '/file-' + n, content: '' })) });
        if (!(await drive.list({ at, limit: 1 })).next) throw new Error('No continuation was cached.');
        console.log('listed');`;
    const started = Date.now();
    // A referenced five-minute timer would hold the child until this timeout kills it.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr || `signal ${result.signal}`);
    assert.equal(result.stdout.trim(), 'listed');
    assert(Date.now() - started < 20_000);
});
