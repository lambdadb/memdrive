import assert from 'node:assert/strict';
import test from 'node:test';
import { createFileTools, MemDrive } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

const name = 'authorship';
const alice = { user: 'alice', agent: 'planner' };
const bob = { agent: 'reviewer' };
const times = ['2020-01-02T03:04:05.006Z', '2021-02-03T04:05:06.007Z', '2022-03-04T05:06:07.008Z', '2023-04-05T06:07:08.009Z']
    .map(value => new Date(value));
const [t1, t2, t3, t4] = times;
const iso = date => date.toISOString();
const fields = ['createdAt', 'createdBy', 'modifiedAt', 'modifiedBy'];
/** The attribution fields an entry carries; absent fields stay absent. */
const attribution = entry => Object.fromEntries(fields.filter(key => Object.hasOwn(entry, key)).map(key => [key, entry[key]]));
const stamp = (created, createdBy, modified = created, modifiedBy = createdBy) => ({
    createdAt: iso(created), ...(createdBy ? { createdBy } : {}), modifiedAt: iso(modified), ...(modifiedBy ? { modifiedBy } : {}),
});

async function setup(options = {}) {
    const fixture = fileClient();
    const drive = await MemDrive.create({ client: fixture.client, name, metadataSchema: { topic: { type: 'string' } }, ...options });
    const docs = (branch = 'main') => fixture.collections.get(name).branches.get(branch).docs;
    const stored = (fileId, branch) => docs(branch).get(`file:${fileId}`);
    const chunks = (fileId, branch) => [...docs(branch).values()].filter(doc => doc.kind === 'chunk' && doc.fileId === fileId);
    const mutations = since => fixture.calls.slice(since).filter(call => ['upsert', 'update', 'delete'].includes(call.kind))
        .map(call => [call.kind, ...(call.request.docs ?? []).map(doc => doc.kind)]);
    return { fixture, drive, stored, chunks, mutations };
}

test('a create records its time and actor as both creation and modification, on the original only', async () => {
    const { drive, stored, chunks } = await setup();
    const file = await drive.write({ op: 'create', path: '/a.md', content: 'Alpha text.', by: alice, time: t1 });
    assert.deepEqual(attribution(file), stamp(t1, alice));
    assert.deepEqual(attribution(stored(file.fileId)), stamp(t1, alice));
    assert.equal(chunks(file.fileId).length, 1);
    for (const key of ['createdAt', 'createdBy', 'modifiedBy']) assert.equal(Object.hasOwn(chunks(file.fileId)[0], key), false);

    // Keys holding undefined are absent; the SDK stores a copy of the actor.
    const actor = { user: 'carol', agent: undefined };
    const copied = await drive.write({ op: 'create', path: '/b.md', content: 'Beta.', by: actor });
    actor.user = 'changed';
    assert.deepEqual([copied.createdBy, copied.modifiedBy, stored(copied.fileId).createdBy], [{ user: 'carol' }, { user: 'carol' }, { user: 'carol' }]);
    assert.equal(copied.createdAt, copied.modifiedAt);
    assert(Math.abs(Date.parse(copied.createdAt) - Date.now()) < 60_000);

    const anonymous = await drive.write({ op: 'create', path: '/c.md', content: '' });
    assert.deepEqual(Object.keys(attribution(anonymous)), ['createdAt', 'modifiedAt']);
    assert.deepEqual(Object.keys(attribution(stored(anonymous.fileId))), ['createdAt', 'modifiedAt']);
});

test('modifiedBy follows modifiedAt: updates set or clear it, unchanged updates keep it, creation fields never change', async () => {
    const { drive, stored } = await setup();
    const { fileId } = await drive.write({ op: 'create', path: '/a.md', content: 'Alpha text.', by: alice, time: t1 });
    const changed = await drive.write({ op: 'update', fileId, content: 'Alpha text, revised.', by: bob, time: t2 });
    assert.deepEqual(attribution(changed), stamp(t1, alice, t2, bob));
    // A write that changes nothing leaves modifiedAt and modifiedBy as they were.
    const unchanged = await drive.write({ op: 'update', fileId, content: 'Alpha text, revised.', by: { user: 'carol' }, time: t3 });
    assert.deepEqual(attribution(unchanged), stamp(t1, alice, t2, bob));
    assert.deepEqual(attribution(stored(fileId)), stamp(t1, alice, t2, bob));
    // A change without by removes the previous modifier instead of misattributing the change.
    const cleared = await drive.write({ op: 'update', fileId, metadata: { topic: 'x' }, time: t3 });
    assert.deepEqual(attribution(cleared), stamp(t1, alice, t3, null));
    assert.deepEqual(attribution(stored(fileId)), stamp(t1, alice, t3, null));
    const edited = await drive.write({ op: 'update', fileId, edits: [{ oldText: 'revised', newText: 'edited' }], by: bob, time: t4 });
    assert.equal(edited.content, 'Alpha text, edited.');
    assert.deepEqual(attribution(await drive.read({ fileId })), stamp(t1, alice, t4, bob));
});

