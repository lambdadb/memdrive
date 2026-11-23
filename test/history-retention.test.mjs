import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { create, open } from '@functional-systems/memdrive';
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
const draftAt = { kind: 'fork', name: 'draft' };
/** Test shorthand that forwards one explicit at with every view request. */
function scoped(drive, at) {
    return {
        write: input => drive.write(Array.isArray(input) ? { at, operations: input } : { at, ...input }),
        read: input => drive.read({ at, ...input }),
        merge: (input, options) => drive.merge({ at, ...input }, options),
    };
}
const fork = async (drive, request) => scoped(drive, (await drive.fork(request)).at);
async function reopen(fixture, mode = 'managed') {
    const client = { ...fixture.client };
    const main = await open({ client, name: 'pruning-store', mode });
    return { main, draft: scoped(main, draftAt), client };
}
const replay = draft => draft.merge({ requestId: 'first', summary: 'Create note' });
const deletions = fixture => fixture.calls.filter(call => call.kind === 'tag-delete');

async function setup(external = false, retention = { retentionInDays: 1 }) {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'pruning-store', ...retention,
        ...(external ? { embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'fixture' } } : {}) });
    const draft = await fork(main, { name: 'draft' });
    const content = n => external ? new Array(64).fill(n) : `Revision ${n}`;
    const original = await draft.write({ op: 'create', path: '/note', content: content(1) });
    await draft.merge({ requestId: 'first', summary: 'Create note' });
    const saved = scoped(main, (await main.checkpoint({ name: 'saved' })).at);
    const oldFork = await fork(main, { name: 'alternate' });
    await draft.write({ op: 'update', fileId: original.fileId, content: content(2) });
    await draft.merge({ requestId: 'second', summary: 'Update note' });
    await draft.write({ op: 'update', fileId: original.fileId, content: content(3) });
    await draft.merge({ requestId: 'third', summary: 'Update note again' });
    const records = age(fixture, [8, 3, 2]);
    return { fixture, main, draft, saved, oldFork, original, records, content };
}

test('terminal merge automatically expires internal tags while preserving refs, history, cursors and replay', async () => {
    const { fixture, saved, oldFork, original } = await setup();
    const orphan = `merge-capture-${randomUUID()}`;
    await fixture.client.collection('pruning-store').tags.create({ tagName: orphan, source: { kind: 'branch', name: 'main' } });
    const { main, draft } = await reopen(fixture);
    assert.equal('pruneHistory' in main, false);
    const before = await main.history();
    const page = await main.history({ limit: 1 });
    assert.equal(deletions(fixture).length, 0); // Open and reads do not clean.
    assert.deepEqual(await replay(draft), { requestId: 'first', status: 'published', version: 'v1' });
    assert.equal(deletions(fixture).length, 5);
    const state = fixture.collections.get('pruning-store');
    assert.deepEqual([...state.tags.keys()].sort(), ['checkpoint-saved', 'md-main-v3', orphan].sort());
    assert(state.branches.has('md-main-v0'));
    assert.equal((await saved.read({ fileId: original.fileId })).content, 'Revision 1');
    assert.equal((await oldFork.read({ fileId: original.fileId })).content, 'Revision 1');
    assert.equal((await main.read({ fileId: original.fileId })).content, 'Revision 3');
    assert.deepEqual(await main.history(), before);
    assert.deepEqual((await main.history(page.next)).entries, before.entries.slice(1, 2));
    const fresh = await reopen(fixture);
    assert.deepEqual(await fresh.main.history(), before);
    await replay(fresh.draft);
    await assert.rejects(fresh.draft.merge({ requestId: 'first', summary: 'Different input' }), { code: 'MERGE_REQUEST_CONFLICT' });
    await oldFork.write({ op: 'update', fileId: original.fileId, content: 'Conflicting old fork' });
    await assert.rejects(oldFork.merge({ requestId: 'old-fork', summary: 'Try old baseline' }), { code: 'MERGE_CONFLICT' });
    assert(deletions(fixture).every(call => call.retries.strategy === 'none'));
});

