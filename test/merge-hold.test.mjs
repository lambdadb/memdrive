import assert from 'node:assert/strict';
import test from 'node:test';
import { MemDrive } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

// A merge reads its fork directly, so the fork is held still from the moment
// the merge starts until it is settled: a terminal outcome and, for a
// publication, confirmed source bookkeeping.

const name = 'held-store';
const draft = { kind: 'fork', name: 'draft' };
const other = { kind: 'fork', name: 'other' };
const branch = 'fork-draft';
const request = requestId => ({ requestId, summary: `Publish ${requestId}` });
const published = (requestId, version) => ({ requestId, status: 'published', version });
const blockedBy = requestId => ({ code: 'MERGE_BLOCKED', details: { requestId } });
const lost = () => new Error('Response lost');
const rejection = () => Object.assign(new Error('Rejected before dispatch'), { statusCode: 400 });
const unavailable = () => Object.assign(new Error('Unavailable'), { statusCode: 503 });
const tick = () => new Promise(resolve => setImmediate(resolve));
function gate() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

// Both modes keep one original per file. Managed files also have chunks.
const modes = {
    managed: { create: {}, open: {}, content: n => `Revision ${n}`, stored: doc => doc.body },
    'external-vector': { create: { embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'fixture' } },
        open: { mode: 'external' }, content: n => [n, 1, ...Array(62).fill(0)], stored: doc => doc.embedding },
};

const contentDocs = fixture => fixture.collections.get(name);
const forkDocs = (fixture, native = branch) => contentDocs(fixture).branches.get(native).docs;
const tagDocs = (fixture, tag) => contentDocs(fixture).tags.get(tag).docs;
const snapshot = docs => structuredClone([...docs]);
const journalOf = fixture => [...fixture.collections.values()]
    .find(store => store.metadata.tags?.['memdrive.format'] === 'merge-publication-v1')?.branches.get('main').docs;
const journalFetches = (fixture, since) => fixture.calls.slice(since)
    .filter(call => call.kind === 'fetch' && call.request.ids.some(id => /^(?:reservation|completion|applied|bookkeeping|request|retention):/.test(id)));
const tagsCreated = fixture => fixture.calls.filter(call => call.kind === 'tag-create').map(call => call.request.tagName);
const sorted = rows => rows.map(row => JSON.stringify(row)).sort();
/** What a view serves, as stored: every file's path, content or vector and metadata, and every chunk's text. */
function contentOf(docs, mode) {
    const records = [...new Map(docs).values()];
    return { files: sorted(records.filter(doc => doc.kind === 'file').map(doc => [doc.fileId, doc.path, mode.stored(doc), doc.metadata ?? null])),
        chunks: sorted(records.filter(doc => doc.kind === 'chunk').map(doc => [doc.fileId, doc.path, doc.content])) };
}

async function setup(mode = modes.managed) {
    const fixture = fileClient();
    const main = await MemDrive.create({ client: fixture.client, name, ...mode.create });
    await main.fork({ name: 'draft' });
    const restart = (options = {}) => MemDrive.open({ client: { ...fixture.client }, name, ...mode.open, ...options });
    return { fixture, main, restart };
}

/** Publish three files as v1, then change the fork: an update, a move, a deletion and a creation. */
async function changed(mode = modes.managed) {
    const { fixture, main, restart } = await setup(mode);
    const [a, b, c] = await main.write({ at: draft, operations: ['/a', '/b', '/c'].map((path, i) => ({ op: 'create', path, content: mode.content(i + 1) })) });
    assert.deepEqual(await main.merge({ at: draft, ...request('first') }), published('first', 'v1'));
    await main.write({ at: draft, operations: [{ op: 'update', fileId: a.fileId, content: mode.content(10) },
        { op: 'update', fileId: b.fileId, newPath: '/moved' }, { op: 'delete', fileId: c.fileId }] });
    const d = await main.write({ at: draft, op: 'create', path: '/d', content: mode.content(11) });
    const before = { fork: snapshot(forkDocs(fixture)), content: contentOf(forkDocs(fixture), mode), diff: await main.diff({ at: draft }) };
    assert.equal(before.diff.length, 4);
    return { fixture, main, restart, files: { a, b, c, d }, before };
}

function disarm(fixture) {
    fixture.beforeUpsert = fixture.afterUpsert = fixture.beforeDelete = fixture.beforeTagCreate = fixture.beforeFetch = undefined;
}

const isContent = doc => doc.kind === 'file' || doc.kind === 'chunk' || doc.kind === 'tombstone';
/** Reject main content mutations from the `nth` on. */
function stopMain(fixture, nth) {
    let count = 0;
    fixture.beforeUpsert = ({ branch: target, docs }) => {
        if (target === 'main' && docs.some(isContent) && ++count >= nth) throw rejection();
    };
}
/** Reject the fork's bookkeeping mutations from the `nth` on. No user write reaches the fork while it is held. */
function stopFork(fixture, nth) {
    let count = 0;
    fixture.beforeUpsert = fixture.beforeDelete = ({ branch: target }) => {
        if (target === branch && ++count >= nth) throw rejection();
    };
}
const loseRecord = kind => fixture => {
    fixture.beforeUpsert = ({ docs }) => { if (docs[0].kind === kind) throw lost(); };
};

