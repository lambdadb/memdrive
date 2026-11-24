import assert from 'node:assert/strict';
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
const released = fixture => deletions(fixture).map(call => call.name);

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

test('terminal merge automatically expires superseded main version tags while preserving refs, history, cursors and replay', async () => {
    const { fixture, saved, oldFork, original, records } = await setup();
    // An internal-looking tag that no completed merge superseded is never released.
    const orphan = 'md-main-v99';
    await fixture.client.collection('pruning-store').tags.create({ tagName: orphan, source: { kind: 'branch', name: 'main' } });
    const { main, draft } = await reopen(fixture);
    assert.equal('pruneHistory' in main, false);
    const before = await main.history();
    const page = await main.history({ limit: 1 });
    assert.equal(deletions(fixture).length, 0); // Open and reads do not clean.
    assert.deepEqual(await replay(draft), { requestId: 'first', status: 'published', version: 'v1' });
    // Only the versions that a later publication superseded are released.
    assert.deepEqual(released(fixture), ['md-main-v1', 'md-main-v2']);
    const state = fixture.collections.get('pruning-store');
    assert.deepEqual([...state.tags.keys()].sort(), ['checkpoint-saved', 'md-main-v3', orphan].sort());
    assert(state.branches.has('md-main-v0'));
    // Nothing was saved in place of a released tag.
    assert.deepEqual([...records.keys()].filter(id => !/^(?:reservation|completion|applied|bookkeeping|request|retention):/.test(id)), []);
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

test('new publication cleans superseded versions only after its own bookkeeping completes', async () => {
    const { fixture, original, records } = await setup();
    const { draft } = await reopen(fixture);
    await draft.write({ op: 'update', fileId: original.fileId, content: 'Revision 4' });
    fixture.beforeRefDelete = () => assert.equal(records.get('bookkeeping:4')?.kind, 'merge-bookkeeping-v1');
    assert.equal((await draft.merge({ requestId: 'fourth', summary: 'New revision' })).version, 'v4');
    assert.deepEqual(released(fixture), ['md-main-v1', 'md-main-v2']);
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
        const { fixture } = await setup(external, {}); // Default 30-day window.
        assert.equal(fixture.collections.get('pruning-store').metadata.snapshotRetentionInDays, 1);
        age(fixture, [40, 31, 2]);
        const { main, draft } = await reopen(fixture, external ? 'external' : 'managed');
        assert.equal((await main.describe()).retentionInDays, 30);
        const before = await main.history();
        await replay(draft);
        // v1 was superseded 31 days ago; v2 only 2 days ago.
        const tags = fixture.collections.get('pruning-store').tags;
        assert.deepEqual(released(fixture), ['md-main-v1']);
        assert.deepEqual([...tags.keys()].sort(), ['checkpoint-saved', 'md-main-v2', 'md-main-v3']);
        assert.deepEqual(await main.history(), before);
    }
});

test('external stores retain history without loading vectors after cleanup', async () => {
    const { fixture, original, saved } = await setup(true);
    const { main, draft } = await reopen(fixture, 'external');
    const before = await main.history();
    await replay(draft);
    assert.equal(deletions(fixture).length, 2);
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
    // A conflict and an unchanged request supersede nothing and pin nothing.
    assert.deepEqual(released(fixture), ['md-main-v1', 'md-main-v2']);
    assert.deepEqual(await fresh.draft.merge({ requestId: 'unchanged', summary: 'No changes' }), unchanged);
});

test('history keeps 100 affected IDs and the truncation marker after the version tag is released', async () => {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'pruning-store', retentionInDays: 1 });
    const draft = await fork(main, { name: 'draft' });
    const files = await draft.write(Array.from({ length: 100 }, (_, i) => ({ op: 'create', path: `/file-${i}`, content: '' })));
    files.push(await draft.write({ op: 'create', path: '/extra', content: '' }));
    await draft.merge({ requestId: 'first', summary: 'Create note' });
    await draft.write({ op: 'update', fileId: files[0].fileId, content: 'Revision 2' });
    await draft.merge({ requestId: 'second', summary: 'Update note' });
    age(fixture, [3, 2]);
    const fresh = await reopen(fixture);
    const before = await fresh.main.history();
    assert.deepEqual(before.entries[0].fileIds, files.map(({ fileId }) => fileId).sort().slice(0, 100));
    assert.equal(before.entries[0].fileIdsTruncated, true);
    await replay(fresh.draft);
    assert.deepEqual(released(fixture), ['md-main-v1']);
    assert.deepEqual(await (await reopen(fixture)).main.history(), before);
});

