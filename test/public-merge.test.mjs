import assert from 'node:assert/strict';
import test from 'node:test';
import { MemDrive } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

const name = 'workspace';
const request = label => ({ summary: `Publish ${label}` });
const file = (path, content = path) => ({ op: 'create', path, content });
const status = (version, value = 'published') => ({ status: value, version });
const withClient = (fixture, options = {}) => ({ client: { ...fixture.client }, name, ...options });
const journalMutation = call => call.kind === 'upsert' && call.request.docs[0].kind === 'publication-v1';
const mainMutation = call => ['upsert', 'update', 'delete'].includes(call.kind) && call.collection === name && call.request.branch === 'main'
    || call.kind === 'tag-create' || call.kind === 'branch-rollback';
const rollbacks = (fixture, from = 0) => fixture.calls.slice(from).filter(call => call.kind === 'branch-rollback').map(call => call.tag);
const dbRejection = () => Object.assign(new Error('Rejected before dispatch'), { statusCode: 400 });
const mainDocs = fixture => [...fixture.collections.get(name).branches.get('main').docs.entries()].sort();
const tagDocs = (fixture, tag) => [...fixture.collections.get(name).tags.get(tag).docs.entries()].sort();
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
    // A merge has no request identity.
    await assert.rejects(work.merge({ requestId: 'first', ...request('first') }), { code: 'INVALID_INPUT' });
    assert.deepEqual(await work.merge(request('first')), status('v1'));
    assert.deepEqual(await work.diff(), []);
    const old = await checkpoint(main, { name: 'before-update' });
    const priorFork = await fork(main, { name: 'old-fork' });
    const page = await main.list({ limit: 1 });
    assert.deepEqual(page.files.map(({ fileId }) => fileId), [one.fileId]);
    assert.deepEqual(page.next.at, { kind: 'main' });

    await work.write([{ op: 'delete', fileId: two.fileId }, { op: 'update', fileId: one.fileId, newPath: '/moved' }, file('/new')]);
    assert.deepEqual(await work.merge(request('second')), status('v2'));
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
    // Merging the published fork again, from any client, changes nothing on main.
    const replay = scoped(await MemDrive.open(withClient(fixture)), work.at);
    const before = fixture.calls.length;
    assert.deepEqual(await replay.merge(request('again')), status('v2', 'unchanged'));
    assert.deepEqual(fixture.calls.slice(before).filter(mainMutation), []);
    assert.equal(fixture.calls.slice(before).filter(journalMutation).length, 0);
    assert.deepEqual(await work.merge(request('again')), status('v2', 'unchanged'));
    assert.deepEqual(mainDocs(fixture), tagDocs(fixture, 'md-main-v2'));
    // Drive objects of a store in one process share what main holds, so another client's merge does not roll it back.
    await replay.write(file('/third'));
    const next = fixture.calls.length;
    assert.deepEqual(await replay.merge(request('third')), status('v3'));
    assert.deepEqual(rollbacks(fixture, next), []);
});

