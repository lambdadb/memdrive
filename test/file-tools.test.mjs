import assert from 'node:assert/strict';
import test from 'node:test';
import { MemDrive, MemDriveError, createFileTools, fileToolError, fileToolGuide, fileToolGuideTopics } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

const all = ['guide', 'status', 'history', 'list', 'read', 'search', 'findText', 'fork', 'checkpoint', 'diff', 'write', 'merge'];
const publication = requestId => ({ requestId, summary: `Publish ${requestId}` });
async function setup(options = {}) {
    const fixture = fileClient();
    const main = await MemDrive.create({ client: fixture.client, name: 'tools-fixture', ...options });
    const work = await main.fork({ name: 'draft' });
    return { fixture, main, work };
}

test('tool execution follows the bound fork through retrieval, exact edits, diff and publication', async () => {
    const { main, work } = await setup({ metadataSchema: { topic: { type: 'string' } } });
    const tools = createFileTools({ drive: work, tools: all });
    const file = await tools.execute('write', { op: 'create', path: '/notes/plan.txt', content: 'Meet on Monday.', metadata: { topic: 'plan' } });
    assert.equal(await main.read({ fileId: file.fileId }), null);
    assert.deepEqual(await tools.execute('read', { paths: [file.path, '/missing.txt'] }), [file]);
    assert.deepEqual(await tools.execute('list', {}), await work.list());
    assert.deepEqual(await tools.execute('search', { query: 'Monday', rerank: false }), await work.search({ query: 'Monday', rerank: false }));
    assert.equal((await tools.execute('findText', { query: 'monday' })).hits[0].fileId, file.fileId);
    const edited = await tools.execute('write', { op: 'update', fileId: file.fileId,
        edits: [{ oldText: 'Monday', newText: 'Tuesday' }] });
    assert.equal(edited.content, 'Meet on Tuesday.');
    await assert.rejects(tools.execute('write', { op: 'update', fileId: file.fileId,
        edits: [{ oldText: 'Monday', newText: 'Wednesday' }] }), { code: 'EDIT_CONFLICT' });
    assert.deepEqual(await tools.execute('diff', {}), await work.diff());
    const published = await tools.execute('merge', publication('first'));
    assert.equal(published.version, 'v1');
    assert.deepEqual(await tools.execute('merge', publication('first')), published);
    assert.equal((await main.read({ fileId: file.fileId })).content, edited.content);
    assert.deepEqual(await tools.execute('status', {}), await work.status());
    await tools.execute('write', { operations: [{ op: 'update', fileId: file.fileId, newPath: '/notes/moved.txt' },
        { op: 'create', path: '/second.txt', content: 'Second file.' }] });
    await tools.execute('merge', publication('second'));
    const page = await tools.execute('history', { limit: 1 });
    assert(page.cursor);
    await tools.execute('write', { op: 'delete', fileId: file.fileId });
    await tools.execute('merge', publication('third'));
    const tail = await tools.execute('history', { cursor: page.cursor });
    assert.equal(tail.throughVersion, 'v2');
    assert.deepEqual(tail.entries.map(entry => entry.version), ['v2']);
    assert.deepEqual(await tools.execute('history', { sinceVersion: 'v2' }), await main.history({ sinceVersion: 'v2' }));
});

test('allowlists cannot be expanded by callers or input and invalid requests do not reach storage', async () => {
    const { fixture, main, work } = await setup();
    const selected = ['guide', 'status', 'history', 'list', 'read', 'search', 'findText'];
    const tools = createFileTools({ drive: work, tools: selected });
    selected.push('write');
    const before = fixture.calls.length;
    for (const name of ['write', 'merge', 'fork', 'checkpoint', 'open', 'recover', 'constructor', '__proto__'])
        await assert.rejects(tools.execute(name, {}), { code: 'TOOL_NOT_ALLOWED' });
    for (const [name, input] of [
        ['status', { at: { fork: 'another' } }], ['guide', { drive: 'another' }],
        ['read', { path: '/note', fileId: 'other' }], ['read', { path: '/note', name: 'another' }],
        ['list', { cursor: 'bad', prefix: '/' }], ['history', { cursor: 'bad', sinceVersion: 'v0' }],
        ['search', { query: 'hello', at: { fork: 'another' } }], ['findText', { query: 'hello', client: {} }],
        ['guide', null], ['status', []],
    ]) await assert.rejects(tools.execute(name, input), { code: 'INVALID_INPUT' });
    assert.equal(fixture.calls.length, before);
    assert.deepEqual(await tools.execute('guide', {}), fileToolGuide);
    assert.equal(fixture.calls.length, before);
    assert(Object.isFrozen(tools.definitions));
    assert.throws(() => { tools.definitions[0].inputSchema.properties.drive = {}; }, TypeError);
    for (const name of ['write', 'merge', 'diff'])
        assert.throws(() => createFileTools({ drive: main, tools: [name] }), { code: 'TOOL_UNAVAILABLE' });
    assert.throws(() => createFileTools({ drive: main, tools: ['status', 'status'] }), { code: 'INVALID_INPUT' });
    assert.throws(() => createFileTools({ drive: main }), { code: 'INVALID_INPUT' });
    assert.throws(() => createFileTools({ drive: main, tools: ['recover'] }), { code: 'INVALID_INPUT' });
    assert.deepEqual(createFileTools({ drive: work, tools: [] }).definitions, []);
});