test('unfinished bookkeeping blocks cleanup until explicit recovery settles it', async () => {
    const { fixture, records } = await setup();
    records.delete('bookkeeping:3');
    const { draft } = await reopen(fixture);
    await replay(draft); // Old terminal request still replays, but cannot clean.
    assert.equal(deletions(fixture).length, 0);
    await open({ client: { ...fixture.client }, name: 'pruning-store', recover: true });
    assert.equal(deletions(fixture).length, 2);
});

test('partial and unknown deletes preserve merge success and retry across clients', async () => {
    const { fixture } = await setup();
    const { main, draft } = await reopen(fixture);
    const before = await main.history();
    fixture.afterRefDelete = () => { throw new Error('Lost delete response'); };
    assert.equal((await replay(draft)).status, 'published');
    // The pass stops at the first deletion it cannot confirm.
    assert.deepEqual(released(fixture), ['md-main-v1']);
    fixture.afterRefDelete = undefined;
    const fresh = await reopen(fixture);
    assert.deepEqual(await fresh.main.history(), before);
    await replay(fresh.draft);
    assert.deepEqual(released(fixture), ['md-main-v1', 'md-main-v2']);
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
    assert.equal(deletions(fixture).length, 2);
});

test('the retention pass keeps the merge queue but not the queue of the merged fork', async () => {
    const { fixture, original } = await setup();
    const { draft } = await reopen(fixture);
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    // The pass lists tags once, and waits there.
    fixture.listTags = async () => {
        fixture.listTags = undefined;
        enter();
        await held;
        return { tags: [...fixture.collections.get('pruning-store').tags.keys()].map(name => ({ name })) };
    };
    let returned = false, merged = false;
    const merging = replay(draft).then(result => { returned = true; return result; });
    await entered;
    // A write to the fork does not wait for the pass.
    await draft.write({ op: 'update', fileId: original.fileId, content: 'Revision 4' });
    assert.equal(returned, false);
    // Another merge does: cleanup stays serialized with merges.
    const next = draft.merge({ requestId: 'fourth', summary: 'New revision' }).then(result => { merged = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(merged, false);
    release();
    assert.equal((await merging).status, 'published');
    assert.equal((await next).version, 'v4');
    assert.deepEqual(released(fixture), ['md-main-v1', 'md-main-v2']);
    assert.equal((await draft.read({ fileId: original.fileId })).content, 'Revision 4');
});

test('a malformed publication record cannot justify deletion or replace a successful merge result', async () => {
    const { fixture, records } = await setup();
    const { main, draft } = await reopen(fixture);
    const { fileIds } = records.get('completion:2');
    delete records.get('completion:2').fileIds;
    assert.equal((await replay(draft)).status, 'published');
    assert.equal(deletions(fixture).length, 0);
    assert.equal(records.has('retention:watermark'), false);
    await assert.rejects(main.history(), { code: 'INVALID_RESULT' });
    records.get('completion:2').fileIds = fileIds;
    await replay(draft);
    assert.equal(deletions(fixture).length, 2);
});

/** A store whose draft published `count` versions, each superseding the one before. */
async function publishVersions(count) {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'pruning-store', retentionInDays: 1 });
    const draft = await fork(main, { name: 'draft' });
    const file = await draft.write({ op: 'create', path: '/note', content: '0' });
    await draft.merge({ requestId: 'first', summary: 'Create note' });
    for (let i = 1; i < count; i++) {
        await draft.write({ op: 'update', fileId: file.fileId, content: String(i) });
        await draft.merge({ requestId: `revision-${i}`, summary: 'Update note' });
    }
    return fixture;
}

