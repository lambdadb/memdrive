import assert from 'node:assert/strict';
import test from 'node:test';
import { MemDrive, createFileTools } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

const name = 'historical-store';
async function setup(external = false) {
    const fixture = fileClient();
    const mode = external ? 'external' : 'managed';
    const main = await MemDrive.create({ client: fixture.client, name, retentionInDays: 1,
        ...(external ? { embedding: { mode, dimensions: 64, similarity: 'cosine', identity: 'fixture' } } : {}) });
    const state = fixture.collections.get(name);
    const draft = await main.fork({ name: 'draft' });
    const content = n => external ? new Array(64).fill(n) : `Revision ${n}`;
    const first = await draft.write({ op: 'create', path: '/first', content: content(1) });
    await draft.merge({ requestId: 'first', summary: 'First publication' });
    await draft.write({ op: 'update', fileId: first.fileId, newPath: '/second', content: content(2) });
    await draft.merge({ requestId: 'second', summary: 'Second publication' });
    const journal = [...fixture.collections.values()].find(store => store.metadata.tags['memdrive.format'] === 'merge-publication-v1');
    const records = journal.branches.get('main').docs;
    const client = { ...fixture.client };
    const fresh = await MemDrive.open({ client, name, mode });
    const work = await MemDrive.open({ client, name, mode, at: { fork: 'draft' } });
    return { fixture, state, records, main: fresh, draft: work, first, mode, client };
}

test('main refs select exact publication versions and retained v0; omission selects current main', async () => {
    const { main, fixture, first } = await setup();
    const initial = await main.fork({ name: 'initial', version: 'v0' });
    assert.equal(await initial.read({ fileId: first.fileId }), null);
    const { version } = (await main.history()).entries[0];
    const old = await main.fork({ name: 'earlier', version });
    const exact = await main.checkpoint({ name: 'exact', version });
    const latest = await main.checkpoint({ name: 'latest', version: 'v2' });
    const current = await main.fork({ name: 'current' });
    for (const view of [old, exact]) assert.equal((await view.read({ fileId: first.fileId })).content, 'Revision 1');
    for (const view of [latest, current]) assert.equal((await view.read({ fileId: first.fileId })).content, 'Revision 2');
    assert.deepEqual(fixture.calls.find(call => call.request?.branchName === 'fork-earlier').request.source, { kind: 'tag', name: 'md-main-v1' });
    assert.equal((await main.status()).mainVersion, 'v2');
    assert(!fixture.calls.some(call => call.request?.source && 'asOf' in call.request.source));
});

test('an unfinished publication cannot be selected even after its target tag is created', async () => {
    const { main, draft, fixture, state, first } = await setup();
    await draft.write({ op: 'update', fileId: first.fileId, content: 'Unpublished third revision' });
    fixture.beforeUpsert = request => {
        if (request.docs.some(doc => doc.id === 'completion:3')) throw new Error('Pause publication');
    };
    await assert.rejects(draft.merge({ requestId: 'third', summary: 'Third publication' }), { code: 'MERGE_RESUMABLE' });
    assert(state.tags.has('md-main-v3'));
    await assert.rejects(main.checkpoint({ name: 'unpublished', version: 'v3' }),
        error => error.code === 'HISTORICAL_VIEW_UNAVAILABLE' && error.details.version === 'v3');
    const saved = await main.checkpoint({ name: 'during-merge', version: 'v2' });
    assert.equal((await saved.read({ fileId: first.fileId })).content, 'Revision 2');
    assert.equal((await main.status()).merge.phase, 'publication');
});

test('missing or expired versions fail without fallback while explicitly preserved refs survive', async () => {
    const { fixture, main, state, first } = await setup();
    const preserved = await main.checkpoint({ name: 'preserved', version: 'v1' });
    state.tags.delete('md-main-v1');
    const count = fixture.calls.filter(call => ['branch-create', 'tag-create'].includes(call.kind)).length;
    for (const version of ['v1', 'v3', 'v999999999999999999999999999999'])
        for (const method of ['fork', 'checkpoint'])
            await assert.rejects(main[method]({ name: 'unavailable', version }),
                error => error.code === 'HISTORICAL_VIEW_UNAVAILABLE' && error.details.version === version);
    assert.equal(fixture.calls.filter(call => ['branch-create', 'tag-create'].includes(call.kind)).length, count);
    assert.equal((await main.history()).entries[0].version, 'v1');
    assert.equal((await preserved.read({ fileId: first.fileId })).content, 'Revision 1');
});

test('legacy main without an initial pin does not synthesize historical v0', async () => {
    const fixture = fileClient();
    const main = await MemDrive.create({ client: fixture.client, name });
    fixture.collections.get(name).branches.delete('md-main-v0');
    const fresh = await MemDrive.open({ client: { ...fixture.client }, name });
    const count = fixture.calls.length;
    await assert.rejects(fresh.fork({ name: 'unknown-past', version: 'v0' }), { code: 'HISTORICAL_VIEW_UNAVAILABLE' });
    assert(!fixture.calls.slice(count).some(call => ['branch-create', 'tag-create'].includes(call.kind)));
});