// Each step stops the second merge at one point of its sequence: reservation,
// request index, main application, applied record, target tag, completion
// record, source bookkeeping and bookkeeping record.
const interruptions = {
    'after the reservation': { phase: 'publication', arm: loseRecord('merge-request-v1') },
    'after the request index': { phase: 'publication', arm: fixture => stopMain(fixture, 1) },
    'during application': { phase: 'publication', arm: fixture => stopMain(fixture, 2) },
    'after application': { phase: 'publication', arm: loseRecord('merge-applied-v1') },
    'after the applied record': { phase: 'publication', arm: fixture => {
        fixture.beforeTagCreate = tag => { if (tag === 'md-main-v2') throw unavailable(); };
    } },
    'after the target tag': { phase: 'publication', arm: loseRecord('merge-result-v1') },
    'after the completion record': { phase: 'bookkeeping', arm: fixture => stopFork(fixture, 1) },
    'during source bookkeeping': { phase: 'bookkeeping', arm: fixture => stopFork(fixture, 3) },
    'after source bookkeeping': { phase: 'bookkeeping', arm: loseRecord('merge-bookkeeping-v1') },
};

for (const [modeLabel, mode] of Object.entries(modes)) {
    test(`operations issued while a merge runs complete after it in order, and it publishes exactly the fork it found (${modeLabel})`, async () => {
        const { fixture, main } = await setup(mode);
        const file = await main.write({ at: draft, op: 'create', path: '/note', content: mode.content(1) });
        const { fileId } = file;
        const applying = gate(), resume = gate();
        fixture.beforeUpsert = async ({ branch: target, docs }) => {
            if (target === 'main' && docs.some(isContent)) {
                fixture.beforeUpsert = undefined;
                applying.resolve();
                await resume.promise;
            }
        };
        const order = [];
        const track = (label, promise) => promise.then(value => { order.push(label); return value; });
        const first = track('merge', main.merge({ at: draft, ...request('first') }));
        await applying.promise;
        const found = { fork: snapshot(forkDocs(fixture)), content: contentOf(forkDocs(fixture), mode) };
        const edit = track('write', main.write({ at: draft, op: 'update', fileId, content: mode.content(2) }));
        const scan = track('diff', main.diff({ at: draft }));
        const saved = track('checkpoint', main.checkpoint({ at: draft, name: 'saved' }));
        const child = track('fork', main.fork({ at: draft, name: 'child' }));
        const second = track('second merge', main.merge({ at: draft, ...request('second') }));
        const later = track('later write', main.write({ at: draft, op: 'update', fileId, content: mode.content(3) }));
        // Reads of the fork do not wait, and nothing else moves while the merge runs.
        assert.deepEqual(await main.read({ at: draft, fileId }), file);
        await tick();
        assert.deepEqual(order, []);
        assert.deepEqual(snapshot(forkDocs(fixture)), found.fork);
        assert(!contentDocs(fixture).tags.has('checkpoint-saved') && !contentDocs(fixture).branches.has('fork-child'));

        resume.resolve();
        assert.deepEqual(await first, published('first', 'v1'));
        assert.deepEqual(await second, published('second', 'v2'));
        await Promise.all([edit, saved, child, later]);
        assert.deepEqual(order, ['merge', 'write', 'diff', 'checkpoint', 'fork', 'second merge', 'later write']);
        // The diff ran after the first merge advanced the baseline and after the first queued edit.
        assert.deepEqual(await scan, [{ op: 'update', fileId, path: '/note' }]);
        // No queued edit reached the first publication, and each later view holds what preceded it.
        assert.deepEqual(contentOf(tagDocs(fixture, 'md-main-v1'), mode), found.content);
        const stored = docs => mode.stored(docs.get(`file:${fileId}`));
        assert.deepEqual(stored(tagDocs(fixture, 'md-main-v1')), mode.content(1));
        for (const docs of [tagDocs(fixture, 'checkpoint-saved'), forkDocs(fixture, 'fork-child'), tagDocs(fixture, 'md-main-v2')])
            assert.deepEqual(stored(docs), mode.content(2));
        assert.deepEqual(stored(forkDocs(fixture)), mode.content(3));
        assert.deepEqual(await main.diff({ at: draft }), [{ op: 'update', fileId, path: '/note' }]);
        assert.deepEqual((await main.history()).entries.map(entry => [entry.version, entry.fileIds]), [['v1', [fileId]], ['v2', [fileId]]]);
        assert.deepEqual(tagsCreated(fixture), ['md-main-v1', 'checkpoint-saved', 'md-main-v2']);
    });

    test(`an interrupted merge holds its fork still until the same request settles it, in process and after a restart (${modeLabel})`, async () => {
        for (const [step, { phase, arm }] of Object.entries(interruptions)) for (const resume of ['same process', 'new process', 'recovery']) {
            const label = `${step}, ${resume}`;
            const { fixture, main, restart, files: { a, b, c, d }, before } = await changed(mode);
            arm(fixture);
            await assert.rejects(main.merge({ at: draft, ...request('second') }), { code: 'MERGE_RESUMABLE',
                details: { requestId: 'second', ...(phase === 'bookkeeping' ? { publishedVersion: 'v2' } : {}) } }, label);
            disarm(fixture);
            const held = snapshot(forkDocs(fixture));
            // The fork changes only after its publication is recorded.
            if (phase === 'publication') assert.deepEqual(held, before.fork, label);
            // A restarted process never saw the merge start.
            const drive = resume === 'same process' ? main : await restart();
            assert.deepEqual((await drive.status({ at: draft })).merge, { requestId: 'second', phase }, label);

            // Every write to the held fork is rejected.
            for (const write of [{ op: 'update', fileId: a.fileId, content: mode.content(20) }, { op: 'create', path: '/new', content: mode.content(21) },
                { op: 'update', fileId: d.fileId, newPath: '/renamed' }, { op: 'delete', fileId: b.fileId },
                { operations: [{ op: 'create', path: '/batch', content: mode.content(22) }, { op: 'delete', fileId: d.fileId }] }])
                await assert.rejects(drive.write({ at: draft, ...write }), blockedBy('second'), label);
            // Another merge of the fork and its deletion wait for the unfinished one too.
            await assert.rejects(drive.merge({ at: draft, ...request('another') }), blockedBy('second'), label);
            await assert.rejects(drive.deleteFork({ at: draft }), blockedBy('second'), label);

            // Reads, diff and references from the held fork keep working, so work can continue elsewhere.
            assert.equal((await drive.read({ at: draft, fileId: d.fileId })).path, '/d', label);
            assert.deepEqual((await drive.list({ at: draft })).files.map(file => file.path).sort(), ['/a', '/d', '/moved'], label);
            const diff = await drive.diff({ at: draft });
            if (phase === 'publication') assert.deepEqual(diff, before.diff, label);
            else assert(diff.every(change => before.diff.some(expected => JSON.stringify(expected) === JSON.stringify(change))), label);
            const { at: saved } = await drive.checkpoint({ at: draft, name: 'saved' });
            const { at: child } = await drive.fork({ at: draft, name: 'child' });
            for (const at of [saved, child])
                assert.deepEqual(await drive.read({ at, paths: ['/a', '/d', '/moved'] }), await drive.read({ at: draft, paths: ['/a', '/d', '/moved'] }), label);
            await drive.write({ at: child, op: 'create', path: '/elsewhere', content: mode.content(30) });
            assert.deepEqual(snapshot(forkDocs(fixture)), held, label);

            // The same request, or recovery by the owner, publishes exactly what the fork held.
            if (resume === 'recovery') {
                await restart({ recover: true });
                assert.deepEqual(await drive.status({ at: draft }), { at: draft, mainVersion: 'v2' }, label);
            }
            assert.deepEqual(await drive.merge({ at: draft, ...request('second') }), published('second', 'v2'), label);
            assert.deepEqual(contentOf(tagDocs(fixture, 'md-main-v2'), mode), before.content, label);
            const affected = [a, b, c, d].map(file => file.fileId).sort();
            assert.deepEqual((await drive.history({ sinceVersion: 'v1' })).entries.map(entry => [entry.version, entry.fileIds, entry.fileIdsTruncated]),
                [['v2', affected, false]], label);
            assert.deepEqual(await drive.status({ at: draft }), { at: draft, mainVersion: 'v2' }, label);
            assert.equal(journalOf(fixture).get('bookkeeping:2').kind, 'merge-bookkeeping-v1', label);
            // A merge pins its target version and nothing else.
            assert.deepEqual(tagsCreated(fixture).filter(tag => tag !== 'checkpoint-saved'),
                step === 'after the applied record' ? ['md-main-v1', 'md-main-v2', 'md-main-v2'] : ['md-main-v1', 'md-main-v2'], label);

            // The settled fork remains, with no change left; a later edit is the next merge's only change.
            assert((await drive.listForks()).forks.some(({ at }) => at.name === 'draft'), label);
            assert.deepEqual(await drive.diff({ at: draft }), [], label);
            assert.deepEqual(contentOf(forkDocs(fixture), mode), before.content, label);
            await drive.write({ at: draft, op: 'update', fileId: d.fileId, content: mode.content(40) });
            assert.deepEqual(await drive.diff({ at: draft }), [{ op: 'update', fileId: d.fileId, path: '/d' }], label);
            assert.deepEqual(await drive.merge({ at: draft, ...request('third') }), published('third', 'v3'), label);
            assert.deepEqual((await drive.history({ sinceVersion: 'v2' })).entries.map(entry => [entry.version, entry.fileIds]), [['v3', [d.fileId]]], label);
            assert.deepEqual(contentOf(tagDocs(fixture, 'md-main-v3'), mode), contentOf(forkDocs(fixture), mode), label);
            // The child fork taken during the hold kept its own content.
            assert.equal((await drive.read({ at: child, path: '/elsewhere' })).path, '/elsewhere', label);
        }
    });
}

