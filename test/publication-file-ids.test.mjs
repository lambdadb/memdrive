import assert from 'node:assert/strict';
import test from 'node:test';
import { MemDrive } from '@functional-systems/memdrive';
import { parseOutcome } from '../dist/esm/publication-log.js';
import { fileClient } from './helpers/file-client.mjs';

const name = 'file-id-store';
const draft = { kind: 'fork', name: 'draft' };
const request = requestId => ({ requestId, summary: `Publish ${requestId}` });
const published = (requestId, version) => ({ requestId, status: 'published', version });
const journalOf = fixture => [...fixture.collections.values()]
    .find(store => store.metadata.tags['memdrive.format'] === 'merge-publication-v1').branches.get('main').docs;
const completionWrites = fixture => fixture.calls
    .filter(call => call.kind === 'upsert' && call.request.docs[0].kind === 'merge-result-v1').map(call => call.request.docs[0]);
const lost = () => new Error('Response lost');
const sorted = files => files.map(({ fileId }) => fileId).sort();

const forkDocs = fixture => fixture.collections.get(name).branches.get('fork-draft').docs;

/** The first 100 net changes that the fork's stored originals state, without the SDK's diff. */
function fromRecords(fixture) {
    const ids = [...forkDocs(fixture).values()]
        .filter(doc => doc.changed === true && (doc.kind === 'tombstone' ? doc.baseline !== undefined
            : doc.kind === 'file' && doc.fingerprint !== doc.baseline?.fingerprint))
        .map(doc => doc.fileId).sort();
    return { fileIds: ids.slice(0, 100), fileIdsTruncated: ids.length > 100 };
}

async function setup() {
    const fixture = fileClient();
    const main = await MemDrive.create({ client: fixture.client, name });
    await main.fork({ name: 'draft' });
    const write = input => main.write(Array.isArray(input) ? { at: draft, operations: input } : { at: draft, ...input });
    // What the fork holds when a merge is first requested is what that merge may publish.
    const sources = new Map();
    const merge = async requestId => {
        if (!sources.has(requestId)) {
            const changes = await main.diff({ at: draft });
            sources.set(requestId, { diff: { fileIds: changes.slice(0, 100).map(change => change.fileId), fileIdsTruncated: changes.length > 100 },
                records: fromRecords(fixture) });
        }
        return main.merge({ at: draft, ...request(requestId) });
    };
    // One write accepts at most 100 operations.
    const create = async (count, prefix) => {
        const files = [];
        for (let start = 0; start < count; start += 100) files.push(...await write(Array.from({ length: Math.min(100, count - start) },
            (_, i) => ({ op: 'create', path: `/${prefix}-${start + i}`, content: `${prefix} ${start + i}` }))));
        return files;
    };
    /** Check one publication's history entry and stored record against the fork as its merge found it. */
    function assertRecorded(entry, slot, requestId, label = entry.version) {
        const completion = journalOf(fixture).get(`completion:${slot}`);
        const { fileIds, fileIdsTruncated } = entry;
        assert.deepEqual({ fileIds, fileIdsTruncated }, sources.get(requestId).diff, label);
        assert.deepEqual({ fileIds, fileIdsTruncated }, sources.get(requestId).records, label);
        assert.deepEqual(Object.keys(completion).sort(),
            ['completedAt', 'driveId', 'fileIds', 'fileIdsTruncated', 'id', 'kind', 'status', 'version'], label);
        assert.deepEqual([completion.status, completion.version, completion.fileIds, completion.fileIdsTruncated, completion.completedAt],
            ['published', entry.version, fileIds, fileIdsTruncated, entry.publishedAt], label);
    }
    return { fixture, main, write, merge, create, assertRecorded };
}

