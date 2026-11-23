import assert from 'node:assert/strict';
import test from 'node:test';
import { create } from '@functional-systems/memdrive';
import { captureMergeSource, prepareMerge } from '../dist/esm/merge-preflight.js';
import { fingerprintOf } from '../dist/esm/records.js';
import { textChunker } from '../dist/esm/text-chunks.js';
import { workingWriter } from '../dist/esm/writes.js';
import { fileClient } from './helpers/file-client.mjs';

const name = 'workspace';
const schema = { label: { type: 'string' } };
const branch = { kind: 'branch', name: 'fork-research' };
const main = { kind: 'branch', name: 'main' };
const fileId = id => `00000000-0000-4000-8000-${id.toString(16).padStart(12, '0')}`;
const idOf = id => `file:${fileId(id)}`;

function original(id, path, fields = {}) {
    return { id: idOf(id), kind: 'file', fileId: fileId(id), path, body: '', modifiedAt: '2026-01-01T00:00:00.000Z',
        chunking: { strategy: 'boundary', version: '1' }, ...fields };
}

async function setup(seeds = []) {
    const fixture = fileClient();
    await create({ client: fixture.client, name, metadataSchema: schema });
    const handle = fixture.client.collection(name);
    const { branches, tags } = fixture.collections.get(name);
    const mainDocs = branches.get('main').docs;
    for (const [id, path] of seeds) mainDocs.set(idOf(id), original(id, path, { version: 'v1', changed: false }));
    await handle.branches.create({ branchName: branch.name, source: main });
    const work = workingWriter(handle, name, branch.name, schema, undefined, textChunker({ strategy: 'auto' }));
    const pending = new Set();
    const capture = (tagName = 'merge-input') => captureMergeSource(handle, branch, tagName, work.enqueueRef, pending);
    const publishFixture = async (tagName = 'published-current') => {
        await handle.tags.create({ tagName, source: main });
        return { kind: 'tag', name: tagName };
    };
    return { fixture, handle, work, mainDocs, branches, tags, capture, publishFixture };
}

test('merge capture is queued between writes and reopens exact frozen originals after the fork changes', async () => {
    const { fixture, work, branches, capture, publishFixture, mainDocs } = await setup([[1, '/original']]);
    const published = await publishFixture();
    const path = '/archive/"draft" * 한글.md';
    const content = '\uFEFF# Draft\r\n  café\t😀\n\u0000\n';
    const metadata = { label: 'before\nnext' };
    const first = work.write({ op: 'update', fileId: fileId(1), newPath: path, content, metadata });
    const frozen = capture();
    const later = work.write({ op: 'update', fileId: fileId(1), content: 'newer', metadata: { label: 'after' } });
    const exact = await first;
    const source = await frozen;
    await later;
    await work.write({ op: 'create', path: '/later', content: 'another file' });
    branches.delete(branch.name);
    mainDocs.set(idOf(1), original(1, path, { version: 'v2', changed: false }));
    const before = fixture.calls.length;

    const reopened = fixture.client.collection(name);
    const plan = await prepareMerge(reopened, name, source, published, schema);
    assert.deepEqual(plan.source, { kind: 'tag', name: source.name });
    assert.deepEqual(plan.publishedMain, published);
    assert.deepEqual(plan.targets.map(target => target.change),
        [{ op: 'update', fileId: fileId(1), previousPath: '/original', path }]);
    assert.deepEqual(plan.targets[0].file, exact);
    assert.equal(plan.targets[0].baseline.version, 'v1');
    assert.deepEqual(await prepareMerge(reopened, name, source, published, schema), plan);
    const requests = fixture.calls.slice(before);
    assert.ok(requests.every(call => ['query', 'fetch'].includes(call.kind) &&
        call.request.ref.kind === 'tag' && call.request.consistentRead === false));
    const pathLookup = requests.find(call => call.kind === 'query' && call.request.ref.name === published.name);
    assert.deepEqual(pathLookup.request.query.bool[1].queryString, { defaultField: 'path', query: path, skipSyntax: true });
    assert.deepEqual(fixture.calls.find(call => call.kind === 'tag-create' && call.request.tagName === source.name).retries,
        { strategy: 'none' });
});

