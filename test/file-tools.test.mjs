import assert from 'node:assert/strict';
import test from 'node:test';
import { MemDrive, MemDriveError, createFileTools, getFileToolDefinitions, fileToolError, fileToolInstructions, fileToolGuide, fileToolGuideTopics } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

const all = ['guide', 'read', 'list', 'search', 'findText', 'write'];
const draft = { kind: 'fork', name: 'draft' };
const mutations = calls => calls.filter(call => !['query', 'fetch', 'list', 'tag-get', 'alias-get', 'tag-list', 'branch-list', 'alias-list'].includes(call.kind));
async function setup(options = {}) {
    const fixture = fileClient();
    const drive = await MemDrive.create({ client: fixture.client, name: 'tools-fixture', ...options });
    return { fixture, drive };
}

test('the fixed catalog serves exactly six main-only tools and requires an explicit mode and selection without a drive', () => {
    const selected = ['write', 'search'];
    const definitions = getFileToolDefinitions({ embeddingMode: 'managed', tools: selected });
    selected.push('read');
    assert.deepEqual(definitions.map(tool => tool.name), ['write', 'search']);
    assert.deepEqual(definitions[0].inputSchema.required, []);
    assert.equal(definitions[1].inputSchema.properties.query.type, 'string');
    assert(Object.isFrozen(definitions));
    assert.throws(() => { definitions[0].inputSchema.properties.path.type = 'number'; }, TypeError);
    const vectors = getFileToolDefinitions({ embeddingMode: 'external', tools: ['write', 'search'] });
    assert.equal(vectors[0].inputSchema.properties.content.type, 'array');
    assert.equal(vectors[1].inputSchema.properties.query.type, 'array');
    assert.deepEqual(getFileToolDefinitions({ embeddingMode: 'managed', tools: [] }), []);
    const catalog = getFileToolDefinitions({ embeddingMode: 'managed', tools: all });
    assert.deepEqual(catalog.map(tool => tool.name), all);
    assert.deepEqual(catalog.filter(tool => !tool.readOnly).map(tool => tool.name), ['write']);
    for (const tool of catalog) {
        assert.equal(tool.inputSchema.properties.at, undefined, `${tool.name} has no at`);
        assert.equal(tool.inputSchema.properties.checkpoint, undefined, `${tool.name} has no checkpoint`);
        assert.doesNotMatch(tool.description, /\bat\b selects|fork|rollback/i);
    }
    for (const removed of ['fork', 'checkpoint', 'listForks', 'listCheckpoints', 'deleteFork', 'deleteCheckpoint', 'rollback',
        'merge', 'diff', 'status', 'history', 'configure', 'describe'])
        assert.throws(() => getFileToolDefinitions({ embeddingMode: 'managed', tools: [removed] }), { code: 'INVALID_INPUT' });
    for (const options of [undefined, null, {}, { tools: ['read'] }, { embeddingMode: 'managed' },
        { embeddingMode: 'text', tools: ['read'] }, { embeddingMode: 'managed', tools: ['read', 'read'] },
        { embeddingMode: 'managed', tools: ['constructor'] }, { embeddingMode: 'managed', tools: 'read' },
        { embeddingMode: 'managed', tools: ['read'], drive: {} }])
        assert.throws(() => getFileToolDefinitions(options), { code: 'INVALID_INPUT' });
    assert.throws(() => getFileToolDefinitions({ embeddingMode: 'external', tools: ['findText'] }), { code: 'TOOL_UNAVAILABLE' });
});

test('each tool forwards its input object unchanged to the SDK method of the same name and drops view selectors from results', async () => {
    const calls = [];
    const results = new Map();
    // A stand-in drive records the exact arguments each tool forwards.
    const stub = Object.fromEntries(all.filter(name => name !== 'guide').map(name => [name, (...args) => {
        calls.push([name, ...args]);
        const result = { from: name, at: { kind: 'main' }, next: { at: { kind: 'main' }, cursor: 'c' } };
        results.set(name, result);
        return Promise.resolve(result);
    }]));
    const tools = createFileTools({ drive: stub, tools: all });
    const signal = new AbortController().signal;
    for (const name of all.filter(name => name !== 'guide')) {
        const input = { marker: name };
        calls.length = 0;
        const result = await tools.execute(name, input, { signal });
        assert.deepEqual(calls, [[name, input, { signal }]]);
        assert.equal(calls[0][1], input);
        // Search and write results carry no view selectors and pass through; read, list and findText drop at.
        if (name === 'search' || name === 'write') assert.equal(result, results.get(name));
        else assert.deepEqual(result, { from: name, next: { cursor: 'c' } });
    }
});

