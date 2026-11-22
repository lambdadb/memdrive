import assert from 'node:assert/strict';
import test from 'node:test';
import { MemDrive, createFileTools } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

const name = 'historical-store';
const base = Date.now() - 60_000;
const time = offset => new Date(base + offset).toISOString();
async function setup(external = false) {
    const fixture = fileClient();
    const mode = external ? 'external' : 'managed';
    const main = await MemDrive.create({ client: fixture.client, name, retentionInDays: 1,
        ...(external ? { embedding: { mode, dimensions: 64, similarity: 'cosine', identity: 'fixture' } } : {}) });
    const state = fixture.collections.get(name);
    state.branches.get('md-main-v0').createdAt = new Date(base);
    const draft = await main.fork({ name: 'draft' });
    const content = n => external ? new Array(64).fill(n) : `Revision ${n}`;
    const first = await draft.write({ op: 'create', path: '/first', content: content(1) });
    await draft.merge({ requestId: 'first', summary: 'First publication' });
    const oldWorking = structuredClone(state.branches.get('fork-draft').docs);
    await draft.write({ op: 'update', fileId: first.fileId, newPath: '/second', content: content(2) });
    await draft.merge({ requestId: 'second', summary: 'Second publication' });
    const journal = [...fixture.collections.values()].find(store => store.metadata.tags['memdrive.format'] === 'merge-publication-v1');
    const records = journal.branches.get('main').docs;
    records.get('completion:1').completedAt = time(1000);
    records.get('completion:2').completedAt = time(2000);
    const client = { ...fixture.client };
    const fresh = await MemDrive.open({ client, name, mode });
    const work = await MemDrive.open({ client, name, mode, at: { fork: 'draft' } });
    return { fixture, state, records, main: fresh, draft: work, first, mode, content, oldWorking, client };
}

test('main asOf selects completed publication boundaries and initial state without exposing native main time travel', async () => {
    const { main, fixture, first } = await setup();
    const initial = await main.fork({ name: 'initial', asOf: time(500) });
    assert.equal(await initial.read({ fileId: first.fileId }), null);
    const old = await main.fork({ name: 'earlier', asOf: time(1500) });
    const exact = await main.checkpoint({ name: 'exact', asOf: time(1000) });
    const latest = await main.checkpoint({ name: 'latest', asOf: time(2000) });
    assert.equal((await old.read({ fileId: first.fileId })).content, 'Revision 1');
    assert.equal((await exact.read({ fileId: first.fileId })).content, 'Revision 1');
    assert.equal((await latest.read({ fileId: first.fileId })).content, 'Revision 2');
    assert.deepEqual(fixture.calls.find(call => call.request?.branchName === 'fork-earlier').request.source, { kind: 'tag', name: 'md-main-v1' });
    assert.equal((await main.status()).mainVersion, 'v2');
    await assert.rejects(main.fork({ name: 'before-store', asOf: time(-1) }), { code: 'HISTORICAL_VIEW_UNAVAILABLE' });
});

test('main historical refs never expose an applied but unpublished merge', async () => {
    const { main, draft, fixture, first } = await setup();
    await draft.write({ op: 'update', fileId: first.fileId, content: 'Unpublished third revision' });
    fixture.beforeUpsert = request => {
        if (request.docs.some(doc => doc.id === 'completion:3')) throw new Error('Pause publication');
    };
    await assert.rejects(draft.merge({ requestId: 'third', summary: 'Third publication' }), { code: 'MERGE_RESUMABLE' });
    const saved = await main.checkpoint({ name: 'during-merge', asOf: new Date().toISOString() });
    assert.equal((await saved.read({ fileId: first.fileId })).content, 'Revision 2');
    assert.equal((await main.status()).merge.phase, 'publication');
});

test('missing retained main versions fail without falling back to current, older tags or native main', async () => {
    const { fixture, main, state, first } = await setup();
    const preserved = await main.checkpoint({ name: 'preserved', asOf: time(1000) });
    state.tags.delete('md-main-v1');
    const count = fixture.calls.filter(call => ['branch-create', 'tag-create'].includes(call.kind)).length;
    await assert.rejects(main.fork({ name: 'expired', asOf: time(1000) }), { code: 'HISTORICAL_VIEW_UNAVAILABLE' });
    await assert.rejects(main.checkpoint({ name: 'expired', asOf: time(1500) }), { code: 'HISTORICAL_VIEW_UNAVAILABLE' });
    assert.equal(fixture.calls.filter(call => ['branch-create', 'tag-create'].includes(call.kind)).length, count);
    assert.equal((await main.history()).entries[0].version, 'v1');
    assert.equal((await preserved.read({ fileId: first.fileId })).content, 'Revision 1');
});

test('legacy main without an initial pin does not synthesize historical v0', async () => {
    const fixture = fileClient();
    const main = await MemDrive.create({ client: fixture.client, name });
    fixture.collections.get(name).branches.delete('md-main-v0');
    const count = fixture.calls.length;
    await assert.rejects(main.fork({ name: 'unknown-past', asOf: time(0) }), { code: 'HISTORICAL_VIEW_UNAVAILABLE' });
    assert(!fixture.calls.slice(count).some(call => ['branch-create', 'tag-create'].includes(call.kind)));
});

