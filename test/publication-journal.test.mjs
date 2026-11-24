import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { MemDrive } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

const name = 'journal-store';
const draft = { kind: 'fork', name: 'draft' };
const other = { kind: 'fork', name: 'other' };
const request = requestId => ({ requestId, summary: `Publish ${requestId}` });
const published = (requestId, version) => ({ requestId, status: 'published', version });
const fresh = fixture => MemDrive.open({ client: { ...fixture.client }, name });
const journalOf = fixture => [...fixture.collections.values()]
    .find(store => store.metadata.tags['memdrive.format'] === 'merge-publication-v1')?.branches.get('main').docs;
const journalId = id => /^(?:reservation|completion|applied|bookkeeping|request|retention):/.test(id);
const journalFetches = (fixture, since = 0) => fixture.calls.slice(since)
    .filter(call => call.kind === 'fetch' && call.request.ids.some(journalId));
const journalWrites = fixture => fixture.calls.filter(call => call.kind === 'upsert' && call.collection !== name).length;
const reservations = fixture => [...journalOf(fixture).values()].filter(doc => doc.kind === 'merge-reservation-v1');
const indexOf = (fixture, requestId) => [...journalOf(fixture).values()]
    .find(doc => doc.kind === 'merge-request-v1' && doc.requestId === requestId);
const lost = () => new Error('Response lost');

async function setup() {
    const fixture = fileClient();
    const main = await MemDrive.create({ client: fixture.client, name });
    await main.fork({ name: 'draft' });
    await main.fork({ name: 'other' });
    const file = await main.write({ at: draft, op: 'create', path: '/note', content: '0' });
    return { fixture, main, file };
}

/**
 * Run `count` merges with mixed outcomes. Every fifth request is unchanged and
 * every seventh conflicts, so their version numbers stay unused.
 */
async function populate(count) {
    const { fixture, main, file } = await setup();
    const versions = [];
    if (count) await main.write({ at: other, op: 'create', path: '/note', content: 'competing' });
    for (let slot = 1; slot <= count; slot++) {
        if (slot % 7 === 0) {
            await assert.rejects(main.merge({ at: other, ...request(`r${slot}`) }), { code: 'MERGE_CONFLICT' });
        } else if (slot % 5 === 0) {
            assert.equal((await main.merge({ at: draft, ...request(`r${slot}`) })).status, 'unchanged');
        } else {
            if (slot > 1) await main.write({ at: draft, op: 'update', fileId: file.fileId, content: String(slot) });
            assert.deepEqual(await main.merge({ at: draft, ...request(`r${slot}`) }), published(`r${slot}`, `v${slot}`));
            versions.push(`v${slot}`);
        }
    }
    return { fixture, main, file, versions };
}

async function pages(drive, limit) {
    const entries = [];
    let through;
    for (let page = await drive.history({ limit }); ; page = await drive.history(page.next)) {
        through ??= page.throughVersion;
        assert.equal(page.throughVersion, through);
        assert(page.entries.length <= limit);
        entries.push(...page.entries);
        if (!page.next) return { entries, through };
    }
}

test('a cold client finds the journal head in a logarithmic number of fetches for any number of merges', async () => {
    for (const count of [0, 1, 2, 3, 16, 17, 200]) {
        const { fixture, main, versions } = await populate(count);
        const expected = { at: { kind: 'main' }, mainVersion: versions.at(-1) ?? 'v0' };
        assert.deepEqual(await main.status(), expected);
        const reader = await fresh(fixture);
        const before = fixture.calls.length;
        assert.deepEqual(await reader.status(), expected, `status after ${count} merges`);
        // A replay of every record would need at least one fetch per merge.
        const fetches = journalFetches(fixture, before);
        assert(fetches.length <= 6, `${fetches.length} journal fetches after ${count} merges`);
        assert(fetches.every(call => call.request.ids.length <= 1000));
        const history = await pages(reader, 7);
        assert.equal(history.through, expected.mainVersion);
        assert.deepEqual(history.entries.map(entry => entry.version), versions, `history after ${count} merges`);
        assert.deepEqual(history.entries, (await pages(main, 100)).entries);
    }
});

