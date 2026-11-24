import assert from 'node:assert/strict';
import test from 'node:test';
import { create } from '@functional-systems/memdrive';
import { applyMerge, advanceMergeSource, verifyMerge } from '../dist/esm/merge-apply.js';
import { prepareMerge } from '../dist/esm/merge-preflight.js';
import { originalId } from '../dist/esm/records.js';
import { textChunker } from '../dist/esm/text-chunks.js';
import { workingWriter } from '../dist/esm/writes.js';
import { fileClient } from './helpers/file-client.mjs';

const name = 'workspace';
const branch = 'fork-research';
const main = { kind: 'branch', name: 'main' };
const schema = { label: { type: 'string' } };
const chunker = textChunker({ strategy: 'auto' });
const rejection = () => Object.assign(new Error('rate limited'), { status: 429 });

// Each test plays the merge that owns the fork: nothing writes to the fork
// between a plan and the bookkeeping of its publication.
async function setup() {
    const fixture = fileClient();
    await create({ client: fixture.client, name, metadataSchema: schema });
    const handle = fixture.client.collection(name);
    const state = fixture.collections.get(name);
    async function tag(name, source = main) {
        await handle.tags.create({ tagName: name, source });
        return { kind: 'tag', name };
    }
    const initial = await tag('initial');
    await handle.branches.create({ branchName: branch, source: initial });
    const writer = workingWriter(handle, name, branch, schema, undefined, chunker);
    const prepare = (previous = initial) => prepareMerge(handle, name, { kind: 'branch', name: branch }, previous, schema);
    // Bookkeeping compares with the plan of the run that published, or, when it is
    // resumed without one, with the version's tag. Each test pins a version as a tag of that name.
    const advance = (version, plan) => advanceMergeSource(handle, name, branch, version,
        plan ? { plan } : { tag: { kind: 'tag', name: version } }, schema);
    /** Publish the fork's changes as `version` and advance its baselines. */
    async function publish(version, previous) {
        const plan = await prepare(previous);
        await applyMerge(handle, name, plan, version);
        const published = await tag(version);
        await verifyMerge(handle, name, plan, version, published);
        await advance(version, plan);
        return published;
    }
    return { fixture, state, handle, writer, initial, tag, prepare, advance, publish };
}

test('replay uses fixed record IDs, retires stale chunks, and verifies the actual pinned listing', async () => {
    const { fixture, state, handle, writer, tag, prepare, advance, publish } = await setup();
    const file = await writer.write({ op: 'create', path: '/before', content: 'prior passage', metadata: { label: 'old' } });
    const v1 = await publish('v1');

    const moved = { op: 'update', fileId: file.fileId, newPath: '/folder/after:"', content: 'published passage', metadata: {} };
    await writer.write(moved);
    const plan = await prepare(v1);
    fixture.beforeDelete = request => {
        if (request.branch === 'main') throw rejection();
    };
    await assert.rejects(applyMerge(handle, name, plan, 'v2'), { code: 'DATABASE_ERROR', status: 429 });
    const partial = fixture.calls.findLast(call => call.kind === 'upsert' && call.request.branch === 'main').request;
    fixture.beforeDelete = undefined;
    // A resumed merge plans the untouched fork again and replays the same records.
    assert.deepEqual(await prepare(v1), plan);
    await applyMerge(handle, name, plan, 'v2');
    const replay = fixture.calls.findLast(call => call.kind === 'upsert' && call.request.branch === 'main').request;
    assert.deepEqual(replay, partial);
    assert.equal(state.tags.get(v1.name).docs.get(originalId(file.fileId)).body, 'prior passage');

    await verifyMerge(handle, name, plan, 'v2', main);
    const v2 = await tag('v2');
    fixture.pathLookup = request => request.ref.name === v2.name && { isDocsInline: true, total: 0, docs: [] };
    await assert.rejects(verifyMerge(handle, name, plan, 'v2', v2), { code: 'INVALID_RESULT' });
    fixture.pathLookup = undefined;
    await verifyMerge(handle, name, plan, 'v2', v2);
    const published = [...state.tags.get(v2.name).docs.values()];
    assert.equal(published.length, 2);
    const chunk = published.find(doc => doc.kind === 'chunk');
    const original = published.find(doc => doc.kind === 'file');
    assert.equal(chunk.content, moved.content);
    assert.equal(chunk.path, moved.newPath);
    assert.equal(original.body, moved.content);
    assert.equal(original.version, 'v2');
    assert.equal(original.metadata, undefined);
    for (const field of ['changed', 'baseline', 'fingerprint']) assert.equal(Object.hasOwn(original, field), false);

    // Bookkeeping leaves no change; a later edit is a change against the new baseline.
    await advance('v2', plan);
    assert.deepEqual(await writer.diff(), []);
    await writer.write({ op: 'update', fileId: file.fileId, content: 'next passage' });
    assert.deepEqual(await writer.diff(), [{ op: 'update', fileId: file.fileId, path: moved.newPath }]);
    const next = await prepare(v2);
    assert.equal(next.targets[0].file.content, 'next passage');
    assert.equal(next.targets[0].baseline.version, 'v2');
});