test('a publication records the affected file IDs that its fork held when the merge started', async () => {
    const { fixture, main, write, merge, create, assertRecorded } = await setup();
    const expected = [], requests = [];
    const publish = async (requestId, files, truncated = false) => {
        const slot = expected.length + 1;
        requests.push(requestId);
        assert.deepEqual(await merge(requestId), published(requestId, `v${slot}`));
        expected.push({ version: `v${slot}`, summary: `Publish ${requestId}`, fileIds: sorted(files).slice(0, 100), fileIdsTruncated: truncated });
    };

    // Creates.
    const [a, b, c] = await create(3, 'first');
    await publish('creates', [a, b, c]);
    // An update, a move, a delete and a create in one publication.
    await write([{ op: 'update', fileId: a.fileId, content: 'changed' }, { op: 'update', fileId: b.fileId, newPath: '/moved' },
        { op: 'delete', fileId: c.fileId }]);
    const d = await write({ op: 'create', path: '/added', content: 'added' });
    await publish('mixed', [a, b, c, d]);
    // An edit that is undone and a file created and deleted before publication are not affected files.
    await write({ op: 'update', fileId: a.fileId, content: 'temporary' });
    await write({ op: 'update', fileId: a.fileId, content: 'changed' });
    const transient = await write({ op: 'create', path: '/transient', content: 'transient' });
    await write({ op: 'delete', fileId: transient.fileId });
    await write({ op: 'update', fileId: d.fileId, content: 'added again', newPath: '/renamed' });
    await publish('net', [d]);
    // Exactly 100 affected files are complete, not truncated.
    const hundred = await create(100, 'hundred');
    await publish('exact', hundred);
    // 101 updates, moves and deletes are truncated to the first 100 IDs.
    const ordered = [...hundred].sort((x, y) => x.fileId < y.fileId ? -1 : 1);
    const operations = ordered.map(({ fileId }, i) => i % 3 === 0 ? { op: 'update', fileId, content: `updated ${i}` }
        : i % 3 === 1 ? { op: 'update', fileId, newPath: `/moved-${i}` } : { op: 'delete', fileId });
    operations.push({ op: 'delete', fileId: a.fileId });
    for (let start = 0; start < operations.length; start += 50) await write(operations.slice(start, start + 50));
    await publish('over', [...hundred, a], true);
    // Many more than 100 creates.
    await publish('many', await create(250, 'many'), true);

    const history = await main.history();
    assert.equal(history.throughVersion, 'v6');
    assert.deepEqual(history.entries.map(({ publishedAt: _publishedAt, ...entry }) => entry), expected);
    for (const [index, entry] of history.entries.entries()) assertRecorded(entry, index + 1, requests[index]);
    assert.deepEqual(history.entries.map(entry => entry.fileIds.length), [3, 4, 1, 100, 100, 100]);
    // The record is the whole answer: a client that never saw the merges returns
    // the same entries, although the fork no longer states any of those changes.
    assert.deepEqual(await main.diff({ at: draft }), []);
    assert.deepEqual(await (await MemDrive.open({ client: { ...fixture.client }, name })).history(), history);
});

test('a lost completion write is retried with the identical record', async () => {
    for (const applied of [false, true]) {
        const { fixture, main, write, merge, create, assertRecorded } = await setup();
        const files = await create(3, 'note');
        await merge('first');
        await write([{ op: 'update', fileId: files[0].fileId, content: 'changed' }, { op: 'delete', fileId: files[1].fileId }]);
        const added = await write({ op: 'create', path: '/added', content: 'added' });
        // Lose the response. When the write was applied, also lose the read that would confirm it.
        let failed = false, hidden = false;
        fixture[applied ? 'afterUpsert' : 'beforeUpsert'] = ({ docs }) => {
            if (docs[0].kind === 'merge-result-v1' && !failed) {
                failed = hidden = true;
                throw lost();
            }
        };
        fixture.beforeFetch = ({ ids }) => {
            if (applied && hidden && ids.length === 1 && ids[0] === 'completion:2') {
                hidden = false;
                return { isDocsInline: true, total: 0, docs: [] };
            }
        };
        await assert.rejects(merge('second'), { code: 'MERGE_RESUMABLE', details: { requestId: 'second' } });
        assert(failed && (!applied || !hidden));
        const [submitted] = completionWrites(fixture).slice(1);
        assert.deepEqual(submitted.fileIds, sorted([files[0], files[1], added]));
        assert.equal(submitted.fileIdsTruncated, false);
        // The fork cannot move on before the retry, so the retry derives the same record.
        const held = structuredClone([...forkDocs(fixture)]);
        for (const operation of [{ op: 'create', path: '/later', content: 'later' }, { op: 'update', fileId: files[2].fileId, content: 'later' }])
            await assert.rejects(write(operation), { code: 'MERGE_BLOCKED', details: { requestId: 'second' } });
        assert.deepEqual([...forkDocs(fixture)], held);
        assert.deepEqual(await merge('second'), published('second', 'v2'));
        // An unapplied write is submitted again unchanged; an applied one is only confirmed.
        const writes = completionWrites(fixture).slice(1);
        assert.equal(writes.length, applied ? 1 : 2);
        for (const record of writes) assert.deepEqual(record, submitted);
        assert.deepEqual(journalOf(fixture).get('completion:2'), submitted);
        const [, entry] = (await main.history()).entries;
        assert.equal(entry.publishedAt, submitted.completedAt);
        assertRecorded(entry, 2, 'second', `applied ${applied}`);
    }
});