test('the head search is exact at every probe boundary and stays logarithmic far beyond one probe batch', async () => {
    const { fixture, main } = await setup();
    await main.fork({ name: 'empty' });
    await main.merge({ at: { kind: 'fork', name: 'empty' }, ...request('r1') });
    const [journalName, journal] = [...fixture.collections].find(([key]) => key.startsWith('md-journal-'));
    const { driveId } = journal.branches.get('main').docs.get('reservation:1');
    const at = new Date().toISOString();
    // Serve a synthetic journal of unchanged merges whose last reservation is unfinished.
    let head = 1n;
    fixture.beforeFetch = ({ ids }) => {
        if (!ids.some(id => /^(?:reservation|completion|bookkeeping):/.test(id))) return undefined;
        const docs = ids.flatMap(id => {
            const [kind, value] = id.split(':'), slot = BigInt(value);
            if (slot > head) return [];
            if (kind === 'reservation') return [{ id, driveId, kind: 'merge-reservation-v1', requestId: `r${slot}`, summary: 'Synthetic',
                branch: 'fork-empty', startedAt: at, priorVersion: 'v0', version: `v${slot}` }];
            return kind === 'completion' && slot < head
                ? [{ id, driveId, kind: 'merge-result-v1', status: 'unchanged', version: 'v0', completedAt: at }] : [];
        });
        return { isDocsInline: true, total: docs.length, docs: docs.map(doc => ({ collection: journalName, doc })) };
    };
    const observe = async (drive, expected, limit) => {
        const before = fixture.calls.length;
        assert.deepEqual(await drive.status(), { at: { kind: 'main' }, mainVersion: 'v0',
            merge: { requestId: `r${expected}`, phase: 'publication' } }, `head ${expected}`);
        const fetches = journalFetches(fixture, before);
        assert(fetches.length <= limit, `${fetches.length} journal fetches for head ${expected}`);
        assert(fetches.every(call => call.request.ids.length <= 1000));
    };
    for (const value of [1n, 2n, 3n, 4n, 7n, 8n, 9n, 127n, 128n, 129n, 250n, 251n, 252n, 255n, 256n, 257n, 1000n, 524287n, 524288n,
        524289n, 1048575n, 1048576n, 1048577n, 10n ** 6n + 3n, 2n ** 40n + 5n]) {
        head = value;
        const reader = await fresh(fixture);
        await observe(reader, value, value > 2n ** 20n ? 12 : 7);
        // A warm client catches up with a nearby and a distant head the same way.
        for (const ahead of [1n, 2n, 300n, 70_000n]) {
            head += ahead;
            await observe(reader, head, 7);
        }
    }
});

test('a cold client observes an unfinished head in either phase and a new owner resumes it', async () => {
    for (const count of [0, 3, 17]) for (const phase of ['publication', 'bookkeeping']) {
        const { fixture, main, file, versions } = await populate(count);
        const last = versions.at(-1) ?? 'v0', next = `v${count + 1}`;
        await main.write({ at: draft, op: 'update', fileId: file.fileId, content: 'unfinished' });
        const kind = phase === 'publication' ? 'merge-result-v1' : 'merge-bookkeeping-v1';
        fixture.beforeUpsert = ({ docs }) => { if (docs[0].kind === kind) throw lost(); };
        await assert.rejects(main.merge({ at: draft, ...request('head') }), { code: 'MERGE_RESUMABLE' });
        fixture.beforeUpsert = undefined;
        const reader = await fresh(fixture);
        assert.deepEqual(await reader.status(), { at: { kind: 'main' }, mainVersion: phase === 'publication' ? last : next,
            merge: { requestId: 'head', phase } });
        assert.equal((await reader.history()).throughVersion, phase === 'publication' ? last : next);
        await assert.rejects(reader.merge({ at: other, ...request('blocked') }), { code: 'MERGE_BLOCKED', details: { requestId: 'head' } });
        // The unfinished target is selectable only once its publication is recorded.
        const selecting = reader.checkpoint({ name: 'target', version: next });
        if (phase === 'publication') await assert.rejects(selecting, { code: 'HISTORICAL_VIEW_UNAVAILABLE' });
        else assert.deepEqual(await selecting, { at: { kind: 'checkpoint', name: 'target' } });
        const owner = await MemDrive.open({ client: { ...fixture.client }, name, recover: true });
        assert.deepEqual(await owner.status(), { at: { kind: 'main' }, mainVersion: next });
        assert.deepEqual(await owner.merge({ at: draft, ...request('head') }), published('head', next));
        assert.equal(reservations(fixture).length, count + 1);
    }
});