test('merge preflight checks all pinned pages including final-page moves and deletes', async () => {
    const { fixture, handle, work, branches, mainDocs, capture, publishFixture } = await setup([[1000, '/old'], [1001, '/remove']]);
    const sourceDocs = branches.get(branch.name).docs;
    for (let i = 999; i >= 0; i--) {
        const path = `/new/${i}`;
        const doc = original(i, path, { changed: true, fingerprint: await fingerprintOf({ path, content: '' }) });
        sourceDocs.set(doc.id, doc);
    }
    await work.write([
        { op: 'update', fileId: fileId(1000), newPath: '/moved' },
        { op: 'delete', fileId: fileId(1001) },
    ]);
    const source = await capture();
    mainDocs.set(idOf(1002), original(1002, '/unrelated', { version: 'v2', changed: false }));
    const published = await publishFixture();
    fixture.listPage = () => { throw new Error('Eventual document list must not be used'); };

    const plan = await prepareMerge(handle, name, source, published, schema);
    assert.equal(plan.targets.length, 1002);
    assert.deepEqual(plan.targets.slice(-2).map(target => target.change), [
        { op: 'update', fileId: fileId(1000), path: '/moved', previousPath: '/old' },
        { op: 'delete', fileId: fileId(1001), previousPath: '/remove' },
    ]);
    assert.equal(plan.targets.at(-1).file, undefined);
    const pages = fixture.calls.filter(call => call.kind === 'query' && call.request.ref.name === source.name);
    assert.equal(pages.length, 2);
    assert.equal(pages[1].request.query.bool[2].queryString.query, `{${idOf(999)} TO *}`);

    // Only the deleted target changed on main. A late-page conflict still rejects the whole plan.
    mainDocs.get(idOf(1001)).version = 'v3';
    const newer = await publishFixture('published-newer');
    await assert.rejects(prepareMerge(handle, name, source, newer, schema), {
        code: 'MERGE_CONFLICT', details: { fileIds: [fileId(1001)], paths: [] },
    });
});

test('merge preflight accepts a batch that vacates a path and rejects changed baselines or foreign owners', async () => {
    const { handle, work, mainDocs, capture, publishFixture } = await setup([[1, '/left'], [2, '/right'], [3, '/replace']]);
    await work.write({ op: 'update', fileId: fileId(1), newPath: '/temporary' });
    await work.write({ op: 'update', fileId: fileId(2), newPath: '/left' });
    await work.write({ op: 'update', fileId: fileId(1), newPath: '/right' });
    await work.write({ op: 'delete', fileId: fileId(3) });
    await work.write({ op: 'create', path: '/replace', content: 'the replacement' });
    const path = '/foreign/"occupied" * 한글.md';
    await work.write({ op: 'create', path, content: 'new file' });
    const source = await capture();

    const published = await publishFixture();
    assert.equal((await prepareMerge(handle, name, source, published, schema)).targets.length, 5);

    mainDocs.get(idOf(2)).version = 'v2';
    mainDocs.set(idOf(4), original(4, path, { version: 'v2', changed: false }));
    const newer = await publishFixture('published-newer');
    await assert.rejects(prepareMerge(handle, name, source, newer, schema), {
        code: 'MERGE_CONFLICT', details: { fileIds: [fileId(2)], paths: [path] },
    });
});