test('a merge resumed by a new process records the same affected files from its held fork', async () => {
    for (const stage of ['content', 'applied', 'completion']) for (const resume of ['recover', 'replay']) {
        const label = `${stage} ${resume}`;
        const { fixture, write, merge, create, assertRecorded } = await setup();
        const files = (await create(104, 'note')).sort((x, y) => x.fileId < y.fileId ? -1 : 1);
        await merge('first');
        // 105 affected files: updates, moves, deletes and creates.
        const operations = files.map(({ fileId }, i) => i < 50 ? { op: 'update', fileId, content: `updated ${i}` }
            : i < 80 ? { op: 'delete', fileId } : i < 102 ? { op: 'update', fileId, newPath: `/moved-${i}` } : undefined).filter(Boolean);
        for (let start = 0; start < operations.length; start += 50) await write(operations.slice(start, start + 50));
        const created = await create(3, 'created');
        const affected = sorted([...files.slice(0, 102), ...created]);

        // Stop the first process after part of main was written, after all of it
        // was written, or at the terminal record.
        let mainWrites = 0, failed = false;
        const fail = () => { failed = true; throw Object.assign(lost(), { statusCode: 400 }); };
        fixture.beforeUpsert = ({ branch, docs }) => {
            if (stage === 'content' ? branch === 'main' && docs.some(doc => doc.kind === 'file') && ++mainWrites === 40
                : docs[0].kind === (stage === 'applied' ? 'merge-applied-v1' : 'merge-result-v1')) fail();
        };
        await assert.rejects(merge('second'), { code: 'MERGE_RESUMABLE', details: { requestId: 'second' } }, label);
        assert(failed, label);
        fixture.beforeUpsert = undefined;
        const attempted = completionWrites(fixture).slice(1);
        assert.equal(attempted.length, stage === 'completion' ? 1 : 0, label);
        assert.equal(journalOf(fixture).has('completion:2'), false, label);

        // Nothing changes the fork while the merge is unfinished, in this process or a new one.
        const held = structuredClone([...forkDocs(fixture)]);
        const observer = await MemDrive.open({ client: { ...fixture.client }, name });
        for (const operation of [{ op: 'create', path: '/after-interruption', content: 'later' },
            { op: 'update', fileId: files[103].fileId, content: 'later' }, { op: 'update', fileId: files[0].fileId, content: 'later again' }]) {
            await assert.rejects(write(operation), { code: 'MERGE_BLOCKED', details: { requestId: 'second' } }, label);
            await assert.rejects(observer.write({ at: draft, ...operation }), { code: 'MERGE_BLOCKED', details: { requestId: 'second' } }, label);
        }
        assert.deepEqual([...forkDocs(fixture)], held, label);

        const restarted = await MemDrive.open({ client: { ...fixture.client }, name, recover: resume === 'recover' });
        assert.deepEqual(await restarted.merge({ at: draft, ...request('second') }), published('second', 'v2'), label);
        const completion = journalOf(fixture).get('completion:2');
        assert.deepEqual(completion.fileIds, affected.slice(0, 100), label);
        assert.equal(completion.fileIdsTruncated, true, label);
        // The new process derives the record again. Only its timestamp may differ.
        for (const record of attempted) assert.deepEqual({ ...record, completedAt: completion.completedAt }, completion, label);
        assert.equal(completionWrites(fixture).length, stage === 'completion' ? 3 : 2, label);
        const [, entry] = (await restarted.history()).entries;
        assertRecorded(entry, 2, 'second', label);
        assert.deepEqual(await (await MemDrive.open({ client: { ...fixture.client }, name })).history(), await restarted.history(), label);
    }
});