test('bookkeeping that stopped halfway resumes without planning the half-advanced fork again', async () => {
    for (const resume of ['same process', 'new process', 'recovery']) {
        const { fixture, main, restart } = await setup();
        // Roles follow ID order, which is also bookkeeping order: the first file
        // vacates its path and the second one takes it.
        const [first, second] = (await main.write({ at: draft, operations: ['/a', '/b'].map(path => ({ op: 'create', path, content: path })) }))
            .sort((x, y) => x.fileId < y.fileId ? -1 : 1);
        assert.deepEqual(await main.merge({ at: draft, ...request('first') }), published('first', 'v1'));
        await main.write({ at: draft, op: 'update', fileId: first.fileId, newPath: '/vacated-to' });
        await main.write({ at: draft, op: 'update', fileId: second.fileId, newPath: first.path });
        const before = contentOf(forkDocs(fixture), modes.managed);
        stopFork(fixture, 2);
        await assert.rejects(main.merge({ at: draft, ...request('second') }),
            { code: 'MERGE_RESUMABLE', details: { requestId: 'second', publishedVersion: 'v2' } }, resume);
        disarm(fixture);
        // Only the second file is left to advance. Against the prior version its
        // new path looks occupied by the first file, which is no longer a change.
        const drive = resume === 'same process' ? main : await restart();
        assert.deepEqual(await drive.diff({ at: draft }), [{ op: 'update', fileId: second.fileId, path: first.path, previousPath: second.path }], resume);
        await assert.rejects(drive.write({ at: draft, op: 'update', fileId: second.fileId, content: 'edit' }), blockedBy('second'), resume);
        if (resume === 'recovery') await restart({ recover: true });
        assert.deepEqual(await drive.merge({ at: draft, ...request('second') }), published('second', 'v2'), resume);
        assert.deepEqual(await drive.diff({ at: draft }), [], resume);
        assert.deepEqual(contentOf(tagDocs(fixture, 'md-main-v2'), modes.managed), before, resume);
        assert.deepEqual(contentOf(forkDocs(fixture), modes.managed), before, resume);
        assert.deepEqual((await drive.read({ paths: [first.path, '/vacated-to'] })).map(file => file.fileId), [second.fileId, first.fileId], resume);
        assert.deepEqual(await drive.merge({ at: draft, ...request('third') }), { requestId: 'third', status: 'unchanged', version: 'v2' }, resume);
    }
});

