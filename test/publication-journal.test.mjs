import assert from 'node:assert/strict';
import test from 'node:test';
import { MemDrive } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

const name = 'journal-store';
const draft = { kind: 'fork', name: 'draft' };
const other = { kind: 'fork', name: 'other' };
const request = label => ({ summary: `Publish ${label}` });
const fresh = fixture => MemDrive.open({ client: { ...fixture.client }, name });
const journalId = id => /^(?:publication|retention):/.test(id);
const journalFetches = (fixture, since = 0) => fixture.calls.slice(since)
    .filter(call => call.kind === 'fetch' && call.request.ids.some(journalId));
const journalWrites = fixture => fixture.calls.filter(call => call.kind === 'upsert' && call.collection !== name).length;

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
 * every seventh conflicts; neither takes a version number.
 */
async function populate(count) {
    const { fixture, main, file } = await setup();
    const versions = [], contents = new Map();
    if (count) await main.write({ at: other, op: 'create', path: '/note', content: 'competing' });
    for (let round = 1; round <= count; round++) {
        if (round % 7 === 0) {
            await assert.rejects(main.merge({ at: other, ...request(`r${round}`) }), { code: 'MERGE_CONFLICT' });
        } else if (round % 5 === 0) {
            assert.deepEqual(await main.merge({ at: draft, ...request(`r${round}`) }), { status: 'unchanged', version: versions.at(-1) ?? 'v0' });
        } else {
            if (round > 1) await main.write({ at: draft, op: 'update', fileId: file.fileId, content: String(round) });
            const version = `v${versions.length + 1}`;
            assert.deepEqual(await main.merge({ at: draft, ...request(`r${round}`) }), { status: 'published', version });
            versions.push(version);
            contents.set(version, round > 1 ? String(round) : '0');
        }
    }
    return { fixture, main, file, versions, contents };
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
        assert(fetches.every(call => call.request.ids.length <= 1000 && call.request.fields?.include.join() === 'id,driveId'));
        const history = await pages(reader, 7);
        assert.equal(history.through, expected.mainVersion);
        // Versions are contiguous: only publications take numbers.
        assert.deepEqual(history.entries.map(entry => entry.version), versions, `history after ${count} merges`);
        assert.deepEqual(history.entries, (await pages(main, 100)).entries);
    }
});

test('the head search is exact at every probe boundary and stays logarithmic far beyond one probe batch', async () => {
    const { fixture, main } = await setup();
    await main.merge({ at: draft, ...request('r1') });
    const [journalName, journal] = [...fixture.collections].find(([key]) => key.startsWith('md-journal-'));
    const { driveId } = journal.branches.get('main').docs.get('publication:1');
    const at = new Date().toISOString();
    // Serve a synthetic journal of publications up to `head`.
    let head = 1n;
    fixture.beforeFetch = ({ ids }) => {
        if (!ids.some(id => id.startsWith('publication:'))) return undefined;
        const docs = ids.flatMap(id => {
            const slot = BigInt(id.slice('publication:'.length));
            return slot > head ? [] : [{ id, driveId, kind: 'publication-v1', version: `v${slot}`, publishedAt: at,
                summary: 'Synthetic', fileIds: ['00000000-0000-4000-8000-000000000000'], fileIdsTruncated: false }];
        });
        return { isDocsInline: true, total: docs.length, docs: docs.map(doc => ({ collection: journalName, doc })) };
    };
    const observe = async (drive, expected, limit) => {
        const before = fixture.calls.length;
        assert.deepEqual(await drive.status(), { at: { kind: 'main' }, mainVersion: `v${expected}` }, `head ${expected}`);
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
        // A warm client whose head did not move probes only the next version.
        const before = fixture.calls.length;
        await observe(reader, head, 1);
        assert.deepEqual(journalFetches(fixture, before).map(call => call.request.ids), [[`publication:${head + 1n}`]]);
    }
    // A gap in the journal is never read as its head.
    head = 5n;
    const sparse = fixture.beforeFetch;
    fixture.beforeFetch = request => {
        const response = sparse(request);
        if (!response) return response;
        response.docs = response.docs.filter(({ doc }) => doc.id !== 'publication:2');
        response.total = response.docs.length;
        return response;
    };
    await assert.rejects((await fresh(fixture)).status(), { code: 'INVALID_RESULT' });
});

