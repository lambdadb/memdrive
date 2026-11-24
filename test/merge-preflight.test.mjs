import assert from 'node:assert/strict';
import test from 'node:test';
import { create } from '@functional-systems/memdrive';
import { prepareMerge } from '../dist/esm/merge-preflight.js';
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
    const { branches } = fixture.collections.get(name);
    const mainDocs = branches.get('main').docs;
    for (const [id, path] of seeds) mainDocs.set(idOf(id), original(id, path, { version: 'v1', changed: false }));
    await handle.branches.create({ branchName: branch.name, source: main });
    const work = workingWriter(handle, name, branch.name, schema, undefined, textChunker({ strategy: 'auto' }));
    const publishFixture = async (tagName = 'published-current') => {
        await handle.tags.create({ tagName, source: main });
        return { kind: 'tag', name: tagName };
    };
    const forkDocs = branches.get(branch.name).docs;
    return { fixture, handle, work, mainDocs, forkDocs, publishFixture };
}
const changePage = call => call.kind === 'query' && call.request.query.bool?.[1]?.queryString?.defaultField === 'changed';

test('merge preflight reads exact originals from the working fork with consistent reads and plans the same merge again', async () => {
    const { fixture, handle, work, publishFixture, mainDocs } = await setup([[1, '/original']]);
    const published = await publishFixture();
    const path = '/archive/"draft" * 한글.md';
    const content = '\uFEFF# Draft\r\n  café\t😀\n\u0000\n';
    const metadata = { label: 'before\nnext' };
    const exact = await work.write({ op: 'update', fileId: fileId(1), newPath: path, content, metadata });
    // Writable main moves on; the plan compares against the published version only.
    mainDocs.set(idOf(1), original(1, path, { version: 'v2', changed: false }));
    const before = fixture.calls.length;

    const reopened = fixture.client.collection(name);
    const plan = await prepareMerge(reopened, name, branch, published, schema);
    assert.deepEqual(plan.source, branch);
    assert.deepEqual(plan.publishedMain, published);
    assert.deepEqual(plan.targets.map(target => target.change),
        [{ op: 'update', fileId: fileId(1), previousPath: '/original', path }]);
    assert.deepEqual(plan.targets[0].file, exact);
    assert.equal(plan.targets[0].baseline.version, 'v1');
    // An untouched fork yields the same plan, as a resumed merge requires.
    assert.deepEqual(await prepareMerge(reopened, name, branch, published, schema), plan);
    const requests = fixture.calls.slice(before);
    assert.ok(requests.every(call => ['query', 'fetch'].includes(call.kind)));
    // The fork is read like the fork's own reads; published main is a pinned tag.
    for (const { request } of requests)
        assert.deepEqual([request.ref.kind, request.consistentRead], request.ref.name === branch.name ? ['branch', true] : ['tag', false]);
    assert.deepEqual([...new Set(requests.map(call => call.request.ref.name))].sort(), [branch.name, published.name].sort());
    const pathLookup = requests.find(call => call.kind === 'query' && call.request.ref.name === published.name);
    assert.deepEqual(pathLookup.request.query.bool[1].queryString, { defaultField: 'path', query: path, skipSyntax: true });
    // Only a working fork is a merge source.
    await assert.rejects(prepareMerge(reopened, name, published, published, schema), { code: 'INVALID_INPUT' });
});

test('merge preflight checks all source pages including final-page moves and deletes', async () => {
    const { fixture, handle, work, forkDocs: sourceDocs, mainDocs, publishFixture } = await setup([[1000, '/old'], [1001, '/remove']]);
    for (let i = 999; i >= 0; i--) {
        const path = `/new/${i}`;
        const doc = original(i, path, { changed: true, fingerprint: await fingerprintOf({ path, content: '' }) });
        sourceDocs.set(doc.id, doc);
    }
    await work.write([
        { op: 'update', fileId: fileId(1000), newPath: '/moved' },
        { op: 'delete', fileId: fileId(1001) },
    ]);
    mainDocs.set(idOf(1002), original(1002, '/unrelated', { version: 'v2', changed: false }));
    const published = await publishFixture();
    fixture.listPage = () => { throw new Error('Eventual document list must not be used'); };
    const before = fixture.calls.length;

    const plan = await prepareMerge(handle, name, branch, published, schema);
    assert.equal(plan.targets.length, 1002);
    assert.deepEqual(plan.targets.slice(-2).map(target => target.change), [
        { op: 'update', fileId: fileId(1000), path: '/moved', previousPath: '/old' },
        { op: 'delete', fileId: fileId(1001), previousPath: '/remove' },
    ]);
    assert.equal(plan.targets.at(-1).file, undefined);
    const pages = fixture.calls.slice(before).filter(changePage);
    assert.equal(pages.length, 2);
    assert(pages.every(call => call.request.ref.name === branch.name));
    assert.equal(pages[1].request.query.bool[2].queryString.query, `{${idOf(999)} TO *}`);

    // Only the deleted target changed on main. A late-page conflict still rejects the whole plan.
    mainDocs.get(idOf(1001)).version = 'v3';
    const newer = await publishFixture('published-newer');
    await assert.rejects(prepareMerge(handle, name, branch, newer, schema), {
        code: 'MERGE_CONFLICT', details: { fileIds: [fileId(1001)], paths: [] },
    });
});