// The hold is the only thing that keeps a fork still, so bookkeeping does not
// rely on it: an original is advanced only if the published version holds
// exactly its current state. A merge that reaches bookkeeping in the run that
// built its plan compares with the plan; a resumed one reads the version's tag.
const forkCalls = calls => calls.filter(call => call.request?.ref?.name === branch || call.request?.branch === branch);
const versionReads = (calls, version) => calls.filter(call => call.request?.ref?.name === `md-main-${version}`);

for (const [modeLabel, mode] of Object.entries(modes)) {
    test(`bookkeeping never marks a change that slipped past the hold as published (${modeLabel})`, async () => {
        const paths = [['same run', 'same run'], ...['before bookkeeping', 'during bookkeeping']
            .flatMap(stopped => ['retry', 'new process', 'recovery'].map(resume => [stopped, resume]))];
        for (const [stopped, resume] of paths) for (const slipped of ['mixed', 'creation']) {
            const label = `${stopped}, ${slipped}, ${resume}`;
            const { fixture, main, restart, files: { a, b, c, d } } = await changed(mode);
            // Another client object wrote to the fork before the merge started. It
            // passed its first-write check, so a merge it never saw does not stop it.
            const intruder = await restart();
            const seed = await intruder.write({ at: draft, op: 'create', path: '/seed', content: mode.content(12) });
            const content = contentOf(forkDocs(fixture), mode);
            // Published, but not yet settled: the intruder creates a file, edits a
            // published file and deletes a published file.
            let created, early, violated;
            const advanced = id => forkDocs(fixture).get(`file:${id}`)?.baseline?.version === 'v2';
            async function violate() {
                early = new Set([a, b].filter(file => advanced(file.fileId)).map(file => file.fileId));
                created = await intruder.write({ at: draft, op: 'create', path: '/slipped', content: mode.content(51) });
                if (slipped === 'mixed') {
                    await intruder.write({ at: draft, op: 'update', fileId: a.fileId, content: mode.content(50) });
                    await intruder.write({ at: draft, op: 'delete', fileId: b.fileId });
                }
                violated = contentOf(forkDocs(fixture), mode);
            }

            // The merge settles with its original publication on every path that runs bookkeeping.
            let drive = main;
            if (stopped === 'same run') {
                // The completion record is confirmed; bookkeeping follows in the same run, with its plan.
                let since;
                fixture.afterUpsert = async ({ docs }) => {
                    if (docs[0].kind !== 'merge-result-v1') return;
                    fixture.afterUpsert = undefined;
                    since = fixture.calls.length;
                    await violate();
                };
                assert.deepEqual(await main.merge({ at: draft, ...request('second') }), published('second', 'v2'), label);
                // The plan decided: the published version was not read again.
                assert.deepEqual(versionReads(fixture.calls.slice(since), 'v2'), [], label);
            } else {
                stopFork(fixture, stopped === 'before bookkeeping' ? 1 : 3);
                await assert.rejects(main.merge({ at: draft, ...request('second') }),
                    { code: 'MERGE_RESUMABLE', details: { requestId: 'second', publishedVersion: 'v2' } }, label);
                disarm(fixture);
                await violate();
                if (resume !== 'retry') drive = await restart();
                if (resume === 'recovery') await restart({ recover: true });
                assert.deepEqual(await drive.merge({ at: draft, ...request('second') }), published('second', 'v2'), label);
            }
            assert.equal(early.size > 0 && stopped !== 'during bookkeeping', false, label);
            assert.deepEqual(await drive.status({ at: draft }), { at: draft, mainVersion: 'v2' }, label);
            assert.equal(journalOf(fixture).get('bookkeeping:2').kind, 'merge-bookkeeping-v1', label);
            assert.deepEqual(contentOf(tagDocs(fixture, 'md-main-v2'), mode), content, label);
            assert.deepEqual((await drive.history({ sinceVersion: 'v1' })).entries.map(entry => entry.fileIds),
                [[a, b, c, d, seed].map(file => file.fileId).sort()], label);

            // Bookkeeping changed no content, and the slipped changes are still changes.
            assert.deepEqual(contentOf(forkDocs(fixture), mode), violated, label);
            const expected = [{ op: 'create', fileId: created.fileId, path: '/slipped' }, ...(slipped === 'mixed' ? [
                { op: 'update', fileId: a.fileId, path: '/a' },
                // The deleted file keeps the baseline it had when it was deleted.
                { op: 'delete', fileId: b.fileId, previousPath: early.has(b.fileId) ? '/moved' : '/b' }] : [])];
            assert.deepEqual(sorted(await drive.diff({ at: draft })), sorted(expected), label);
            // Published files that nothing touched have no change left.
            for (const file of [d, seed, ...(slipped === 'mixed' ? [] : [a, b])]) {
                const doc = forkDocs(fixture).get(`file:${file.fileId}`);
                assert.deepEqual([doc.changed, doc.version, doc.baseline.version], [false, 'v2', 'v2'], label);
            }
            assert.equal(forkDocs(fixture).has(`file:${c.fileId}`), false, label);
            // A slipped edit of a file whose baseline had not advanced keeps the prior baseline.
            if (slipped === 'mixed' && !early.has(a.fileId)) assert.equal(forkDocs(fixture).get(`file:${a.fileId}`).baseline.version, 'v1', label);

            // The next merge treats them as ordinary changes: it publishes them, or
            // reports those whose baseline main has moved past.
            const stale = slipped === 'mixed' ? [a, b].filter(file => !early.has(file.fileId)).map(file => file.fileId).sort() : [];
            if (stale.length) {
                await assert.rejects(drive.merge({ at: draft, ...request('third') }),
                    error => error.code === 'MERGE_CONFLICT' && JSON.stringify([...error.details.fileIds].sort()) === JSON.stringify(stale)
                        && error.details.paths.length === 0, label);
                assert.deepEqual(sorted(await drive.diff({ at: draft })), sorted(expected), label);
                await drive.write({ at: draft, op: 'create', path: '/after-conflict', content: mode.content(60) });
            } else {
                assert.deepEqual(await drive.merge({ at: draft, ...request('third') }), published('third', 'v3'), label);
                assert.deepEqual((await drive.history({ sinceVersion: 'v2' })).entries.map(entry => entry.fileIds),
                    [expected.map(change => change.fileId).sort()], label);
                assert.deepEqual(contentOf(tagDocs(fixture, 'md-main-v3'), mode), violated, label);
                assert.deepEqual(await drive.diff({ at: draft }), [], label);
            }
        }
    });

    test(`bookkeeping sends no extra request in the run that published and reads the version once per batch when resumed (${modeLabel})`, async () => {
        for (const extra of [0, 13]) for (const resumed of [false, true]) {
            const label = `${extra + 4} changes, ${resumed ? 'resumed' : 'same run'}`;
            const { fixture, main, files: { a, b, c, d }, before } = await changed(mode);
            // 4 changes fit one batch of 16; 17 need two.
            const more = extra ? await main.write({ at: draft, operations: Array.from({ length: extra }, (_, i) =>
                ({ op: 'create', path: `/more-${i}`, content: mode.content(100 + i) })) }) : [];
            const all = [a, b, c, d, ...more];
            const content = contentOf(forkDocs(fixture), mode);
            let since;
            if (resumed) {
                // Stop before the first bookkeeping mutation; the retry has no plan.
                stopFork(fixture, 1);
                await assert.rejects(main.merge({ at: draft, ...request('second') }), { code: 'MERGE_RESUMABLE' }, label);
                disarm(fixture);
                since = fixture.calls.length;
            } else {
                fixture.beforeUpsert = ({ docs }) => { if (docs[0].kind === 'merge-result-v1') since = fixture.calls.length; };
            }
            assert.deepEqual(await main.merge({ at: draft, ...request('second') }), published('second', 'v2'), label);
            disarm(fixture);
            // From the completion record on, or in the whole retry, only bookkeeping touches the fork and the new version.
            const calls = fixture.calls.slice(since);
            const ids = all.map(file => `file:${file.fileId}`).sort();
            const batches = extra ? [ids.slice(0, 16), ids.slice(16)] : [ids];
            assert.deepEqual(versionReads(calls, 'v2').map(call => [call.kind, call.request.ids, call.request.consistentRead, call.request.includeVectors]),
                resumed ? batches.map(batch => ['fetch', batch, false, mode !== modes.managed]) : [], label);
            // The fork is touched as it was before this check existed: one scan,
            // one read per batch, and a mutation with its confirming read per original.
            assert.equal(forkCalls(calls).length, 1 + batches.length + 2 * all.length, label);
            assert.deepEqual(forkCalls(calls).map(call => call.kind).filter(kind => kind === 'upsert' || kind === 'delete').sort(),
                [...Array(all.length - 1).fill('upsert'), 'delete'].sort(), label);
            // The outcome of bookkeeping is what it was: no change left and the same content.
            assert.deepEqual(await main.diff({ at: draft }), [], label);
            assert.deepEqual(contentOf(forkDocs(fixture), mode), content, label);
            assert.deepEqual(contentOf(tagDocs(fixture, 'md-main-v2'), mode), content, label);
            if (!extra) assert.deepEqual(content, before.content, label);
            for (const file of all.filter(file => file !== c)) {
                const doc = forkDocs(fixture).get(`file:${file.fileId}`);
                assert.deepEqual([doc.changed, doc.version, doc.baseline.version, doc.baseline.path, doc.baseline.fingerprint],
                    [false, 'v2', 'v2', doc.path, doc.fingerprint], label);
            }
            assert.equal(forkDocs(fixture).has(`file:${c.fileId}`), false, label);
        }
    });
}