test('moves record the new modifier, writing the whole original after the chunk patches only when the modifier changes', async () => {
    const { fixture, drive, stored, chunks, mutations } = await setup();
    const { fileId } = await drive.write({ op: 'create', path: '/a.md', content: 'Alpha text.', by: alice, time: t1 });
    const move = async (newPath, change) => {
        const since = fixture.calls.length;
        const moved = await drive.write({ op: 'update', fileId, newPath, ...change });
        return { moved, sent: mutations(since) };
    };
    // The same modifier: one patch of the chunk and the original, as before.
    let { moved, sent } = await move('/b.md', { by: alice, time: t2 });
    assert.deepEqual(attribution(moved), stamp(t1, alice, t2, alice));
    assert.deepEqual(sent, [['update', 'chunk', 'file']]);
    // A patch merges into the stored original, so another modifier rewrites it.
    ({ moved, sent } = await move('/c.md', { by: bob, time: t3 }));
    assert.deepEqual(sent, [['update', 'chunk'], ['upsert', 'file']]);
    assert.deepEqual(attribution(stored(fileId)), stamp(t1, alice, t3, bob));
    ({ moved, sent } = await move('/d.md', { time: t4 }));
    assert.deepEqual(sent, [['update', 'chunk'], ['upsert', 'file']]);
    assert.deepEqual(attribution(stored(fileId)), stamp(t1, alice, t4, null));
    assert.deepEqual(await drive.read({ path: '/d.md' }), moved);
    assert.equal(stored(fileId).body, 'Alpha text.');
    assert.deepEqual(chunks(fileId).map(chunk => [chunk.path, chunk.revision]), [['/d.md', stored(fileId).revision]]);
    assert.deepEqual((await drive.search({ query: 'Alpha' })).hits.map(hit => [hit.path, hit.modifiedAt]), [['/d.md', iso(t4)]]);
    ({ sent } = await move('/e.md', {}));
    assert.deepEqual(sent, [['update', 'chunk', 'file']]);

    // An empty file has no chunks: only its original is written.
    const empty = await drive.write({ op: 'create', path: '/empty.md', content: '', by: alice });
    const since = fixture.calls.length;
    await drive.write({ op: 'update', fileId: empty.fileId, newPath: '/empty-moved.md', by: bob });
    assert.deepEqual(mutations(since), [['upsert', 'file']]);
    assert.deepEqual(stored(empty.fileId).modifiedBy, bob);
});

test('a batch applies by and time to every operation, and its operations accept neither', async () => {
    const { fixture, drive } = await setup();
    const first = await drive.write({ op: 'create', path: '/a.md', content: 'Alpha.', by: alice, time: t1 });
    const [created, updated] = await drive.write({ by: bob, time: t2, operations: [
        { op: 'create', path: '/b.md', content: 'Beta.' },
        { op: 'update', fileId: first.fileId, content: 'Alpha, revised.' },
    ] });
    assert.deepEqual(attribution(created), stamp(t2, bob));
    assert.deepEqual(attribution(updated), stamp(t1, alice, t2, bob));
    const before = fixture.calls.length;
    for (const operation of [{ op: 'create', path: '/c.md', content: 'C.', by: bob }, { op: 'update', fileId: first.fileId, content: 'C.', time: t3 },
        { op: 'delete', fileId: first.fileId, by: bob }])
        await assert.rejects(drive.write({ operations: [operation] }), { code: 'INVALID_INPUT' });
    assert.equal(fixture.calls.length, before);
});