test('a failed merge after main writes rolls main back, keeps the fork, and the fork can be merged again', async () => {
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
    const forkBefore = structuredClone([...fixture.collections.get(name).branches.get('fork-research').docs]);
    const before = fixture.calls.length;
    await assert.rejects(work.merge(request('second')), { code: 'DATABASE_ERROR', status: 400 });
    assert(failed, 'A native original already changed before the injected failure.');
    fixture.beforeUpsert = undefined;
    // Main holds the published version again; the fork keeps its edits.
    assert.deepEqual(rollbacks(fixture, before), ['md-main-v1']);
    assert.deepEqual(mainDocs(fixture), tagDocs(fixture, 'md-main-v1'));
    assert.deepEqual([...fixture.collections.get(name).branches.get('fork-research').docs], forkBefore);
    const observer = await MemDrive.open(withClient(fixture));
    assert.deepEqual(await observer.status(), { at: { kind: 'main' }, mainVersion: 'v1' });
    assert.equal((await observer.history()).throughVersion, 'v1');
    assert.deepEqual(await observer.read({ paths: ['/one', '/two'] }), [one, two]);
    assert.deepEqual((await observer.list()).files.map(({ path }) => path), ['/one', '/two']);
    assert.deepEqual((await observer.search({ query: 'draft', rerank: false })).hits.map(({ content }) => content).sort(), ['/one', '/two']);
    assert.equal(fixture.calls.slice(before).filter(journalMutation).length, 0);

    // Nothing is held: another fork publishes, and the failed fork takes edits and merges again.
    assert.deepEqual(await alternate.merge(request('alternate')), status('v2'));
    await work.write(file('/three'));
    assert.deepEqual(await work.merge(request('second')), status('v3'));
    assert.equal((await observer.read({ fileId: one.fileId })).content, 'draft one');
    assert.equal((await observer.read({ path: '/alternate' })).content, '/alternate');
    assert.deepEqual(await work.diff(), []);
    assert.deepEqual(mainDocs(fixture), tagDocs(fixture, 'md-main-v3'));
});

test('main rollback retries only the definite rejection of a tag whose snapshot is not yet published', async () => {
    for (const message of ['Rollback requires a tag with a published snapshot', 'Some other rejection']) {
        const { fixture, main } = await setup();
        const work = await fork(main, { name: 'research' });
        const saved = await work.write(file('/one'));
        await work.merge(request('first'));
        await work.write({ op: 'update', fileId: saved.fileId, content: 'two' });
        const retried = message.includes('published snapshot');
        let rejections = 0;
        fixture.beforeTagCreate = tag => { if (tag === 'md-main-v2') throw Object.assign(new Error('Forbidden'), { statusCode: 403 }); };
        fixture.beforeRollback = () => {
            if (rejections++ < (retried ? 2 : 1)) throw Object.assign(new Error(message), { statusCode: 400 });
        };
        const before = fixture.calls.length;
        await assert.rejects(work.merge(request('second')), { code: 'DATABASE_ERROR', status: 403 }, message);
        assert.equal(rollbacks(fixture, before).length, retried ? 3 : 1, message);
        assert.equal(mainDocs(fixture).some(([, doc]) => doc.body === 'two'), !retried, message);
        fixture.beforeTagCreate = undefined;
        // Main may still hold the failed writes, so the next merge restores it first.
        const next = fixture.calls.length;
        assert.deepEqual(await work.merge(request('second')), status('v2'), message);
        assert.deepEqual(rollbacks(fixture, next), retried ? [] : ['md-main-v1'], message);
        assert.equal((await main.read({ fileId: saved.fileId })).content, 'two', message);
    }
});

test('healthy queued merges check current main and terminal conflict and unchanged outcomes replay unchanged', async () => {
    const { fixture, main } = await setup();
    const left = await fork(main, { name: 'left' });
    const right = await fork(main, { name: 'right' });
    assert.deepEqual(await left.merge(request('empty')), status('v0', 'unchanged'));
    const [alpha] = await left.write([file('/alpha'), file('/same', 'left')]);
    await right.write(file('/same', 'right'));
    const results = await Promise.allSettled([left.merge(request('left')), right.merge(request('conflict'))]);
    // Only publications take version numbers.
    assert.deepEqual(results[0], { status: 'fulfilled', value: status('v1') });
    assert.equal(results[1].reason.code, 'MERGE_CONFLICT');
    assert.deepEqual(results[1].reason.details.paths, ['/same']);
    assert.deepEqual(await left.merge(request('empty')), status('v1', 'unchanged'));
    const independent = await fork(main, { name: 'fresh' });
    await left.write({ op: 'update', fileId: alpha.fileId, content: 'later' });
    await independent.write(file('/independent'));
    const updates = await Promise.all([
        left.merge(request('next')), left.merge(request('repeat')), independent.merge(request('independent')),
    ]);
    // A second merge of the same fork waits for the first, so the other fork's merge publishes before it.
    assert.deepEqual(updates, [status('v2'), status('v3', 'unchanged'), status('v3')]);

    const reopened = scoped(await MemDrive.open(withClient(fixture)), right.at);
    await assert.rejects(reopened.merge(request('conflict')), { code: 'MERGE_CONFLICT',
        details: { fileIds: [], paths: ['/same'] } });
});