test('cleanup is capped at 100 tags and the next merge continues the backlog', async () => {
    // 103 publications leave 102 superseded version tags.
    const fixture = await publishVersions(103);
    age(fixture, []);
    const fresh = await reopen(fixture);
    await replay(fresh.draft);
    assert.equal(deletions(fixture).length, 100);
    await replay(fresh.draft);
    assert.equal(deletions(fixture).length, 102);
    assert.deepEqual([...fixture.collections.get('pruning-store').tags.keys()], ['md-main-v103']);
});

test('a history read racing cleanup returns the complete entry while its version tag is released', async () => {
    const fixture = fileClient();
    const main = await create({ client: fixture.client, name: 'pruning-store', retentionInDays: 1 });
    const draft = await fork(main, { name: 'draft' });
    const [one] = await draft.write([{ op: 'create', path: '/one', content: '' }, { op: 'create', path: '/two', content: '' }]);
    await draft.merge({ requestId: 'first', summary: 'Create note' });
    await draft.write({ op: 'update', fileId: one.fileId, content: 'Revision 2' });
    await draft.merge({ requestId: 'second', summary: 'Update note' });
    age(fixture, [3, 2]);
    const reader = await reopen(fixture);
    const before = await reader.main.history();
    assert.deepEqual(before.entries.map(entry => entry.fileIds.length), [2, 1]);
    const cleaner = await reopen(fixture);
    // Cleanup releases the first version's tag while the reader is fetching the slot records.
    fixture.beforeFetch = async request => {
        if (!request.ids.includes('completion:1') || !request.ids.includes('reservation:1') || request.ids.includes('bookkeeping:1')) return;
        fixture.beforeFetch = undefined;
        await replay(cleaner.draft);
    };
    const start = fixture.calls.length;
    assert.deepEqual(await reader.main.history(), before);
    assert.equal(fixture.beforeFetch, undefined);
    assert.deepEqual(released(fixture), ['md-main-v1']);
    // History and cleanup read journal records only, never file content.
    assert.equal(fixture.calls.slice(start).some(call => call.kind === 'query'), false);
});

test('cleanup cancellation after publication preserves success and retries later', async () => {
    const { fixture } = await setup();
    const { draft } = await reopen(fixture);
    const controller = new AbortController();
    // The pass lists tags once, before it deletes any.
    fixture.listTags = () => {
        fixture.listTags = undefined;
        controller.abort();
    };
    const result = await draft.merge({ requestId: 'first', summary: 'Create note' }, { signal: controller.signal });
    assert.equal(result.status, 'published');
    assert.equal(controller.signal.aborted, true);
    assert.equal(deletions(fixture).length, 0);
    await replay(draft);
    assert.equal(deletions(fixture).length, 2);
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
    // The tag listing of the pass never answers.
    fixture.listTags = () => new Promise((_, reject) => {
        maintenanceSignal.addEventListener('abort', () => reject(new Error('Cleanup deadline')), { once: true });
    });
    assert.equal((await replay(draft)).status, 'published');
    assert.equal(maintenanceSignal.aborted, true);
    assert.equal(deletions(fixture).length, 0);
    fixture.listTags = undefined;
    await replay(draft);
    assert.equal(deletions(fixture).length, 2);
});

const watermark = records => records.get('retention:watermark')?.slot;
const lookups = fixture => fixture.calls.filter(call => call.kind === 'tag-get').length;