test('invalid actors and times fail with INVALID_INPUT before any storage request', async () => {
    const { fixture, drive } = await setup();
    const create = { op: 'create', path: '/a.md', content: 'Alpha.' };
    const before = fixture.calls.length;
    const actors = [null, 'alice', [], {}, { user: undefined }, { user: '' }, { agent: ' \t' }, { user: 'a\u0000b' }, { user: 'a\nb' },
        { agent: '\uD800' }, { user: 'x'.repeat(257) }, { user: '가'.repeat(86) }, { user: 1 }, { team: 'x' }, { user: 'a', team: 'x' },
        Object.assign(Object.create({ inherited: true }), { user: 'a' })];
    for (const by of actors) {
        await assert.rejects(drive.write({ ...create, by }), { code: 'INVALID_INPUT' }, JSON.stringify(by));
        await assert.rejects(drive.write({ by, operations: [create], checkpoint: { name: 'turn-1' } }), { code: 'INVALID_INPUT' });
    }
    for (const time of [null, iso(t1), t1.getTime(), new Date(Number.NaN), new Date('+010000-01-01T00:00:00.000Z'), new Date('-000001-01-01T00:00:00.000Z')])
        await assert.rejects(drive.write({ ...create, time }), { code: 'INVALID_INPUT' }, String(time));
    assert.equal(fixture.calls.length, before);
    // The limits are inclusive, and a well-formed surrogate pair is allowed.
    for (const user of ['x'.repeat(256), '가'.repeat(85), '😀 agent'])
        assert.equal((await drive.write({ op: 'create', path: `/${user.length}.md`, content: '', by: { user } })).createdBy.user, user);
    const early = new Date('0000-01-01T00:00:00.000Z');
    assert.equal((await drive.write({ op: 'create', path: '/early.md', content: '', time: early })).createdAt, '0000-01-01T00:00:00.000Z');
});

test('a checkpointed write records by and time, and its checkpoint holds them', async () => {
    const { drive } = await setup();
    const { at } = await drive.fork({ name: 'draft' });
    const { result, checkpoint } = await drive.write({ at, op: 'create', path: '/a.md', content: 'Alpha.', by: alice, time: t1,
        checkpoint: { name: 'turn-1' } });
    assert.deepEqual(attribution(result), stamp(t1, alice));
    const next = await drive.write({ at, by: bob, time: t2, operations: [{ op: 'update', fileId: result.fileId, newPath: '/b.md' }],
        checkpoint: { name: 'turn-2' } });
    assert.deepEqual(attribution(next.result[0]), stamp(t1, alice, t2, bob));
    assert.deepEqual(await drive.read({ at: checkpoint.at, fileId: result.fileId }), result);
    assert.deepEqual(await drive.read({ at: next.checkpoint.at, fileId: result.fileId }), next.result[0]);
});

test('read, list, search and findText return the stored attribution and reject invalid stored values', async () => {
    const { drive, stored } = await setup();
    const authored = await drive.write({ op: 'create', path: '/notes/a.md', content: 'Shared needle.', metadata: { topic: 't' }, by: alice, time: t1 });
    const plain = await drive.write({ op: 'create', path: '/notes/b.md', content: 'Plain needle.', time: t2 });
    const expected = new Map([[authored.fileId, stamp(t1, alice)], [plain.fileId, stamp(t2, null)]]);
    const check = entries => {
        assert.equal(entries.length, 2);
        for (const entry of entries) assert.deepEqual(attribution(entry), expected.get(entry.fileId));
    };
    check([await drive.read({ path: authored.path }), await drive.read({ fileId: plain.fileId })]);
    check(await drive.read({ paths: [authored.path, plain.path] }));
    check([await drive.read({ fileId: authored.fileId, maxChars: 4 }), await drive.read({ fileId: plain.fileId, startLine: 1 })]);
    check((await drive.list({ prefix: '/notes/' })).files);
    check((await drive.search({ query: 'needle' })).hits);
    check((await drive.findText({ query: 'needle' })).hits);

    stored(plain.fileId).modifiedBy = { user: '' };
    await assert.rejects(drive.read({ fileId: plain.fileId }), { code: 'INVALID_RESULT' });
    delete stored(plain.fileId).modifiedBy;
    delete stored(plain.fileId).createdAt;
    await assert.rejects(drive.list(), { code: 'INVALID_RESULT' });
});

