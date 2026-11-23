import assert from 'node:assert/strict';
import test from 'node:test';
import { MemDrive, createFileTools } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

const name = 'historical-store';
const draftAt = { kind: 'fork', name: 'draft' };
async function setup(external = false) {
    const fixture = fileClient();
    const mode = external ? 'external' : 'managed';
    const drive = await MemDrive.create({ client: fixture.client, name, retentionInDays: 1,
        ...(external ? { embedding: { mode, dimensions: 64, similarity: 'cosine', identity: 'fixture' } } : {}) });
    const state = fixture.collections.get(name);
    await drive.fork({ name: 'draft' });
    const content = n => external ? new Array(64).fill(n) : `Revision ${n}`;
    const first = await drive.write({ at: draftAt, op: 'create', path: '/first', content: content(1) });
    await drive.merge({ at: draftAt, requestId: 'first', summary: 'First publication' });
    await drive.write({ at: draftAt, op: 'update', fileId: first.fileId, newPath: '/second', content: content(2) });
    await drive.merge({ at: draftAt, requestId: 'second', summary: 'Second publication' });
    const journal = [...fixture.collections.values()].find(store => store.metadata.tags['memdrive.format'] === 'merge-publication-v1');
    const records = journal.branches.get('main').docs;
    const client = { ...fixture.client };
    const fresh = await MemDrive.open({ client, name, mode });
    return { fixture, state, records, drive: fresh, first, mode, client };
}

test('main sources select exact publication versions and retained v0; omission selects current main', async () => {
    const { drive, fixture, first } = await setup();
    const { at: initial } = await drive.fork({ name: 'initial', version: 'v0' });
    assert.equal(await drive.read({ at: initial, fileId: first.fileId }), null);
    const { version } = (await drive.history()).entries[0];
    const old = await drive.fork({ name: 'earlier', version });
    assert.deepEqual(old, { at: { kind: 'fork', name: 'earlier' } });
    const exact = await drive.checkpoint({ at: { kind: 'main' }, name: 'exact', version });
    assert.deepEqual(exact, { at: { kind: 'checkpoint', name: 'exact' } });
    const latest = await drive.checkpoint({ name: 'latest', version: 'v2' });
    const current = await drive.fork({ name: 'current' });
    for (const { at } of [old, exact]) assert.equal((await drive.read({ at, fileId: first.fileId })).content, 'Revision 1');
    for (const { at } of [latest, current]) assert.equal((await drive.read({ at, fileId: first.fileId })).content, 'Revision 2');
    assert.deepEqual(fixture.calls.find(call => call.request?.branchName === 'fork-earlier').request.source, { kind: 'tag', name: 'md-main-v1' });
    assert.equal((await drive.status()).mainVersion, 'v2');
    assert(!fixture.calls.some(call => call.request?.source && 'asOf' in call.request.source));
});

test('an unfinished publication cannot be selected even after its target tag is created', async () => {
    const { drive, fixture, state, first } = await setup();
    await drive.write({ at: draftAt, op: 'update', fileId: first.fileId, content: 'Unpublished third revision' });
    fixture.beforeUpsert = request => {
        if (request.docs.some(doc => doc.id === 'completion:3')) throw new Error('Pause publication');
    };
    await assert.rejects(drive.merge({ at: draftAt, requestId: 'third', summary: 'Third publication' }), { code: 'MERGE_RESUMABLE' });
    assert(state.tags.has('md-main-v3'));
    await assert.rejects(drive.checkpoint({ name: 'unpublished', version: 'v3' }),
        error => error.code === 'HISTORICAL_VIEW_UNAVAILABLE' && error.details.version === 'v3');
    const { at } = await drive.checkpoint({ name: 'during-merge', version: 'v2' });
    assert.equal((await drive.read({ at, fileId: first.fileId })).content, 'Revision 2');
    assert.equal((await drive.status()).merge.phase, 'publication');
});