test('the retention watermark never passes a tag whose deletion failed or is unconfirmed', async () => {
    for (const uncertain of [false, true]) {
        const { fixture, records } = await setup();
        const { draft } = await reopen(fixture);
        const state = fixture.collections.get('pruning-store');
        // Slot 2 releases the main tag it superseded, then slot 3 releases its own.
        fixture[uncertain ? 'afterRefDelete' : 'beforeRefDelete'] = (_kind, tag) => {
            if (tag === 'md-main-v1') throw Object.assign(new Error('Deletion failed'), uncertain ? {} : { statusCode: 403 });
        };
        assert.equal((await replay(draft)).status, 'published');
        assert.deepEqual(released(fixture), ['md-main-v1']);
        assert.equal(state.tags.has('md-main-v1'), !uncertain);
        assert.equal(watermark(records), '2');
        assert(state.tags.has('md-main-v2'));
        fixture.afterRefDelete = fixture.beforeRefDelete = undefined;
        // A later pass, on any client, resumes at the unreleased slot and confirms it.
        await replay((await reopen(fixture)).draft);
        assert.deepEqual(released(fixture), uncertain ? ['md-main-v1', 'md-main-v2'] : ['md-main-v1', 'md-main-v1', 'md-main-v2']);
        assert.deepEqual([...state.tags.keys()].sort(), ['checkpoint-saved', 'md-main-v3']);
        assert.equal(watermark(records), '4');
    }
});

test('cleanup stops at a slot still inside the window and resumes in order once it expires', async () => {
    const { fixture, records } = await setup();
    age(fixture, [8, 0, 3]);
    const { main, draft } = await reopen(fixture);
    const before = await main.history();
    const state = fixture.collections.get('pruning-store');
    await replay(draft);
    // The first slot superseded nothing. The second has not expired, so nothing
    // after it is examined, although the third has, and the watermark stays on it.
    assert.deepEqual(released(fixture), []);
    assert.equal(watermark(records), '2');
    for (const tag of ['md-main-v1', 'md-main-v2', 'md-main-v3']) assert(state.tags.has(tag), tag);
    await replay(draft);
    assert.deepEqual(released(fixture), []);
    // Only the second outcome ages. Its recorded time is also its publication time.
    records.get('completion:2').completedAt = new Date(Date.now() - 3 * day).toISOString();
    await replay(draft);
    assert.deepEqual(released(fixture), ['md-main-v1', 'md-main-v2']);
    assert.deepEqual([...state.tags.keys()].sort(), ['checkpoint-saved', 'md-main-v3']);
    assert.equal(watermark(records), '4');
    const summary = ({ version, summary, fileIds }) => ({ version, summary, fileIds });
    assert.deepEqual((await (await reopen(fixture)).main.history()).entries.map(summary), before.entries.map(summary));
});

test('an unfinished merge leaves the watermark untouched until recovery settles it', async () => {
    const { fixture, records, original } = await setup();
    const { draft } = await reopen(fixture);
    await draft.write({ op: 'update', fileId: original.fileId, content: 'Revision 4' });
    fixture.beforeUpsert = request => {
        if (request.docs.some(doc => doc.kind === 'merge-result-v1')) throw new Error('Lost completion');
    };
    await assert.rejects(draft.merge({ requestId: 'fourth', summary: 'New revision' }), { code: 'MERGE_RESUMABLE' });
    fixture.beforeUpsert = undefined;
    const observer = await reopen(fixture);
    await replay(observer.draft); // A settled request replays beside the unfinished head.
    assert.equal(deletions(fixture).length, 0);
    assert.equal(watermark(records), undefined);
    await open({ client: { ...fixture.client }, name: 'pruning-store', recover: true });
    // The recovered publication is new, so the version it superseded stays.
    assert.deepEqual(released(fixture), ['md-main-v1', 'md-main-v2']);
    assert.equal(watermark(records), '4');
    assert(fixture.collections.get('pruning-store').tags.has('md-main-v3'));
});