test('merge preflight fails on missing frozen payloads and inconsistent destination lookups', async () => {
    const { fixture, handle, work, tags, capture, publishFixture } = await setup([[1, '/original']]);
    await work.write({ op: 'update', fileId: fileId(1), content: 'edit' });
    const source = await capture();
    const published = await publishFixture();
    const docs = tags.get(source.name).docs;
    const stored = docs.get(idOf(1));

    fixture.beforeFetch = request => {
        if (request.ref.name === source.name) return { isDocsInline: true, total: 0, docs: [] };
    };
    await assert.rejects(prepareMerge(handle, name, source, published, schema), { code: 'INVALID_RESULT' });
    fixture.beforeFetch = undefined;
    stored.body = 'changed in transit';
    await assert.rejects(prepareMerge(handle, name, source, published, schema), { code: 'INVALID_RESULT' });
    stored.body = 'edit';
    // A text original always records the chunking that produced its chunks.
    const { chunking } = stored;
    delete stored.chunking;
    await assert.rejects(prepareMerge(handle, name, source, published, schema), { code: 'INVALID_RESULT' });
    stored.chunking = chunking;

    fixture.pathLookup = () => ({ isDocsInline: true, total: 0, docs: [] });
    await assert.rejects(prepareMerge(handle, name, source, published, schema), { code: 'INVALID_RESULT' });
    fixture.pathLookup = () => ({ isDocsInline: true, total: 2, docs: [] });
    await assert.rejects(prepareMerge(handle, name, source, published, schema), { code: 'INVALID_RESULT' });
});

test('merge preflight rejects a created original without a fingerprint before any mutation', async () => {
    const { fixture, handle, work, mainDocs, tags, capture, publishFixture } = await setup([[1, '/original']]);
    const created = await work.write({ op: 'create', path: '/created', content: 'new file' });
    const source = await capture();
    const published = await publishFixture();
    assert.deepEqual((await prepareMerge(handle, name, source, published, schema)).targets.map(target => target.change),
        [{ op: 'create', fileId: created.fileId, path: '/created' }]);

    const stored = tags.get(source.name).docs.get(`file:${created.fileId}`);
    assert.match(stored.fingerprint, /^[0-9a-f]{64}$/);
    delete stored.fingerprint;
    const main = structuredClone([...mainDocs]);
    const before = fixture.calls.length;
    await assert.rejects(prepareMerge(handle, name, source, published, schema), { code: 'INVALID_RESULT' });
    assert.ok(fixture.calls.slice(before).every(call => ['query', 'fetch'].includes(call.kind)));
    assert.deepEqual([...mainDocs], main);
});

test('merge capture fences an unconfirmed earlier write and a lost tag response', async () => {
    const { fixture, work, capture, publishFixture, handle } = await setup();
    let apply;
    fixture.beforeUpsert = ({ branch: branchName, docs }) => {
        apply = () => {
            const records = fixture.collections.get(name).branches.get(branchName).docs;
            for (const doc of docs) records.set(doc.id, doc);
        };
        throw new Error('Lost write response');
    };
    await assert.rejects(work.write({ op: 'create', path: '/uncertain', content: '' }), { code: 'WRITE_UNCONFIRMED' });
    await assert.rejects(capture(), { code: 'WRITE_UNCONFIRMED' });
    assert.ok(!fixture.calls.some(call => call.kind === 'tag-create'));
    apply();

    fixture.afterTagCreate = tag => {
        if (tag.name === 'merge-input') throw new Error('Lost tag response');
    };
    await assert.rejects(capture(), { code: 'REF_CREATION_UNCONFIRMED', details: { tag: 'merge-input' } });
    await assert.rejects(capture(), { code: 'REF_CREATION_UNCONFIRMED', details: { tag: 'merge-input' } });
    assert.equal(fixture.calls.filter(call => call.kind === 'tag-create').length, 1);

    const found = await handle.tags.get('merge-input');
    const known = { kind: 'tag', name: found.tag.name };
    fixture.beforeUpsert = undefined;
    await work.write({ op: 'create', path: '/later', content: '' });
    const published = await publishFixture();
    await assert.rejects(prepareMerge(handle, name, known, published, schema), { code: 'INVALID_INPUT' });
    const retried = await capture('merge-input-retry');
    const { targets } = await prepareMerge(handle, name, retried, published, schema);
    assert.deepEqual(targets.map(target => target.file.path).sort(), ['/later', '/uncertain']);
});
