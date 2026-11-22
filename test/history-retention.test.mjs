import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { create, open, destroy } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

const day = 86_400_000;
const age = (fixture, days) => {
    const journal = [...fixture.collections.values()].find(store => store.metadata.tags['memdrive.format'] === 'merge-publication-v1');
    for (const doc of journal.branches.get('main').docs.values()) {
        if (doc.kind === 'merge-result-v1') {
            const slot = Number(doc.id.slice('completion:'.length));
            doc.completedAt = new Date(Date.now() - (days[slot - 1] ?? 2) * day).toISOString();
        } else if (doc.kind === 'merge-reservation-v1') {
            const slot = Number(doc.id.slice('reservation:'.length));
            doc.startedAt = new Date(Date.now() - (days[slot - 1] ?? 2) * day - 1000).toISOString();
        }
    }
    return journal.branches.get('main').docs;
};
const reopen = (fixture, mode = 'managed') => open({ client: { ...fixture.client }, name: 'pruning-store', mode });

async function setup(external = false) {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'pruning-store', retentionInDays: 1,
        ...(external ? { embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'fixture' } } : {}) });
    const draft = await main.fork({ name: 'draft' });
    const content = n => external ? new Array(64).fill(n) : `Revision ${n}`;
    const original = await draft.write({ op: 'create', path: '/note', content: content(1) });
    await draft.merge({ requestId: 'first', summary: 'Create note' });
    const saved = await main.checkpoint({ name: 'saved' });
    const oldFork = await main.fork({ name: 'alternate' });
    await draft.write({ op: 'update', fileId: original.fileId, content: content(2) });
    await draft.merge({ requestId: 'second', summary: 'Update note' });
    await draft.write({ op: 'update', fileId: original.fileId, content: content(3) });
    await draft.merge({ requestId: 'third', summary: 'Update note again' });
    const records = age(fixture, [8, 3, 2]);
    return { fixture, main, draft, saved, oldFork, original, records, content };
}

test('cleanup previews and batches only expired internal tags, preserving refs, history and replay', async () => {
    const { fixture, draft, saved, oldFork, original } = await setup();
    const orphan = `merge-capture-${randomUUID()}`;
    await fixture.client.collection('pruning-store').tags.create({ tagName: orphan, source: { kind: 'branch', name: 'main' } });
    const main = await reopen(fixture);
    const before = await main.history();
    const firstPage = await main.history({ limit: 1 });
    const callStart = fixture.calls.length;
    const preview = await main.pruneHistory();
    assert.equal(preview.dryRun, true);
    assert.equal(preview.retentionInDays, 1);
    assert.equal(preview.tags.length, 5);
    assert.deepEqual(preview.deleted, []);
    assert(!fixture.calls.slice(callStart).some(call => ['upsert', 'tag-delete', 'branch-delete'].includes(call.kind)));
    const batch = await main.pruneHistory({ dryRun: false, limit: 2 });
    assert.equal(batch.deleted.length, 2);
    assert.equal(batch.hasMore, true);
    const rest = await main.pruneHistory({ dryRun: false });
    assert.equal(rest.deleted.length, 3);
    assert.equal(rest.hasMore, false);
    const state = fixture.collections.get('pruning-store');
    assert.deepEqual([...state.tags.keys()].sort(), ['checkpoint-saved', 'md-main-v3', orphan].sort());
    assert(state.branches.has('md-main-v0'));
    assert.equal((await saved.read({ fileId: original.fileId })).content, 'Revision 1');
    assert.equal((await oldFork.read({ fileId: original.fileId })).content, 'Revision 1');
    assert.equal((await main.read({ fileId: original.fileId })).content, 'Revision 3');
    assert.deepEqual(await main.history(), before);
    assert.deepEqual((await main.history({ cursor: firstPage.cursor })).entries, before.entries.slice(1, 2));
    const fresh = await reopen(fixture);
    assert.deepEqual(await fresh.history(), before);
    const replayFork = await open({ client: { ...fixture.client }, name: 'pruning-store', at: { fork: 'draft' } });
    const tagCount = state.tags.size;
    assert.deepEqual(await replayFork.merge({ requestId: 'first', summary: 'Create note' }),
        { requestId: 'first', status: 'published', version: 'v1' });
    assert.equal(state.tags.size, tagCount);
    await assert.rejects(draft.merge({ requestId: 'first', summary: 'Different input' }), { code: 'MERGE_REQUEST_CONFLICT' });
    await oldFork.write({ op: 'update', fileId: original.fileId, content: 'Conflicting old fork' });
    await assert.rejects(oldFork.merge({ requestId: 'old-fork', summary: 'Try old baseline' }), { code: 'MERGE_CONFLICT' });
    assert(fixture.calls.filter(call => call.kind === 'tag-delete').every(call => call.retries.strategy === 'none'));
});