test('a lost watermark write only repeats confirmed work on the next pass', async () => {
    for (const applied of [false, true]) {
        const { fixture, records } = await setup();
        const { main, draft } = await reopen(fixture);
        const before = await main.history();
        fixture[applied ? 'afterUpsert' : 'beforeUpsert'] = request => {
            if (request.docs.some(doc => doc.kind === 'retention-watermark-v1')) throw new Error('Lost watermark response');
        };
        assert.equal((await replay(draft)).status, 'published');
        assert.equal(deletions(fixture).length, 2);
        assert.equal(watermark(records), applied ? '4' : undefined);
        fixture.afterUpsert = fixture.beforeUpsert = undefined;
        // A client without the lost value starts lower, finds nothing left to delete
        // and confirms each absent tag directly before storing the watermark.
        const fresh = await reopen(fixture);
        const confirmed = lookups(fixture);
        await replay(fresh.draft);
        assert.equal(deletions(fixture).length, 2);
        assert.equal(lookups(fixture) - confirmed, applied ? 0 : 2);
        assert.equal(watermark(records), '4');
        assert.deepEqual(await fresh.main.history(), before);
    }
});

test('a fresh client continues cleanup from the stored watermark without rereading earlier slots', async () => {
    const fixture = await publishVersions(103);
    const records = age(fixture, []);
    const latest = draft => draft.merge({ requestId: 'revision-102', summary: 'Update note' });
    await latest((await reopen(fixture)).draft);
    // The pass stops at the slot whose tag would exceed its limit.
    assert.equal(deletions(fixture).length, 100);
    assert.equal(watermark(records), '102');

    const fresh = await reopen(fixture);
    const start = fixture.calls.length;
    await latest(fresh.draft);
    assert.equal(deletions(fixture).length, 102);
    assert.equal(watermark(records), '104');
    const fetches = fixture.calls.slice(start).filter(call => call.kind === 'fetch' && call.request.ref.name === 'main'
        && call.request.ids.some(id => /^(?:reservation|completion|bookkeeping|request|retention):/.test(id)));
    // Outcomes are read only from the watermark on. The cold head search also
    // probes the first slot.
    const outcomes = new Set(fetches.flatMap(call => call.request.ids).filter(id => id.startsWith('completion:'))
        .map(id => Number(id.slice('completion:'.length))));
    assert.deepEqual([...outcomes].sort((a, b) => a - b), [1, 102, 103]);
    assert(fetches.length <= 16, `${fetches.length} journal fetches`);
    await latest(fresh.draft);
    assert.equal(deletions(fixture).length, 102);
});

test('a history page reads only slot records, with the same result before and after cleanup', async () => {
    const { fixture } = await setup();
    const reads = async drive => {
        const start = fixture.calls.length;
        const page = await drive.history();
        const calls = fixture.calls.slice(start);
        return { page, kinds: [...new Set(calls.map(call => call.kind))], ids: calls.map(call => call.request.ids) };
    };
    const { main, draft } = await reopen(fixture);
    // A cold client finds the head, then reads the page's slots in one fetch.
    const before = await reads(main);
    assert.deepEqual(before.kinds, ['fetch']);
    assert.deepEqual(before.ids.at(-1), [1, 2, 3].flatMap(slot => [`reservation:${slot}`, `completion:${slot}`]));
    assert.deepEqual(before.page.entries.map(({ version }) => version), ['v1', 'v2', 'v3']);
    await replay(draft);
    assert.deepEqual(released(fixture), ['md-main-v1', 'md-main-v2']);
    const after = await reads((await reopen(fixture)).main);
    assert.deepEqual(after, before);
    // A warm client probes the next slot and reads the page.
    const warm = await reads(main);
    assert.deepEqual(warm.ids, [['reservation:4', 'completion:4', 'bookkeeping:4'], before.ids.at(-1)]);
    assert.deepEqual(warm.page, before.page);
});