test('a published creation that is deleted and replaced afterwards publishes the deletion by file ID', async () => {
    const { state, writer, advance, publish } = await setup();
    const created = await writer.write({ op: 'create', path: '/notes', content: 'published' });
    const v1 = await publish('v1');
    // A repeated bookkeeping pass finds nothing left to advance.
    await advance('v1');
    assert.deepEqual(await writer.diff(), []);

    await writer.write({ op: 'delete', fileId: created.fileId });
    const replacement = await writer.write({ op: 'create', path: '/notes', content: 'replacement' });
    const diff = await writer.diff();
    assert.deepEqual(diff.find(change => change.fileId === created.fileId),
        { op: 'delete', fileId: created.fileId, previousPath: '/notes' });
    assert.deepEqual(diff.find(change => change.fileId === replacement.fileId),
        { op: 'create', fileId: replacement.fileId, path: '/notes' });

    const v2 = await publish('v2', v1);
    assert.deepEqual(await writer.diff(), []);
    assert.ok(![...state.tags.get(v2.name).docs.values()].some(doc => doc.fileId === created.fileId));
    assert.equal(state.tags.get(v2.name).docs.get(originalId(replacement.fileId)).body, 'replacement');
    // The published deletion leaves no record of the file on the fork.
    assert.equal(state.branches.get(branch).docs.has(originalId(created.fileId)), false);
});

test('source bookkeeping resumes a partial pass from the fork alone, even where the merge plan no longer holds', async () => {
    const { fixture, state, handle, writer, tag, prepare, advance, publish } = await setup();
    // Roles follow ID order, which is also bookkeeping order: the first file
    // vacates its path, the second takes that path and the third is deleted.
    const [first, second, removed] = (await writer.write(['/a', '/b', '/c'].map(path => ({ op: 'create', path, content: path }))))
        .sort((a, b) => a.fileId < b.fileId ? -1 : 1);
    const v1 = await publish('v1');
    await writer.write({ op: 'update', fileId: first.fileId, newPath: '/vacated-to' });
    await writer.write({ op: 'update', fileId: second.fileId, newPath: first.path });
    await writer.write({ op: 'delete', fileId: removed.fileId });
    const plan = await prepare(v1);
    assert.equal(plan.targets.length, 3);
    await applyMerge(handle, name, plan, 'v2');
    const v2 = await tag('v2');
    await verifyMerge(handle, name, plan, 'v2', v2);

    // Stop after the first original is advanced.
    let mutations = 0;
    const stop = request => { if (request.branch === branch && ++mutations > 1) throw rejection(); };
    fixture.beforeUpsert = fixture.beforeDelete = stop;
    await assert.rejects(advance('v2', plan), { code: 'DATABASE_ERROR', status: 429 });
    fixture.beforeUpsert = fixture.beforeDelete = undefined;
    assert.deepEqual((await writer.diff()).map(change => change.fileId), [second.fileId, removed.fileId]);
    // The half-advanced fork cannot be planned against the prior version again:
    // the vacated path now looks occupied. Bookkeeping must not depend on a plan.
    await assert.rejects(prepare(v1), { code: 'MERGE_CONFLICT', details: { fileIds: [], paths: [first.path] } });

    await advance('v2');
    assert.deepEqual(await writer.diff(), []);
    const docs = state.branches.get(branch).docs;
    for (const [file, path] of [[first, '/vacated-to'], [second, first.path]]) {
        const doc = docs.get(originalId(file.fileId));
        assert.deepEqual([doc.path, doc.changed, doc.version, doc.baseline.version, doc.baseline.path, doc.baseline.fingerprint],
            [path, false, 'v2', 'v2', path, doc.fingerprint]);
    }
    assert.equal(docs.has(originalId(removed.fileId)), false);
    // The next merge starts from the advanced baselines.
    assert.deepEqual((await prepare(v2)).targets, []);
});