test('a long-lived main version is retained until its successor is old enough and native retention is read afresh', async () => {
    const { fixture } = await setup();
    age(fixture, [20, 10, 0]);
    const main = await reopen(fixture);
    const preview = await main.pruneHistory();
    assert(preview.tags.includes('md-main-v1'));
    assert(!preview.tags.includes('md-main-v2'));
    assert(!preview.tags.includes('md-main-v3'));
    fixture.collections.get('pruning-store').metadata.snapshotRetentionInDays = 31;
    assert.deepEqual((await main.pruneHistory()).tags, []);
    assert.equal((await main.describe()).retentionInDays, 31);
});

test('external stores retain bounded history without requiring vectors after cleanup', async () => {
    const { fixture, original, saved } = await setup(true);
    const main = await reopen(fixture, 'external');
    const before = await main.history();
    assert.equal((await main.pruneHistory({ dryRun: false })).deleted.length, 5);
    assert.deepEqual(await (await reopen(fixture, 'external')).history(), before);
    assert.equal((await saved.read({ fileId: original.fileId })).fileId, original.fileId);
});

test('completed conflict captures expire while conflict and unchanged request replay survive', async () => {
    const { fixture, draft, oldFork, original } = await setup();
    await oldFork.write({ op: 'update', fileId: original.fileId, content: 'Rejected revision' });
    await assert.rejects(oldFork.merge({ requestId: 'conflict', summary: 'Conflicting change' }), { code: 'MERGE_CONFLICT' });
    const unchanged = await draft.merge({ requestId: 'unchanged', summary: 'No changes' });
    age(fixture, [8, 3, 2, 2, 2]);
    const main = await reopen(fixture);
    assert.equal((await main.pruneHistory({ dryRun: false })).deleted.length, 6);
    const freshClient = { ...fixture.client };
    const freshOld = await open({ client: freshClient, name: 'pruning-store', at: { fork: 'alternate' } });
    await assert.rejects(freshOld.merge({ requestId: 'conflict', summary: 'Conflicting change' }), { code: 'MERGE_CONFLICT' });
    const freshDraft = await open({ client: freshClient, name: 'pruning-store', at: { fork: 'draft' } });
    assert.deepEqual(await freshDraft.merge({ requestId: 'unchanged', summary: 'No changes' }), unchanged);
});

test('archived history preserves the original bounded file-ID list and truncation marker', async () => {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'pruning-store', retentionInDays: 1 });
    const draft = await main.fork({ name: 'draft' });
    await draft.write(Array.from({ length: 100 }, (_, i) => ({ op: 'create', path: `/file-${i}`, content: '' })));
    await draft.write({ op: 'create', path: '/extra', content: '' });
    await draft.merge({ requestId: 'many-files', summary: 'Create empty fixtures' });
    age(fixture, [2]);
    const fresh = await reopen(fixture);
    const before = await fresh.history();
    assert.equal(before.entries[0].fileIds.length, 100);
    assert.equal(before.entries[0].fileIdsTruncated, true);
    assert.equal((await fresh.pruneHistory({ dryRun: false })).deleted.length, 1);
    assert.deepEqual(await (await reopen(fixture)).history(), before);
});

test('unfinished bookkeeping prevents cleanup even when its publication is old', async () => {
    const { fixture, records } = await setup();
    records.delete('bookkeeping:3');
    const main = await reopen(fixture);
    await assert.rejects(main.pruneHistory({ dryRun: false }), { code: 'MERGE_BLOCKED' });
    assert(!fixture.calls.some(call => call.kind === 'tag-delete'));
});

