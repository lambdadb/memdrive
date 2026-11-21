import assert from 'node:assert/strict';
import test from 'node:test';
import { MemDrive } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

const name = 'workspace';
const request = requestId => ({ requestId, summary: `Publish ${requestId}` });
const file = (path, content = path) => ({ op: 'create', path, content });
const status = (requestId, version, value = 'published') => ({ requestId, version, status: value });
const withClient = (fixture, options = {}) => ({ client: { ...fixture.client }, name, ...options });
const journalMutation = call => call.kind === 'upsert' && call.request.docs[0].kind.startsWith('merge-');
const dbRejection = () => Object.assign(new Error('Rejected before dispatch'), { statusCode: 400 });
function gate() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function setup() {
    const fixture = fileClient();
    const main = await MemDrive.create({ client: fixture.client, name });
    return { fixture, main };
}

test('public merges publish to main and keep a started list, old checkpoints, and forks on their selected versions', async () => {
    const { fixture, main } = await setup();
    const work = await main.fork({ name: 'research' });
    const [one, two] = await work.write([file('/one'), file('/two')]);
    assert.equal('merge' in main, false);
    assert.deepEqual(await work.merge(request('first')), status('first', 'v1'));
    assert.deepEqual(await work.diff(), []);
    const old = await main.checkpoint({ name: 'before-update' });
    const priorFork = await main.fork({ name: 'old-fork' });
    const page = await main.list({ limit: 1 });
    assert.deepEqual(page.files.map(({ fileId }) => fileId), [one.fileId]);
    assert(page.cursor);

    await work.write([{ op: 'delete', fileId: two.fileId }, { op: 'update', fileId: one.fileId, newPath: '/moved' }, file('/new')]);
    assert.deepEqual(await work.merge(request('second')), status('second', 'v2'));
    assert.deepEqual(await work.diff(), []);
    assert.deepEqual((await main.list({ cursor: page.cursor })).files.map(({ fileId }) => fileId), [two.fileId]);

    const reopened = await MemDrive.open(withClient(fixture));
    assert.equal((await reopened.read({ fileId: one.fileId })).path, '/moved');
    assert.equal(await reopened.read({ path: '/two' }), null);
    assert.deepEqual((await reopened.list()).files.map(({ path }) => path), ['/moved', '/new']);
    assert.equal((await reopened.search({ query: '/one', rerank: false })).hits.find(hit => hit.fileId === one.fileId)?.path, '/moved');
    assert.equal((await old.read({ fileId: one.fileId })).path, '/one');
    assert.deepEqual(await priorFork.read({ fileId: two.fileId }), two);
    assert.equal('merge' in old, false);
    const count = fixture.calls.filter(journalMutation).length;
    const replay = await MemDrive.open(withClient(fixture, { at: { fork: 'research' } }));
    assert.deepEqual(await replay.merge(request('first')), status('first', 'v1'));
    assert.equal(fixture.calls.filter(journalMutation).length, count);
    await assert.rejects(replay.merge({ ...request('first'), summary: 'Different input' }), { code: 'MERGE_REQUEST_CONFLICT' });
});