test('new publication cleans old captures only after its own bookkeeping completes', async () => {
    const { fixture, original, records } = await setup();
    const { draft } = await reopen(fixture);
    await draft.write({ op: 'update', fileId: original.fileId, content: 'Revision 4' });
    fixture.beforeRefDelete = () => assert.equal(records.get('bookkeeping:4')?.kind, 'merge-bookkeeping-v1');
    assert.equal((await draft.merge({ requestId: 'fourth', summary: 'New revision' })).version, 'v4');
    assert.equal(deletions(fixture).length, 5);
    assert(fixture.collections.get('pruning-store').tags.has('md-main-v3')); // Just superseded.
});

test('supersession timing and the freshly read SDK window determine eligibility', async () => {
    const { fixture } = await setup();
    age(fixture, [20, 10, 0]);
    const { main, draft } = await reopen(fixture);
    await main.configure({ retentionInDays: 31 });
    await replay(draft);
    assert.equal(deletions(fixture).length, 0);
    // Another client shortens the window; the next pass rereads it.
    await (await reopen(fixture)).main.configure({ retentionInDays: 1 });
    await replay(draft);
    const tags = fixture.collections.get('pruning-store').tags;
    assert(!tags.has('md-main-v1'));
    assert(tags.has('md-main-v2'));
    assert(tags.has('md-main-v3'));
});

test('the SDK window, not one-day native retention, selects expired internal refs in both embedding modes', async () => {
    for (const external of [false, true]) {
        const { fixture, records } = await setup(external, {}); // Default 30-day window.
        assert.equal(fixture.collections.get('pruning-store').metadata.snapshotRetentionInDays, 1);
        age(fixture, [40, 31, 2]);
        const { main, draft } = await reopen(fixture, external ? 'external' : 'managed');
        assert.equal((await main.describe()).retentionInDays, 30);
        const before = await main.history();
        await replay(draft);
        // v1 was superseded 31 days ago; v2 only 2 days ago. Captures age from completion.
        const tags = fixture.collections.get('pruning-store').tags;
        assert.equal(deletions(fixture).length, 3);
        assert(!tags.has('md-main-v1'));
        assert(tags.has('md-main-v2') && tags.has('md-main-v3') && tags.has('checkpoint-saved'));
        assert(!tags.has(records.get('reservation:1').sourceTag) && !tags.has(records.get('reservation:2').sourceTag));
        assert(tags.has(records.get('reservation:3').sourceTag));
        assert.deepEqual(await main.history(), before);
    }
});

test('external stores retain history without loading vectors after cleanup', async () => {
    const { fixture, original, saved } = await setup(true);
    const { main, draft } = await reopen(fixture, 'external');
    const before = await main.history();
    await replay(draft);
    assert.equal(deletions(fixture).length, 5);
    assert.deepEqual(await (await reopen(fixture, 'external')).main.history(), before);
    assert.equal((await saved.read({ fileId: original.fileId })).fileId, original.fileId);
});

test('conflict and unchanged outcomes trigger cleanup without changing replay semantics', async () => {
    const { fixture, draft, oldFork, original } = await setup();
    await oldFork.write({ op: 'update', fileId: original.fileId, content: 'Rejected revision' });
    await assert.rejects(oldFork.merge({ requestId: 'conflict', summary: 'Conflicting change' }), { code: 'MERGE_CONFLICT' });
    const unchanged = await draft.merge({ requestId: 'unchanged', summary: 'No changes' });
    age(fixture, [8, 3, 2, 2, 2]);
    const fresh = await reopen(fixture);
    const freshOld = scoped(fresh.main, { kind: 'fork', name: 'alternate' });
    await assert.rejects(freshOld.merge({ requestId: 'conflict', summary: 'Conflicting change' }), { code: 'MERGE_CONFLICT' });
    assert.equal(deletions(fixture).length, 6);
    assert.deepEqual(await fresh.draft.merge({ requestId: 'unchanged', summary: 'No changes' }), unchanged);
});

