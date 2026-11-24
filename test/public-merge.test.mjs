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

/** Test shorthand that forwards one explicit at with every view request. */
function scoped(drive, at) {
    return {
        at,
        write: input => drive.write(Array.isArray(input) ? { at, operations: input } : { at, ...input }),
        read: input => drive.read({ at, ...input }),
        list: (input = {}) => drive.list({ at, ...input }),
        search: input => drive.search({ at, ...input }),
        status: () => drive.status({ at }),
        diff: () => drive.diff({ at }),
        merge: (input, options) => drive.merge({ at, ...input }, options),
    };
}
async function fork(drive, request) {
    return scoped(drive, (await drive.fork(request)).at);
}
async function checkpoint(drive, request) {
    return scoped(drive, (await drive.checkpoint(request)).at);
}
const forkAt = forkName => ({ kind: 'fork', name: forkName });

async function setup() {
    const fixture = fileClient();
    const main = await MemDrive.create({ client: fixture.client, name });
    return { fixture, main };
}

test('public merges publish to main and keep a started list, old checkpoints, and forks on their selected versions', async () => {
    const { fixture, main } = await setup();
    const work = await fork(main, { name: 'research' });
    const [one, two] = await work.write([file('/one'), file('/two')]);
    for (const at of [undefined, { kind: 'main' }, { kind: 'checkpoint', name: 'research' }])
        await assert.rejects(main.merge({ at, ...request('first') }), { code: 'INVALID_INPUT' });
    assert.deepEqual(await work.merge(request('first')), status('first', 'v1'));
    assert.deepEqual(await work.diff(), []);
    const old = await checkpoint(main, { name: 'before-update' });
    const priorFork = await fork(main, { name: 'old-fork' });
    const page = await main.list({ limit: 1 });
    assert.deepEqual(page.files.map(({ fileId }) => fileId), [one.fileId]);
    assert.deepEqual(page.next.at, { kind: 'main' });

    await work.write([{ op: 'delete', fileId: two.fileId }, { op: 'update', fileId: one.fileId, newPath: '/moved' }, file('/new')]);
    assert.deepEqual(await work.merge(request('second')), status('second', 'v2'));
    assert.deepEqual(await work.diff(), []);
    assert.deepEqual((await main.list(page.next)).files.map(({ fileId }) => fileId), [two.fileId]);
    // merge publishes only; the fork stays available for later work.
    assert.deepEqual((await main.listForks()).forks.map(({ at }) => at), [forkAt('old-fork'), forkAt('research')]);
    assert.deepEqual((await work.status()).at, work.at);

    const reopened = await MemDrive.open(withClient(fixture));
    assert.equal((await reopened.read({ fileId: one.fileId })).path, '/moved');
    assert.equal(await reopened.read({ path: '/two' }), null);
    assert.deepEqual((await reopened.list()).files.map(({ path }) => path), ['/moved', '/new']);
    assert.equal((await reopened.search({ query: '/one', rerank: false })).hits.find(hit => hit.fileId === one.fileId)?.path, '/moved');
    assert.equal((await old.read({ fileId: one.fileId })).path, '/one');
    assert.deepEqual(await priorFork.read({ fileId: two.fileId }), two);
    await assert.rejects(main.merge({ at: old.at, ...request('first') }), { code: 'INVALID_INPUT' });
    const count = fixture.calls.filter(journalMutation).length;
    const replay = scoped(await MemDrive.open(withClient(fixture)), work.at);
    assert.deepEqual(await replay.merge(request('first')), status('first', 'v1'));
    assert.equal(fixture.calls.filter(journalMutation).length, count);
    await assert.rejects(replay.merge({ ...request('first'), summary: 'Different input' }), { code: 'MERGE_REQUEST_CONFLICT' });
});