test('a second client sees the same status, history pages, exact versions and request replay as the writer', async () => {
    const { fixture, main, file, versions } = await populate(200);
    const reader = await fresh(fixture);
    assert.deepEqual(await reader.status(), await main.status());
    for (const limit of [7, 100]) assert.deepEqual(await pages(reader, limit), await pages(main, limit));
    // Sparse publications: v5, v7 and v10 are unused, and pages continue across them.
    const first = await reader.history({ sinceVersion: 'v3', limit: 4 });
    assert.deepEqual(first.entries.map(entry => entry.version), ['v4', 'v6', 'v8', 'v9']);
    assert.equal(first.throughVersion, 'v199');
    const second = await (await fresh(fixture)).history(first.next);
    assert.deepEqual(second.entries.map(entry => entry.version), ['v11', 'v12', 'v13', 'v16']);
    assert.deepEqual(second, await main.history(first.next));
    assert.deepEqual(await reader.history({ sinceVersion: 'v199' }), { entries: [], throughVersion: 'v199' });
    assert.deepEqual((await reader.history({ sinceVersion: 'v198', limit: 1 })), await main.history({ sinceVersion: 'v198', limit: 1 }));
    for (const sinceVersion of ['v5', 'v7', 'v200', 'v201', 'v100000'])
        await assert.rejects(reader.history({ sinceVersion }), { code: 'VERSION_NOT_FOUND', details: { version: sinceVersion } });
    assert.deepEqual(versions.length, (await pages(reader, 100)).entries.length);

    // Exact versions: a publication is selectable, an unused number is not.
    for (const [version, content] of [['v101', '101'], ['v4', '4'], ['v199', '199']]) {
        const { at } = await reader.fork({ name: `at-${version}`, version });
        assert.equal((await reader.read({ at, fileId: file.fileId })).content, content);
    }
    for (const version of ['v100', 'v98', 'v200', 'v201'])
        await assert.rejects(reader.checkpoint({ name: 'unused', version }),
            error => error.code === 'HISTORICAL_VIEW_UNAVAILABLE' && error.details.version === version);

    // Replay any past request through a client that never saw it run.
    const writes = journalWrites(fixture);
    const replayer = await fresh(fixture);
    assert.deepEqual(await replayer.merge({ at: draft, ...request('r101') }), published('r101', 'v101'));
    assert.deepEqual(await replayer.merge({ at: draft, ...request('r1') }), published('r1', 'v1'));
    assert.deepEqual(await replayer.merge({ at: draft, ...request('r100') }), { requestId: 'r100', status: 'unchanged', version: 'v99' });
    await assert.rejects(replayer.merge({ at: other, ...request('r98') }),
        { code: 'MERGE_CONFLICT', details: { requestId: 'r98', fileIds: [], paths: ['/note'] } });
    for (const [at, requestId] of [[draft, 'r101'], [draft, 'r100'], [other, 'r98']])
        await assert.rejects(replayer.merge({ at, requestId, summary: 'Different input' }), { code: 'MERGE_REQUEST_CONFLICT' });
    await assert.rejects(replayer.merge({ at: other, ...request('r101') }), { code: 'MERGE_REQUEST_CONFLICT' });
    assert.equal(journalWrites(fixture), writes);
    assert.equal(reservations(fixture).length, 200);
});

