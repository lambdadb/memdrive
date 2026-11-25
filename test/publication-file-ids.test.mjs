import assert from 'node:assert/strict';
import test from 'node:test';
import { MemDrive } from '@functional-systems/memdrive';
import { parsePublication } from '../dist/esm/publication-log.js';
import { fileClient } from './helpers/file-client.mjs';

const name = 'file-id-store';
const draft = { kind: 'fork', name: 'draft' };
const request = label => ({ summary: `Publish ${label}` });
const published = version => ({ status: 'published', version });
const journalOf = fixture => [...fixture.collections.values()]
    .find(store => store.metadata.tags['memdrive.format'] === 'merge-publication-v1').branches.get('main').docs;
const recordWrites = fixture => fixture.calls
    .filter(call => call.kind === 'upsert' && call.request.docs[0].kind === 'publication-v1').map(call => call.request.docs[0]);
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
    const merge = async label => {
        if (!sources.has(label)) {
            const changes = await main.diff({ at: draft });
            sources.set(label, { diff: { fileIds: changes.slice(0, 100).map(change => change.fileId), fileIdsTruncated: changes.length > 100 },
                records: fromRecords(fixture) });
        }
        return main.merge({ at: draft, ...request(label) });
    };
    // One write accepts at most 100 operations.
    const create = async (count, prefix) => {
        const files = [];
        for (let start = 0; start < count; start += 100) files.push(...await write(Array.from({ length: Math.min(100, count - start) },
            (_, i) => ({ op: 'create', path: `/${prefix}-${start + i}`, content: `${prefix} ${start + i}` }))));
        return files;
    };
    /** Check one publication's history entry and stored record against the fork as its merge found it. */
    function assertRecorded(entry, slot, source, label = entry.version) {
        const record = journalOf(fixture).get(`publication:${slot}`);
        const { fileIds, fileIdsTruncated } = entry;
        assert.deepEqual({ fileIds, fileIdsTruncated }, sources.get(source).diff, label);
        assert.deepEqual({ fileIds, fileIdsTruncated }, sources.get(source).records, label);
        assert.deepEqual(Object.keys(record).sort(),
            ['driveId', 'fileIds', 'fileIdsTruncated', 'id', 'kind', 'publishedAt', 'summary', 'version'], label);
        assert.deepEqual([record.version, record.summary, record.fileIds, record.fileIdsTruncated, record.publishedAt],
            [entry.version, entry.summary, fileIds, fileIdsTruncated, entry.publishedAt], label);
    }
    return { fixture, main, write, merge, create, assertRecorded };
}