test('a partial physical merge preserves all public main views and replays the held fork, which takes edits again once it settles', async () => {
    const { fixture, main } = await setup();
    const work = await fork(main, { name: 'research' });
    const alternate = await fork(main, { name: 'alternate' });
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
    const beforeStatus = fixture.calls.length;
    assert.deepEqual(await observer.status(),
        { at: { kind: 'main' }, mainVersion: 'v1', merge: { requestId: 'second', phase: 'publication' } });
    assert.equal((await observer.history()).throughVersion, 'v1');
    assert(fixture.calls.slice(beforeStatus).every(({ kind }) => ['fetch', 'query'].includes(kind)));
    assert.deepEqual(await observer.read({ paths: ['/one', '/two'] }), [one, two]);
    assert.deepEqual((await observer.list()).files.map(({ path }) => path), ['/one', '/two']);
    assert.deepEqual((await observer.search({ query: 'draft', rerank: false })).hits.map(({ content }) => content).sort(), ['/one', '/two']);
    const old = await checkpoint(observer, { name: 'mid-merge' });
    const pinnedFork = await fork(observer, { name: 'mid-merge' });
    assert.deepEqual(await old.read({ fileId: one.fileId }), one);
    assert.deepEqual(await pinnedFork.read({ fileId: two.fileId }), two);
    const count = fixture.calls.filter(journalMutation).length;
    await assert.rejects(alternate.merge(request('third')), { code: 'MERGE_BLOCKED', details: { requestId: 'second' } });
    await alternate.diff();
    assert.equal(fixture.calls.filter(journalMutation).length, count);

    fixture.beforeUpsert = undefined;
    // The unfinished merge holds its fork still; the blocked fork is not held.
    await assert.rejects(work.write({ op: 'update', fileId: one.fileId, content: 'edit during the merge' }),
        { code: 'MERGE_BLOCKED', details: { requestId: 'second' } });
    await alternate.write(file('/alternate-later'));
    assert.deepEqual(await work.merge(request('second')), status('second', 'v2'));
    assert.equal((await observer.read({ fileId: one.fileId })).content, 'draft one');
    assert.deepEqual(await work.diff(), []);
    await work.write({ op: 'update', fileId: one.fileId, content: 'later edit' });
    assert.equal((await observer.read({ fileId: one.fileId })).content, 'draft one');
    assert.equal((await work.read({ fileId: one.fileId })).content, 'later edit');
    assert.deepEqual(await work.diff(), [{ op: 'update', fileId: one.fileId, path: one.path }]);
    assert.deepEqual(await alternate.merge(request('third')), status('third', 'v3'));
    assert.equal(await alternate.read({ fileId: one.fileId }), null);
});

test('healthy queued merges check current main and terminal conflict and unchanged outcomes replay unchanged', async () => {
    const { fixture, main } = await setup();
    const left = await fork(main, { name: 'left' });
    const right = await fork(main, { name: 'right' });
    assert.deepEqual(await left.merge(request('empty')), status('empty', 'v0', 'unchanged'));
    const [alpha] = await left.write([file('/alpha'), file('/same', 'left')]);
    await right.write(file('/same', 'right'));
    const results = await Promise.allSettled([left.merge(request('left')), right.merge(request('conflict'))]);
    assert.deepEqual(results[0], { status: 'fulfilled', value: status('left', 'v2') });
    assert.equal(results[1].reason.code, 'MERGE_CONFLICT');
    assert.deepEqual(results[1].reason.details.paths, ['/same']);
    assert.deepEqual(await left.merge(request('empty')), status('empty', 'v0', 'unchanged'));
    const independent = await fork(main, { name: 'fresh' });
    await left.write({ op: 'update', fileId: alpha.fileId, content: 'later' });
    await independent.write(file('/independent'));
    const updates = await Promise.all([
        left.merge(request('next')), left.merge(request('repeat')), independent.merge(request('independent')),
    ]);
    // A second merge of the same fork waits for the first, so the other fork's merge is reserved before it.
    assert.deepEqual(updates, [status('next', 'v4'), status('repeat', 'v5', 'unchanged'), status('independent', 'v5')]);

    const reopened = scoped(await MemDrive.open(withClient(fixture)), right.at);
    await assert.rejects(reopened.merge(request('conflict')), { code: 'MERGE_CONFLICT',
        details: { requestId: 'conflict', fileIds: [], paths: ['/same'] } });
    await assert.rejects(reopened.merge(request('next')), { code: 'MERGE_REQUEST_CONFLICT' });
});