test('write wrapper validates its envelope, forwards cancellation and preserves SDK error details', async () => {
    const { fixture, work } = await setup();
    const tools = createFileTools({ drive: work, tools: ['write', 'merge', 'status', 'guide'] });
    const before = fixture.calls.length;
    await assert.rejects(tools.execute('write', { operations: [], at: { fork: 'other' } }), { code: 'INVALID_INPUT' });
    await assert.rejects(tools.execute('write', { operations: [] }), { code: 'INVALID_INPUT' });
    await assert.rejects(tools.execute('write', { operations: {} }), { code: 'INVALID_INPUT' });
    for (const name of ['write', 'merge', 'status', 'guide'])
        await assert.rejects(tools.execute(name, {}, { signal: AbortSignal.abort() }), { code: 'ABORTED' });
    await assert.rejects(tools.execute('status', {}, { recover: true }), { code: 'INVALID_INPUT' });
    assert.equal(fixture.calls.length, before);
    const failure = new MemDriveError('MERGE_RESUMABLE', 'Resume after exclusive ownership.',
        { details: { requestId: 'request', publishedVersion: 'v1' }, cause: new Error('private transport detail') });
    failure.status = 503;
    assert.deepEqual(fileToolError(failure), { ok: false, error: { code: 'MERGE_RESUMABLE',
        message: failure.message, status: 503, details: failure.details } });
    assert(!JSON.stringify(fileToolError(failure)).includes('private transport detail'));
    assert.deepEqual(fileToolError(new Error('private detail')), { ok: false,
        error: { code: 'TOOL_EXECUTION_FAILED', message: 'The file tool could not complete.' } });
});

test('external-vector tools use vector schemas and preserve reference results without text tools', async () => {
    const { main, work } = await setup({ embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'fixture-v1' } });
    const tools = createFileTools({ drive: work, tools: all.filter(name => name !== 'findText') });
    const vector = [1, ...Array(63).fill(0)];
    const file = await tools.execute('write', { op: 'create', path: '/vector', content: vector });
    assert.equal(file.content, undefined);
    assert.deepEqual(await tools.execute('read', { fileId: file.fileId }), file);
    assert.deepEqual(await tools.execute('search', { query: vector }), await work.search({ query: vector }));
    await assert.rejects(tools.execute('search', { query: 'text' }), { code: 'INVALID_INPUT' });
    await assert.rejects(tools.execute('write', { op: 'update', fileId: file.fileId, edits: [{ oldText: 'a', newText: 'b' }] }), { code: 'INVALID_INPUT' });
    assert.throws(() => createFileTools({ drive: work, tools: ['findText'] }), { code: 'TOOL_UNAVAILABLE' });
    await tools.execute('merge', publication('vector'));
    const checkpoint = await main.checkpoint({ name: 'published' });
    const readOnly = createFileTools({ drive: checkpoint, tools: ['status', 'history', 'read'] });
    assert.deepEqual(await readOnly.execute('status', {}), await checkpoint.status());
    assert.deepEqual(await readOnly.execute('history', {}), await main.history());
    assert.deepEqual(await readOnly.execute('read', { path: '/vector' }), file);
    assert.throws(() => createFileTools({ drive: checkpoint, tools: ['write'] }), { code: 'TOOL_UNAVAILABLE' });
});