test('a history page at 200 merges costs a head lookup and one fetch of its slot records', async () => {
    const { fixture, versions } = await populate(200);
    assert.equal(versions.length, 137);
    // Each publication pins its version. No request leaves any other tag.
    assert.deepEqual([...fixture.collections.get(name).tags.keys()].sort(), versions.map(version => `md-main-${version}`).sort());
    // Every native request of a history read, which must be a fetch of slot records by ID.
    const read = async operation => {
        const before = fixture.calls.length;
        const page = await operation();
        const calls = fixture.calls.slice(before);
        for (const call of calls) {
            assert.equal(call.kind, 'fetch');
            assert.equal(call.request.ref.name, 'main');
            assert(call.request.ids.every(id => /^(?:reservation|completion|bookkeeping):[1-9][0-9]*$/.test(id)), call.request.ids.join());
            assert(call.request.ids.length <= 1000);
        }
        return { page, fetches: calls.length };
    };
    for (const limit of [20, 100]) {
        const reader = await fresh(fixture);
        // Cold: the head search, then the page. Warm: a probe of the next slot, then the page.
        const cold = await read(() => reader.history({ limit }));
        assert.equal(cold.fetches, 4, `cold page of ${limit}`);
        assert.deepEqual(cold.page.entries.map(entry => entry.version), versions.slice(0, limit));
        assert(cold.page.entries.every(entry => entry.fileIds.length === 1 && entry.fileIdsTruncated === false));
        const warm = await read(() => reader.history({ limit }));
        assert.equal(warm.fetches, 2, `warm page of ${limit}`);
        assert.deepEqual(warm.page, cold.page);
        const next = await read(() => reader.history(cold.page.next));
        assert.equal(next.fetches, 2, `continued page of ${limit}`);
        assert.deepEqual(next.page.entries.map(entry => entry.version), versions.slice(limit, 2 * limit));
        // The whole history costs two fetches per page, independent of its entries.
        let pageCount = 0;
        const all = await read(async () => {
            const entries = [];
            for (let page = await reader.history({ limit }); ; page = await reader.history(page.next)) {
                pageCount++;
                entries.push(...page.entries);
                if (!page.next) return entries;
            }
        });
        assert.equal(pageCount, Math.ceil(versions.length / limit));
        assert.equal(all.fetches, 2 * pageCount, `all pages of ${limit}`);
        assert.deepEqual(all.page.map(entry => entry.version), versions);
    }
});

test('per-merge records are read back from the journal instead of being kept in memory', async () => {
    const { fixture } = await populate(40);
    const drive = await fresh(fixture);
    const fetched = async operation => {
        const before = fixture.calls.length;
        await operation();
        return new Set(journalFetches(fixture, before).flatMap(call => call.request.ids));
    };
    // Warm the client with every kind of read, then repeat each one.
    await pages(drive, 100);
    for (let round = 0; round < 2; round++) {
        const replay = await fetched(() => drive.merge({ at: draft, ...request('r12') }));
        assert(replay.has('reservation:12') && replay.has('completion:12'));
        const history = await fetched(() => drive.history({ sinceVersion: 'v22', limit: 2 }));
        assert(history.has('reservation:23') && history.has('completion:24'));
        const version = await fetched(() => drive.checkpoint({ name: `saved-${round}`, version: 'v18' }));
        assert(version.has('reservation:18') && version.has('completion:18'));
        // A known head costs one probe of the next slot; nothing earlier is read again.
        const status = await fetched(() => drive.status());
        assert.deepEqual([...status].sort(), ['bookkeeping:41', 'completion:41', 'reservation:41']);
    }
});