test('a publication records the affected file IDs that its fork held when the merge started', async () => {
    const { fixture, main, write, merge, create, assertRecorded } = await setup();
    const expected = [], requests = [];
    const publish = async (label, files, truncated = false) => {
        const slot = expected.length + 1;
        requests.push(label);
        assert.deepEqual(await merge(label), published(`v${slot}`));
        expected.push({ version: `v${slot}`, summary: `Publish ${label}`, fileIds: sorted(files).slice(0, 100), fileIdsTruncated: truncated });
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

test('a lost publication record write fails the merge, and repeating the merge settles it either way', async () => {
    for (const applied of [false, true]) {
        const label = `applied ${applied}`;
        const { fixture, main, write, merge, create, assertRecorded } = await setup();
        const files = await create(3, 'note');
        await merge('first');
        await write([{ op: 'update', fileId: files[0].fileId, content: 'changed' }, { op: 'delete', fileId: files[1].fileId }]);
        const added = await write({ op: 'create', path: '/added', content: 'added' });
        // Lose the response. When the write was applied, also lose the read that would confirm it.
        let failed = false, hidden = false;
        fixture[applied ? 'afterUpsert' : 'beforeUpsert'] = ({ docs }) => {
            if (docs[0].kind === 'publication-v1' && !failed) {
                failed = hidden = true;
                throw lost();
            }
        };
        fixture.beforeFetch = ({ ids }) => {
            if (applied && hidden && ids.length === 1 && ids[0] === 'publication:2') {
                hidden = false;
                return { isDocsInline: true, total: 0, docs: [] };
            }
        };
        const forkBefore = structuredClone([...forkDocs(fixture)]);
        await assert.rejects(merge('second'), { code: 'DATABASE_ERROR' }, label);
        fixture.afterUpsert = fixture.beforeUpsert = fixture.beforeFetch = undefined;
        const [submitted] = recordWrites(fixture).slice(1);
        assert.deepEqual(submitted.fileIds, sorted([files[0], files[1], added]), label);
        // Main is restored to the latest recorded version; the fork is untouched.
        assert.deepEqual(fixture.calls.filter(call => call.kind === 'branch-rollback').map(call => call.tag), [applied ? 'md-main-v2' : 'md-main-v1'], label);
        assert.deepEqual([...forkDocs(fixture)], forkBefore, label);
        assert.equal((await main.status()).mainVersion, applied ? 'v2' : 'v1', label);
        // A record that landed is a publication: repeating the merge finds main
        // already holding the fork's changes. Otherwise it publishes them.
        assert.deepEqual(await merge('second'), applied ? { status: 'unchanged', version: 'v2' } : published('v2'), label);
        assert.deepEqual(await main.diff({ at: draft }), [], label);
        const [, entry] = (await main.history()).entries;
        assertRecorded(entry, 2, 'second', label);
        assert.deepEqual({ ...entry, publishedAt: submitted.publishedAt }, { version: 'v2', publishedAt: submitted.publishedAt,
            summary: submitted.summary, fileIds: submitted.fileIds, fileIdsTruncated: false }, label);
    }
});

test('a merge interrupted after main writes is rolled back by the next process, which publishes the same affected files', async () => {
    for (const stage of ['content', 'record']) {
        const label = stage;
        const { fixture, write, merge, create, assertRecorded } = await setup();
        const files = (await create(104, 'note')).sort((x, y) => x.fileId < y.fileId ? -1 : 1);
        await merge('first');
        // 105 affected files: updates, moves, deletes and creates.
        const operations = files.map(({ fileId }, i) => i < 50 ? { op: 'update', fileId, content: `updated ${i}` }
            : i < 80 ? { op: 'delete', fileId } : i < 102 ? { op: 'update', fileId, newPath: `/moved-${i}` } : undefined).filter(Boolean);
        for (let start = 0; start < operations.length; start += 50) await write(operations.slice(start, start + 50));
        const created = await create(3, 'created');
        const affected = sorted([...files.slice(0, 102), ...created]);

        // Stop the first process after part of main was written, or at the publication record,
        // and lose its rollback as if the process had stopped.
        let mainWrites = 0, failed = false;
        const fail = () => { failed = true; throw Object.assign(lost(), { statusCode: 400 }); };
        fixture.beforeUpsert = ({ branch, docs }) => {
            if (stage === 'content' ? branch === 'main' && docs.some(doc => doc.kind === 'file') && ++mainWrites === 40
                : docs[0].kind === 'publication-v1') fail();
        };
        fixture.beforeRollback = () => { throw Object.assign(new Error('Unavailable'), { statusCode: 503 }); };
        await assert.rejects(merge('second'), { code: 'DATABASE_ERROR', status: 400 }, label);
        assert(failed, label);
        fixture.beforeUpsert = fixture.beforeRollback = undefined;
        const state = fixture.collections.get(name);
        assert.equal(journalOf(fixture).has('publication:2'), false, label);
        assert.equal(state.tags.has('md-main-v2'), stage === 'record', label);
        // Main holds unpublished writes; readers still see v1.
        assert.notDeepEqual([...state.branches.get('main').docs.keys()].sort(), [...state.tags.get('md-main-v1').docs.keys()].sort(), label);
        const held = structuredClone([...forkDocs(fixture)]);

        const restarted = await MemDrive.open({ client: { ...fixture.client }, name });
        assert.equal((await restarted.status()).mainVersion, 'v1', label);
        const before = fixture.calls.length;
        assert.deepEqual(await restarted.merge({ at: draft, ...request('second') }), published('v2'), label);
        const calls = fixture.calls.slice(before);
        // The first merge of the new process restores main and removes the unrecorded tag before reusing its version.
        assert.deepEqual(calls.filter(call => call.kind === 'branch-rollback').map(call => call.tag), ['md-main-v1'], label);
        assert.deepEqual(calls.filter(call => call.kind === 'tag-delete').map(call => call.name), stage === 'record' ? ['md-main-v2'] : [], label);
        assert.deepEqual([...state.branches.get('main').docs.keys()].sort(), [...state.tags.get('md-main-v2').docs.keys()].sort(), label);
        const record = journalOf(fixture).get('publication:2');
        assert.deepEqual(record.fileIds, affected.slice(0, 100), label);
        assert.equal(record.fileIdsTruncated, true, label);
        // The fork held the same changes, so the first attempt submitted the same record but its time.
        for (const submitted of recordWrites(fixture).slice(1, -1)) assert.deepEqual({ ...submitted, publishedAt: record.publishedAt }, record, label);
        assert.notDeepEqual([...forkDocs(fixture)], held, label);
        const [, entry] = (await restarted.history()).entries;
        assertRecorded(entry, 2, 'second', label);
    }
});

test('a publication record must carry 1–100 strictly ascending file IDs and a consistent truncation flag', () => {
    const ids = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const at = '2026-01-01T00:00:00.000Z';
    const publication = (fileIds, fileIdsTruncated) => ({ id: 'publication:3', driveId: 'drive', kind: 'publication-v1',
        version: 'v3', publishedAt: at, summary: 'Summary', fileIds, fileIdsTruncated });
    const rejected = (doc, label) => assert.throws(() => parsePublication(doc, 3n), { code: 'INVALID_RESULT' }, label);

    for (const [fileIds, truncated] of [[ids.slice(0, 1), false], [ids.slice(40, 43), false], [ids.slice(0, 99), false],
        [ids.slice(0, 100), false], [ids.slice(1, 101), true]]) {
        assert.deepEqual(parsePublication(publication(fileIds, truncated), 3n),
            { version: 'v3', publishedAt: at, summary: 'Summary', fileIds, fileIdsTruncated: truncated });
    }

    const { fileIds: _fileIds, ...withoutIds } = publication(ids.slice(0, 2), false);
    const { fileIdsTruncated: _flag, ...withoutFlag } = publication(ids.slice(0, 2), false);
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
    const valid = publication(ids.slice(0, 1), false);
    for (const [label, doc] of [['another version', { ...valid, version: 'v2' }], ['another ID', { ...valid, id: 'publication:2' }],
        ['another kind', { ...valid, kind: 'merge-result-v1' }], ['an empty summary', { ...valid, summary: ' ' }],
        ['an invalid time', { ...valid, publishedAt: 'yesterday' }]]) rejected(doc, label);
});

test('a malformed publication record fails history while merges and version selection need only its existence', async () => {
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
        const id = `publication:${slot}`, original = structuredClone(records.get(id));
        corrupt(records.get(id));
        const label = `${id} ${corrupt}`;
        await assert.rejects((await fresh()).history(), { code: 'INVALID_RESULT' }, label);
        assert.deepEqual(await (await fresh()).merge({ at: draft, ...request('again') }), { status: 'unchanged', version: 'v2' }, label);
        assert.deepEqual(await (await fresh()).status(), { at: { kind: 'main' }, mainVersion: 'v2' }, label);
        records.set(id, original);
        assert.deepEqual(await (await fresh()).history(), intact, label);
    }
    // A record from another store generation is never accepted.
    records.get('publication:2').driveId = 'other';
    await assert.rejects((await fresh()).status(), { code: 'INVALID_RESULT' });
});