test('source bookkeeping advances only originals whose current state was published, by the plan or by the version tag', async () => {
    for (const known of ['plan', 'tag']) {
        const { fixture, state, handle, writer, tag, prepare, advance, publish } = await setup();
        const [updated, moved, removed, untouched] = await writer.write(['/a', '/b', '/c', '/d'].map(path => ({ op: 'create', path, content: path })));
        const v1 = await publish('v1');
        await writer.write([{ op: 'update', fileId: updated.fileId, content: 'published edit' }, { op: 'update', fileId: moved.fileId, newPath: '/moved' },
            { op: 'delete', fileId: removed.fileId }]);
        const created = await writer.write({ op: 'create', path: '/created', content: 'published creation' });
        const plan = await prepare(v1);
        await applyMerge(handle, name, plan, 'v2');
        const v2 = await tag('v2');
        await verifyMerge(handle, name, plan, 'v2', v2);

        // Writes reach the fork between publication and bookkeeping. This writer has no hold.
        await writer.write({ op: 'update', fileId: updated.fileId, content: 'unpublished edit' });
        await writer.write({ op: 'delete', fileId: moved.fileId });
        await writer.write({ op: 'update', fileId: untouched.fileId, metadata: { label: 'unpublished' } });
        const slipped = await writer.write({ op: 'create', path: '/slipped', content: 'unpublished creation' });
        const docs = state.branches.get(branch).docs;
        const kept = structuredClone([updated, moved, untouched, slipped].map(file => docs.get(originalId(file.fileId))));

        const before = fixture.calls.length;
        await advance('v2', known === 'plan' ? plan : undefined);
        const calls = fixture.calls.slice(before);
        // The plan needs no request. Without it, one read of the version covers the batch.
        assert.deepEqual(calls.filter(call => call.request?.ref?.name === 'v2').map(call => [call.kind, call.request.ids.length]),
            known === 'plan' ? [] : [['fetch', 6]], known);
        // The scan, the batch read, and a mutation with its confirming read per advanced original.
        assert.equal(calls.length, known === 'plan' ? 6 : 7, known);
        assert.deepEqual(calls.filter(call => call.kind === 'upsert').map(call => call.request.docs[0].id), [originalId(created.fileId)], known);
        assert.deepEqual(calls.filter(call => call.kind === 'delete').map(call => call.request.ids), [[originalId(removed.fileId)]], known);
        // The published creation and deletion are settled; everything else is left as it was.
        const advanced = docs.get(originalId(created.fileId));
        assert.deepEqual([advanced.changed, advanced.version, advanced.baseline.version], [false, 'v2', 'v2'], known);
        assert.equal(docs.has(originalId(removed.fileId)), false, known);
        assert.deepEqual([updated, moved, untouched, slipped].map(file => docs.get(originalId(file.fileId))), kept, known);
        const byId = changes => new Map(changes.map(change => [change.fileId, change]));
        assert.deepEqual(byId(await writer.diff()), byId([
            { op: 'update', fileId: updated.fileId, path: '/a' },
            { op: 'delete', fileId: moved.fileId, previousPath: '/b' },
            { op: 'update', fileId: untouched.fileId, path: '/d' },
            { op: 'create', fileId: slipped.fileId, path: '/slipped' }]), known);

        // A repeated pass, on either basis, reads again and changes nothing.
        const again = fixture.calls.length;
        await advance('v2', plan);
        await advance('v2');
        assert(fixture.calls.slice(again).every(call => call.kind === 'query' || call.kind === 'fetch'), known);
        // The leftovers are ordinary changes: main moved past the baselines of the two files it published.
        await assert.rejects(prepare(v2), error => error.code === 'MERGE_CONFLICT'
            && JSON.stringify([...error.details.fileIds].sort()) === JSON.stringify([updated.fileId, moved.fileId].sort()), known);
    }
});