test('a partial physical merge preserves all public main views and replays frozen files while the fork keeps later edits', async () => {
    const { fixture, main } = await setup();
    const work = await main.fork({ name: 'research' });
    const alternate = await main.fork({ name: 'alternate' });
    const [one, two] = await work.write([file('/one'), file('/two')]);
    await work.merge(request('first'));
    await alternate.write(file('/alternate'));
    await work.write([ { op: 'update', fileId: one.fileId, content: 'draft one' },
        { op: 'update', fileId: two.fileId, content: 'draft two' } ]);
    const physical = fixture.collections.get(name).branches.get('main').docs;
    let failed = false;
    fixture.beforeUpsert = ({ branch, docs }) => {
        if (branch === 'main' && docs.some(doc => doc.kind === 'file')
            && [one, two].some(file => physical.get(`file:${file.fileId}`).body !== file.content)) {
            failed = true;
            throw dbRejection();
        }
    };
    await assert.rejects(work.merge(request('second')), { code: 'MERGE_RESUMABLE' });
    assert(failed, 'A native original already changed before the injected failure.');
    const observer = await MemDrive.open(withClient(fixture));
    assert.deepEqual(await observer.read({ paths: ['/one', '/two'] }), [one, two]);
    assert.deepEqual((await observer.list()).files.map(({ path }) => path), ['/one', '/two']);
    assert.deepEqual((await observer.search({ query: 'draft', rerank: false })).hits.map(({ content }) => content).sort(), ['/one', '/two']);
    const old = await observer.checkpoint({ name: 'mid-merge' });
    const pinnedFork = await observer.fork({ name: 'mid-merge' });
    assert.deepEqual(await old.read({ fileId: one.fileId }), one);
    assert.deepEqual(await pinnedFork.read({ fileId: two.fileId }), two);
    const count = fixture.calls.filter(journalMutation).length;
    await assert.rejects(alternate.merge(request('third')), { code: 'MERGE_BLOCKED', details: { requestId: 'second' } });
    await alternate.diff();
    assert.equal(fixture.calls.filter(journalMutation).length, count);

    fixture.beforeUpsert = undefined;
    await work.write({ op: 'update', fileId: one.fileId, content: 'postcapture edit' });
    assert.deepEqual(await work.merge(request('second')), status('second', 'v2'));
    assert.equal((await observer.read({ fileId: one.fileId })).content, 'draft one');
    assert.equal((await work.read({ fileId: one.fileId })).content, 'postcapture edit');
    assert.deepEqual(await work.diff(), [{ op: 'update', fileId: one.fileId, path: one.path }]);
    assert.deepEqual(await alternate.merge(request('third')), status('third', 'v3'));
    assert.equal(await alternate.read({ fileId: one.fileId }), null);
});

test('healthy queued merges check current main and terminal conflict and empty captures replay unchanged', async () => {
    const { fixture, main } = await setup();
    const left = await main.fork({ name: 'left' });
    const right = await main.fork({ name: 'right' });
    assert.deepEqual(await left.merge(request('empty')), status('empty', 'v0', 'unchanged'));
    const [alpha] = await left.write([file('/alpha'), file('/same', 'left')]);
    await right.write(file('/same', 'right'));
    const results = await Promise.allSettled([left.merge(request('left')), right.merge(request('conflict'))]);
    assert.deepEqual(results[0], { status: 'fulfilled', value: status('left', 'v2') });
    assert.equal(results[1].reason.code, 'MERGE_CONFLICT');
    assert.deepEqual(results[1].reason.details.paths, ['/same']);
    assert.deepEqual(await left.merge(request('empty')), status('empty', 'v0', 'unchanged'));
    const independent = await main.fork({ name: 'fresh' });
    await left.write({ op: 'update', fileId: alpha.fileId, content: 'later' });
    await independent.write(file('/independent'));
    const updates = await Promise.all([
        left.merge(request('next')), left.merge(request('repeat')), independent.merge(request('independent')),
    ]);
    assert.deepEqual(updates, [status('next', 'v4'), status('repeat', 'v4', 'unchanged'), status('independent', 'v6')]);

    const reopened = await MemDrive.open(withClient(fixture, { at: { fork: 'right' } }));
    await assert.rejects(reopened.merge(request('conflict')), { code: 'MERGE_CONFLICT',
        details: { requestId: 'conflict', fileIds: [], paths: ['/same'] } });
    await assert.rejects(reopened.merge(request('next')), { code: 'MERGE_REQUEST_CONFLICT' });
});