test('unknown mutable writes fence the runtime and an exclusive drained owner can resume from the journal', async () => {
    const { fixture, main } = await setup();
    const work = await fork(main, { name: 'research' });
    const saved = await work.write(file('/published'));
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
    await assert.rejects(work.write(file('/during')), { code: 'MERGE_BLOCKED', details: { requestId: 'uncertain' } });
    assert.equal(await observer.read({ fileId: saved.fileId }), null);

    const owner = { ...fixture.client };
    fixture.afterUpsert = ({ docs }) => {
        if (docs[0].kind === 'merge-result-v1') throw new Error('The terminal record response was lost');
    };
    const recovered = await MemDrive.open({ client: owner, name, recover: true });
    assert.deepEqual(await recovered.read({ fileId: saved.fileId }), saved);
    assert.deepEqual(await observer.read({ fileId: saved.fileId }), saved);
    assert.equal(await MemDrive.open({ client: owner, name }), recovered);
    const writer = scoped(recovered, work.at);
    assert.deepEqual(await writer.merge(request('uncertain')), status('uncertain', 'v1'));
    // The replacement owner writes again. The fenced runtime never does: its mutation may still land.
    await writer.write(file('/after'));
    await assert.rejects(work.write(file('/during')), { code: 'MERGE_BLOCKED', details: { requestId: 'uncertain' } });
});

test('a reader of a store whose creation left v0 unpinned safely rechecks main if a publication races its read', async () => {
    const fixture = fileClient();
    fixture.beforeBranchCreate = () => { throw Object.assign(new Error('Unavailable'), { statusCode: 503 }); };
    await assert.rejects(MemDrive.create({ client: fixture.client, name }), { code: 'MAIN_BOOTSTRAP_UNCONFIRMED' });
    fixture.beforeBranchCreate = undefined;
    const state = fixture.collections.get(name);
    const observer = await MemDrive.open(withClient(fixture));
    assert.deepEqual(await observer.status(), { at: { kind: 'main' }, mainVersion: 'v0' });
    assert.deepEqual(await observer.history(), { entries: [], throughVersion: 'v0' });
    assert.deepEqual(await observer.list(), { files: [], prefixes: [], consistency: 'eventual' });
    // The unpinned main is empty, so its live scan ends without a cursor.
    assert.deepEqual(await observer.findText({ query: 'update' }), { hits: [], consistency: 'live' });
    assert(!state.branches.has('md-main-v0'));

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
    const work = scoped(await MemDrive.open(withClient(fixture)), forkAt('research'));
    const saved = await work.write(file('/first-update'));
    const read = observer.read({ fileId: saved.fileId });
    await oldRead.promise;
    // Pin the frozen initial reference with a different owner runtime
    // before physically applying the first merge.
    const takeover = { ...fixture.client };
    await MemDrive.open({ client: takeover, name, recover: true });
    const owner = await MemDrive.open({ client: takeover, name });
    await owner.merge({ at: forkAt('research'), ...request('first') });
    release.resolve();
    assert.deepEqual(await read, saved);
});