test('external-vector files record and return attribution', async () => {
    const embedding = { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'fixture' };
    const { drive, stored, mutations, fixture } = await setup({ embedding });
    const vector = value => Array.from({ length: 64 }, (_, index) => index === 0 ? value : 0.5);
    const file = await drive.write({ op: 'create', path: '/a', content: vector(1), metadata: { topic: 't' }, by: alice, time: t1 });
    assert.deepEqual(attribution(file), stamp(t1, alice));
    const unchanged = await drive.write({ op: 'update', fileId: file.fileId, metadata: { topic: 't' }, by: bob, time: t2 });
    assert.deepEqual(attribution(unchanged), stamp(t1, alice));
    const updated = await drive.write({ op: 'update', fileId: file.fileId, content: vector(2), by: bob, time: t2 });
    assert.deepEqual(attribution(updated), stamp(t1, alice, t2, bob));
    const since = fixture.calls.length;
    const moved = await drive.write({ op: 'update', fileId: file.fileId, newPath: '/b', time: t3 });
    assert.deepEqual(mutations(since), [['upsert', 'file']]);
    assert.deepEqual(attribution(moved), stamp(t1, alice, t3, null));
    assert.deepEqual(attribution(stored(file.fileId)), stamp(t1, alice, t3, null));
    const other = await drive.write({ op: 'create', path: '/c', content: vector(3), by: bob, time: t4 });
    for (const entries of [await drive.read({ paths: ['/b', '/c'] }), (await drive.list()).files, (await drive.search({ query: vector(1) })).hits])
        assert.deepEqual(entries.map(attribution), [attribution(moved), attribution(other)]);
});

test('file tools pass the host actor and time on every write and reject them from the model', async () => {
    const { fixture, drive } = await setup();
    let clock = 0;
    const now = () => times[clock++];
    const tools = createFileTools({ drive, tools: ['write', 'read'], actor: alice, now });
    const file = await tools.execute('write', { op: 'create', path: '/a.md', content: 'Alpha.' });
    assert.deepEqual(attribution(file), stamp(t1, alice));
    const [updated] = await tools.execute('write', { operations: [{ op: 'update', fileId: file.fileId, content: 'Alpha, revised.' }] });
    assert.deepEqual(attribution(updated), stamp(t1, alice, t2, alice));
    assert.deepEqual(await tools.execute('read', { fileId: file.fileId }), updated);

    let turn = 0;
    const checkpointed = createFileTools({ drive, tools: ['write'], actor: bob, now, checkpoint: () => ({ name: `turn-${++turn}` }) });
    const plainResult = await checkpointed.execute('write', { op: 'update', fileId: file.fileId, newPath: '/b.md' });
    assert.deepEqual(attribution(plainResult), stamp(t1, alice, t3, bob));
    assert.deepEqual(attribution(await drive.read({ at: { kind: 'checkpoint', name: 'turn-1' }, fileId: file.fileId })), stamp(t1, alice, t3, bob));

    // Model input cannot name the actor or time; it fails before the hooks or storage run.
    const before = fixture.calls.length;
    for (const input of [{ op: 'create', path: '/c.md', content: '', by: bob }, { op: 'create', path: '/c.md', content: '', time: t4 },
        { operations: [{ op: 'create', path: '/c.md', content: '' }], by: undefined }])
        await assert.rejects(checkpointed.execute('write', input), error => error.code === 'INVALID_INPUT' && /host supplies by and time/.test(error.message));
    assert.deepEqual([fixture.calls.length, turn, clock], [before, 1, 3]);

    const anonymous = await createFileTools({ drive, tools: ['write'] }).execute('write', { op: 'create', path: '/d.md', content: '' });
    assert.deepEqual(Object.keys(attribution(anonymous)), ['createdAt', 'modifiedAt']);
    for (const options of [{ actor: {} }, { actor: { user: 'a', role: 'admin' } }, { actor: 'alice' }, { now: t1 }])
        assert.throws(() => createFileTools({ drive, tools: ['write'], ...options }), { code: 'INVALID_INPUT' });
    const late = fixture.calls.length;
    await assert.rejects(createFileTools({ drive, tools: ['write'], now: () => 'today' }).execute('write', { op: 'create', path: '/e.md', content: '' }),
        { code: 'INVALID_INPUT' });
    assert.equal(fixture.calls.length, late);
});