test('operations queued behind a merge that ends unsettled: writes and other merges are rejected, diff and references proceed', async () => {
    const { fixture, main, before } = await changed();
    const applying = gate(), resume = gate();
    fixture.beforeUpsert = async ({ branch: target, docs }) => {
        if (target === 'main' && docs.some(isContent)) {
            applying.resolve();
            await resume.promise;
            throw rejection();
        }
    };
    const merging = assert.rejects(main.merge({ at: draft, ...request('second') }), { code: 'MERGE_RESUMABLE' });
    await applying.promise;
    const write = assert.rejects(main.write({ at: draft, op: 'create', path: '/queued', content: 'queued' }), blockedBy('second'));
    const scan = main.diff({ at: draft });
    const saved = main.checkpoint({ at: draft, name: 'saved' });
    const next = assert.rejects(main.merge({ at: draft, ...request('next') }), blockedBy('second'));
    const again = assert.rejects(main.write({ at: draft, op: 'create', path: '/queued-later', content: 'queued' }), blockedBy('second'));
    resume.resolve();
    await Promise.all([merging, write, next, again]);
    assert.deepEqual(await scan, before.diff);
    assert.deepEqual(await saved, { at: { kind: 'checkpoint', name: 'saved' } });
    assert.deepEqual(snapshot(forkDocs(fixture)), before.fork);
    assert.equal([...journalOf(fixture).values()].filter(doc => doc.kind === 'merge-reservation-v1').length, 2);
    disarm(fixture);
    assert.deepEqual(await main.merge({ at: draft, ...request('second') }), published('second', 'v2'));
    assert.deepEqual(contentOf(tagDocs(fixture, 'md-main-v2'), modes.managed), before.content);
    await main.write({ at: draft, op: 'create', path: '/queued', content: 'queued' });
});

