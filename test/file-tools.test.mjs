import assert from 'node:assert/strict';
import test from 'node:test';
import { MemDrive, MemDriveError, createFileTools, getFileToolDefinitions, fileToolError, fileToolInstructions, fileToolGuide, fileToolGuideTopics } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

const all = ['guide', 'list', 'read', 'search', 'findText', 'fork', 'checkpoint',
    'listForks', 'listCheckpoints', 'deleteFork', 'deleteCheckpoint', 'write', 'rollback'];
const draft = { kind: 'fork', name: 'draft' };
async function setup(options = {}) {
    const fixture = fileClient();
    const drive = await MemDrive.create({ client: fixture.client, name: 'tools-fixture', ...options });
    await drive.fork({ name: 'draft' });
    return { fixture, drive };
}

test('fixed tool definitions require an explicit mode and selection without a drive', () => {
    const selected = ['fork', 'checkpoint', 'write', 'search'];
    const definitions = getFileToolDefinitions({ embeddingMode: 'managed', tools: selected });
    selected.push('read');
    assert.deepEqual(definitions.map(tool => tool.name), ['fork', 'checkpoint', 'write', 'search']);
    assert.equal(definitions[0].inputSchema.properties.version, undefined);
    assert.deepEqual(definitions[1].inputSchema.required, ['name']);
    assert.deepEqual(definitions[2].inputSchema.required, []);
    assert.equal(definitions[3].inputSchema.properties.query.type, 'string');
    assert(Object.isFrozen(definitions));
    assert.throws(() => { definitions[0].inputSchema.properties.name.type = 'number'; }, TypeError);
    const vectors = getFileToolDefinitions({ embeddingMode: 'external', tools: ['write', 'search'] });
    assert.equal(vectors[0].inputSchema.properties.content.type, 'array');
    assert.equal(vectors[1].inputSchema.properties.query.type, 'array');
    assert.deepEqual(getFileToolDefinitions({ embeddingMode: 'managed', tools: [] }), []);
    const flags = Object.fromEntries(getFileToolDefinitions({ embeddingMode: 'managed', tools: all }).map(tool => [tool.name, tool.readOnly]));
    assert.deepEqual(Object.keys(flags).filter(name => !flags[name]), ['fork', 'checkpoint', 'deleteFork', 'deleteCheckpoint', 'write', 'rollback']);
    for (const removed of ['merge', 'diff', 'status', 'history', 'configure'])
        assert.throws(() => getFileToolDefinitions({ embeddingMode: 'managed', tools: [removed] }), { code: 'INVALID_INPUT' });
    for (const options of [undefined, null, {}, { tools: ['read'] }, { embeddingMode: 'managed' },
        { embeddingMode: 'text', tools: ['read'] }, { embeddingMode: 'managed', tools: ['read', 'read'] },
        { embeddingMode: 'managed', tools: ['constructor'] }, { embeddingMode: 'managed', tools: ['recover'] },
        { embeddingMode: 'managed', tools: ['open'] }, { embeddingMode: 'managed', tools: ['describe'] },
        { embeddingMode: 'managed', tools: 'read' }, { embeddingMode: 'managed', tools: ['read'], drive: {} }])
        assert.throws(() => getFileToolDefinitions(options), { code: 'INVALID_INPUT' });
    assert.throws(() => getFileToolDefinitions({ embeddingMode: 'external', tools: ['findText'] }), { code: 'TOOL_UNAVAILABLE' });
});

test('each tool forwards its input object unchanged to the SDK method of the same name and returns its result', async () => {
    const calls = [];
    const results = new Map();
    // A stand-in drive records the exact arguments each tool forwards.
    const stub = Object.fromEntries(all.filter(name => name !== 'guide').map(name => [name, (...args) => {
        calls.push([name, ...args]);
        const result = { from: name };
        results.set(name, result);
        return Promise.resolve(result);
    }]));
    const tools = createFileTools({ drive: stub, tools: all });
    const signal = new AbortController().signal;
    for (const name of all.filter(name => name !== 'guide')) {
        const input = { at: draft, marker: name };
        calls.length = 0;
        const result = await tools.execute(name, input, { signal });
        assert.equal(result, results.get(name));
        assert.equal(calls.length, 1);
        assert.equal(calls[0][0], name);
        assert.equal(calls[0][1], input);
        assert.deepEqual(calls[0][2], { signal });
    }
});