test('missing or expired versions fail without fallback while explicitly preserved refs survive', async () => {
    const { fixture, drive, state, first } = await setup();
    const { at: preserved } = await drive.checkpoint({ name: 'preserved', version: 'v1' });
    state.tags.delete('md-main-v1');
    const count = fixture.calls.filter(call => ['branch-create', 'tag-create'].includes(call.kind)).length;
    for (const version of ['v1', 'v3', 'v999999999999999999999999999999'])
        for (const method of ['fork', 'checkpoint'])
            await assert.rejects(drive[method]({ name: 'unavailable', version }),
                error => error.code === 'HISTORICAL_VIEW_UNAVAILABLE' && error.details.version === version);
    assert.equal(fixture.calls.filter(call => ['branch-create', 'tag-create'].includes(call.kind)).length, count);
    assert.equal((await drive.history()).entries[0].version, 'v1');
    assert.equal((await drive.read({ at: preserved, fileId: first.fileId })).content, 'Revision 1');
});

test('an interrupted creation leaves v0 unavailable, never synthesized, until a later operation pins it', async () => {
    const fixture = fileClient();
    fixture.beforeBranchCreate = () => { throw Object.assign(new Error('Unavailable'), { statusCode: 503 }); };
    await assert.rejects(MemDrive.create({ client: fixture.client, name }), { code: 'MAIN_BOOTSTRAP_UNCONFIRMED' });
    fixture.beforeBranchCreate = undefined;
    assert(!fixture.collections.get(name).branches.has('md-main-v0'));
    const fresh = await MemDrive.open({ client: { ...fixture.client }, name });
    const count = fixture.calls.length;
    await assert.rejects(fresh.fork({ name: 'unknown-past', version: 'v0' }), { code: 'HISTORICAL_VIEW_UNAVAILABLE' });
    assert(!fixture.calls.slice(count).some(call => ['branch-create', 'tag-create'].includes(call.kind)));
    // A ref from current main pins the initial view, which is then selectable.
    await fresh.fork({ name: 'draft' });
    assert.deepEqual(await fresh.fork({ name: 'initial', version: 'v0' }), { at: { kind: 'fork', name: 'initial' } });
    assert.deepEqual(fixture.calls.findLast(call => call.kind === 'branch-create').request.source, { kind: 'branch', name: 'md-main-v0' });
});

test('versioned forks preserve old merge baselines and can be copied through explicit checkpoints', async () => {
    const { drive, first } = await setup();
    const { at: old } = await drive.fork({ name: 'past-work', version: 'v1' });
    const { at: saved } = await drive.checkpoint({ at: old, name: 'past-save' });
    await drive.write({ at: old, op: 'update', fileId: first.fileId, content: 'Historical edit' });
    await assert.rejects(drive.merge({ at: old, requestId: 'historical-edit', summary: 'Edit from an old baseline' }), { code: 'MERGE_CONFLICT' });
    await drive.deleteFork({ at: old });
    assert.equal((await drive.read({ at: saved, fileId: first.fileId })).content, 'Revision 1');
    const { at: copy } = await drive.fork({ at: saved, name: 'copy-saved' });
    assert.equal((await drive.read({ at: copy, fileId: first.fileId })).content, 'Revision 1');
});

test('versioned refs support external vectors without changing the selected mode', async () => {
    const { drive, fixture, first, mode } = await setup(true);
    const historical = await drive.fork({ name: 'vector-main', version: 'v1' });
    const saved = await drive.checkpoint({ name: 'vector-save', version: 'v1' });
    assert.equal((await drive.describe()).embedding.mode, mode);
    for (const { at } of [historical, saved]) assert.equal((await drive.read({ at, fileId: first.fileId })).path, '/first');
    const docs = fixture.collections.get(name).branches.get('fork-vector-main').docs;
    assert.deepEqual(docs.get(`file:${first.fileId}`).embedding, new Array(64).fill(1));
});