test('a merge that fails before it reserves holds nothing, and conflict and unchanged outcomes leave the fork writable', async () => {
    const { fixture, main, restart } = await setup();
    await main.fork({ name: 'other' });
    const file = await main.write({ at: draft, op: 'create', path: '/note', content: 'first' });
    const reservations = () => [...journalOf(fixture)?.values() ?? []].filter(doc => doc.kind === 'merge-reservation-v1').map(doc => doc.requestId);
    const writable = async (drive, at, path) => assert.equal((await drive.write({ at, op: 'create', path, content: path })).path, path);

    // The journal read that precedes the reservation fails, so nothing is dispatched.
    fixture.beforeFetch = ({ ids }) => { if (ids.length === 1 && ids[0] === 'reservation:1') throw unavailable(); };
    await assert.rejects(main.merge({ at: draft, ...request('first') }), { code: 'DATABASE_ERROR', status: 503 });
    disarm(fixture);
    assert.deepEqual(reservations(), []);
    assert.deepEqual(await main.status({ at: draft }), { at: draft, mainVersion: 'v0' });
    await writable(main, draft, '/after-failed-read');
    await writable(await restart(), draft, '/after-failed-read-restart');

    // An aborted request reserves nothing either.
    await assert.rejects(main.merge({ at: draft, ...request('first') }, { signal: AbortSignal.abort() }), { code: 'ABORTED' });
    await writable(main, draft, '/after-abort');
    assert.deepEqual(reservations(), []);

    // Another fork's unfinished merge blocks this merge before it reserves.
    await main.write({ at: other, op: 'create', path: '/other', content: 'other' });
    loseRecord('merge-result-v1')(fixture);
    await assert.rejects(main.merge({ at: other, ...request('unfinished') }), { code: 'MERGE_RESUMABLE' });
    disarm(fixture);
    await assert.rejects(main.merge({ at: draft, ...request('first') }), blockedBy('unfinished'));
    assert.deepEqual(reservations(), ['unfinished']);
    await writable(main, draft, '/while-blocked');
    await assert.rejects(main.write({ at: other, op: 'create', path: '/held', content: 'held' }), blockedBy('unfinished'));
    assert.deepEqual(await main.merge({ at: other, ...request('unfinished') }), published('unfinished', 'v1'));
    await writable(main, other, '/other-after');

    // Published, then unchanged: the fork stays writable after each terminal outcome.
    assert.deepEqual(await main.merge({ at: draft, ...request('first') }), published('first', 'v2'));
    await writable(main, draft, '/after-publication');
    assert.deepEqual(await main.merge({ at: draft, ...request('second') }), published('second', 'v3'));
    assert.deepEqual(await main.merge({ at: draft, ...request('empty') }), { requestId: 'empty', status: 'unchanged', version: 'v3' });
    await writable(main, draft, '/after-unchanged');
    await writable(await restart(), draft, '/after-unchanged-restart');

    // A conflict is terminal too: the fork is writable at once, in process and after a restart.
    const { at: stale } = await main.fork({ name: 'stale', version: 'v2' });
    await main.write({ at: stale, op: 'update', fileId: file.fileId, content: 'stale' });
    await main.write({ at: draft, op: 'update', fileId: file.fileId, content: 'current' });
    assert.deepEqual(await main.merge({ at: draft, ...request('current') }), published('current', 'v5'));
    await assert.rejects(main.merge({ at: stale, ...request('conflict') }), { code: 'MERGE_CONFLICT' });
    await writable(main, stale, '/after-conflict');
    await writable(await restart(), stale, '/after-conflict-restart');
    assert.deepEqual(await main.status({ at: stale }), { at: stale, mainVersion: 'v5' });
    // No request left a tag other than a main version.
    assert.deepEqual(tagsCreated(fixture), ['md-main-v1', 'md-main-v2', 'md-main-v3', 'md-main-v5']);
});