test('drive-bound execution writes to main by default or a selected fork and rejects checkpoint writes', async () => {
    for (const external of [false, true]) {
        const { fixture, drive } = await setup(external
            ? { embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'fixture-v1' } } : {});
        const names = all.filter(name => !external || name !== 'findText');
        const tools = createFileTools({ drive, tools: names });
        const content = external ? [1, ...Array(63).fill(0)] : 'Original wording.';
        await drive.checkpoint({ name: 'saved' });
        const before = fixture.calls.length;
        await assert.rejects(tools.execute('write', { at: { kind: 'checkpoint', name: 'saved' }, op: 'create', path: '/note.txt', content }),
            { code: 'INVALID_INPUT' });
        assert.equal(fixture.calls.length, before);
        const reader = createFileTools({ drive, tools: ['read'] });
        await assert.rejects(reader.execute('write', { at: draft, op: 'create', path: '/note.txt', content }), { code: 'TOOL_NOT_ALLOWED' });
        const file = await tools.execute('write', { at: draft, op: 'create', path: '/note.txt', content });
        assert.equal(file.path, '/note.txt');
        assert.equal(await tools.execute('read', { fileId: file.fileId }), null);
        assert.deepEqual(await tools.execute('read', { at: draft, fileId: file.fileId }), file);
        const onMain = await tools.execute('write', { op: 'create', path: '/main.txt', content });
        assert.deepEqual(await tools.execute('read', { at: { kind: 'main' }, fileId: onMain.fileId }), onMain);
        assert.equal(await tools.execute('read', { at: draft, fileId: onMain.fileId }), null);
    }
});

test('tool execution follows at through retrieval, exact edits, checkpoints and rollback', async () => {
    const { drive } = await setup({ metadataSchema: { topic: { type: 'string' } } });
    const tools = createFileTools({ drive, tools: all });
    const file = await tools.execute('write', { at: draft, op: 'create', path: '/notes/plan.txt', content: 'Meet on Monday.', metadata: { topic: 'plan' } });
    assert.equal(await drive.read({ fileId: file.fileId }), null);
    assert.deepEqual(await tools.execute('read', { at: draft, paths: [file.path, '/missing.txt'] }), [file]);
    assert.deepEqual(await tools.execute('list', { at: draft }), await drive.list({ at: draft }));
    assert.deepEqual(await tools.execute('search', { at: draft, query: 'Monday', rerank: false }), await drive.search({ at: draft, query: 'Monday', rerank: false }));
    assert.equal((await tools.execute('findText', { at: draft, query: 'monday' })).hits[0].fileId, file.fileId);
    const { at: saved } = await tools.execute('checkpoint', { at: draft, name: 'before-edit' });
    const edited = await tools.execute('write', { at: draft, op: 'update', fileId: file.fileId,
        edits: [{ oldText: 'Monday', newText: 'Tuesday' }] });
    assert.equal(edited.content, 'Meet on Tuesday.');
    await assert.rejects(tools.execute('write', { at: draft, op: 'update', fileId: file.fileId,
        edits: [{ oldText: 'Monday', newText: 'Wednesday' }] }), { code: 'EDIT_CONFLICT' });
    assert.deepEqual(await tools.execute('listForks', {}), { forks: [{ at: draft }] });
    // Bring the fork's file to main by writing it there; the SDK has no merge.
    const copied = await tools.execute('write', { op: 'create', path: edited.path, content: edited.content, metadata: edited.metadata });
    assert.equal((await tools.execute('read', { path: edited.path })).content, copied.content);
    assert.deepEqual(await tools.execute('rollback', { at: draft, to: saved }), { at: draft });
    assert.equal((await tools.execute('read', { at: draft, fileId: file.fileId })).content, 'Meet on Monday.');
    assert.equal((await tools.execute('read', { path: edited.path })).content, 'Meet on Tuesday.');
    await assert.rejects(tools.execute('rollback', { at: saved, to: saved }), { code: 'INVALID_INPUT' });
    await assert.rejects(tools.execute('rollback', { to: saved }), { code: 'INVALID_INPUT' });
});

