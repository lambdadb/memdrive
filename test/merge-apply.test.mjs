import assert from 'node:assert/strict';
import test from 'node:test';
import { create } from '@functional-systems/memdrive';
import { applyMerge, advanceMergeSource, verifyMerge } from '../dist/esm/merge-apply.js';
import { confirmedMergeSource, prepareMerge } from '../dist/esm/merge-preflight.js';
import { originalId } from '../dist/esm/records.js';
import { textChunker } from '../dist/esm/text-chunks.js';
import { workingWriter } from '../dist/esm/writes.js';
import { fileClient } from './helpers/file-client.mjs';

const name = 'workspace';
const branch = 'fork-research';
const main = { kind: 'branch', name: 'main' };
const schema = { label: { type: 'string' } };
const chunker = textChunker({ strategy: 'auto' });

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
    async function prepare(tagName, previous = initial) {
        await writer.enqueueRef(() => tag(tagName, { kind: 'branch', name: branch }));
        return prepareMerge(handle, name, confirmedMergeSource(handle, tagName), previous, schema);
    }
    return { fixture, state, handle, writer, initial, tag, prepare };
}

test('replay uses fixed record IDs, retires stale chunks, and verifies the actual pinned listing', async () => {
    const { fixture, state, handle, writer, tag, prepare } = await setup();
    const file = await writer.write({ op: 'create', path: '/before', content: 'prior passage', metadata: { label: 'old' } });
    const old = await prepare('old');
    await applyMerge(handle, name, old, 'v1');
    const v1 = await tag('v1');
    await advanceMergeSource(handle, name, old, 'v1', schema, writer.enqueueBaseline);

    const moved = { op: 'update', fileId: file.fileId, newPath: '/folder/after:"', content: 'frozen passage', metadata: {} };
    await writer.write(moved);
    const plan = await prepare('new', v1);
    await writer.write({ op: 'update', fileId: file.fileId, content: 'next passage' });
    fixture.beforeDelete = request => {
        if (request.branch === 'main') throw Object.assign(new Error('rate limited'), { status: 429 });
    };
    await assert.rejects(applyMerge(handle, name, plan, 'v2'), { code: 'DATABASE_ERROR', status: 429 });
    const partial = fixture.calls.findLast(call => call.kind === 'upsert' && call.request.branch === 'main').request;
    fixture.beforeDelete = undefined;
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

    await advanceMergeSource(handle, name, plan, 'v2', schema, writer.enqueueBaseline);
    assert.deepEqual(await writer.diff(), [{ op: 'update', fileId: file.fileId, path: moved.newPath }]);
    const next = await prepare('next', v2);
    assert.equal(next.targets[0].file.content, 'next passage');
    assert.equal(next.targets[0].baseline.version, 'v2');
});

test('later deletion of a captured creation survives source bookkeeping and publishes by file ID', async () => {
    const { state, handle, writer, tag, prepare } = await setup();
    const created = await writer.write({ op: 'create', path: '/notes', content: 'captured' });
    const plan = await prepare('capture');
    await writer.write({ op: 'delete', fileId: created.fileId });
    const replacement = await writer.write({ op: 'create', path: '/notes', content: 'replacement' });
    await applyMerge(handle, name, plan, 'v1');
    const v1 = await tag('v1');

    await advanceMergeSource(handle, name, plan, 'v1', schema, writer.enqueueBaseline);
    await advanceMergeSource(handle, name, plan, 'v1', schema, writer.enqueueBaseline);
    const diff = await writer.diff();
    assert.deepEqual(diff.find(change => change.fileId === created.fileId),
        { op: 'delete', fileId: created.fileId, previousPath: '/notes' });
    assert.deepEqual(diff.find(change => change.fileId === replacement.fileId),
        { op: 'create', fileId: replacement.fileId, path: '/notes' });

    const next = await prepare('next', v1);
    await applyMerge(handle, name, next, 'v2');
    const v2 = await tag('v2');
    await verifyMerge(handle, name, next, 'v2', v2);
    await advanceMergeSource(handle, name, next, 'v2', schema, writer.enqueueBaseline);
    assert.deepEqual(await writer.diff(), []);
    assert.ok(![...state.tags.get(v2.name).docs.values()].some(doc => doc.fileId === created.fileId));
    assert.equal(state.tags.get(v2.name).docs.get(originalId(replacement.fileId)).body, 'replacement');
});

test('unknown mutation outcomes stop application and fence later source writes until owner recovery', async () => {
    const { fixture, handle, writer, prepare } = await setup();
    const file = await writer.write({ op: 'create', path: '/notes', content: 'captured' });
    const plan = await prepare('capture');
    fixture.afterUpsert = request => {
        if (request.branch === 'main') throw new Error('lost acknowledgment');
    };
    await assert.rejects(applyMerge(handle, name, plan, 'v1'), { code: 'MERGE_MUTATION_UNCONFIRMED' });
    assert.equal(fixture.calls.filter(call => call.kind === 'upsert' && call.request.branch === 'main').length, 1);
    fixture.afterUpsert = undefined;
    await applyMerge(handle, name, plan, 'v1');

    const later = { op: 'update', fileId: file.fileId, content: 'later' };
    fixture.afterUpsert = request => {
        if (request.docs[0].baseline?.version === 'v1') throw new Error('lost acknowledgment');
    };
    await assert.rejects(advanceMergeSource(handle, name, plan, 'v1', schema, writer.enqueueBaseline),
        { code: 'MERGE_MUTATION_UNCONFIRMED' });
    await assert.rejects(writer.write(later), { code: 'MERGE_MUTATION_UNCONFIRMED' });
    fixture.afterUpsert = undefined;
    const recovered = workingWriter(handle, name, branch, schema, undefined, chunker);
    await advanceMergeSource(handle, name, plan, 'v1', schema, recovered.enqueueBaseline);
    assert.equal((await recovered.write(later)).content, 'later');
    assert.equal((await recovered.diff())[0].op, 'update');
});

test('publication copies the exact persisted vectors of the captured chunks, including after a move', async () => {
    const { fixture, state, handle, writer, tag, prepare } = await setup();
    const saved = await writer.write({ op: 'create', path: '/old', content: 'original passage', metadata: { label: 'old' } });
    // Persist the vector the backend would infer for the working chunk.
    const vector = [0.125, ...Array(1535).fill(0)];
    for (const doc of state.branches.get(branch).docs.values()) if (doc.kind === 'chunk') doc.embedding = vector;
    let inferred = 0;
    fixture.afterUpsert = ({ branch, docs }) => {
        if (branch === 'main') inferred += docs.filter(doc => doc.kind === 'chunk' && doc.embedding === undefined).length;
    };
    const plan = await prepare('old');
    await applyMerge(handle, name, plan, 'v1');
    const v1 = await tag('v1');
    await verifyMerge(handle, name, plan, 'v1', v1);
    await advanceMergeSource(handle, name, plan, 'v1', schema, writer.enqueueBaseline);

    await writer.write({ op: 'update', fileId: saved.fileId, newPath: '/new' });
    const move = await prepare('move', v1);
    await applyMerge(handle, name, move, 'v2');
    const v2 = await tag('v2');
    await verifyMerge(handle, name, move, 'v2', v2);
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
