import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { create, open } from '@functional-systems/memdrive';
// Internal test hook of the same module instance the package root loads; not part of the public API.
import { queueSizes } from '../dist/esm/branch-queue.js';
import { fileClient } from './helpers/file-client.mjs';

// The CommonJS build is a separate SDK copy with its own branch queues, like another process.
const separateCopy = createRequire(import.meta.url)('@functional-systems/memdrive');
const name = 'append-store';
const append = (target, content) => ({ op: 'append', ...target, content });
const mutationKinds = new Set(['upsert', 'update', 'delete', 'tag-create', 'alias-create', 'alias-retarget', 'branch-rollback']);
const tick = () => new Promise(resolve => setImmediate(resolve));

async function setup(options = {}) {
    const fixture = fileClient();
    const drive = await create({ client: fixture.client, name, ...options });
    const docs = (branch = 'main') => fixture.collections.get(name).branches.get(branch).docs;
    const mutations = () => fixture.calls.filter(call => mutationKinds.has(call.kind)).length;
    return { fixture, drive, docs, mutations };
}

test.afterEach(() => assert.deepEqual(queueSizes(), []));

test('append by fileId or by path adds content after one line break, and by path creates a missing file as create would', async () => {
    const { drive } = await setup();
    const by = { user: 'alice' }, time = new Date('2026-01-02T03:04:05.006Z'), later = new Date('2026-02-03T04:05:06.007Z');
    const created = await drive.write({ ...append({ path: '/log.md' }, 'First.'), by, time });
    const reference = await drive.write({ op: 'create', path: '/reference.md', content: 'First.', by, time });
    // The same result and record fields as a create, with default chunking.
    assert.deepEqual({ ...created, fileId: 'id' }, { ...reference, fileId: 'id', path: '/log.md' });
    assert.deepEqual(created, { fileId: created.fileId, path: '/log.md', createdAt: time.toISOString(), createdBy: by,
        modifiedAt: time.toISOString(), modifiedBy: by, content: 'First.' });
    const byPath = await drive.write({ ...append({ path: '/log.md' }, 'Second.\n'), by: { agent: 'scribe' }, time: later });
    assert.deepEqual(byPath, { ...created, modifiedAt: later.toISOString(), modifiedBy: { agent: 'scribe' }, content: 'First.\nSecond.\n' });
    const byId = await drive.write(append({ fileId: created.fileId }, 'Third.'));
    assert.equal(byId.content, 'First.\nSecond.\nThird.');
    assert.deepEqual(await drive.read({ fileId: created.fileId }), byId);

    // Existing content ending with a line break of the SDK's line model (\n, \r\n or a lone \r) gets no separator; empty content none either.
    for (const [index, [existing, expected]] of [['a\n', 'a\nb'], ['a\r\n', 'a\r\nb'], ['a', 'a\nb'], ['a\r', 'a\rb'], ['', 'b'], ['\n', '\nb'], ['a\r\r', 'a\r\rb']].entries()) {
        const file = await drive.write({ op: 'create', path: `/break-${index}.md`, content: existing });
        assert.equal((await drive.write(append({ fileId: file.fileId }, 'b'))).content, expected, JSON.stringify(existing));
    }
    // A fork appends on its own branch.
    await drive.fork({ name: 'draft' });
    await drive.write({ at: { kind: 'fork', name: 'draft' }, ...append({ path: '/log.md' }, 'Draft only.') });
    assert.equal((await drive.read({ path: '/log.md' })).content, 'First.\nSecond.\nThird.');
    assert.equal((await drive.read({ at: { kind: 'fork', name: 'draft' }, path: '/log.md' })).content, 'First.\nSecond.\nThird.\nDraft only.');
});