test('ref tools create reopenable views from main, forks and checkpoints without switching or publishing', async () => {
    for (const mode of ['managed', 'external']) {
        const external = mode === 'external';
        const options = external ? { embedding: { mode, dimensions: 64, similarity: 'cosine', identity: 'fixture-v1' } } : {};
        const { fixture, main, work } = await setup(options);
        const content = external ? [1, ...Array(63).fill(0)] : 'Published original.';
        const file = await work.write({ op: 'create', path: '/original', content });
        await work.merge(publication('first'));
        await work.write({ op: 'update', fileId: file.fileId, newPath: '/unpublished' });
        const saved = await work.checkpoint({ name: 'source-checkpoint' });
        const copies = [];
        for (const source of [main, work, saved]) {
            const tools = createFileTools({ drive: source, tools: ['fork', 'checkpoint', 'status'] });
            const before = await source.status();
            const expectedFile = await source.read({ fileId: file.fileId });
            for (const kind of ['fork', 'checkpoint']) {
                const name = `from-${source.at.kind}`;
                const created = await tools.execute(kind, { name });
                assert.deepEqual(created, { name: main.name, at: { kind, name } });
                assert.deepEqual(JSON.parse(JSON.stringify(created)), created);
                assert.equal(tools.definitions.find(tool => tool.name === kind).readOnly, false);
                const reopened = await MemDrive.open({ client: fixture.client, name: created.name,
                    ...(external ? { mode } : {}), at: { [created.at.kind]: created.at.name } });
                assert.deepEqual(await reopened.read({ fileId: file.fileId }), expectedFile);
                copies.push({ reopened, expectedFile });
                assert.deepEqual(await tools.execute('status', {}), before);
                await assert.rejects(tools.execute('write', { op: 'delete', fileId: file.fileId }), { code: 'TOOL_NOT_ALLOWED' });
            }
        }
        await work.write({ op: 'update', fileId: file.fileId, newPath: '/later' });
        for (const { reopened, expectedFile } of copies)
            assert.deepEqual(await reopened.read({ fileId: file.fileId }), expectedFile);
        assert.equal((await main.status()).mainVersion, 'v1');
        assert.equal((await main.read({ fileId: file.fileId })).path, '/original');
    }
});

test('ref tools enforce independent permissions, validate locally and preserve conflict and uncertain-outcome errors', async () => {
    const { fixture, work } = await setup();
    const forkOnly = createFileTools({ drive: work, tools: ['fork'] });
    const checkpointOnly = createFileTools({ drive: work, tools: ['checkpoint'] });
    const before = fixture.calls.length;
    await assert.rejects(forkOnly.execute('checkpoint', { name: 'saved' }), { code: 'TOOL_NOT_ALLOWED' });
    await assert.rejects(checkpointOnly.execute('fork', { name: 'draft' }), { code: 'TOOL_NOT_ALLOWED' });
    for (const [tools, kind, max] of [[forkOnly, 'fork', 47], [checkpointOnly, 'checkpoint', 41]]) {
        for (const input of [{}, { name: 'ab' }, { name: 'x'.repeat(max + 1) }, { name: 'bad/path' },
            { name: 'valid', at: { fork: 'other' } }, { name: 'valid', store: 'other' }])
            await assert.rejects(tools.execute(kind, input), { code: 'INVALID_INPUT' });
        await assert.rejects(tools.execute(kind, { name: 'valid' }, { signal: AbortSignal.abort() }), { code: 'ABORTED' });
    }
    await assert.rejects(forkOnly.execute('fork', { name: 'main' }), { code: 'INVALID_INPUT' });
    assert.equal(fixture.calls.length, before);
    await forkOnly.execute('fork', { name: 'copy' });
    await checkpointOnly.execute('checkpoint', { name: 'saved' });
    await assert.rejects(forkOnly.execute('fork', { name: 'copy' }), { code: 'BRANCH_CONFLICT' });
    await assert.rejects(checkpointOnly.execute('checkpoint', { name: 'saved' }), { code: 'CHECKPOINT_CONFLICT' });
    fixture.afterTagCreate = tag => { if (tag.name === 'checkpoint-uncertain') throw new Error('Lost response'); };
    await assert.rejects(checkpointOnly.execute('checkpoint', { name: 'uncertain' }),
        { code: 'REF_CREATION_UNCONFIRMED', details: { checkpoint: 'uncertain' } });
    const afterUncertain = fixture.calls.length;
    await assert.rejects(checkpointOnly.execute('checkpoint', { name: 'uncertain' }), { code: 'REF_CREATION_UNCONFIRMED' });
    assert.equal(fixture.calls.length, afterUncertain);
});


test('guide index and all topics share immutable content without accessing the bound drive', async () => {
    const { fixture, work } = await setup();
    const tools = createFileTools({ drive: work, tools: ['guide'] });
    const before = fixture.calls.length;
    const index = await tools.execute('guide', {});
    assert.equal(index.version, '6');
    assert(index.content.length < 2500);
    assert.match(index.content, /Reading never authorizes a write/);
    assert.deepEqual(index.topics.map(item => item.topic), ['retrieval', 'references', 'editing', 'publication', 'maintenance']);
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
            error.code === 'INVALID_INPUT' && error.message.includes('retrieval, references, editing, publication, maintenance'));
    await assert.rejects(tools.execute('guide', { topic: 'editing', version: '5' }), { code: 'INVALID_INPUT' });
    assert.equal(fixture.calls.length, before);
});