test('a main write with a lost response fails the merge, which waits for it, rolls main back and can be repeated', async () => {
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
    const rejected = assert.rejects(pending, { code: 'DATABASE_ERROR' });
    await dispatched.promise;
    const observer = await MemDrive.open(withClient(fixture));
    // The write landed on main, but readers see only the published version.
    assert.equal(await observer.read({ fileId: saved.fileId }), null);
    const before = fixture.calls.length;
    complete.resolve();
    await rejected;
    fixture.afterUpsert = undefined;
    // Main held nothing at v0, so the failed merge's writes are removed.
    assert.deepEqual(mainDocs(fixture), []);
    assert.equal(fixture.calls.slice(before).filter(call => call.kind === 'delete' && call.request.branch === 'main').length, 1);
    assert.equal(await observer.read({ fileId: saved.fileId }), null);
    await work.write(file('/after'));
    assert.deepEqual(await work.merge(request('uncertain')), status('v1'));
    assert.deepEqual(await observer.read({ fileId: saved.fileId }), saved);
    assert.equal((await observer.read({ path: '/after' })).content, '/after');
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
        if (pause && ref.name === 'main' && !ids[0].startsWith('publication:')) {
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
    // Another client pins the frozen initial reference before it applies the first merge.
    const owner = await MemDrive.open(withClient(fixture));
    await owner.merge({ at: forkAt('research'), ...request('first') });
    release.resolve();
    assert.deepEqual(await read, saved);
});

test('main history reports each publication\'s affected files without version gaps and pins pagination across views', async t => {
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
    assert.equal(page.throughVersion, 'v2');
    const [entry] = page.entries;
    assert.equal(new Date(entry.publishedAt).toISOString(), entry.publishedAt);
    assert.deepEqual(entry, { version: 'v1', publishedAt: entry.publishedAt, summary: 'Publish first',
        fileIds: [first.fileId], fileIdsTruncated: false });
    assert.deepEqual(await old.status(), { at: { kind: 'checkpoint', name: 'original' }, mainVersion: 'v2' });
    assert.deepEqual(await work.status(), { at: { kind: 'fork', name: 'history' }, mainVersion: 'v2' });
    assert(fixture.calls.slice(beforeReads).every(({ kind, request }) => kind === 'fetch' && !request.includeVectors
        || kind === 'query' && !request.includeVectors && !request.fields.include.includes('body')));

    await work.write(file('/fourth'));
    await work.merge(request('fourth'));
    const tail = await main.history(page.next);
    assert.equal(tail.throughVersion, 'v2');
    assert.equal(tail.next, undefined);
    assert.deepEqual(tail.entries.map(item => [item.version, item.fileIds]), [['v2', [first.fileId, second.fileId].sort()]]);
    assert.deepEqual(await main.history(page.next), tail);
    await assert.rejects(main.history({ ...page.next, at: work.at }), { code: 'INVALID_INPUT' });
    const reopened = await MemDrive.open(withClient(fixture));
    assert.deepEqual((await reopened.history({ limit: 1 })).entries, page.entries);
    assert.deepEqual((await reopened.history({ sinceVersion: 'v1' })).entries.map(({ version }) => version), ['v2', 'v3']);
    assert.deepEqual(await reopened.history({ sinceVersion: 'v3' }), { throughVersion: 'v3', entries: [] });
    // Stateless cursors continue on a fresh client of the same store.
    assert.deepEqual(await reopened.history(page.next), tail);
    const state = JSON.parse(Buffer.from(page.next.cursor.slice(3), 'base64url').toString());
    assert.deepEqual(Object.keys(state).sort(), ['d', 'l', 's', 't']);
    const token = value => `h1.${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
    for (const cursor of ['h1.', 'h1.@', `x1.${page.next.cursor.slice(3)}`, token([]), token({ ...state, d: 'other-store' }),
        token({ ...state, s: 'v3' }), token({ ...state, t: 'v9' }), token({ ...state, s: 'v01' }), token({ ...state, l: 0 }),
        token({ ...state, l: 101 }), token({ ...state, s: 'v3', t: 'v2' }), token({ ...state, extra: 1 })])
        await assert.rejects(reopened.history({ cursor }), { code: 'HISTORY_CURSOR_UNAVAILABLE' }, cursor);
    for (const sinceVersion of ['v4', 'v5'])
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
    assert.deepEqual([...fixture.collections.get(name).tags.keys()].sort(), ['checkpoint-original', 'md-main-v1', 'md-main-v2', 'md-main-v3']);
});

test('history caps affected IDs and reads a publication while its source bookkeeping is running', async () => {
    const { fixture, main } = await setup();
    const work = await fork(main, { name: 'big-merge' });
    const files = await work.write(Array.from({ length: 100 }, (_, i) => file(`/entry-${i}`, '')));
    files.push(await work.write(file('/last', '')));
    const started = gate(), release = gate();
    fixture.beforeUpsert = async ({ branch, docs }) => {
        if (branch === 'fork-big-merge' && docs[0].baseline?.version === 'v1') {
            started.resolve();
            await release.promise;
        }
    };
    const merged = work.merge(request('many'));
    await Promise.race([started.promise, merged]);
    try {
        const reader = await MemDrive.open(withClient(fixture));
        assert.deepEqual(await reader.status(), { at: { kind: 'main' }, mainVersion: 'v1' });
        const page = await reader.history();
        assert.deepEqual(page.entries[0].fileIds, files.map(({ fileId }) => fileId).sort().slice(0, 100));
        assert.equal(page.entries[0].fileIdsTruncated, true);
    } finally {
        release.resolve();
        await merged;
    }
    assert.deepEqual(await main.status(), { at: { kind: 'main' }, mainVersion: 'v1' });
});

test('a definite target tag rejection fails the merge, and merging again publishes once', async () => {
    const { fixture, main } = await setup();
    const work = await fork(main, { name: 'research' });
    const original = await work.write(file('/original'));
    let rejectedTarget = false;
    fixture.beforeTagCreate = tag => {
        if (tag === 'md-main-v1' && !rejectedTarget) {
            rejectedTarget = true;
            throw dbRejection();
        }
    };
    // Tags no longer wait for a first snapshot (LambdaDB PR #614), so a 400 is
    // not retried inside the call: the merge fails and main is restored.
    await assert.rejects(work.merge(request('cold')), { code: 'DATABASE_ERROR', status: 400 });
    assert.deepEqual(mainDocs(fixture), []);
    assert.deepEqual(await main.status(), { at: { kind: 'main' }, mainVersion: 'v0' });
    assert.deepEqual(await work.merge(request('cold')), status('v1'));
    assert.deepEqual(await main.read({ fileId: original.fileId }), original);
    assert.equal(fixture.calls.filter(call => call.kind === 'upsert' && call.collection === name
        && call.request.branch === 'main').length, 2);
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
    assert.deepEqual(await Promise.all([first, second]), [status('v1'), status('v2')]);
    await Promise.all([edit, later]);
    assert.equal((await main.read({ fileId: saved.fileId })).content, 'second');
    assert.equal((await work.read({ fileId: saved.fileId })).content, 'third');
    assert.deepEqual(await work.diff(), [{ op: 'update', fileId: saved.fileId, path: saved.path }]);
    const { at } = await main.fork({ name: 'first-version', version: 'v1' });
    assert.equal((await main.read({ at, fileId: saved.fileId })).content, 'first');
});

test('failed source bookkeeping keeps the publication, and the fork settles it before any later operation', async () => {
    const { fixture, main } = await setup();
    const work = await fork(main, { name: 'research' });
    const [kept, removed] = await work.write([file('/kept'), file('/removed')]);
    await work.merge(request('first'));
    await work.write([{ op: 'update', fileId: kept.fileId, content: 'second' }, { op: 'delete', fileId: removed.fileId }]);
    const created = await work.write(file('/created'));
    const rejectBookkeeping = () => {
        fixture.beforeUpsert = fixture.beforeDelete = ({ branch }) => {
            if (branch === 'fork-research') throw new Error('Lost bookkeeping response');
        };
    };
    rejectBookkeeping();
    assert.deepEqual(await work.merge(request('second')), status('v2'));
    fixture.beforeUpsert = fixture.beforeDelete = undefined;
    assert.equal((await main.read({ fileId: kept.fileId })).content, 'second');
    const docs = fixture.collections.get(name).branches.get('fork-research').docs;
    // The baselines were not advanced, so the fork still states all three changes.
    assert.deepEqual([kept, removed, created].map(({ fileId }) => docs.get(`file:${fileId}`)?.changed), [true, true, true]);
    // A new client does not know about the failed pass; merging again settles it without a conflict.
    const other = scoped(await MemDrive.open(withClient(fixture)), work.at);
    assert.equal((await other.diff()).length, 3);
    const before = fixture.calls.length;
    assert.deepEqual(await other.merge(request('again')), status('v2', 'unchanged'));
    assert.deepEqual(fixture.calls.slice(before).filter(mainMutation), []);
    assert.deepEqual(await other.diff(), []);
    const doc = docs.get(`file:${kept.fileId}`);
    assert.deepEqual([doc.changed, doc.version, doc.baseline.version], [false, 'v2', 'v2']);

    // In the publishing client, the next operation of the fork completes the failed pass first:
    // deleting a just-published creation is a published deletion, not a discarded draft.
    const extra = await work.write(file('/extra'));
    await work.merge(request('third'));
    await work.write({ op: 'update', fileId: kept.fileId, content: 'third' });
    rejectBookkeeping();
    assert.deepEqual(await work.merge(request('fourth')), status('v4'));
    fixture.beforeUpsert = fixture.beforeDelete = undefined;
    assert.equal(docs.get(`file:${kept.fileId}`).baseline.version, 'v2');
    await work.write({ op: 'delete', fileId: extra.fileId });
    assert.equal(docs.get(`file:${kept.fileId}`).baseline.version, 'v4');
    assert.deepEqual(await work.diff(), [{ op: 'delete', fileId: extra.fileId, previousPath: '/extra' }]);
    assert.deepEqual(await work.merge(request('delete')), status('v5'));
    assert.equal(await main.read({ fileId: extra.fileId }), null);
    // A pass that fails again fails the operation and stays pending.
    await work.write({ op: 'update', fileId: kept.fileId, content: 'fifth' });
    rejectBookkeeping();
    assert.deepEqual(await work.merge(request('fifth')), status('v6'));
    await assert.rejects(work.write(file('/blocked')), error => error.code === 'DATABASE_ERROR' && error.cause.message === 'Lost bookkeeping response');
    fixture.beforeUpsert = fixture.beforeDelete = undefined;
    await work.write({ op: 'update', fileId: kept.fileId, content: 'sixth' });
    assert.deepEqual(await work.diff(), [{ op: 'update', fileId: kept.fileId, path: '/kept' }]);
    assert.deepEqual(await work.merge(request('sixth')), status('v7'));
});