test('the path lookup of an append by path is a consistent read of the written branch, on main and on a fork', async () => {
    const { fixture, drive } = await setup();
    await drive.write({ op: 'create', path: '/log.md', content: 'Main.' });
    await drive.fork({ name: 'draft' });
    for (const [at, branch] of [[undefined, 'main'], [{ kind: 'fork', name: 'draft' }, 'fork-draft']]) {
        for (const path of ['/log.md', '/new.md']) {
            const start = fixture.calls.length;
            await drive.write({ ...(at ? { at } : {}), ...append({ path }, 'Entry.') });
            // The lookup is the call's first query; a creating append then also checks its destination.
            const lookup = fixture.calls.slice(start).find(call => call.kind === 'query').request;
            assert.deepEqual(lookup, { size: 1000, ref: { kind: 'branch', name: branch }, consistentRead: true, includeVectors: false,
                query: { bool: [{ queryString: { query: '"file"', defaultField: 'kind' }, occur: 'filter' },
                    { queryString: { defaultField: 'path', query: JSON.stringify(path) }, occur: 'filter' }] },
                fields: { include: ['id', 'kind', 'fileId', 'path'] } }, `${branch} ${path}`);
        }
    }
    assert.deepEqual([(await drive.read({ path: '/log.md' })).content, (await drive.read({ at: { kind: 'fork', name: 'draft' }, path: '/log.md' })).content],
        ['Main.\nEntry.', 'Main.\nEntry.']);
});

test('append replaces the chunks: the old generation is removed and search and findText see only the new text', async () => {
    const { drive, docs } = await setup();
    const file = await drive.write({ op: 'create', path: '/notes.md', content: 'Alpha entry.' });
    const before = [...docs().values()].filter(doc => doc.kind === 'chunk').map(doc => doc.id);
    await drive.write(append({ path: '/notes.md' }, 'Omega entry.'));
    const original = docs().get(`file:${file.fileId}`);
    const chunks = [...docs().values()].filter(doc => doc.kind === 'chunk');
    assert(chunks.length > 0 && chunks.every(chunk => chunk.id.endsWith(`:${original.generation}`) && chunk.revision === original.revision));
    assert(before.every(id => !docs().has(id)), 'the created generation is gone');
    assert.equal(chunks.map(chunk => chunk.content).join('\n'), 'Alpha entry.\nOmega entry.');
    const hits = (await drive.search({ query: 'omega', rerank: false })).hits;
    assert(hits.length > 0 && hits.every(hit => hit.fileId === file.fileId) && hits.some(hit => hit.content.includes('Omega entry.')));
    assert.deepEqual((await drive.findText({ query: 'omega' })).hits.map(hit => [hit.fileId, hit.range.startLine]), [[file.fileId, 2]]);
});