test('unknown mutable writes fence the runtime and an exclusive drained owner can resume from the journal', async () => {
    const { fixture, main } = await setup();
    const work = await main.fork({ name: 'research' });
    const saved = await work.write(file('/captured'));
    const dispatched = gate(), complete = gate();
    let didLose = false;
    fixture.afterUpsert = async ({ branch, docs }) => {
        if (!didLose && branch === 'main' && docs.some(doc => doc.kind === 'file')) {
            didLose = true;
            dispatched.resolve();
            await complete.promise;
            throw new Error('The accepted response was lost');
        }
    };
    const pending = work.merge(request('uncertain'));
    const rejected = assert.rejects(pending, { code: 'MERGE_BLOCKED' });
    await dispatched.promise;
    const observer = await MemDrive.open(withClient(fixture));
    assert.equal(await observer.read({ fileId: saved.fileId }), null);
    complete.resolve();
    await rejected;
    await assert.rejects(work.merge(request('uncertain')), { code: 'MERGE_BLOCKED' });
    await assert.rejects(MemDrive.open({ client: fixture.client, name, recover: true }), { code: 'MERGE_BLOCKED' });
    assert.equal(await observer.read({ fileId: saved.fileId }), null);

    const owner = { ...fixture.client };
    fixture.afterUpsert = ({ docs }) => {
        if (docs[0].kind === 'merge-result-v1') throw new Error('The terminal record response was lost');
    };
    const recovered = await MemDrive.open({ client: owner, name, recover: true });
    assert.deepEqual(await recovered.read({ fileId: saved.fileId }), saved);
    assert.deepEqual(await observer.read({ fileId: saved.fileId }), saved);
    const writer = await MemDrive.open({ client: owner, name, at: { fork: 'research' } });
    assert.deepEqual(await writer.merge(request('uncertain')), status('uncertain', 'v1'));
});

test('a read-only legacy store safely rechecks main if an upgrade and publication race its read', async () => {
    const fixture = fileClient();
    await MemDrive.create({ client: fixture.client, name });
    const legacy = fixture.collections.get(name);
    legacy.branches.delete('md-main-v0');
    const observer = await MemDrive.open(withClient(fixture));
    assert.deepEqual(await observer.list(), { files: [], prefixes: [], consistency: 'eventual' });
    assert(!legacy.branches.has('md-main-v0'));

    const oldRead = gate(), release = gate();
    let pause = true;
    fixture.beforeFetch = async ({ ref, ids }) => {
        if (pause && ref.name === 'main' && !ids[0].startsWith('reservation:')) {
            pause = false;
            oldRead.resolve();
            await release.promise;
            return { isDocsInline: true, total: 0, docs: [] };
        }
    };
    await fixture.client.collection(name).branches.create({ branchName: 'fork-research', source: { kind: 'branch', name: 'main' } });
    const work = await MemDrive.open(withClient(fixture, { at: { fork: 'research' } }));
    const saved = await work.write(file('/legacy-update'));
    const read = observer.read({ fileId: saved.fileId });
    await oldRead.promise;
    // Recreate the frozen initial reference with a different owner runtime
    // before physically applying the first merge.
    const takeover = { ...fixture.client };
    await MemDrive.open({ client: takeover, name, recover: true });
    const fork = await MemDrive.open({ client: takeover, name, at: { fork: 'research' } });
    await fork.merge(request('legacy'));
    release.resolve();
    assert.deepEqual(await read, saved);
});

test('known cold tag rejections retry inside the public call while preserving the captured working state', async () => {
    const { fixture, main } = await setup();
    const work = await main.fork({ name: 'research' });
    const original = await work.write(file('/original'));
    const observed = gate();
    let rejectedSource = false, rejectedTarget = false;
    fixture.beforeTagCreate = tag => {
        if (tag.startsWith('merge-capture-') && !rejectedSource) {
            rejectedSource = true;
            observed.resolve();
            throw dbRejection();
        }
        if (tag === 'md-main-v1' && !rejectedTarget) {
            rejectedTarget = true;
            throw dbRejection();
        }
    };
    const publication = work.merge(request('cold'), { signal: AbortSignal.timeout(10_000) });
    await observed.promise;
    const later = work.write(file('/later'));
    assert.deepEqual(await publication, status('cold', 'v1'));
    await later;
    assert(rejectedTarget);
    assert.deepEqual(await main.read({ fileId: original.fileId }), original);
    assert.equal(await main.read({ path: '/later' }), null);
    assert.deepEqual((await work.diff()).map(({ path }) => path), ['/later']);
    assert.equal(fixture.calls.filter(call => call.kind === 'upsert' && call.collection === name
        && call.request.branch === 'main').length, 1);
});