test('versioned forks preserve old merge baselines and can be copied through explicit checkpoints', async () => {
    const { main, first } = await setup();
    const old = await main.fork({ name: 'past-work', version: 'v1' });
    const saved = await old.checkpoint({ name: 'past-save' });
    await old.write({ op: 'update', fileId: first.fileId, content: 'Historical edit' });
    await assert.rejects(old.merge({ requestId: 'historical-edit', summary: 'Edit from an old baseline' }), { code: 'MERGE_CONFLICT' });
    await old.delete();
    assert.equal((await saved.read({ fileId: first.fileId })).content, 'Revision 1');
    const copy = await saved.fork({ name: 'copy-saved' });
    assert.equal((await copy.read({ fileId: first.fileId })).content, 'Revision 1');
});

test('versioned refs support external vectors without changing the selected mode', async () => {
    const { main, fixture, first, mode } = await setup(true);
    const historical = await main.fork({ name: 'vector-main', version: 'v1' });
    const saved = await main.checkpoint({ name: 'vector-save', version: 'v1' });
    for (const view of [historical, saved]) {
        assert.equal((await view.describe()).embedding.mode, mode);
        assert.equal((await view.read({ fileId: first.fileId })).path, '/first');
    }
    const docs = fixture.collections.get(name).branches.get('fork-vector-main').docs;
    assert.deepEqual(docs.get(`file:${first.fileId}`).embedding, new Array(64).fill(1));
});

test('all views reject removed asOf inputs and only main accepts a canonical version', async () => {
    const { main, draft, fixture } = await setup();
    const saved = await main.checkpoint({ name: 'saved' });
    const start = fixture.calls.length;
    for (const view of [main, draft, saved]) for (const method of ['fork', 'checkpoint']) {
        for (const asOf of [undefined, new Date().toISOString()])
            await assert.rejects(view[method]({ name: 'invalid', asOf }), { code: 'INVALID_INPUT' });
        if (view !== main) await assert.rejects(view[method]({ name: 'invalid', version: 'v1' }), { code: 'INVALID_INPUT' });
    }
    for (const method of ['fork', 'checkpoint']) {
        for (const version of [null, 0, '', 'v', 'v01', 'v-1', 'V1', 'v1.0', 'md-main-v1', new Date().toISOString()])
            await assert.rejects(main[method]({ name: 'invalid', version }), { code: 'INVALID_INPUT' });
        await assert.rejects(main[method]({ name: 'cancelled', version: 'v1' }, { signal: AbortSignal.abort() }), { code: 'ABORTED' });
    }
    assert.equal(fixture.calls.length, start);
});

test('versioned ref creation preserves name conflicts, races and unknown outcome fences', async () => {
    const { main, fixture, state } = await setup();
    await main.fork({ name: 'existing', version: 'v1' });
    await assert.rejects(main.fork({ name: 'existing', version: 'v1' }), { code: 'BRANCH_CONFLICT' });
    const tag = state.tags.get('md-main-v1');
    fixture.beforeTagCreate = name => { if (name === 'checkpoint-raced') state.tags.delete('md-main-v1'); };
    await assert.rejects(main.checkpoint({ name: 'raced', version: 'v1' }), { code: 'HISTORICAL_VIEW_UNAVAILABLE' });
    state.tags.set('md-main-v1', tag);
    fixture.beforeTagCreate = undefined;
    await main.checkpoint({ name: 'raced', version: 'v1' }); // A definite rejection releases the name.
    await assert.rejects(main.checkpoint({ name: 'raced', version: 'v1' }), { code: 'CHECKPOINT_CONFLICT' });
    fixture.afterTagCreate = tag => { if (tag.name === 'checkpoint-unknown') throw new Error('Lost response'); };
    await assert.rejects(main.checkpoint({ name: 'unknown', version: 'v1' }), { code: 'REF_CREATION_UNCONFIRMED' });
    const writes = fixture.calls.filter(call => call.kind === 'tag-create').length;
    await assert.rejects(main.checkpoint({ name: 'unknown', version: 'v1' }), { code: 'REF_CREATION_UNCONFIRMED' });
    assert.equal(fixture.calls.filter(call => call.kind === 'tag-create').length, writes);
});

test('versioned tools preserve the bound view and expose version only on main', async () => {
    const { main, draft, client, first } = await setup();
    const tools = createFileTools({ drive: main, tools: ['fork', 'checkpoint'] });
    assert.equal(tools.definitions[0].inputSchema.properties.version.type, 'string');
    const created = await tools.execute('fork', { name: 'tool-past', version: 'v1' });
    assert.deepEqual(created, { name, at: { kind: 'fork', name: 'tool-past' } });
    const past = await MemDrive.open({ client, name, at: { fork: 'tool-past' } });
    assert.equal((await past.read({ fileId: first.fileId })).content, 'Revision 1');
    const saved = await main.checkpoint({ name: 'saved' });
    for (const drive of [draft, saved]) {
        const bound = createFileTools({ drive, tools: ['fork', 'checkpoint'] });
        assert.equal('version' in bound.definitions[0].inputSchema.properties, false);
        await assert.rejects(bound.execute('fork', { name: 'invalid', version: 'v1' }), { code: 'INVALID_INPUT' });
    }
    assert.equal((await main.read({ fileId: first.fileId })).content, 'Revision 2');
});

test('version selection is independent of publication timestamps', async () => {
    const { main, records, first } = await setup();
    records.get('completion:2').completedAt = records.get('completion:1').completedAt;
    const old = await main.checkpoint({ name: 'same-time', version: 'v1' });
    assert.equal((await old.read({ fileId: first.fileId })).content, 'Revision 1');
});