test('summaries must be confirmed before any deletion, and explicit retry settles an uncertain archive', async () => {
    const { fixture } = await setup();
    const main = await reopen(fixture);
    fixture.beforeUpsert = request => {
        if (request.docs.some(doc => doc.kind === 'merge-history-v1')) throw new Error('Lost archive response');
    };
    await assert.rejects(main.pruneHistory({ dryRun: false }), { code: 'HISTORY_CLEANUP_UNCONFIRMED' });
    assert(!fixture.calls.some(call => call.kind === 'tag-delete'));
    await assert.rejects(main.configure({ retentionInDays: 2 }), { code: 'HISTORY_CLEANUP_UNCONFIRMED' });
    await assert.rejects(main.pruneHistory(), { code: 'HISTORY_CLEANUP_UNCONFIRMED' });
    fixture.beforeUpsert = undefined;
    assert.equal((await main.pruneHistory({ dryRun: false })).deleted.length, 5);
    assert.equal((await main.configure({ retentionInDays: 2 })).retentionInDays, 2);
});

test('partial tag deletion is recoverable across clients without losing archived history', async () => {
    const { fixture } = await setup();
    const client = { ...fixture.client };
    const main = await open({ client, name: 'pruning-store' });
    const before = await main.history();
    let deletes = 0;
    fixture.afterRefDelete = () => { if (++deletes === 2) throw new Error('Lost delete response'); };
    await assert.rejects(main.pruneHistory({ dryRun: false }), error => {
        assert.equal(error.code, 'HISTORY_CLEANUP_UNCONFIRMED');
        assert.equal(error.details.deleted.length, 1);
        return true;
    });
    await assert.rejects(destroy({ client, name: 'pruning-store' }), { code: 'HISTORY_CLEANUP_UNCONFIRMED' });
    fixture.afterRefDelete = undefined;
    const fresh = await reopen(fixture);
    assert.deepEqual(await fresh.history(), before);
    assert.equal((await fresh.pruneHistory({ dryRun: false })).deleted.length, 3);
    assert.deepEqual(await fresh.history(), before);
    assert.equal((await main.pruneHistory({ dryRun: false })).deleted.length, 0);
    await main.configure({ retentionInDays: 2 });
});

test('cleanup validates inputs, missing native retention and replaced store generations without mutations', async () => {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'pruning-store' });
    for (const request of [{ limit: 0 }, { limit: 1001 }, { limit: '1' }, { dryRun: 'false' }, { force: true }])
        await assert.rejects(main.pruneHistory(request), { code: 'INVALID_INPUT' });
    await assert.rejects(main.pruneHistory({}, { signal: AbortSignal.abort() }), { code: 'ABORTED' });
    await assert.rejects(main.pruneHistory({ dryRun: false }), { code: 'RETENTION_UNAVAILABLE' });
    await main.configure({ retentionInDays: 7 });
    assert.deepEqual((await main.pruneHistory()).tags, []);
    fixture.collections.get('pruning-store').metadata.createdAt = new Date(9000);
    await assert.rejects(main.pruneHistory({ dryRun: false }), { code: 'STORE_REPLACED' });
    assert(!fixture.calls.some(call => call.kind === 'tag-delete'));
});

test('cleanup excludes concurrent operations and malformed archives cannot justify deletion', async () => {
    const { fixture, records } = await setup();
    const main = await reopen(fixture);
    let release, enter;
    const entered = new Promise(resolve => { enter = resolve; });
    fixture.beforeUpsert = async request => {
        if (request.docs.some(doc => doc.kind === 'merge-history-v1')) {
            enter();
            await new Promise(resolve => { release = resolve; });
        }
    };
    const pruning = main.pruneHistory({ dryRun: false, limit: 1 });
    await entered;
    await assert.rejects(main.read({ path: '/note' }), { code: 'STORE_BUSY' });
    fixture.beforeUpsert = undefined;
    release();
    await pruning;
    records.get('history:v1').sourceTag = `merge-capture-${randomUUID()}`;
    const deleted = fixture.calls.filter(call => call.kind === 'tag-delete').length;
    await assert.rejects(main.pruneHistory({ dryRun: false }), { code: 'INVALID_RESULT' });
    assert.equal(fixture.calls.filter(call => call.kind === 'tag-delete').length, deleted);
});