test('a published completion must carry 1–100 strictly ascending file IDs and a consistent truncation flag', () => {
    const ids = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const at = '2026-01-01T00:00:00.000Z';
    const reservation = { id: 'reservation:3', driveId: 'drive', kind: 'merge-reservation-v1', requestId: 'request', summary: 'Summary',
        branch: 'fork-draft', startedAt: at, priorVersion: 'v2', version: 'v3' };
    const record = fields => ({ id: 'completion:3', driveId: 'drive', kind: 'merge-result-v1', completedAt: at, ...fields });
    const publication = (fileIds, fileIdsTruncated) => record({ status: 'published', version: 'v3', fileIds, fileIdsTruncated });
    const rejected = (doc, label) => assert.throws(() => parseOutcome(doc, reservation), { code: 'INVALID_RESULT' }, label);

    for (const [fileIds, truncated] of [[ids.slice(0, 1), false], [ids.slice(40, 43), false], [ids.slice(0, 99), false],
        [ids.slice(0, 100), false], [ids.slice(1, 101), true]]) {
        assert.deepEqual(parseOutcome(publication(fileIds, truncated), reservation),
            { status: 'published', version: 'v3', fileIds, fileIdsTruncated: truncated, completedAt: at });
    }

    const { fileIds: _fileIds, ...withoutIds } = publication(ids.slice(0, 2), false);
    const { fileIdsTruncated: _flag, ...withoutFlag } = publication(ids.slice(0, 2), false);
    rejected(record({ status: 'published', version: 'v3' }), 'neither field');
    rejected(withoutIds, 'missing fileIds');
    rejected(withoutFlag, 'missing fileIdsTruncated');
    for (const [label, fileIds, truncated = false] of [
        ['no IDs', []], ['101 IDs', ids], ['101 IDs truncated', ids, true], ['a string', ids[0]], ['an object', { 0: ids[0], length: 1 }],
        ['null', null], ['an uppercase ID', [ids[10].replace('8000', 'A000')]], ['an original ID', [`file:${ids[0]}`]],
        ['a number', [1]], ['a null ID', [null]], ['a nested list', [[ids[0]]]], ['descending IDs', [ids[2], ids[1]]],
        ['an unordered tail', [ids[0], ids[2], ids[1]]], ['a duplicate ID', [ids[1], ids[1]]],
        ['truncation with 1 ID', ids.slice(0, 1), true], ['truncation with 99 IDs', ids.slice(0, 99), true],
        ['a string flag', ids.slice(0, 100), 'true'], ['a numeric flag', ids.slice(0, 2), 0], ['a null flag', ids.slice(0, 2), null],
    ]) rejected(publication(fileIds, truncated), label);
    // The existing conditions still apply.
    rejected({ ...publication(ids.slice(0, 1), false), version: 'v2' }, 'another version');

    // Other outcomes keep their format and need no file list.
    assert.deepEqual(parseOutcome(record({ status: 'unchanged', version: 'v2' }), reservation),
        { status: 'unchanged', version: 'v2', completedAt: at });
    rejected(record({ status: 'unchanged', version: 'v3' }), 'unchanged at the reserved version');
    assert.deepEqual(parseOutcome(record({ status: 'conflict', fileIds: [ids[1], ids[0]], paths: ['/note'] }), reservation),
        { status: 'conflict', fileIds: [ids[1], ids[0]], paths: ['/note'], completedAt: at });
    assert.deepEqual(parseOutcome(record({ status: 'conflict', fileIds: [], paths: ['/note'] }), reservation),
        { status: 'conflict', fileIds: [], paths: ['/note'], completedAt: at });
    rejected(record({ status: 'conflict', fileIds: [], paths: [] }), 'a conflict without a cause');
});

test('a malformed published completion in the journal fails status, history, version selection and replay', async () => {
    const { fixture, write, merge, create } = await setup();
    const files = await create(2, 'note');
    await merge('first');
    await write({ op: 'update', fileId: files[0].fileId, content: 'changed' });
    await merge('second');
    const records = journalOf(fixture);
    const fresh = () => MemDrive.open({ client: { ...fixture.client }, name });
    const intact = await (await fresh()).history();
    for (const [slot, corrupt] of [
        [1, doc => { delete doc.fileIds; }], [1, doc => { delete doc.fileIdsTruncated; }], [1, doc => { doc.fileIds.reverse(); }],
        [1, doc => { doc.fileIdsTruncated = true; }], [2, doc => { doc.fileIds = []; }], [2, doc => { doc.fileIds.push(doc.fileIds[0]); }],
    ]) {
        const id = `completion:${slot}`, original = structuredClone(records.get(id));
        corrupt(records.get(id));
        const label = `${id} ${corrupt}`;
        await assert.rejects((await fresh()).history(), { code: 'INVALID_RESULT' }, label);
        await assert.rejects((await fresh()).merge({ at: draft, ...request(slot === 1 ? 'first' : 'second') }), { code: 'INVALID_RESULT' }, label);
        await assert.rejects((await fresh()).checkpoint({ name: 'selected', version: `v${slot}` }), { code: 'INVALID_RESULT' }, label);
        // A cold client reads the head slot to learn the published version.
        if (slot === 2) await assert.rejects((await fresh()).status(), { code: 'INVALID_RESULT' }, label);
        records.set(id, original);
        assert.deepEqual(await (await fresh()).history(), intact, label);
    }
});