test('all sources reject removed asOf inputs and only a main source accepts a canonical version', async () => {
    const { drive, fixture } = await setup();
    const { at: saved } = await drive.checkpoint({ name: 'saved' });
    const start = fixture.calls.length;
    for (const at of [undefined, { kind: 'main' }, draftAt, saved]) for (const method of ['fork', 'checkpoint']) {
        for (const asOf of [undefined, new Date().toISOString()])
            await assert.rejects(drive[method]({ at, name: 'invalid', asOf }), { code: 'INVALID_INPUT' });
        if (at?.kind === 'fork' || at?.kind === 'checkpoint')
            await assert.rejects(drive[method]({ at, name: 'invalid', version: 'v1' }), { code: 'INVALID_INPUT' });
    }
    for (const method of ['fork', 'checkpoint']) {
        for (const version of [null, 0, '', 'v', 'v01', 'v-1', 'V1', 'v1.0', 'md-main-v1', new Date().toISOString()])
            await assert.rejects(drive[method]({ name: 'invalid', version }), { code: 'INVALID_INPUT' });
        for (const at of [{ kind: 'fork' }, { kind: 'main', name: 'main' }, { fork: 'draft' }, 'main'])
            await assert.rejects(drive[method]({ at, name: 'invalid' }), { code: 'INVALID_INPUT' });
        await assert.rejects(drive[method]({ name: 'cancelled', version: 'v1' }, { signal: AbortSignal.abort() }), { code: 'ABORTED' });
    }
    assert.equal(fixture.calls.length, start);
});

test('versioned ref creation preserves name conflicts, races and unknown outcome fences', async () => {
    const { drive, fixture, state } = await setup();
    await drive.fork({ name: 'existing', version: 'v1' });
    await assert.rejects(drive.fork({ name: 'existing', version: 'v1' }), { code: 'BRANCH_CONFLICT' });
    const tag = state.tags.get('md-main-v1');
    fixture.beforeTagCreate = name => { if (name === 'checkpoint-raced') state.tags.delete('md-main-v1'); };
    await assert.rejects(drive.checkpoint({ name: 'raced', version: 'v1' }), { code: 'HISTORICAL_VIEW_UNAVAILABLE' });
    state.tags.set('md-main-v1', tag);
    fixture.beforeTagCreate = undefined;
    await drive.checkpoint({ name: 'raced', version: 'v1' }); // A definite rejection releases the name.
    await assert.rejects(drive.checkpoint({ name: 'raced', version: 'v1' }), { code: 'CHECKPOINT_CONFLICT' });
    fixture.afterTagCreate = tag => { if (tag.name === 'checkpoint-unknown') throw new Error('Lost response'); };
    await assert.rejects(drive.checkpoint({ name: 'unknown', version: 'v1' }), { code: 'REF_CREATION_UNCONFIRMED' });
    const writes = fixture.calls.filter(call => call.kind === 'tag-create').length;
    await assert.rejects(drive.checkpoint({ name: 'unknown', version: 'v1' }), { code: 'REF_CREATION_UNCONFIRMED' });
    assert.equal(fixture.calls.filter(call => call.kind === 'tag-create').length, writes);
    // Using the uncertain at inspects it and clears the creation fence.
    assert.deepEqual((await drive.status({ at: { kind: 'checkpoint', name: 'unknown' } })).at, { kind: 'checkpoint', name: 'unknown' });
    await assert.rejects(drive.checkpoint({ name: 'unknown', version: 'v1' }), { code: 'CHECKPOINT_CONFLICT' });
});

test('versioned tools return serializable at values and reject version from non-main sources', async () => {
    const { drive, first } = await setup();
    const tools = createFileTools({ drive, tools: ['fork', 'checkpoint', 'read'] });
    assert.equal(tools.definitions[0].inputSchema.properties.version.type, 'string');
    const created = await tools.execute('fork', { name: 'tool-past', version: 'v1' });
    assert.deepEqual(created, { at: { kind: 'fork', name: 'tool-past' } });
    assert.equal((await tools.execute('read', { at: created.at, fileId: first.fileId })).content, 'Revision 1');
    const { at: saved } = await drive.checkpoint({ name: 'saved' });
    for (const at of [draftAt, saved])
        await assert.rejects(tools.execute('fork', { at, name: 'invalid', version: 'v1' }), { code: 'INVALID_INPUT' });
    assert.equal((await drive.read({ fileId: first.fileId })).content, 'Revision 2');
});

test('version selection is independent of publication timestamps', async () => {
    const { drive, records, first } = await setup();
    records.get('completion:2').completedAt = records.get('completion:1').completedAt;
    const { at } = await drive.checkpoint({ name: 'same-time', version: 'v1' });
    assert.equal((await drive.read({ at, fileId: first.fileId })).content, 'Revision 1');
});