test('unknown mutation outcomes stop application and source bookkeeping, and a repeated pass completes them', async () => {
    const { fixture, handle, writer, tag, prepare, advance } = await setup();
    const file = await writer.write({ op: 'create', path: '/notes', content: 'published' });
    const plan = await prepare();
    fixture.afterUpsert = request => {
        if (request.branch === 'main') throw new Error('lost acknowledgment');
    };
    await assert.rejects(applyMerge(handle, name, plan, 'v1'), { code: 'MERGE_MUTATION_UNCONFIRMED' });
    assert.equal(fixture.calls.filter(call => call.kind === 'upsert' && call.request.branch === 'main').length, 1);
    fixture.afterUpsert = undefined;
    await applyMerge(handle, name, plan, 'v1');
    await tag('v1');

    fixture.afterUpsert = request => {
        if (request.docs[0].baseline?.version === 'v1') throw new Error('lost acknowledgment');
    };
    await assert.rejects(advance('v1', plan), { code: 'MERGE_MUTATION_UNCONFIRMED' });
    fixture.afterUpsert = undefined;
    // The publication module stops this client here and rejects writes to the
    // fork. A replacement owner repeats the pass before the fork is written again.
    const recovered = workingWriter(handle, name, branch, schema, undefined, chunker);
    await advance('v1');
    assert.deepEqual(await recovered.diff(), []);
    const later = { op: 'update', fileId: file.fileId, content: 'later' };
    assert.equal((await recovered.write(later)).content, 'later');
    assert.equal((await recovered.diff())[0].op, 'update');
});

test('publication copies the exact persisted vectors of the fork\'s chunks, including after a move', async () => {
    const { fixture, state, writer, publish } = await setup();
    const saved = await writer.write({ op: 'create', path: '/old', content: 'original passage', metadata: { label: 'old' } });
    // Persist the vector the backend would infer for the working chunk.
    const vector = [0.125, ...Array(1535).fill(0)];
    for (const doc of state.branches.get(branch).docs.values()) if (doc.kind === 'chunk') doc.embedding = vector;
    let inferred = 0;
    fixture.afterUpsert = ({ branch, docs }) => {
        if (branch === 'main') inferred += docs.filter(doc => doc.kind === 'chunk' && doc.embedding === undefined).length;
    };
    const v1 = await publish('v1');

    await writer.write({ op: 'update', fileId: saved.fileId, newPath: '/new' });
    const v2 = await publish('v2', v1);
    assert.equal(inferred, 0);
    for (const [version, path] of [[v1, '/old'], [v2, '/new']]) {
        const chunks = [...state.tags.get(version.name).docs.values()].filter(doc => doc.kind === 'chunk');
        assert.equal(chunks.length, 1);
        assert.equal(chunks[0].path, path);
        assert.equal(chunks[0].content, saved.content);
        assert.equal(chunks[0].embeddingText, saved.content);
        assert.deepEqual(chunks[0].metadata, { label: 'old' });
        assert.deepEqual(chunks[0].embedding, vector);
    }
});