test('append reports a missing file and shared paths like update and read, and invalid requests fail before storage access', async () => {
    const { fixture, drive, mutations } = await setup();
    const missing = '00000000-0000-4000-8000-000000000000';
    await assert.rejects(drive.write(append({ fileId: missing }, 'x')), { code: 'FILE_NOT_FOUND', details: { fileId: missing } });
    await assert.rejects(drive.write({ op: 'update', fileId: missing, content: 'x' }), { code: 'FILE_NOT_FOUND', details: { fileId: missing } });
    const file = await drive.write({ op: 'create', path: '/a.md', content: 'a' });
    const before = fixture.calls.length;
    for (const request of [{ op: 'append', content: 'x' }, append({ path: '/a.md', fileId: file.fileId }, 'x'), append({ path: '/a.md' }, ''),
        append({ path: '/a.md' }, 1), { op: 'append', path: '/a.md' }, append({ path: '/a.md' }, '\ud800'), append({ path: 'a.md' }, 'x'),
        append({ fileId: 'a.md' }, 'x'), { ...append({ fileId: file.fileId }, 'x'), newPath: '/b.md' },
        { ...append({ path: '/a.md' }, 'x'), metadata: {} }, { ...append({ fileId: file.fileId }, 'x'), edits: [{ oldText: 'a', newText: 'b' }] },
        { operations: [append({ path: '/a.md' }, 'x'), { ...append({ path: '/b.md' }, 'x'), metadata: {} }] }])
        await assert.rejects(drive.write(request), { code: 'INVALID_INPUT' }, JSON.stringify(request));
    assert.equal(fixture.calls.length, before, 'validation reads and writes nothing');

    // Files that share a path after racing creates in separate SDK copies make an append by path ambiguous.
    const other = await separateCopy.open({ client: { ...fixture.client }, name });
    let arrived = 0, release;
    const bothChecked = new Promise(resolve => { release = resolve; });
    fixture.beforeUpsert = async () => { if (++arrived === 2) release(); await bothChecked; };
    const [one, two] = await Promise.all([drive.write(append({ path: '/same.md' }, 'one')), other.write(append({ path: '/same.md' }, 'two'))]);
    fixture.beforeUpsert = undefined;
    const ambiguous = { code: 'PATH_AMBIGUOUS', details: { paths: [{ path: '/same.md', fileIds: [one.fileId, two.fileId].sort() }] } };
    await assert.rejects(drive.read({ path: '/same.md' }), ambiguous);
    const start = mutations();
    await assert.rejects(drive.write(append({ path: '/same.md' }, 'three')), ambiguous);
    await assert.rejects(drive.write({ operations: [append({ path: '/a.md' }, 'x'), append({ path: '/same.md' }, 'three')] }), ambiguous);
    assert.equal(mutations(), start);
    // By fileId each file still takes appends.
    assert.equal((await drive.write(append({ fileId: one.fileId }, 'three'))).content, 'one\nthree');
    // External-vector drives store no text.
    const vectors = await setup({ embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'fixture-v1' } });
    const vector = await vectors.drive.write({ op: 'create', path: '/v', content: [1, ...Array(63).fill(0)] });
    const vectorCalls = vectors.fixture.calls.length;
    for (const request of [append({ path: '/v' }, 'x'), append({ fileId: vector.fileId }, 'x'), { operations: [append({ path: '/w' }, 'x')] }])
        await assert.rejects(vectors.drive.write(request), { code: 'INVALID_INPUT' });
    assert.equal(vectors.fixture.calls.length, vectorCalls);
});