test('main history reports each publication\'s affected files, omits version gaps, and pins pagination across views', async t => {
    const { fixture, main } = await setup();
    const work = await fork(main, { name: 'history' });
    const first = await work.write(file('/first'));
    await work.merge(request('first'));
    const old = await checkpoint(main, { name: 'original' });
    await work.merge(request('unchanged'));
    const second = await work.write(file('/second'));
    await work.write({ op: 'delete', fileId: first.fileId });
    await work.merge(request('third'));
    const beforeReads = fixture.calls.length;
    const page = await main.history({ limit: 1, sinceVersion: 'v0' });
    assert.deepEqual(Object.keys(page.next), ['cursor']);
    assert.equal(page.throughVersion, 'v3');
    const [entry] = page.entries;
    assert.equal(new Date(entry.publishedAt).toISOString(), entry.publishedAt);
    assert.deepEqual(entry, { version: 'v1', publishedAt: entry.publishedAt, summary: 'Publish first',
        fileIds: [first.fileId], fileIdsTruncated: false });
    assert.deepEqual(await old.status(), { at: { kind: 'checkpoint', name: 'original' }, mainVersion: 'v3' });
    assert.deepEqual(await work.status(), { at: { kind: 'fork', name: 'history' }, mainVersion: 'v3' });
    assert(fixture.calls.slice(beforeReads).every(({ kind, request }) => kind === 'fetch' && !request.includeVectors
        || kind === 'query' && !request.includeVectors && !request.fields.include.includes('body')));

    await work.write(file('/fourth'));
    await work.merge(request('fourth'));
    const tail = await main.history(page.next);
    assert.equal(tail.throughVersion, 'v3');
    assert.equal(tail.next, undefined);
    assert.deepEqual(tail.entries.map(item => [item.version, item.fileIds]), [['v3', [first.fileId, second.fileId].sort()]]);
    assert.deepEqual(await main.history(page.next), tail);
    await assert.rejects(main.history({ ...page.next, at: work.at }), { code: 'INVALID_INPUT' });
    const reopened = await MemDrive.open(withClient(fixture));
    assert.deepEqual((await reopened.history({ limit: 1 })).entries, page.entries);
    assert.deepEqual((await reopened.history({ sinceVersion: 'v1' })).entries.map(({ version }) => version), ['v3', 'v4']);
    assert.deepEqual(await reopened.history({ sinceVersion: 'v4' }), { throughVersion: 'v4', entries: [] });
    // Stateless cursors continue on a fresh client of the same store.
    assert.deepEqual(await reopened.history(page.next), tail);
    const state = JSON.parse(Buffer.from(page.next.cursor.slice(3), 'base64url').toString());
    assert.deepEqual(Object.keys(state).sort(), ['d', 'l', 's', 't']);
    const token = value => `h1.${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
    for (const cursor of ['h1.', 'h1.@', `x1.${page.next.cursor.slice(3)}`, token([]), token({ ...state, d: 'other-store' }),
        token({ ...state, s: 'v2' }), token({ ...state, t: 'v9' }), token({ ...state, s: 'v01' }), token({ ...state, l: 0 }),
        token({ ...state, l: 101 }), token({ ...state, s: 'v4', t: 'v3' }), token({ ...state, extra: 1 })])
        await assert.rejects(reopened.history({ cursor }), { code: 'HISTORY_CURSOR_UNAVAILABLE' }, cursor);
    for (const sinceVersion of ['v2', 'v5'])
        await assert.rejects(reopened.history({ sinceVersion }), { code: 'VERSION_NOT_FOUND', details: { version: sinceVersion } });
    await assert.rejects(reopened.history({ sinceVersion: 'v01' }), { code: 'INVALID_INPUT' });
    await assert.rejects(reopened.history({ limit: 0 }), { code: 'INVALID_INPUT' });
    await assert.rejects(reopened.history({ ...page.next, limit: 1 }), { code: 'INVALID_INPUT' });
    await assert.rejects(reopened.history({}, { signal: AbortSignal.abort() }), { code: 'ABORTED' });

    // History cursors do not expire in SDK memory.
    const later = Date.now() + 60 * 60 * 1000;
    const clock = t.mock.method(Date, 'now', () => later);
    try {
        assert.deepEqual(await main.history(page.next), tail);
    } finally {
        clock.mock.restore();
    }

    // Merges leave only main version tags beside the user's checkpoint.
    assert.deepEqual([...fixture.collections.get(name).tags.keys()].sort(), ['checkpoint-original', 'md-main-v1', 'md-main-v3', 'md-main-v4']);
});

test('history caps affected IDs and reads a published completion while bookkeeping is running', async () => {
    const { fixture, main } = await setup();
    const work = await fork(main, { name: 'big-merge' });
    const files = await work.write(Array.from({ length: 100 }, (_, i) => file(`/entry-${i}`, '')));
    files.push(await work.write(file('/last', '')));
    const started = gate(), release = gate();
    fixture.beforeUpsert = async ({ docs }) => {
        if (docs[0].kind === 'merge-bookkeeping-v1') {
            started.resolve();
            await release.promise;
        }
    };
    const merged = work.merge(request('many'));
    await Promise.race([started.promise, merged]);
    try {
        const reader = await MemDrive.open(withClient(fixture));
        assert.deepEqual(await reader.status(),
            { at: { kind: 'main' }, mainVersion: 'v1', merge: { requestId: 'many', phase: 'bookkeeping' } });
        const page = await reader.history();
        assert.deepEqual(page.entries[0].fileIds, files.map(({ fileId }) => fileId).sort().slice(0, 100));
        assert.equal(page.entries[0].fileIdsTruncated, true);
    } finally {
        release.resolve();
        await merged;
    }
    assert.deepEqual(await main.status(), { at: { kind: 'main' }, mainVersion: 'v1' });
});

test('a known cold target tag rejection retries inside the public call while a queued write waits for the merge', async () => {
    const { fixture, main } = await setup();
    const work = await fork(main, { name: 'research' });
    const original = await work.write(file('/original'));
    const observed = gate();
    let rejectedTarget = false;
    fixture.beforeTagCreate = tag => {
        if (tag === 'md-main-v1' && !rejectedTarget) {
            rejectedTarget = true;
            observed.resolve();
            throw dbRejection();
        }
    };
    const publication = work.merge(request('cold'), { signal: AbortSignal.timeout(10_000) });
    await observed.promise;
    let written = false;
    const later = work.write(file('/later')).then(() => { written = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(written, false);
    assert.deepEqual(await publication, status('cold', 'v1'));
    await later;
    assert.deepEqual(await main.read({ fileId: original.fileId }), original);
    assert.equal(await main.read({ path: '/later' }), null);
    assert.deepEqual((await work.diff()).map(({ path }) => path), ['/later']);
    assert.equal(fixture.calls.filter(call => call.kind === 'upsert' && call.collection === name
        && call.request.branch === 'main').length, 1);
    // The merge pins nothing but its target version.
    assert.deepEqual(fixture.calls.filter(call => call.kind === 'tag-create').map(call => call.request.tagName), ['md-main-v1', 'md-main-v1']);
});

test('a second merge of a fork and later edits wait for its running merge, each publishing what preceded it', async () => {
    const { fixture, main } = await setup();
    const work = await fork(main, { name: 'research' });
    const saved = await work.write(file('/versioned', 'first'));
    const applying = gate(), resume = gate();
    fixture.beforeUpsert = async ({ branch, docs }) => {
        if (branch === 'main' && docs.some(doc => doc.kind === 'file' && doc.body === 'first')) {
            applying.resolve();
            await resume.promise;
        }
    };
    const first = work.merge(request('first'));
    await applying.promise;
    const edit = work.write({ op: 'update', fileId: saved.fileId, content: 'second' });
    const second = work.merge(request('second'));
    const later = work.write({ op: 'update', fileId: saved.fileId, content: 'third' });
    resume.resolve();
    assert.deepEqual(await Promise.all([first, second]), [status('first', 'v1'), status('second', 'v2')]);
    await Promise.all([edit, later]);
    assert.equal((await main.read({ fileId: saved.fileId })).content, 'second');
    assert.equal((await work.read({ fileId: saved.fileId })).content, 'third');
    assert.deepEqual(await work.diff(), [{ op: 'update', fileId: saved.fileId, path: saved.path }]);
    const { at } = await main.fork({ name: 'first-version', version: 'v1' });
    assert.equal((await main.read({ at, fileId: saved.fileId })).content, 'first');
});

test('a temporarily unconfirmed bookkeeping record can settle without blocking subsequent publication', async () => {
    const { fixture, main } = await setup();
    const work = await fork(main, { name: 'research' });
    await work.write(file('/first'));
    let hideBookkeeping = false;
    fixture.afterUpsert = ({ docs }) => {
        if (docs[0].kind === 'merge-bookkeeping-v1' && docs[0].id === 'bookkeeping:1') {
            hideBookkeeping = true;
            throw new Error('Lost bookkeeping response');
        }
    };
    fixture.beforeFetch = ({ ids, ref }) => {
        if (hideBookkeeping && ref.name === 'main' && ids[0] === 'bookkeeping:1') {
            hideBookkeeping = false;
            return { isDocsInline: true, total: 0, docs: [] };
        }
    };
    await assert.rejects(work.merge(request('first')), { code: 'MERGE_RESUMABLE',
        details: { requestId: 'first', publishedVersion: 'v1' } });
    assert.equal((await main.read({ path: '/first' })).content, '/first');
    await work.write(file('/second'));
    assert.deepEqual(await work.merge(request('second')), status('second', 'v2'));
    assert.deepEqual(await work.merge(request('first')), status('first', 'v1'));
});