test('fork asOf passes native Unix milliseconds and preserves historical data and merge baselines', async () => {
    const { draft, fixture, oldWorking, first } = await setup();
    fixture.snapshotAt = (collection, source) => {
        assert.equal(collection, name);
        assert.deepEqual(source, { kind: 'branch', name: 'fork-draft', asOf: base + 1500 });
        return oldWorking;
    };
    const old = await draft.fork({ name: 'past-work', asOf: time(1500) });
    const saved = await draft.checkpoint({ name: 'past-save', asOf: time(1500) });
    assert.equal((await old.read({ fileId: first.fileId })).content, 'Revision 1');
    assert.equal((await saved.read({ fileId: first.fileId })).path, '/first');
    await old.write({ op: 'update', fileId: first.fileId, content: 'Historical edit' });
    await assert.rejects(old.merge({ requestId: 'historical-edit', summary: 'Edit from an old baseline' }), { code: 'MERGE_CONFLICT' });
    await draft.delete();
    assert.equal((await saved.read({ fileId: first.fileId })).content, 'Revision 1');
    const copy = await saved.fork({ name: 'copy-saved' });
    assert.equal((await copy.read({ fileId: first.fileId })).content, 'Revision 1');
});

test('historical refs support external vectors without changing the selected mode', async () => {
    const { main, draft, fixture, oldWorking, first, mode } = await setup(true);
    fixture.snapshotAt = () => oldWorking;
    const historical = await main.fork({ name: 'vector-main', asOf: time(1000) });
    const saved = await draft.checkpoint({ name: 'vector-work', asOf: time(1500) });
    for (const view of [historical, saved]) {
        assert.equal((await view.describe()).embedding.mode, mode);
        assert.equal((await view.read({ fileId: first.fileId })).path, '/first');
    }
    const docs = fixture.collections.get(name).branches.get('fork-vector-main').docs;
    assert.deepEqual(docs.get(`file:${first.fileId}`).embedding, new Array(64).fill(1));
});

test('historical requests validate dates and fixed checkpoint sources before native calls', async () => {
    const { main, draft, fixture } = await setup();
    const saved = await main.checkpoint({ name: 'saved' });
    const start = fixture.calls.length;
    for (const view of [main, draft]) for (const method of ['fork', 'checkpoint']) {
        for (const asOf of [null, 0, new Date(), '', '2026-02-30T00:00:00.000Z', '2026-01-01', '2026-01-01T00:00:00Z', new Date(Date.now() + 60_000).toISOString()])
            await assert.rejects(view[method]({ name: 'invalid', asOf }), { code: 'INVALID_INPUT' });
        await assert.rejects(view[method]({ name: 'cancelled', asOf: time(1000) }, { signal: AbortSignal.abort() }), { code: 'ABORTED' });
    }
    for (const method of ['fork', 'checkpoint'])
        await assert.rejects(saved[method]({ name: 'fixed', asOf: time(1000) }), { code: 'INVALID_INPUT' });
    assert.equal(fixture.calls.length, start);
});

test('expired native snapshots and reference creation races report historical unavailability without losing name conflict or unknown outcomes', async () => {
    const { main, draft, fixture, oldWorking, state } = await setup();
    await assert.rejects(draft.fork({ name: 'missing', asOf: time(1000) }), { code: 'HISTORICAL_VIEW_UNAVAILABLE' });
    await assert.rejects(draft.checkpoint({ name: 'missing', asOf: time(1000) }), { code: 'HISTORICAL_VIEW_UNAVAILABLE' });
    fixture.snapshotAt = () => oldWorking;
    await draft.fork({ name: 'missing', asOf: time(1000) }); // Definite failure releases the name.
    await assert.rejects(draft.fork({ name: 'missing', asOf: time(1000) }), { code: 'BRANCH_CONFLICT' });
    fixture.beforeTagCreate = tag => { if (tag === 'checkpoint-raced') state.tags.delete('md-main-v1'); };
    await assert.rejects(main.checkpoint({ name: 'raced', asOf: time(1000) }), { code: 'HISTORICAL_VIEW_UNAVAILABLE' });
    fixture.afterTagCreate = tag => { if (tag.name === 'checkpoint-unknown') throw new Error('Lost response'); };
    await assert.rejects(draft.checkpoint({ name: 'unknown', asOf: time(1000) }), { code: 'REF_CREATION_UNCONFIRMED' });
    const writes = fixture.calls.filter(call => call.kind === 'tag-create').length;
    await assert.rejects(draft.checkpoint({ name: 'unknown', asOf: time(1000) }), { code: 'REF_CREATION_UNCONFIRMED' });
    assert.equal(fixture.calls.filter(call => call.kind === 'tag-create').length, writes);
});

test('historical tools preserve the bound view and omit asOf from checkpoint schemas', async () => {
    const { main, client, first } = await setup();
    const tools = createFileTools({ drive: main, tools: ['fork', 'checkpoint'] });
    assert.equal(tools.definitions[0].inputSchema.properties.asOf.type, 'string');
    const created = await tools.execute('fork', { name: 'tool-past', asOf: time(1000) });
    assert.deepEqual(created, { name, at: { kind: 'fork', name: 'tool-past' } });
    const past = await MemDrive.open({ client, name, at: { fork: 'tool-past' } });
    assert.equal((await past.read({ fileId: first.fileId })).content, 'Revision 1');
    const saved = await main.checkpoint({ name: 'saved' });
    const fixed = createFileTools({ drive: saved, tools: ['fork', 'checkpoint'] });
    assert.equal('asOf' in fixed.definitions[0].inputSchema.properties, false);
    await assert.rejects(fixed.execute('fork', { name: 'invalid', asOf: time(1000) }), { code: 'INVALID_INPUT' });
    assert.equal((await main.read({ fileId: first.fileId })).content, 'Revision 2');
});

test('main time selection chooses the later publication when timestamps share a millisecond', async () => {
    const { main, records, first } = await setup();
    records.get('completion:2').completedAt = time(1000);
    const saved = await main.checkpoint({ name: 'same-time', asOf: time(1000) });
    assert.equal((await saved.read({ fileId: first.fileId })).content, 'Revision 2');
});