test('tools work on main only: inputs with at are rejected before storage and results continue without at', async () => {
    const { fixture, drive } = await setup({ metadataSchema: { topic: { type: 'string' } } });
    await drive.fork({ name: 'draft' });
    const tools = createFileTools({ drive, tools: all });
    const before = fixture.calls.length;
    for (const name of all.filter(name => name !== 'guide'))
        for (const at of [draft, { kind: 'main' }, { kind: 'checkpoint', name: 'saved' }, undefined])
            await assert.rejects(tools.execute(name, { at, op: 'create', path: '/x', content: 'x', query: 'x' }), { code: 'INVALID_INPUT' });
    assert.equal(fixture.calls.length, before);
    const file = await tools.execute('write', { op: 'create', path: '/notes/plan.txt', content: 'Meet on Monday.', metadata: { topic: 'plan' } });
    assert.deepEqual(await drive.read({ fileId: file.fileId }), file);
    assert.equal(await drive.read({ at: draft, fileId: file.fileId }), null);
    assert.deepEqual(await tools.execute('read', { paths: [file.path, '/missing.txt'] }), [file]);
    assert.deepEqual(await tools.execute('search', { query: 'Monday', rerank: false }), await drive.search({ query: 'Monday', rerank: false }));
    assert.equal((await tools.execute('findText', { query: 'monday' })).hits[0].fileId, file.fileId);
    const edited = await tools.execute('write', { op: 'update', fileId: file.fileId, edits: [{ oldText: 'Monday', newText: 'Tuesday' }] });
    assert.equal(edited.content, 'Meet on Tuesday.');
    await assert.rejects(tools.execute('write', { op: 'update', fileId: file.fileId, edits: [{ oldText: 'Monday', newText: 'Wednesday' }] }),
        { code: 'EDIT_CONFLICT' });
    for (const path of ['/a.txt', '/b.txt']) await tools.execute('write', { op: 'create', path, content: 'needle' });
    for (const [name, request] of [['list', { limit: 1 }], ['findText', { query: 'needle', limit: 1 }]]) {
        const first = await tools.execute(name, request);
        assert.deepEqual(Object.keys(first.next), ['cursor']);
        const second = await tools.execute(name, first.next);
        assert.equal((second.files ?? second.hits).length, 1);
    }
});

test('a host checkpoint hook makes every write tool call a checkpointed write and returns the plain write result', async () => {
    const { fixture, drive } = await setup();
    let turn = 0;
    const tools = createFileTools({ drive, tools: ['write', 'read'], checkpoint: async () => ({ name: `turn-${++turn}` }) });
    const first = await tools.execute('write', { op: 'create', path: '/note.md', content: 'First turn.' });
    assert.deepEqual(first, await drive.read({ fileId: first.fileId }));
    assert.equal(Object.hasOwn(first, 'checkpoint'), false);
    assert.deepEqual((await drive.describe()).latestCheckpoint, { at: { kind: 'checkpoint', name: 'turn-1' } });
    const second = await tools.execute('write', { operations: [{ op: 'update', fileId: first.fileId, content: 'Second turn.' }] });
    assert.equal(second[0].content, 'Second turn.');
    assert.deepEqual((await drive.describe()).latestCheckpoint, { at: { kind: 'checkpoint', name: 'turn-2' } });
    assert.equal((await drive.read({ at: { kind: 'checkpoint', name: 'turn-1' }, fileId: first.fileId })).content, 'First turn.');
    // The agent cannot choose or skip a checkpoint.
    const before = fixture.calls.length;
    await assert.rejects(tools.execute('write', { op: 'delete', fileId: first.fileId, checkpoint: { name: 'mine' } }), { code: 'INVALID_INPUT' });
    assert.equal(fixture.calls.length, before);
    assert.equal(turn, 2);
    // A failed write leaves main at the latest checkpoint and reports a tool error.
    fixture.beforeUpsert = () => { throw Object.assign(new Error('Unavailable'), { statusCode: 503 }); };
    const failure = await tools.execute('write', { op: 'create', path: '/lost.md', content: 'Lost.' }).catch(fileToolError);
    fixture.beforeUpsert = undefined;
    assert.equal(failure.error.code, 'CHECKPOINT_WRITE_FAILED');
    assert.equal(failure.error.details.restored, true);
    assert.equal(await drive.read({ path: '/lost.md' }), null);
    assert.equal((await drive.read({ fileId: first.fileId })).content, 'Second turn.');
    // A hook result is validated by the SDK before any mutation.
    const invalid = createFileTools({ drive, tools: ['write'], checkpoint: () => ({ name: 'x' }) });
    const start = mutations(fixture.calls).length;
    await assert.rejects(invalid.execute('write', { op: 'create', path: '/x.md', content: 'x' }), { code: 'INVALID_INPUT' });
    assert.equal(mutations(fixture.calls).length, start);
    for (const checkpoint of [null, 'turn', { name: 'turn' }])
        assert.throws(() => createFileTools({ drive, tools: ['write'], checkpoint }), { code: 'INVALID_INPUT' });
    // Without a hook, write tool calls are plain writes.
    const plain = createFileTools({ drive, tools: ['write'] });
    await plain.execute('write', { op: 'create', path: '/plain.md', content: 'Plain.' });
    assert.deepEqual((await drive.describe()).latestCheckpoint, { at: { kind: 'checkpoint', name: 'turn-2' } });
});