test('a fork with an unconfirmed write cannot start a merge and nothing is reserved', async () => {
    const { fixture, main } = await setup();
    await main.write({ at: draft, op: 'create', path: '/settled', content: 'settled' });
    // The write is accepted, but its response and every read that would confirm it are lost.
    let uncertain;
    fixture.afterUpsert = ({ docs }) => {
        uncertain = new Set(docs.map(doc => doc.id));
        throw lost();
    };
    fixture.beforeFetch = ({ ref, ids }) => ref.name === branch && ids.some(id => uncertain?.has(id))
        ? { isDocsInline: true, total: 0, docs: [] } : undefined;
    await assert.rejects(main.write({ at: draft, op: 'create', path: '/uncertain', content: 'uncertain' }), { code: 'WRITE_UNCONFIRMED' });
    fixture.afterUpsert = undefined;
    const calls = fixture.calls.length;
    await assert.rejects(main.merge({ at: draft, ...request('first') }), { code: 'WRITE_UNCONFIRMED' });
    // The merge stopped before it provisioned the journal or wrote any record.
    assert.equal(journalOf(fixture), undefined);
    assert(fixture.calls.slice(calls).every(call => call.kind === 'fetch' || call.kind === 'query'));
    assert.deepEqual(await main.status({ at: draft }), { at: draft, mainVersion: 'v0' });
    // Nothing holds the fork: an unrelated write still goes through.
    await main.write({ at: draft, op: 'create', path: '/unrelated', content: 'unrelated' });

    // Once the write is confirmed, the same request publishes the whole fork.
    disarm(fixture);
    assert.deepEqual(await main.merge({ at: draft, ...request('first') }), published('first', 'v1'));
    assert.deepEqual((await main.list()).files.map(file => file.path).sort(), ['/settled', '/uncertain', '/unrelated']);
});

test('a reservation whose write is unconfirmed holds the fork until the same request settles it', async () => {
    for (const landed of [false, true]) {
        const { fixture, main, restart, before } = await changed();
        // Lose the reservation's response and, if it landed, the read that would confirm it.
        let hidden = false;
        fixture[landed ? 'afterUpsert' : 'beforeUpsert'] = ({ docs }) => {
            if (docs[0].kind === 'merge-reservation-v1') { hidden = true; throw lost(); }
        };
        fixture.beforeFetch = ({ ids }) => {
            if (hidden && ids.length === 1 && ids[0] === 'reservation:2') {
                hidden = false;
                return { isDocsInline: true, total: 0, docs: [] };
            }
        };
        await assert.rejects(main.merge({ at: draft, ...request('second') }), { code: 'MERGE_RESUMABLE', details: { requestId: 'second' } });
        disarm(fixture);
        assert.equal(journalOf(fixture).has('reservation:2'), landed);
        assert.equal(journalOf(fixture).has('completion:2'), false);
        await assert.rejects(main.write({ at: draft, op: 'create', path: '/new', content: 'new' }), blockedBy('second'));
        assert.deepEqual((await main.status({ at: draft })).merge, { requestId: 'second', phase: 'publication' });
        assert.deepEqual(await main.diff({ at: draft }), before.diff);
        // A reservation that landed also holds the fork for a process that never saw it.
        if (landed) await assert.rejects((await restart()).write({ at: draft, op: 'create', path: '/new', content: 'new' }), blockedBy('second'));
        assert.deepEqual(snapshot(forkDocs(fixture)), before.fork);
        assert.deepEqual(await main.merge({ at: draft, ...request('second') }), published('second', 'v2'));
        assert.deepEqual(contentOf(tagDocs(fixture, 'md-main-v2'), modes.managed), before.content);
        await main.write({ at: draft, op: 'create', path: '/new', content: 'new' });
    }
});

test('a content mutation of unknown outcome holds the fork on that client until a replacement owner recovers', async () => {
    for (const target of ['main', 'fork']) {
        const { fixture, main, restart, before } = await changed();
        // The mutation is applied, but its response is lost.
        fixture.afterUpsert = ({ branch: mutated, docs }) => {
            if (mutated === (target === 'main' ? 'main' : branch) && docs.some(isContent)) throw lost();
        };
        const unknown = error => error.code === 'MERGE_BLOCKED' && error.details.requestId === 'second'
            && error.cause?.code === 'MERGE_MUTATION_UNCONFIRMED';
        await assert.rejects(main.merge({ at: draft, ...request('second') }), unknown, target);
        disarm(fixture);
        assert.deepEqual((await main.status({ at: draft })).merge, { requestId: 'second', phase: target === 'main' ? 'publication' : 'bookkeeping' }, target);
        // This client neither resumes the merge nor writes to its fork.
        await assert.rejects(main.merge({ at: draft, ...request('second') }), blockedBy('second'), target);
        await assert.rejects(main.write({ at: draft, op: 'create', path: '/new', content: 'new' }), unknown, target);
        // Reads, diff and references from the fork stay available.
        // Bookkeeping had begun on the fork when its mutation was lost.
        assert.equal((await main.diff({ at: draft })).length < 4, target === 'fork', target);
        assert.deepEqual(await main.checkpoint({ at: draft, name: 'saved' }), { at: { kind: 'checkpoint', name: 'saved' } }, target);
        assert.deepEqual(await main.fork({ at: draft, name: 'child' }), { at: { kind: 'fork', name: 'child' } }, target);

        // After the host fenced this client, a replacement owner settles the merge and writes again.
        const owner = await restart();
        await assert.rejects(owner.write({ at: draft, op: 'create', path: '/new', content: 'new' }), blockedBy('second'), target);
        assert.equal(await restart({ recover: true }) === owner, false);
        assert.deepEqual(await owner.merge({ at: draft, ...request('second') }), published('second', 'v2'), target);
        assert.deepEqual(contentOf(tagDocs(fixture, 'md-main-v2'), modes.managed), before.content, target);
        assert.deepEqual(await owner.diff({ at: draft }), [], target);
        await owner.write({ at: draft, op: 'create', path: '/new', content: 'new' });
        // The fenced client stays fenced: its mutation may still land.
        await assert.rejects(main.write({ at: draft, op: 'create', path: '/late', content: 'late' }), unknown, target);
    }
});