test('bounded archives preserve 100 affected IDs and the truncation marker', async () => {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'pruning-store', retentionInDays: 1 });
    const draft = await fork(main, { name: 'draft' });
    await draft.write(Array.from({ length: 100 }, (_, i) => ({ op: 'create', path: `/file-${i}`, content: '' })));
    await draft.write({ op: 'create', path: '/extra', content: '' });
    await draft.merge({ requestId: 'first', summary: 'Create note' });
    age(fixture, [2]);
    const fresh = await reopen(fixture);
    const before = await fresh.main.history();
    assert.equal(before.entries[0].fileIds.length, 100);
    assert.equal(before.entries[0].fileIdsTruncated, true);
    await replay(fresh.draft);
    assert.equal(deletions(fixture).length, 1);
    assert.deepEqual(await (await reopen(fixture)).main.history(), before);
});

test('unfinished bookkeeping blocks cleanup until explicit recovery settles it', async () => {
    const { fixture, records } = await setup();
    records.delete('bookkeeping:3');
    const { draft } = await reopen(fixture);
    await replay(draft); // Old terminal request still replays, but cannot clean.
    assert.equal(deletions(fixture).length, 0);
    await open({ client: { ...fixture.client }, name: 'pruning-store', recover: true });
    assert.equal(deletions(fixture).length, 5);
});

test('unconfirmed archives retain all tags and retry automatically on a later merge', async () => {
    const { fixture } = await setup();
    const { main, draft } = await reopen(fixture);
    fixture.beforeUpsert = request => {
        if (request.docs.some(doc => doc.kind === 'merge-history-v1')) throw new Error('Lost archive response');
    };
    assert.equal((await replay(draft)).status, 'published');
    assert.equal(deletions(fixture).length, 0);
    await main.configure({ retentionInDays: 2 });
    fixture.beforeUpsert = undefined;
    await replay(draft);
    assert.equal(deletions(fixture).length, 5);
});

test('partial and unknown deletes preserve merge success and retry across clients', async () => {
    const { fixture } = await setup();
    const { main, draft } = await reopen(fixture);
    const before = await main.history();
    let deletes = 0;
    fixture.afterRefDelete = () => { if (++deletes === 2) throw new Error('Lost delete response'); };
    assert.equal((await replay(draft)).status, 'published');
    assert.equal(deletions(fixture).length, 2);
    fixture.afterRefDelete = undefined;
    const fresh = await reopen(fixture);
    assert.deepEqual(await fresh.main.history(), before);
    await replay(fresh.draft);
    assert.equal(deletions(fixture).length, 5);
    assert.deepEqual(await fresh.main.history(), before);
});

test('missing or invalid retention, replaced generation and cancellation skip cleanup', async () => {
    const { fixture } = await setup();
    const { draft } = await reopen(fixture);
    const metadata = fixture.collections.get('pruning-store').metadata;
    const configured = metadata.description;
    for (const description of ['memdrive-config-v1:{"chunking":{"strategy":"auto"}}',
        'memdrive-config-v1:{"chunking":{"strategy":"auto"},"retentionInDays":0}']) {
        metadata.description = description;
        await replay(draft);
        assert.equal(deletions(fixture).length, 0);
    }
    metadata.description = configured;
    metadata.createdAt = new Date(9000);
    await replay(draft);
    assert.equal(deletions(fixture).length, 0);
    await assert.rejects(draft.merge({ requestId: 'first', summary: 'Create note' }, { signal: AbortSignal.abort() }), { code: 'ABORTED' });
});

test('in-flight reads defer cleanup until another merge without blocking either result', async () => {
    const { fixture, original } = await setup();
    const { main, draft } = await reopen(fixture);
    let release, enter;
    const entered = new Promise(resolve => { enter = resolve; });
    fixture.beforeFetch = async request => {
        if (request.ids.includes(`file:${original.fileId}`)) {
            enter();
            await new Promise(resolve => { release = resolve; });
        }
    };
    const reading = main.read({ fileId: original.fileId });
    await entered;
    await replay(draft);
    assert.equal(deletions(fixture).length, 0);
    fixture.beforeFetch = undefined;
    release();
    assert.equal((await reading).content, 'Revision 3');
    await replay(draft);
    assert.equal(deletions(fixture).length, 5);
});