test('allowlists cannot be expanded by callers or input and invalid requests do not reach storage', async () => {
    const { fixture, drive } = await setup();
    const selected = ['guide', 'list', 'read', 'search', 'findText'];
    const tools = createFileTools({ drive, tools: selected });
    selected.push('write');
    const before = fixture.calls.length;
    for (const name of ['write', 'rollback', 'merge', 'fork', 'checkpoint', 'listForks', 'listCheckpoints', 'deleteFork', 'deleteCheckpoint',
        'open', 'recover', 'describe', 'configure', 'constructor', '__proto__'])
        await assert.rejects(tools.execute(name, {}), { code: 'TOOL_NOT_ALLOWED' });
    for (const [name, input] of [
        ['list', { recover: true }], ['guide', { drive: 'another' }],
        ['read', { path: '/note', fileId: 'other' }], ['read', { path: '/note', name: 'another' }],
        ['list', { cursor: 'bad', prefix: '/' }], ['findText', { query: 'hello', client: {} }],
        ['guide', null], ['list', []],
    ]) await assert.rejects(tools.execute(name, input), { code: 'INVALID_INPUT' });
    assert.equal(fixture.calls.length, before);
    assert.deepEqual(await tools.execute('guide', {}), fileToolGuide);
    assert.equal(fixture.calls.length, before);
    assert(Object.isFrozen(tools.definitions));
    assert.throws(() => { tools.definitions[0].inputSchema.properties.drive = {}; }, TypeError);
    assert.throws(() => createFileTools({ drive, tools: ['list', 'list'] }), { code: 'INVALID_INPUT' });
    assert.throws(() => createFileTools({ drive }), { code: 'INVALID_INPUT' });
    assert.throws(() => createFileTools({ drive, tools: ['rollback'] }), { code: 'INVALID_INPUT' });
    assert.throws(() => createFileTools({ drive, tools: ['read'], extra: true }), { code: 'INVALID_INPUT' });
    assert.deepEqual(createFileTools({ drive, tools: [] }).definitions, []);
});