test('stores index createdAt but not actors, and a files-v1 store neither opens nor is destroyed', async () => {
    const { fixture } = await setup();
    const { indexConfigs, tags } = fixture.collections.get(name).metadata;
    assert.equal(tags['memdrive.format'], 'files-v2');
    assert.deepEqual([indexConfigs.createdAt, indexConfigs.modifiedAt], [{ type: 'datetime' }, { type: 'datetime' }]);
    assert.equal(Object.hasOwn(indexConfigs, 'createdBy') || Object.hasOwn(indexConfigs, 'modifiedBy'), false);
    const { createdAt: _createdAt, ...earlierIndexes } = indexConfigs;
    const { client } = fixture;
    await client.createCollection({ ...fixture.collections.get(name).metadata, collectionName: 'earlier', indexConfigs: earlierIndexes,
        tags: { ...tags, 'memdrive.format': 'files-v1' } });
    await assert.rejects(MemDrive.open({ client, name: 'earlier' }), { code: 'INCOMPATIBLE_STORE' });
    await assert.rejects(MemDrive.destroy({ client, name: 'earlier' }), { code: 'INCOMPATIBLE_STORE' });
    assert(fixture.collections.has('earlier'));
    // The current tag still requires the createdAt index.
    await client.createCollection({ ...fixture.collections.get(name).metadata, collectionName: 'unindexed', indexConfigs: earlierIndexes });
    await assert.rejects(MemDrive.open({ client, name: 'unindexed' }), { code: 'INCOMPATIBLE_STORE' });
});

test('plain writes without by or time send the same native requests as before attribution', async () => {
    const { fixture, drive } = await setup();
    const a = await drive.write({ op: 'create', path: '/a.md', content: 'Alpha text.' });
    const [b] = await drive.write({ operations: [{ op: 'create', path: '/b.md', content: 'Beta.' }, { op: 'create', path: '/c.md', content: '' }] });
    await drive.write({ op: 'update', fileId: a.fileId, content: 'Alpha text, revised.' });
    await drive.write({ op: 'update', fileId: a.fileId, newPath: '/moved/a.md' });
    await drive.write({ op: 'update', fileId: a.fileId, newPath: '/moved/a.md' });
    await drive.write({ op: 'update', fileId: b.fileId, edits: [{ oldText: 'Beta', newText: 'Gamma' }], metadata: { topic: 'x' } });
    await drive.write({ op: 'delete', fileId: b.fileId });
    await drive.write({ op: 'create', path: '/d.md', content: 'Delta.', checkpoint: { name: 'turn-1' } });
    // Recorded from the SDK before this change; the originals gained only createdAt.
    assert.equal(fixture.calls.map(call => call.kind).join(' '), 'query upsert fetch query upsert fetch fetch upsert fetch fetch query delete fetch '
        + 'query fetch query query update fetch fetch query fetch query update fetch fetch query fetch upsert fetch fetch query delete fetch query '
        + 'fetch delete fetch fetch query delete fetch query query upsert fetch tag-create alias-retarget alias-create');
    const shapes = new Set(fixture.calls.filter(call => call.kind === 'upsert' || call.kind === 'update')
        .flatMap(call => call.request.docs.map(doc => `${call.kind} ${doc.kind}: ${Object.keys(doc).sort().join(',')}`)));
    const chunk = 'ancestorPaths,content,embeddingText,end,fileId,fileName,id,kind,modifiedAt,path,revision,start';
    const original = 'ancestorPaths,body,chunking,createdAt,fileId,fileName,id,kind,modifiedAt,path,revision';
    const patch = 'ancestorPaths,fileId,fileName,id,kind,modifiedAt,path,revision';
    assert.deepEqual([...shapes].sort(), [
        `update chunk: ${patch}`, `update file: ${patch}`,
        `upsert chunk: ${chunk}`, `upsert chunk: ${chunk.replace('kind,', 'kind,metadata,')}`,
        `upsert file: ${original}`, `upsert file: ${original.replace('fileName,', 'fileName,generation,')}`,
        `upsert file: ${original.replace('fileName,', 'fileName,generation,').replace('kind,', 'kind,metadata,')}`,
    ].sort());
});