test('list and findText continuations forward next unchanged and reject another view', async () => {
    const { drive } = await setup();
    const tools = createFileTools({ drive, tools: ['list', 'findText', 'write'] });
    for (const path of ['/a.txt', '/b.txt', '/c.txt']) await tools.execute('write', { at: draft, op: 'create', path, content: 'needle' });
    for (const [name, request] of [['list', { at: draft, limit: 1 }], ['findText', { at: draft, query: 'needle', limit: 1 }]]) {
        const first = await tools.execute(name, request);
        assert.deepEqual(first.next.at, draft);
        await assert.rejects(tools.execute(name, { cursor: first.next.cursor }), { code: 'CURSOR_VIEW_MISMATCH' });
        await assert.rejects(tools.execute(name, { at: { kind: 'main' }, cursor: first.next.cursor }), { code: 'CURSOR_VIEW_MISMATCH' });
        const second = await tools.execute(name, first.next);
        assert.equal((second.files ?? second.hits).length, 1);
    }
});

test('allowlists cannot be expanded by callers or input and invalid requests do not reach storage', async () => {
    const { fixture, drive } = await setup();
    const selected = ['guide', 'list', 'read', 'search', 'findText', 'listForks', 'listCheckpoints'];
    const tools = createFileTools({ drive, tools: selected });
    selected.push('write');
    const before = fixture.calls.length;
    for (const name of ['write', 'rollback', 'merge', 'diff', 'status', 'history', 'fork', 'checkpoint', 'deleteFork', 'deleteCheckpoint',
        'open', 'recover', 'describe', 'configure', 'constructor', '__proto__'])
        await assert.rejects(tools.execute(name, { at: draft }), { code: 'TOOL_NOT_ALLOWED' });
    for (const [name, input] of [
        ['list', { at: { fork: 'another' } }], ['list', { at: { kind: 'main', name: 'x' } }], ['list', { recover: true }],
        ['guide', { drive: 'another' }],
        ['read', { path: '/note', fileId: 'other' }], ['read', { path: '/note', name: 'another' }],
        ['list', { cursor: 'bad', prefix: '/' }], ['listForks', { at: draft }],
        ['search', { query: 'hello', at: { fork: 'another' } }], ['findText', { query: 'hello', client: {} }],
        ['guide', null], ['list', []],
    ]) await assert.rejects(tools.execute(name, input), { code: 'INVALID_INPUT' });
    assert.equal(fixture.calls.length, before);
    assert.deepEqual(await tools.execute('guide', {}), fileToolGuide);
    assert.equal(fixture.calls.length, before);
    assert(Object.isFrozen(tools.definitions));
    assert.throws(() => { tools.definitions[0].inputSchema.properties.drive = {}; }, TypeError);
    assert.throws(() => createFileTools({ drive, tools: ['list', 'list'] }), { code: 'INVALID_INPUT' });
    assert.throws(() => createFileTools({ drive }), { code: 'INVALID_INPUT' });
    assert.throws(() => createFileTools({ drive, tools: ['recover'] }), { code: 'INVALID_INPUT' });
    assert.deepEqual(createFileTools({ drive, tools: [] }).definitions, []);
});