test('a crash after the reservation and before its request index resumes the same slot and writes the index', async () => {
    for (const resume of ['replay', 'recover']) {
        const { fixture, main } = await setup();
        await main.write({ at: other, op: 'create', path: '/other', content: 'other' });
        fixture.beforeUpsert = ({ docs }) => { if (docs[0].kind === 'merge-request-v1') throw lost(); };
        await assert.rejects(main.merge({ at: draft, ...request('first') }), { code: 'MERGE_RESUMABLE', details: { requestId: 'first' } });
        fixture.beforeUpsert = undefined;
        assert.deepEqual(reservations(fixture).map(doc => [doc.id, doc.requestId]), [['reservation:1', 'first']]);
        assert.equal(indexOf(fixture, 'first'), undefined);
        // A new process finds the unfinished head without any index.
        const restarted = await fresh(fixture);
        assert.deepEqual(await restarted.status(), { at: { kind: 'main' }, mainVersion: 'v0', merge: { requestId: 'first', phase: 'publication' } });
        // No other request can take the next slot before the head and its index settle.
        await assert.rejects(restarted.merge({ at: other, ...request('second') }), { code: 'MERGE_BLOCKED', details: { requestId: 'first' } });
        await assert.rejects(restarted.merge({ at: draft, requestId: 'first', summary: 'Different input' }), { code: 'MERGE_REQUEST_CONFLICT' });
        assert.equal(reservations(fixture).length, 1);
        assert.equal(journalOf(fixture).has('completion:1'), false);
        if (resume === 'recover') {
            // The index is confirmed before the slot reaches its terminal record.
            let indexedFirst;
            fixture.beforeUpsert = ({ docs }) => {
                if (docs[0].kind === 'merge-result-v1') indexedFirst = indexOf(fixture, 'first')?.slot === '1';
            };
            const owner = await MemDrive.open({ client: { ...fixture.client }, name, recover: true });
            fixture.beforeUpsert = undefined;
            assert.equal(indexedFirst, true);
            assert.deepEqual(await owner.status(), { at: { kind: 'main' }, mainVersion: 'v1' });
        }
        const owner = await fresh(fixture);
        assert.deepEqual(await owner.merge({ at: draft, ...request('first') }), published('first', 'v1'));
        assert.equal(indexOf(fixture, 'first').slot, '1');
        assert.deepEqual(await owner.merge({ at: other, ...request('second') }), published('second', 'v2'));
        assert.deepEqual(reservations(fixture).map(doc => [doc.id, doc.requestId]).sort(), [['reservation:1', 'first'], ['reservation:2', 'second']]);
        assert.deepEqual([...fixture.collections.get(name).tags.keys()].sort(), ['md-main-v1', 'md-main-v2']);
        assert.deepEqual(await (await fresh(fixture)).merge({ at: draft, ...request('first') }), published('first', 'v1'));
    }
});

test('a request index is written once and a late or repeated write of it changes nothing', async () => {
    const { fixture, main, file } = await setup();
    const indexWrites = () => fixture.calls.filter(call => call.kind === 'upsert' && call.request.docs[0].kind === 'merge-request-v1');
    assert.deepEqual(await main.merge({ at: draft, ...request('first') }), published('first', 'v1'));
    const index = structuredClone(indexOf(fixture, 'first'));
    assert.deepEqual(Object.keys(index).sort(), ['driveId', 'id', 'kind', 'requestId', 'slot']);
    assert.equal(index.id, `request:${createHash('sha256').update('first').digest('hex')}`);
    assert.equal(index.slot, '1');
    // A head resumed by a new process confirms the existing index without rewriting it.
    await main.write({ at: draft, op: 'update', fileId: file.fileId, content: 'second' });
    fixture.beforeUpsert = ({ docs }) => { if (docs[0].kind === 'merge-result-v1') throw lost(); };
    await assert.rejects(main.merge({ at: draft, ...request('second') }), { code: 'MERGE_RESUMABLE' });
    fixture.beforeUpsert = undefined;
    assert.equal(indexWrites().length, 2);
    assert.deepEqual(await (await fresh(fixture)).merge({ at: draft, ...request('second') }), published('second', 'v2'));
    assert.equal(indexWrites().length, 2);
    // An earlier submission of the same index arrives after the request completed.
    const [journalName] = [...fixture.collections].find(([key]) => key.startsWith('md-journal-'));
    await fixture.client.collection(journalName).docs.upsert({ branch: 'main', docs: [index] });
    assert.deepEqual(indexOf(fixture, 'first'), index);
    const reader = await fresh(fixture);
    assert.deepEqual(await reader.merge({ at: draft, ...request('first') }), published('first', 'v1'));
    assert.deepEqual(await reader.merge({ at: draft, ...request('second') }), published('second', 'v2'));
    assert.deepEqual(await reader.status(), { at: { kind: 'main' }, mainVersion: 'v2' });
    assert.equal(reservations(fixture).length, 2);
});