test('batches run appends with other operations in input order and reject a file targeted twice or a path produced twice before writing', async () => {
    const { fixture, drive, mutations } = await setup();
    const [a, b, , z] = await drive.write({ operations: ['/a.md', '/b.md', '/c.md', '/z.md'].map(path => ({ op: 'create', path, content: path })) });
    const results = await drive.write({ operations: [append({ path: '/new.md' }, 'New.'), { op: 'create', path: '/d.md', content: 'd' },
        append({ fileId: a.fileId }, 'A.'), { op: 'update', fileId: b.fileId, content: 'B.' }, append({ path: '/c.md' }, 'C.'), { op: 'delete', fileId: z.fileId }] });
    assert.deepEqual(results.map(result => [result.path, result.content]), [['/new.md', 'New.'], ['/d.md', 'd'], ['/a.md', '/a.md\nA.'], ['/b.md', 'B.'],
        ['/c.md', '/c.md\nC.'], [undefined, undefined]]);
    assert.deepEqual(results[5], { fileId: z.fileId });
    assert.deepEqual((await drive.read({ paths: ['/new.md', '/c.md', '/z.md'] })).map(file => file.content), ['New.', '/c.md\nC.']);

    const [x, y] = await drive.write({ operations: ['/x.md', '/y.md'].map(path => ({ op: 'create', path, content: 'x' })) });
    const before = fixture.calls.length, start = mutations();
    // Before any read: two appends by one fileId or one path, an append by fileId beside an update or delete of it, and an append beside a create at its path.
    for (const operations of [[append({ fileId: x.fileId }, '1'), append({ fileId: x.fileId }, '2')],
        [append({ path: '/x.md' }, '1'), append({ path: '/x.md' }, '2')], [append({ path: '/new-1.md' }, '1'), append({ path: '/new-1.md' }, '2')],
        [append({ fileId: x.fileId }, '1'), { op: 'update', fileId: x.fileId, content: '2' }], [append({ fileId: x.fileId }, '1'), { op: 'delete', fileId: x.fileId }],
        [{ op: 'create', path: '/new-2.md', content: '1' }, append({ path: '/new-2.md' }, '2')]])
        await assert.rejects(drive.write({ operations }), { code: 'INVALID_INPUT' }, JSON.stringify(operations));
    assert.equal(fixture.calls.length, before);
    // After the path lookup, before any write: an append by path that resolves to a file another operation targets, or that creates a file at a path a move takes.
    for (const operations of [[append({ path: '/x.md' }, '1'), append({ fileId: x.fileId }, '2')],
        [{ op: 'update', fileId: x.fileId, edits: [{ oldText: 'x', newText: 'z' }] }, append({ path: '/x.md' }, '2')],
        [append({ path: '/x.md' }, '1'), { op: 'delete', fileId: x.fileId }],
        [append({ path: '/new-3.md' }, '1'), { op: 'update', fileId: y.fileId, newPath: '/new-3.md' }]])
        await assert.rejects(drive.write({ operations }), { code: 'INVALID_INPUT' }, JSON.stringify(operations));
    // A move onto the path of the file an append resolves to fails as any move onto an existing path does.
    await assert.rejects(drive.write({ operations: [append({ path: '/x.md' }, '1'), { op: 'update', fileId: y.fileId, newPath: '/x.md' }] }), { code: 'PATH_EXISTS' });
    assert.equal(mutations(), start);
    assert.deepEqual((await drive.read({ paths: ['/x.md', '/y.md', '/new-3.md'] })).map(file => [file.path, file.content]), [['/x.md', 'x'], ['/y.md', 'x']]);
});

test('checkpointed appends record a checkpoint, and a failed one is restored like any write', async () => {
    const { fixture, drive } = await setup();
    // Without a latest checkpoint, a failed append that created its file removes it.
    fixture.beforeTagCreate = () => { throw Object.assign(new Error('Unavailable'), { statusCode: 503 }); };
    await assert.rejects(drive.write({ ...append({ path: '/log.md' }, 'Lost.'), checkpoint: { name: 'zero' } }), error => error.code === 'CHECKPOINT_WRITE_FAILED'
        && error.details.stage === 'checkpoint' && error.details.restored === true && error.details.restoredTo === null);
    fixture.beforeTagCreate = undefined;
    assert.equal(await drive.read({ path: '/log.md' }), null);
    const { result, checkpoint } = await drive.write({ ...append({ path: '/log.md' }, 'One.'), checkpoint: { name: 'one' } });
    assert.deepEqual([result.content, checkpoint, (await drive.describe()).latestCheckpoint], ['One.', { at: { kind: 'checkpoint', name: 'one' } },
        { at: { kind: 'checkpoint', name: 'one' } }]);
    const { result: [second] } = await drive.write({ operations: [append({ fileId: result.fileId }, 'Two.')], checkpoint: { name: 'two' } });
    assert.equal(second.content, 'One.\nTwo.');
    assert.equal((await drive.read({ at: { kind: 'checkpoint', name: 'one' }, fileId: result.fileId })).content, 'One.');
    // A failed append is restored to the latest checkpoint.
    fixture.beforeUpsert = () => { throw Object.assign(new Error('Unavailable'), { statusCode: 503 }); };
    await assert.rejects(drive.write({ ...append({ path: '/log.md' }, 'Three.'), checkpoint: { name: 'three' } }), error => error.code === 'CHECKPOINT_WRITE_FAILED'
        && error.details.stage === 'write' && error.details.restored === true && error.details.restoredTo?.name === 'two');
    fixture.beforeUpsert = undefined;
    assert.equal((await drive.read({ path: '/log.md' })).content, 'One.\nTwo.');
});