test('a second client sees the same status, history pages and exact versions, and repeating a merge writes nothing', async () => {
    const { fixture, main, file, versions, contents } = await populate(200);
    const latest = versions.at(-1);
    const reader = await fresh(fixture);
    assert.deepEqual(await reader.status(), await main.status());
    for (const limit of [7, 100]) assert.deepEqual(await pages(reader, limit), await pages(main, limit));
    const first = await reader.history({ sinceVersion: 'v3', limit: 4 });
    assert.deepEqual(first.entries.map(entry => entry.version), ['v4', 'v5', 'v6', 'v7']);
    assert.equal(first.throughVersion, latest);
    const second = await (await fresh(fixture)).history(first.next);
    assert.deepEqual(second.entries.map(entry => entry.version), ['v8', 'v9', 'v10', 'v11']);
    assert.deepEqual(second, await main.history(first.next));
    assert.deepEqual(await reader.history({ sinceVersion: latest }), { entries: [], throughVersion: latest });
    const next = `v${versions.length + 1}`;
    for (const sinceVersion of [next, 'v100000'])
        await assert.rejects(reader.history({ sinceVersion }), { code: 'VERSION_NOT_FOUND', details: { version: sinceVersion } });

    // Exact versions: every publication is selectable, a later number is not.
    for (const version of ['v101', 'v4', latest]) {
        const { at } = await reader.fork({ name: `at-${version}`, version });
        assert.equal((await reader.read({ at, fileId: file.fileId })).content, contents.get(version));
    }
    for (const version of [next, 'v100000'])
        await assert.rejects(reader.checkpoint({ name: 'unused', version }),
            error => error.code === 'HISTORICAL_VIEW_UNAVAILABLE' && error.details.version === version);

    // A client that never saw the merges repeats them without writing anything.
    const writes = journalWrites(fixture);
    const replayer = await fresh(fixture);
    assert.deepEqual(await replayer.merge({ at: draft, ...request('again') }), { status: 'unchanged', version: latest });
    await assert.rejects(replayer.merge({ at: other, ...request('again') }),
        { code: 'MERGE_CONFLICT', details: { fileIds: [], paths: ['/note'] } });
    assert.equal(journalWrites(fixture), writes);
    assert.equal([...fixture.collections.values()].find(store => store.metadata.tags['memdrive.format'] === 'merge-publication-v1')
        .branches.get('main').docs.size, versions.length);
});

test('a history page costs a head lookup and one fetch of its publication records', async () => {
    const { fixture, versions } = await populate(200);
    assert.equal(versions.length, 137);
    // Each publication pins its version. No merge leaves any other tag.
    assert.deepEqual([...fixture.collections.get(name).tags.keys()].sort(), versions.map(version => `md-main-${version}`).sort());
    // Every native request of a history read, which must be a fetch of publication records by ID.
    const read = async operation => {
        const before = fixture.calls.length;
        const page = await operation();
        const calls = fixture.calls.slice(before);
        for (const call of calls) {
            assert.equal(call.kind, 'fetch');
            assert.equal(call.request.ref.name, 'main');
            assert(call.request.ids.every(id => /^publication:[1-9][0-9]*$/.test(id)), call.request.ids.join());
            assert(call.request.ids.length <= 1000);
        }
        return { page, fetches: calls.length };
    };
    for (const limit of [20, 100]) {
        const reader = await fresh(fixture);
        // Cold: the head search, then the page. Warm: a probe of the next version, then the page.
        const cold = await read(() => reader.history({ limit }));
        assert.equal(cold.fetches, 3, `cold page of ${limit}`);
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

test('publication records are read back from the journal instead of being kept in memory', async () => {
    const { fixture, versions } = await populate(40);
    const drive = await fresh(fixture);
    const fetched = async operation => {
        const before = fixture.calls.length;
        await operation();
        return new Set(journalFetches(fixture, before).flatMap(call => call.request.ids));
    };
    // Warm the client with every kind of read, then repeat each one.
    await pages(drive, 100);
    const head = versions.length;
    for (let round = 0; round < 2; round++) {
        const history = await fetched(() => drive.history({ sinceVersion: 'v22', limit: 2 }));
        assert.deepEqual([...history].sort(), [`publication:${head + 1}`, 'publication:23', 'publication:24'].sort());
        // A known head costs one probe of the next version; nothing earlier is read again.
        const status = await fetched(() => drive.status());
        assert.deepEqual([...status], [`publication:${head + 1}`]);
        // Selecting a version needs only the head: every earlier version is a publication.
        const version = await fetched(() => drive.checkpoint({ name: `saved-${round}`, version: 'v18' }));
        assert.deepEqual([...version], [`publication:${head + 1}`]);
    }
});