test('a request index that names a missing or foreign reservation is a journal inconsistency', async () => {
    const { fixture, main } = await setup();
    assert.deepEqual(await main.merge({ at: draft, ...request('first') }), published('first', 'v1'));
    const records = journalOf(fixture);
    const { driveId } = records.get('reservation:1');
    const plant = (requestId, slot) => {
        const id = `request:${createHash('sha256').update(requestId).digest('hex')}`;
        records.set(id, { id, driveId, kind: 'merge-request-v1', requestId, slot });
    };
    plant('foreign', '1');
    plant('missing', '2');
    plant('distant', '900');
    const writes = journalWrites(fixture);
    for (const requestId of ['foreign', 'missing', 'distant']) {
        const reader = await fresh(fixture);
        await assert.rejects(reader.merge({ at: draft, ...request(requestId) }), { code: 'INVALID_RESULT' }, requestId);
        await assert.rejects(reader.merge({ at: other, ...request(requestId) }), { code: 'INVALID_RESULT' }, requestId);
    }
    // Nothing was reserved for them, and consistent requests are unaffected.
    assert.equal(journalWrites(fixture), writes);
    assert.equal(reservations(fixture).length, 1);
    const reader = await fresh(fixture);
    assert.deepEqual(await reader.merge({ at: draft, ...request('first') }), published('first', 'v1'));
    assert.deepEqual(await reader.merge({ at: draft, ...request('next') }), { requestId: 'next', status: 'unchanged', version: 'v1' });
});

test('a request replays after completion, after publication with unfinished bookkeeping and after a conflict', async () => {
    const { fixture, main, file } = await setup();
    await main.write({ at: other, op: 'create', path: '/note', content: 'competing' });
    assert.deepEqual(await main.merge({ at: draft, ...request('done') }), published('done', 'v1'));
    await assert.rejects(main.merge({ at: other, ...request('conflict') }), { code: 'MERGE_CONFLICT' });
    assert.deepEqual(await main.merge({ at: draft, ...request('empty') }), { requestId: 'empty', status: 'unchanged', version: 'v1' });
    await main.write({ at: draft, op: 'update', fileId: file.fileId, content: 'second' });
    fixture.beforeUpsert = ({ docs }) => { if (docs[0].kind === 'merge-bookkeeping-v1') throw lost(); };
    await assert.rejects(main.merge({ at: draft, ...request('paused') }),
        { code: 'MERGE_RESUMABLE', details: { requestId: 'paused', publishedVersion: 'v4' } });
    fixture.beforeUpsert = undefined;

    const reader = await fresh(fixture);
    const writes = journalWrites(fixture);
    assert.deepEqual(await reader.merge({ at: draft, ...request('done') }), published('done', 'v1'));
    assert.deepEqual(await reader.merge({ at: draft, ...request('empty') }), { requestId: 'empty', status: 'unchanged', version: 'v1' });
    await assert.rejects(reader.merge({ at: other, ...request('conflict') }),
        { code: 'MERGE_CONFLICT', details: { requestId: 'conflict', fileIds: [], paths: ['/note'] } });
    for (const [at, requestId] of [[draft, 'done'], [draft, 'empty'], [other, 'conflict'], [draft, 'paused']])
        await assert.rejects(reader.merge({ at, requestId, summary: 'Different input' }), { code: 'MERGE_REQUEST_CONFLICT' });
    await assert.rejects(reader.merge({ at: other, ...request('new') }), { code: 'MERGE_BLOCKED', details: { requestId: 'paused' } });
    assert.equal(journalWrites(fixture), writes);
    assert(!journalOf(fixture).has('bookkeeping:4'));
    // Replaying the paused request finishes its bookkeeping and returns its publication.
    assert.deepEqual(await reader.merge({ at: draft, ...request('paused') }), published('paused', 'v4'));
    assert.equal(journalOf(fixture).get('bookkeeping:4').kind, 'merge-bookkeeping-v1');
    assert.deepEqual(await (await fresh(fixture)).merge({ at: draft, ...request('paused') }), published('paused', 'v4'));
    assert.equal(reservations(fixture).length, 4);
});