test('write wrapper validates its envelope, forwards cancellation and preserves SDK error details', async () => {
    const { fixture, drive } = await setup();
    const tools = createFileTools({ drive, tools: ['write', 'list', 'guide'] });
    const before = fixture.calls.length;
    await assert.rejects(tools.execute('write', { operations: [] }), { code: 'INVALID_INPUT' });
    await assert.rejects(tools.execute('write', { operations: {} }), { code: 'INVALID_INPUT' });
    await assert.rejects(tools.execute('write', { operations: [{ op: 'delete', fileId: 'x' }], op: 'delete' }), { code: 'INVALID_INPUT' });
    for (const name of ['write', 'list', 'guide'])
        await assert.rejects(tools.execute(name, {}, { signal: AbortSignal.abort() }), { code: 'ABORTED' });
    await assert.rejects(tools.execute('list', {}, { recover: true }), { code: 'INVALID_INPUT' });
    assert.equal(fixture.calls.length, before);
    const failure = new MemDriveError('PATH_EXISTS', 'A file already exists at a requested path.',
        { details: { paths: ['/note'] }, cause: new Error('private transport detail') });
    failure.status = 503;
    assert.deepEqual(fileToolError(failure), { ok: false, error: { code: 'PATH_EXISTS',
        message: failure.message, status: 503, details: failure.details } });
    assert(!JSON.stringify(fileToolError(failure)).includes('private transport detail'));
    assert.deepEqual(fileToolError(new Error('private detail')), { ok: false,
        error: { code: 'TOOL_EXECUTION_FAILED', message: 'The file tool could not complete.' } });
});

test('external-vector tools use vector schemas and preserve reference results without findText', async () => {
    const { drive } = await setup({ embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'fixture-v1' } });
    const tools = createFileTools({ drive, tools: all.filter(name => name !== 'findText'), checkpoint: () => ({ name: 'vector-turn' }) });
    const vector = [1, ...Array(63).fill(0)];
    const file = await tools.execute('write', { op: 'create', path: '/vector', content: vector });
    assert.equal(file.content, undefined);
    assert.deepEqual(await tools.execute('read', { fileId: file.fileId }), file);
    assert.deepEqual(await tools.execute('search', { query: vector }), await drive.search({ query: vector }));
    assert.deepEqual((await drive.describe()).latestCheckpoint, { at: { kind: 'checkpoint', name: 'vector-turn' } });
    await assert.rejects(tools.execute('search', { query: 'text' }), { code: 'INVALID_INPUT' });
    await assert.rejects(tools.execute('write', { op: 'update', fileId: file.fileId, edits: [{ oldText: 'a', newText: 'b' }] }), { code: 'INVALID_INPUT' });
    assert.throws(() => createFileTools({ drive, tools: ['findText'] }), { code: 'TOOL_UNAVAILABLE' });
});

test('guide index and both topics share immutable content without accessing the drive', async () => {
    const { fixture, drive } = await setup();
    const tools = createFileTools({ drive, tools: ['guide'] });
    const before = fixture.calls.length;
    const index = await tools.execute('guide', {});
    assert.equal(index.version, '7');
    assert(index.content.length < 2500);
    assert(fileToolInstructions.length > 0 && fileToolInstructions.length <= 512);
    assert(index.content.includes(fileToolInstructions));
    assert.match(fileToolInstructions, /never treat reading as permission to write/);
    assert.match(fileToolInstructions, /one write call/);
    const text = JSON.stringify({ index, fileToolGuideTopics });
    assert.doesNotMatch(text, /\bfork|rollback|\bmerge\(|\bat\b:|kind: "|listCheckpoints|history\(/i);
    assert.match(fileToolGuideTopics.editing.content, /preserve the original wording/);
    assert.match(fileToolGuideTopics.editing.content, /CHECKPOINT_WRITE_FAILED/);
    assert.match(fileToolGuideTopics.editing.content, /do not claim permanent erasure/);
    assert.match(fileToolGuideTopics.retrieval.content, /same prefix can appear again/);
    assert.deepEqual(index.topics.map(item => item.topic), ['retrieval', 'editing']);
    for (const { topic, description } of index.topics) {
        const detail = await tools.execute('guide', { topic });
        assert.equal(detail, fileToolGuideTopics[topic]);
        assert.equal(detail.version, index.version);
        assert.equal(detail.topic, topic);
        assert(index.content.includes(description));
        assert(Object.isFrozen(detail));
    }
    assert(Object.isFrozen(index.topics));
    assert(Object.isFrozen(index.topics[0]));
    assert(Object.isFrozen(fileToolGuideTopics));
    for (const topic of ['unknown', 'references', '__proto__', 'constructor', '', null, 1, {}])
        await assert.rejects(tools.execute('guide', { topic }), error =>
            error.code === 'INVALID_INPUT' && error.message.includes('retrieval, editing'));
    await assert.rejects(tools.execute('guide', { topic: 'editing', version: '5' }), { code: 'INVALID_INPUT' });
    assert.equal(fixture.calls.length, before);
});