test('write wrapper validates its envelope, forwards cancellation and preserves SDK error details', async () => {
    const { fixture, drive } = await setup();
    const tools = createFileTools({ drive, tools: ['write', 'rollback', 'list', 'guide', 'deleteFork'] });
    const before = fixture.calls.length;
    await assert.rejects(tools.execute('write', { operations: [], at: { fork: 'other' } }), { code: 'INVALID_INPUT' });
    await assert.rejects(tools.execute('write', { at: draft, operations: [] }), { code: 'INVALID_INPUT' });
    await assert.rejects(tools.execute('write', { at: draft, operations: {} }), { code: 'INVALID_INPUT' });
    await assert.rejects(tools.execute('write', { at: draft, operations: [{ op: 'delete', fileId: 'x' }], op: 'delete' }), { code: 'INVALID_INPUT' });
    for (const name of ['write', 'rollback', 'list', 'guide', 'deleteFork'])
        await assert.rejects(tools.execute(name, { at: draft }, { signal: AbortSignal.abort() }), { code: 'ABORTED' });
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

test('external-vector tools use vector schemas and preserve reference results without text tools', async () => {
    const { drive } = await setup({ embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'fixture-v1' } });
    const tools = createFileTools({ drive, tools: all.filter(name => name !== 'findText') });
    const vector = [1, ...Array(63).fill(0)];
    const file = await tools.execute('write', { at: draft, op: 'create', path: '/vector', content: vector });
    assert.equal(file.content, undefined);
    assert.deepEqual(await tools.execute('read', { at: draft, fileId: file.fileId }), file);
    assert.deepEqual(await tools.execute('search', { at: draft, query: vector }), await drive.search({ at: draft, query: vector }));
    await assert.rejects(tools.execute('search', { at: draft, query: 'text' }), { code: 'INVALID_INPUT' });
    await assert.rejects(tools.execute('write', { at: draft, op: 'update', fileId: file.fileId, edits: [{ oldText: 'a', newText: 'b' }] }), { code: 'INVALID_INPUT' });
    assert.throws(() => createFileTools({ drive, tools: ['findText'] }), { code: 'TOOL_UNAVAILABLE' });
    const { at } = await tools.execute('checkpoint', { at: draft, name: 'saved' });
    assert.deepEqual(await tools.execute('read', { at, path: '/vector' }), file);
    await assert.rejects(tools.execute('write', { at, op: 'delete', fileId: file.fileId }), { code: 'INVALID_INPUT' });
});

test('ref tools create views from main, forks and checkpoints, return { at } and list or delete them', async () => {
    for (const mode of ['managed', 'external']) {
        const external = mode === 'external';
        const options = external ? { embedding: { mode, dimensions: 64, similarity: 'cosine', identity: 'fixture-v1' } } : {};
        const { drive } = await setup(options);
        const tools = createFileTools({ drive, tools: ['fork', 'checkpoint', 'read', 'list', 'listForks', 'listCheckpoints', 'deleteFork', 'deleteCheckpoint'] });
        const content = external ? [1, ...Array(63).fill(0)] : 'Main original.';
        const file = await drive.write({ op: 'create', path: '/original', content });
        await drive.deleteFork({ at: draft });
        await drive.fork({ name: 'draft' });
        await drive.write({ at: draft, op: 'update', fileId: file.fileId, newPath: '/fork-only' });
        const saved = (await tools.execute('checkpoint', { at: draft, name: 'source-checkpoint' })).at;
        const copies = [];
        for (const source of [{ kind: 'main' }, draft, saved]) {
            const expectedFile = await drive.read({ at: source, fileId: file.fileId });
            for (const kind of ['fork', 'checkpoint']) {
                const name = `from-${source.kind}`;
                const created = await tools.execute(kind, { at: source, name });
                assert.deepEqual(created, { at: { kind, name } });
                assert.deepEqual(JSON.parse(JSON.stringify(created)), created);
                assert.deepEqual(await tools.execute('read', { at: created.at, fileId: file.fileId }), expectedFile);
                copies.push({ at: created.at, expectedFile });
            }
        }
        await drive.write({ at: draft, op: 'update', fileId: file.fileId, newPath: '/later' });
        for (const { at, expectedFile } of copies)
            assert.deepEqual(await drive.read({ at, fileId: file.fileId }), expectedFile);
        assert.equal((await drive.read({ fileId: file.fileId })).path, '/original');
        assert.deepEqual((await tools.execute('listForks', {})).forks.map(({ at }) => at.name), ['draft', 'from-checkpoint', 'from-fork', 'from-main']);
        assert.deepEqual((await tools.execute('listCheckpoints', {})).checkpoints.map(({ at }) => at.name),
            ['from-checkpoint', 'from-fork', 'from-main', 'source-checkpoint']);
        const removed = { kind: 'fork', name: 'from-main' };
        assert.deepEqual(await tools.execute('deleteFork', { at: removed }), { at: removed });
        assert.deepEqual(await tools.execute('deleteCheckpoint', { at: saved }), { at: saved });
        await assert.rejects(tools.execute('read', { at: removed, fileId: file.fileId }), { code: 'BRANCH_NOT_FOUND' });
        await assert.rejects(tools.execute('list', { at: saved }), { code: 'CHECKPOINT_NOT_FOUND' });
        await assert.rejects(tools.execute('deleteFork', { at: saved }), { code: 'INVALID_INPUT' });
        await assert.rejects(tools.execute('deleteCheckpoint', { at: { kind: 'main' } }), { code: 'INVALID_INPUT' });
    }
});

test('ref tools enforce independent permissions, validate locally and preserve conflict and native errors', async () => {
    const { fixture, drive } = await setup();
    const forkOnly = createFileTools({ drive, tools: ['fork'] });
    const checkpointOnly = createFileTools({ drive, tools: ['checkpoint'] });
    const before = fixture.calls.length;
    await assert.rejects(forkOnly.execute('checkpoint', { name: 'saved' }), { code: 'TOOL_NOT_ALLOWED' });
    await assert.rejects(checkpointOnly.execute('fork', { name: 'draft' }), { code: 'TOOL_NOT_ALLOWED' });
    for (const [tools, kind, max] of [[forkOnly, 'fork', 47], [checkpointOnly, 'checkpoint', 41]]) {
        for (const input of [{}, { name: 'ab' }, { name: 'x'.repeat(max + 1) }, { name: 'bad/path' },
            { name: 'valid', at: { fork: 'other' } }, { name: 'valid', store: 'other' }, { at: draft, name: 'valid', version: 'v0' }])
            await assert.rejects(tools.execute(kind, input), { code: 'INVALID_INPUT' });
        await assert.rejects(tools.execute(kind, { name: 'valid' }, { signal: AbortSignal.abort() }), { code: 'ABORTED' });
    }
    await assert.rejects(forkOnly.execute('fork', { name: 'main' }), { code: 'INVALID_INPUT' });
    assert.equal(fixture.calls.length, before);
    await forkOnly.execute('fork', { at: draft, name: 'copy' });
    await checkpointOnly.execute('checkpoint', { at: draft, name: 'saved' });
    await assert.rejects(forkOnly.execute('fork', { name: 'copy' }), { code: 'BRANCH_CONFLICT' });
    await assert.rejects(checkpointOnly.execute('checkpoint', { name: 'saved' }), { code: 'CHECKPOINT_CONFLICT' });
    fixture.afterTagCreate = tag => { if (tag.name === 'checkpoint-uncertain') throw new Error('Lost response'); };
    await assert.rejects(checkpointOnly.execute('checkpoint', { name: 'uncertain' }), error => error.code === 'DATABASE_ERROR' && error.status === undefined);
    fixture.afterTagCreate = undefined;
    // No fence: the retry reaches LambdaDB, which reports the name as taken.
    await assert.rejects(checkpointOnly.execute('checkpoint', { name: 'uncertain' }), { code: 'CHECKPOINT_CONFLICT' });
});

test('guide index and all topics share immutable content without accessing the drive', async () => {
    const { fixture, drive } = await setup();
    const tools = createFileTools({ drive, tools: ['guide'] });
    const before = fixture.calls.length;
    const index = await tools.execute('guide', {});
    assert.equal(index.version, '7');
    assert(index.content.length < 2500);
    assert(fileToolInstructions.length > 0 && fileToolInstructions.length <= 512);
    assert(index.content.includes(fileToolInstructions));
    assert.match(index.content, /Reading never authorizes a write/);
    assert.match(index.content, /Omitting at selects main/);
    assert.doesNotMatch(JSON.stringify(fileToolGuideTopics), /bound view|binding/);
    assert.match(fileToolGuideTopics.references.content, /never retried automatically/);
    assert.match(fileToolGuideTopics.editing.content, /Writes are not serialized/);
    assert.match(fileToolGuideTopics.retrieval.content, /CURSOR_VIEW_MISMATCH/);
    assert.match(fileToolGuideTopics.retrieval.content, /same prefix can appear again/);
    assert.doesNotMatch(JSON.stringify(fileToolGuideTopics), /\bmerge\(|\bdiff\b|history\(|status\(|mainVersion|publication/);
    assert.deepEqual(index.topics.map(item => item.topic), ['retrieval', 'references', 'editing', 'maintenance']);
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
    for (const topic of ['unknown', '__proto__', 'constructor', '', null, 1, {}])
        await assert.rejects(tools.execute('guide', { topic }), error =>
            error.code === 'INVALID_INPUT' && error.message.includes('retrieval, references, editing, maintenance'));
    await assert.rejects(tools.execute('guide', { topic: 'editing', version: '5' }), { code: 'INVALID_INPUT' });
    assert.equal(fixture.calls.length, before);
});