test('corrupt archives cannot justify deletion or replace a successful merge result', async () => {
    const { fixture, records } = await setup();
    const { draft } = await reopen(fixture);
    let deletes = 0;
    fixture.afterRefDelete = () => { if (++deletes === 1) throw new Error('Stop after one tag'); };
    await replay(draft);
    fixture.afterRefDelete = undefined;
    records.get('history:v1').sourceTag = `merge-capture-${randomUUID()}`;
    await replay(draft);
    assert.equal(deletions(fixture).length, 1);
});

test('cleanup is capped at 100 tags and the next merge continues the backlog', async () => {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'pruning-store', retentionInDays: 1 });
    const draft = await fork(main, { name: 'draft' });
    const file = await draft.write({ op: 'create', path: '/note', content: '0' });
    await draft.merge({ requestId: 'first', summary: 'Create note' });
    for (let i = 1; i < 52; i++) {
        await draft.write({ op: 'update', fileId: file.fileId, content: String(i) });
        await draft.merge({ requestId: `revision-${i}`, summary: 'Update note' });
    }
    age(fixture, []);
    const fresh = await reopen(fixture);
    await replay(fresh.draft);
    assert.equal(deletions(fixture).length, 100);
    await replay(fresh.draft);
    assert.equal(deletions(fixture).length, 103);
});

test('a history read racing cleanup uses the complete confirmed archive', async () => {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'pruning-store', retentionInDays: 1 });
    const draft = await fork(main, { name: 'draft' });
    await draft.write([{ op: 'create', path: '/one', content: '' }, { op: 'create', path: '/two', content: '' }]);
    await draft.merge({ requestId: 'first', summary: 'Create note' });
    age(fixture, [2]);
    const reader = await reopen(fixture);
    const before = await reader.main.history();
    const cleaner = await reopen(fixture);
    fixture.diffPage = async request => {
        if (!request.ref.name.startsWith('merge-capture-')) return;
        fixture.diffPage = undefined;
        const docs = fixture.collections.get('pruning-store').tags.get(request.ref.name).docs;
        const one = [...docs.values()].find(doc => doc.kind === 'file');
        await replay(cleaner.draft);
        return { isDocsInline: true, total: 1, docs: [{ collection: 'pruning-store', doc: one }] };
    };
    assert.deepEqual(await reader.main.history(), before);
    assert.equal(deletions(fixture).length, 1);
});

test('cleanup cancellation after publication preserves success and retries later', async () => {
    const { fixture } = await setup();
    const { draft } = await reopen(fixture);
    const controller = new AbortController();
    fixture.beforeUpsert = request => {
        if (request.docs.some(doc => doc.kind === 'merge-history-v1')) controller.abort();
    };
    const result = await draft.merge({ requestId: 'first', summary: 'Create note' }, { signal: controller.signal });
    assert.equal(result.status, 'published');
    assert.equal(deletions(fixture).length, 0);
    fixture.beforeUpsert = undefined;
    await replay(draft);
    assert.equal(deletions(fixture).length, 5);
});

test('cleanup has its own abort deadline without turning a terminal merge into failure', async () => {
    const { fixture } = await setup();
    let maintenanceSignal;
    const client = { ...fixture.client, collection(name) {
        const handle = fixture.client.collection(name);
        return { ...handle, async get(options) {
            maintenanceSignal = options?.signal;
            return handle.get(options);
        } };
    } };
    const draft = scoped(await open({ client, name: 'pruning-store' }), draftAt);
    fixture.beforeUpsert = request => {
        if (request.docs.some(doc => doc.kind === 'merge-history-v1')) return new Promise((_, reject) => {
            maintenanceSignal.addEventListener('abort', () => reject(new Error('Cleanup deadline')), { once: true });
        });
    };
    assert.equal((await replay(draft)).status, 'published');
    assert.equal(maintenanceSignal.aborted, true);
    assert.equal(deletions(fixture).length, 0);
    fixture.beforeUpsert = undefined;
    await replay(draft);
    assert.equal(deletions(fixture).length, 5);
});