test('recovery and a retried merge of the same fork settle together without waiting on each other', { timeout: 20_000 }, async () => {
    for (const order of ['merge first', 'recovery first']) {
        const { fixture, main, before } = await changed();
        stopFork(fixture, 2);
        await assert.rejects(main.merge({ at: draft, ...request('second') }), { code: 'MERGE_RESUMABLE' });
        disarm(fixture);
        const retry = () => main.merge({ at: draft, ...request('second') });
        const recover = () => MemDrive.open({ client: fixture.client, name, recover: true });
        const [first, second] = order === 'merge first' ? [retry(), recover()] : [recover(), retry()];
        // A write and a diff queued behind them run once the fork is settled.
        const write = main.write({ at: draft, op: 'create', path: '/queued', content: 'queued' });
        const scan = main.diff({ at: draft });
        const [merged, recovered] = order === 'merge first' ? [await first, await second] : [await second, await first];
        assert.deepEqual(merged, published('second', 'v2'), order);
        assert.equal(recovered, main, order);
        assert.equal((await write).path, '/queued', order);
        assert.deepEqual((await scan).map(change => change.path), ['/queued'], order);
        assert.deepEqual(contentOf(tagDocs(fixture, 'md-main-v2'), modes.managed), before.content, order);
        assert.deepEqual(await main.status({ at: draft }), { at: draft, mainVersion: 'v2' }, order);
    }
});

test('the journal is read for a fork\'s first write only, and again only while a merge is known to hold it', async () => {
    const { fixture, main, restart } = await setup();
    await main.fork({ name: 'other' });
    const write = (drive, at, path) => drive.write({ at, op: 'create', path, content: path });
    // Before any merge there is no journal to read.
    let since = fixture.calls.length;
    await write(main, draft, '/first');
    await write(main, draft, '/second');
    assert.equal(journalFetches(fixture, since).length, 0);
    assert.deepEqual(await main.merge({ at: draft, ...request('first') }), published('first', 'v1'));

    // A client that knows the journal head reads its next slot once per fork.
    const next = ['reservation:2', 'completion:2', 'bookkeeping:2'];
    since = fixture.calls.length;
    await write(main, other, '/other-first');
    assert.deepEqual(journalFetches(fixture, since).map(call => call.request.ids), [next]);
    since = fixture.calls.length;
    for (const path of ['/other-second', '/other-third']) await write(main, other, path);
    for (const path of ['/third', '/fourth']) await write(main, draft, path);
    await main.write({ at: draft, operations: [{ op: 'create', path: '/batch', content: '' }] });
    await main.diff({ at: draft });
    await main.read({ at: draft, path: '/third' });
    await main.checkpoint({ at: draft, name: 'saved' });
    assert.equal(journalFetches(fixture, since).length, 0);

    // A new process finds the head with its first write to each fork, then stops reading.
    const fresh = await restart();
    since = fixture.calls.length;
    await write(fresh, draft, '/fresh-first');
    const cold = journalFetches(fixture, since).length;
    assert(cold >= 1 && cold <= 3, `${cold} journal fetches for a cold first write`);
    since = fixture.calls.length;
    await write(fresh, other, '/fresh-other');
    assert.deepEqual(journalFetches(fixture, since).map(call => call.request.ids), [next]);
    since = fixture.calls.length;
    for (let i = 0; i < 5; i++) {
        await write(fresh, draft, `/fresh-${i}`);
        await write(fresh, other, `/fresh-other-${i}`);
    }
    assert.equal(journalFetches(fixture, since).length, 0);

    // A known hold is confirmed against the journal with one read before each
    // rejection, and the fork that is not held still needs no read.
    stopMain(fixture, 1);
    await assert.rejects(fresh.merge({ at: draft, ...request('second') }), { code: 'MERGE_RESUMABLE' });
    disarm(fixture);
    since = fixture.calls.length;
    await assert.rejects(write(fresh, draft, '/held'), blockedBy('second'));
    await assert.rejects(write(fresh, draft, '/held'), blockedBy('second'));
    assert.deepEqual(journalFetches(fixture, since).map(call => call.request.ids), Array(2).fill(['completion:2', 'bookkeeping:2']));
    since = fixture.calls.length;
    await write(fresh, other, '/not-held');
    assert.equal(journalFetches(fixture, since).length, 0);
    assert.deepEqual(await fresh.merge({ at: draft, ...request('second') }), published('second', 'v2'));
    since = fixture.calls.length;
    await write(fresh, draft, '/settled');
    assert.equal(journalFetches(fixture, since).length, 0);
});