test('a lost response on any journal write keeps one reservation per request and blocks others until it settles', async () => {
    for (const kind of ['merge-request-v1', 'merge-reservation-v1', 'merge-applied-v1', 'merge-result-v1', 'merge-bookkeeping-v1'])
        for (const applied of [false, true]) {
            const label = `${kind} ${applied ? 'applied' : 'not applied'}`;
            const { fixture, main } = await setup();
            await main.write({ at: other, op: 'create', path: '/other', content: 'other' });
            let failed = false;
            fixture[applied ? 'afterUpsert' : 'beforeUpsert'] = ({ docs }) => {
                if (docs[0].kind === kind && !failed) {
                    failed = true;
                    throw lost();
                }
            };
            const attempt = main.merge({ at: draft, ...request('first') });
            if (applied) {
                // The confirming read finds the record, so the merge continues.
                assert.deepEqual(await attempt, published('first', 'v1'), label);
            } else {
                // A paused bookkeeping step reports the version it already published.
                await assert.rejects(attempt, { code: 'MERGE_RESUMABLE', details: { requestId: 'first',
                    ...(kind === 'merge-bookkeeping-v1' ? { publishedVersion: 'v1' } : {}) } }, label);
                await assert.rejects(main.merge({ at: other, ...request('second') }),
                    { code: 'MERGE_BLOCKED', details: { requestId: 'first' } }, label);
                await assert.rejects(main.merge({ at: draft, requestId: 'first', summary: 'Different input' }),
                    { code: 'MERGE_REQUEST_CONFLICT' }, label);
                assert.equal((await main.status()).merge.requestId, 'first', label);
                assert.deepEqual(await main.merge({ at: draft, ...request('first') }), published('first', 'v1'), label);
            }
            assert(failed, label);
            assert.deepEqual(await main.merge({ at: other, ...request('second') }), published('second', 'v2'), label);
            assert.deepEqual(reservations(fixture).map(doc => [doc.id, doc.requestId]).sort(),
                [['reservation:1', 'first'], ['reservation:2', 'second']], label);
            assert.deepEqual([indexOf(fixture, 'first').slot, indexOf(fixture, 'second').slot], ['1', '2'], label);
            const reader = await fresh(fixture);
            assert.deepEqual(await reader.merge({ at: draft, ...request('first') }), published('first', 'v1'), label);
            assert.deepEqual(await reader.status(), { at: { kind: 'main' }, mainVersion: 'v2' }, label);
        }
});

test('a lost request index response keeps the reserved slot blocked until recovery confirms the index', async () => {
    const { fixture, main } = await setup();
    await main.write({ at: other, op: 'create', path: '/other', content: 'other' });
    // The index reaches the journal, but its response and the confirming read are lost.
    let hide = false;
    fixture.afterUpsert = ({ docs }) => {
        if (docs[0].kind === 'merge-request-v1' && docs[0].requestId === 'first') {
            fixture.afterUpsert = undefined;
            hide = true;
            throw lost();
        }
    };
    fixture.beforeFetch = ({ ids }) => {
        if (hide && ids.length === 1 && ids[0].startsWith('request:')) {
            hide = false;
            return { isDocsInline: true, total: 0, docs: [] };
        }
    };
    await assert.rejects(main.merge({ at: draft, ...request('first') }), { code: 'MERGE_RESUMABLE' });
    fixture.beforeFetch = undefined;
    assert.equal(indexOf(fixture, 'first').slot, '1');
    assert.equal(reservations(fixture).length, 1);
    assert.equal(journalOf(fixture).has('completion:1'), false);
    await assert.rejects(main.merge({ at: other, ...request('second') }), { code: 'MERGE_BLOCKED', details: { requestId: 'first' } });
    assert.deepEqual(await main.status(), { at: { kind: 'main' }, mainVersion: 'v0', merge: { requestId: 'first', phase: 'publication' } });
    const recovered = await MemDrive.open({ client: fixture.client, name, recover: true });
    assert.equal(recovered, main);
    assert.deepEqual(await main.status(), { at: { kind: 'main' }, mainVersion: 'v1' });
    assert.deepEqual(await main.merge({ at: draft, ...request('first') }), published('first', 'v1'));
    assert.deepEqual(await main.merge({ at: other, ...request('second') }), published('second', 'v2'));
    assert.equal(fixture.calls.filter(call => call.kind === 'upsert' && call.request.docs[0].kind === 'merge-request-v1'
        && call.request.docs[0].requestId === 'first').length, 1);
});