test('merge preflight accepts a batch that vacates a path and rejects changed baselines or foreign owners', async () => {
    const { handle, work, mainDocs, publishFixture } = await setup([[1, '/left'], [2, '/right'], [3, '/replace']]);
    await work.write({ op: 'update', fileId: fileId(1), newPath: '/temporary' });
    await work.write({ op: 'update', fileId: fileId(2), newPath: '/left' });
    await work.write({ op: 'update', fileId: fileId(1), newPath: '/right' });
    await work.write({ op: 'delete', fileId: fileId(3) });
    await work.write({ op: 'create', path: '/replace', content: 'the replacement' });
    const path = '/foreign/"occupied" * 한글.md';
    await work.write({ op: 'create', path, content: 'new file' });

    const published = await publishFixture();
    assert.equal((await prepareMerge(handle, name, branch, published, schema)).targets.length, 5);

    mainDocs.get(idOf(2)).version = 'v2';
    mainDocs.set(idOf(4), original(4, path, { version: 'v2', changed: false }));
    const newer = await publishFixture('published-newer');
    await assert.rejects(prepareMerge(handle, name, branch, newer, schema), {
        code: 'MERGE_CONFLICT', details: { fileIds: [fileId(2)], paths: [path] },
    });
});

test('merge preflight fails on missing source payloads and inconsistent destination lookups', async () => {
    const { fixture, handle, work, forkDocs, publishFixture } = await setup([[1, '/original']]);
    await work.write({ op: 'update', fileId: fileId(1), content: 'edit' });
    const published = await publishFixture();
    const stored = forkDocs.get(idOf(1));
    const prepare = () => prepareMerge(handle, name, branch, published, schema);

    fixture.beforeFetch = request => {
        if (request.ref.name === branch.name) return { isDocsInline: true, total: 0, docs: [] };
    };
    await assert.rejects(prepare(), { code: 'INVALID_RESULT' });
    fixture.beforeFetch = undefined;
    stored.body = 'changed in transit';
    await assert.rejects(prepare(), { code: 'INVALID_RESULT' });
    stored.body = 'edit';
    // A text original always records the chunking that produced its chunks.
    const { chunking } = stored;
    delete stored.chunking;
    await assert.rejects(prepare(), { code: 'INVALID_RESULT' });
    stored.chunking = chunking;

    fixture.pathLookup = () => ({ isDocsInline: true, total: 0, docs: [] });
    await assert.rejects(prepare(), { code: 'INVALID_RESULT' });
    fixture.pathLookup = () => ({ isDocsInline: true, total: 2, docs: [] });
    await assert.rejects(prepare(), { code: 'INVALID_RESULT' });
});

test('merge preflight rejects a created original without a fingerprint before any mutation', async () => {
    const { fixture, handle, work, mainDocs, forkDocs, publishFixture } = await setup([[1, '/original']]);
    const created = await work.write({ op: 'create', path: '/created', content: 'new file' });
    const published = await publishFixture();
    assert.deepEqual((await prepareMerge(handle, name, branch, published, schema)).targets.map(target => target.change),
        [{ op: 'create', fileId: created.fileId, path: '/created' }]);

    const stored = forkDocs.get(`file:${created.fileId}`);
    assert.match(stored.fingerprint, /^[0-9a-f]{64}$/);
    delete stored.fingerprint;
    const main = structuredClone([...mainDocs]);
    const before = fixture.calls.length;
    await assert.rejects(prepareMerge(handle, name, branch, published, schema), { code: 'INVALID_RESULT' });
    assert.ok(fixture.calls.slice(before).every(call => ['query', 'fetch'].includes(call.kind)));
    assert.deepEqual([...mainDocs], main);
});