test('appends in one process run in queue order: a new path ends as one file with both contents, and creates, moves and deletes interleave as whole calls', async () => {
    const { fixture, drive } = await setup();
    const other = await open({ client: { ...fixture.client }, name });
    const hold = () => {
        let entered, release;
        const arrived = new Promise(resolve => { entered = resolve; });
        const released = new Promise(resolve => { release = resolve; });
        fixture.beforeUpsert = async () => { fixture.beforeUpsert = undefined; entered(); await released; };
        return { arrived, release };
    };
    // The second append looks up the path only after the first has created the file.
    let held = hold();
    const first = drive.write(append({ path: '/log.md' }, 'First.'));
    await held.arrived;
    const before = fixture.calls.length;
    const second = other.write(append({ path: '/log.md' }, 'Second.'));
    const third = drive.write(append({ path: '/log.md' }, 'Third.'));
    for (let turn = 0; turn < 1000 && queueSizes()[0] !== 3; turn++) await tick();
    assert.deepEqual([queueSizes(), fixture.calls.length], [[3], before]);
    held.release();
    const results = await Promise.all([first, second, third]);
    assert.equal(new Set(results.map(result => result.fileId)).size, 1);
    assert.equal((await drive.read({ path: '/log.md' })).content, 'First.\nSecond.\nThird.');

    // An append queued behind a create at its path appends to the created file; a create queued behind an append that creates fails.
    held = hold();
    const created = drive.write({ op: 'create', path: '/a.md', content: 'Created.' });
    await held.arrived;
    const appended = other.write(append({ path: '/a.md' }, 'Appended.'));
    held.release();
    assert.equal((await appended).fileId, (await created).fileId);
    held = hold();
    const appendFirst = drive.write(append({ path: '/b.md' }, 'Appended.'));
    await held.arrived;
    const createAfter = other.write({ op: 'create', path: '/b.md', content: 'Created.' });
    held.release();
    await appendFirst;
    await assert.rejects(createAfter, { code: 'PATH_EXISTS' });
    // A move onto the path first: the append extends the moved file. An append first: the move fails.
    const moving = await drive.write({ op: 'create', path: '/moving.md', content: 'Moved.' });
    held = hold();
    // Changed content makes the move an upsert, which the hold intercepts; a move alone is a patch.
    const moved = drive.write({ op: 'update', fileId: moving.fileId, newPath: '/c.md', content: 'Moved here.' });
    await held.arrived;
    const afterMove = other.write(append({ path: '/c.md' }, 'Appended.'));
    held.release();
    await moved;
    assert.deepEqual([(await afterMove).fileId, (await drive.read({ path: '/c.md' })).content], [moving.fileId, 'Moved here.\nAppended.']);
    held = hold();
    const beforeMove = drive.write(append({ path: '/d.md' }, 'Appended.'));
    await held.arrived;
    const moveAfter = other.write({ op: 'update', fileId: moving.fileId, newPath: '/d.md' });
    held.release();
    await beforeMove;
    await assert.rejects(moveAfter, { code: 'PATH_EXISTS' });
    // A delete first: an append by fileId finds no file and an append by path creates a new one.
    const doomed = await drive.write({ op: 'create', path: '/e.md', content: 'Doomed.' });
    held = hold();
    const kept = drive.write({ op: 'update', fileId: doomed.fileId, content: 'Kept briefly.' });
    await held.arrived;
    const deleted = other.write({ op: 'delete', fileId: doomed.fileId });
    const byId = drive.write(append({ fileId: doomed.fileId }, 'Lost.'));
    const byPath = other.write(append({ path: '/e.md' }, 'Recreated.'));
    held.release();
    await kept;
    await deleted;
    await assert.rejects(byId, { code: 'FILE_NOT_FOUND' });
    const recreated = await byPath;
    assert.deepEqual([recreated.fileId === doomed.fileId, recreated.content], [false, 'Recreated.']);
});
