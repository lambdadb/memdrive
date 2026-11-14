import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { create, MemDriveError } from '../dist/esm/index.js';
import { createTools } from '../dist/esm/tools/index.js';
import { memdriveClient } from './helpers/memdrive-client.mjs';

const schema = {
    role: { type: 'string', description: 'Message author role' },
    tags: { type: 'string[]', description: 'Topics associated with a memory' },
    score: { type: 'number' },
};
const setup = async options => {
    const f = memdriveClient();
    const drive = await create({ client: f.client, name: 'tools_test', metadataSchema: schema, ...options });
    f.search = (_request, docs) => docs;
    return { f, drive };
};
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const validators = tools => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    return new Map(JSON.parse(JSON.stringify(tools.definitions)).map(definition => [definition.name, {
        input: ajv.compile(definition.inputSchema), output: ajv.compile(definition.outputSchema),
    }]));
};
const conforms = (validate, value) => assert(validate(value), JSON.stringify(validate.errors));

test('tool catalog is detached, portable and read-only unless writes are explicitly included', async () => {
    const { f, drive } = await setup();
    const tools = await createTools({ drive });
    const expected = ['memdrive_count_values', 'memdrive_describe', 'memdrive_list', 'memdrive_read', 'memdrive_recall'];
    assert.deepEqual(tools.definitions.map(tool => tool.name).sort(), expected);
    assert(tools.definitions.every(tool => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint
        && tool.annotations.openWorldHint === false && tool.description.length > 0));
    const exposed = tools.definitions;
    exposed[0].name = 'changed';
    exposed[0].inputSchema.properties = {};
    assert.deepEqual(tools.definitions.map(tool => tool.name).sort(), expected);
    const before = f.calls.length;
    for (const name of ['memdrive_remember', 'memdrive_forget', 'missing']) {
        const result = await tools.execute(name, {});
        assert.equal(result.ok, false); assert.equal(result.error.code, 'UNKNOWN_TOOL');
    }
    assert.equal(f.calls.length, before);
    const writable = await createTools({ drive, writable: true });
    const names = writable.definitions.map(tool => tool.name);
    assert.equal(names.length, 7);
    const remember = writable.definitions.find(tool => tool.name === 'memdrive_remember');
    const forget = writable.definitions.find(tool => tool.name === 'memdrive_forget');
    assert.deepEqual(remember.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
    assert.deepEqual(forget.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
});

test('input and output schemas cover real SDK operations and the same JSON survives direct and MCP envelopes', async () => {
    const { f, drive } = await setup();
    const tools = await createTools({ drive, writable: true });
    const validate = validators(tools);
    const cases = [
        ['memdrive_remember', { mems: [{ id: 'one', content: 'Practice is on Friday.', metadata: { role: 'user', tags: ['music'] } }] }],
        ['memdrive_recall', { requests: [{ query: 'When is practice?' }, { query: 'Which topic?', rerank: false }] }],
        ['memdrive_read', { ids: ['one', 'absent'] }],
        ['memdrive_describe', {}],
        ['memdrive_list', { limit: 1 }],
    ];
    for (const [name, args] of cases) {
        conforms(validate.get(name).input, args);
        const result = await tools.execute(name, args);
        assert.equal(result.ok, true, JSON.stringify(result));
        conforms(validate.get(name).output, result);
        // These are transport-shaped wrappers around one execution result, not a live protocol test.
        const direct = { type: 'function_call_output', output: JSON.stringify(result) };
        const mcp = { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }], isError: !result.ok };
        assert.deepEqual(JSON.parse(direct.output), mcp.structuredContent);
        assert.deepEqual(JSON.parse(mcp.content[0].text), mcp.structuredContent);
    }
    f.search = () => ({ docs: [], facets: { 'metadata.tags': { buckets: [{ value: 'music', count: 1 }] } } });
    const countArgs = { fields: ['metadata.tags'], limit: 1 };
    conforms(validate.get('memdrive_count_values').input, countArgs);
    const count = await tools.execute('memdrive_count_values', countArgs);
    assert.equal(count.ok, true); conforms(validate.get('memdrive_count_values').output, count);
    assert.deepEqual(count.value.values['metadata.tags'].buckets, [{ value: 'music', count: 1 }]);
    const forgetArgs = { ids: ['one'] };
    conforms(validate.get('memdrive_forget').input, forgetArgs);
    const forgotten = await tools.execute('memdrive_forget', forgetArgs);
    assert.deepEqual(forgotten, { ok: true, value: { acknowledged: true } });
    conforms(validate.get('memdrive_forget').output, forgotten);
    assert.deepEqual((await drive.read({ ids: ['one'] })).mems, []);
});

test('recall preserves batch order and per-request failures and does not expose a mode or hidden selection step', async () => {
    const { f, drive } = await setup();
    await drive.remember({ mems: [{ id: 'first', content: 'first' }, { id: 'second', content: 'second' }] });
    f.search = async (request, docs) => {
        const query = request.query.knn.queryText;
        if (query === 'first') await new Promise(resolve => setTimeout(resolve, 5));
        return docs.filter(doc => doc.memId === query);
    };
    const tools = await createTools({ drive });
    const result = await tools.execute('memdrive_recall', { requests: [{ query: 'first' }, { query: '' }, { query: 'second' }] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.results.map(item => item.error?.code ?? item.matches[0].memId), ['first', 'INVALID_INPUT', 'second']);
    assert.deepEqual(result.value.results.map(item => item.usage.databaseRequests), [1, 0, 1]);
    conforms(validators(tools).get('memdrive_recall').output, result);
    const before = f.calls.length;
    for (const input of [{ query: 'single' }, { requests: [] }, { requests: Array(6).fill({ query: 'q' }) },
        { requests: [{ query: 'q' }], mode: 'agentic' }]) {
        const bad = await tools.execute('memdrive_recall', input);
        assert.equal(bad.ok, false); assert.equal(bad.error.code, 'INVALID_INPUT');
    }
    assert.equal(f.calls.length, before);
});

test('cancelling a running recall batch preserves completed matches and each request usage', async () => {
    const { f, drive } = await setup({ maxConcurrentRequests: 1 });
    await drive.remember({ mems: [{ id: 'completed', content: 'Finished evidence' }] });
    const entered = gate(), release = gate();
    f.search = async (request, docs) => {
        if (request.query.knn.queryText === 'in-flight') {
            entered.resolve();
            await release.promise;
        }
        return docs;
    };
    const tools = await createTools({ drive });
    const controller = new AbortController();
    const pending = tools.execute('memdrive_recall', {
        requests: [{ query: 'completed' }, { query: 'in-flight' }, { query: 'queued' }],
    }, { signal: controller.signal });
    // The second query starts only after the first logical recall has completed.
    await entered.promise;
    controller.abort();
    release.resolve();
    const result = await pending;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.value.results.map(item => item.error?.code ?? item.matches[0].memId),
        ['completed', 'ABORTED', 'ABORTED']);
    assert.deepEqual(result.value.results.map(item => item.usage.databaseRequests), [1, 1, 0]);
    assert.equal(f.calls.filter(call => call.kind === 'query').length, 2);
    conforms(validators(tools).get('memdrive_recall').output, result);
});

test('tool arguments cannot change the bound branch and explicit writes affect only that branch', async () => {
    const { f, drive } = await setup();
    await drive.remember({ mems: [{ id: 'shared', content: 'main' }] });
    await drive.branches.create({ name: 'alternate' });
    const tools = await createTools({ drive, branch: 'alternate', writable: true });
    const written = await tools.execute('memdrive_remember', { mems: [{ id: 'shared', content: 'alternate' }] });
    assert.equal(written.ok, true);
    const read = await tools.execute('memdrive_read', { ids: ['shared'] });
    assert.deepEqual(read.value.mems, [{ id: 'shared', content: 'alternate' }]);
    assert.deepEqual((await drive.read({ ids: ['shared'] })).mems, [{ id: 'shared', content: 'main' }]);
    const before = f.calls.length;
    for (const [name, args] of [
        ['memdrive_read', { ids: ['shared'], branch: 'main' }],
        ['memdrive_describe', { name: 'another' }],
        ['memdrive_remember', { mems: [{ content: 'x' }], branch: 'main' }],
    ]) {
        const invalid = await tools.execute(name, args);
        assert.equal(invalid.ok, false); assert.equal(invalid.error.code, 'INVALID_INPUT');
    }
    assert.equal(f.calls.length, before);
    await drive.branches.delete('alternate');
    const stale = await tools.execute('memdrive_read', { ids: ['shared'] });
    assert.equal(stale.ok, false); assert.equal(stale.error.code, 'BRANCH_INVALIDATED');
});

test('schemas reflect declared metadata and embedding type without accepting unrelated fields or null defaults', async () => {
    const { drive } = await setup();
    const tools = await createTools({ drive, writable: true });
    const validate = validators(tools);
    const remember = validate.get('memdrive_remember').input;
    assert(remember({ mems: [{ content: 'x', metadata: { role: 'user', tags: ['music'], score: 1 } }] }));
    for (const metadata of [{ role: 1 }, { tags: 'music' }, { undeclared: 'x' }])
        assert.equal(remember({ mems: [{ content: 'x', metadata }] }), false);
    assert(JSON.stringify(tools.definitions).includes('Message author role'));
    const recall = validate.get('memdrive_recall').input;
    assert(recall({ requests: [{ query: 'topic', excludeIds: [] }] }));
    assert(recall({ requests: [{ query: 'topic', filter: { and: [
        { field: 'metadata.role', op: 'eq', value: 'user' }, { field: 'timestamp', op: 'exists', value: true },
    ] } }] }));
    assert.equal(recall({ requests: [{ query: 'topic', rerank: null }] }), false);
    assert.equal(recall({ requests: [{ query: 'topic', mode: 'single_pass' }] }), false);
    assert.equal(recall({ requests: [{ query: 'topic', filter: { field: 'metadata.role', op: 'gt', value: 'user' } }] }), false);
    assert.equal(recall({ requests: [{ query: 'topic', filter: { field: 'metadata.missing', op: 'eq', value: 'x' } }] }), false);
    assert.equal(validate.get('memdrive_forget').input({ ids: ['one'], filter: { field: 'id', op: 'eq', value: 'one' } }), false);
    const external = await setup({ embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'fixture-v1' } });
    const vectorTools = await createTools({ drive: external.drive, writable: true });
    const vectorValidate = validators(vectorTools);
    const embedding = [1, ...Array(63).fill(0)];
    assert(vectorValidate.get('memdrive_recall').input({ requests: [{ queryVector: embedding }] }));
    assert.equal(vectorValidate.get('memdrive_recall').input({ requests: [{ query: 'text' }] }), false);
    assert.equal(vectorValidate.get('memdrive_recall').input({ requests: [{ queryVector: embedding, rerank: true }] }), false);
    assert.equal(vectorValidate.get('memdrive_recall').input({ requests: [{ queryVector: [1] }] }), false);
    const writeArgs = { mems: [{ id: 'vector', embedding, metadata: { tags: ['music'] } }] };
    conforms(vectorValidate.get('memdrive_remember').input, writeArgs);
    const written = await vectorTools.execute('memdrive_remember', writeArgs);
    assert.equal(written.ok, true); conforms(vectorValidate.get('memdrive_remember').output, written);
    const recalled = await vectorTools.execute('memdrive_recall', { requests: [{ queryVector: embedding }] });
    conforms(vectorValidate.get('memdrive_recall').output, recalled);
    assert.deepEqual(recalled.value.results[0].matches, [{ kind: 'mem', memId: 'vector', metadata: { tags: ['music'] } }]);
});

test('arguments are detached before asynchronous execution and cancellation never enters the payload', async () => {
    const { f, drive } = await setup();
    const entered = gate(), release = gate();
    let captured, passedOptions;
    const tools = await createTools({ drive: { ...drive, read: async (args, options) => {
        captured = args; passedOptions = options; entered.resolve(); await release.promise;
        return { mems: args.ids.map(id => ({ id, content: 'result' })) };
    } } });
    const controller = new AbortController();
    const args = { ids: ['original'] };
    const result = tools.execute('memdrive_read', args, { signal: controller.signal });
    args.ids[0] = 'mutated';
    await entered.promise;
    assert.deepEqual(captured, { ids: ['original'] }); assert.equal(passedOptions.signal, controller.signal);
    release.resolve(); assert.equal((await result).ok, true);
    controller.abort();
    const normal = await createTools({ drive, writable: true });
    const before = f.calls.length;
    const aborted = await normal.execute('memdrive_remember', { mems: [{ content: 'x' }] }, { signal: controller.signal });
    assert.equal(aborted.ok, false); assert.equal(aborted.error.code, 'ABORTED');
    assert.equal(f.calls.length, before);
    const read = await normal.execute('memdrive_read', { ids: ['one'] }, { signal: controller.signal });
    assert.equal(read.ok, false); assert.equal(read.error.code, 'ABORTED');
    assert.equal(f.calls.length, before);
    await assert.rejects(createTools({ drive }, { signal: controller.signal }), { code: 'ABORTED' });
});

test('write errors preserve reconciliation IDs while raw exceptions and internal details stay private', async () => {
    const { drive } = await setup();
    const partial = new MemDriveError('DATABASE_ERROR', 'Write failed; reconcile accepted memories.', { details: {
        completedIds: ['accepted'], uncertainIds: ['uncertain'], notAttemptedIds: ['pending'],
        secret: 'private-token', request: { credential: 'private-token' },
    }, cause: new Error('private-token') });
    partial.status = 503;
    const tools = await createTools({ drive: { ...drive,
        remember: async () => { throw partial; },
        read: async () => { throw new Error('private-token'); },
    }, writable: true });
    const result = await tools.execute('memdrive_remember', { mems: [{ content: 'x' }] });
    assert.deepEqual(result, { ok: false, error: { code: 'DATABASE_ERROR', message: 'Write failed; reconcile accepted memories.', status: 503,
        details: { completedIds: ['accepted'], uncertainIds: ['uncertain'], notAttemptedIds: ['pending'] } } });
    conforms(validators(tools).get('memdrive_remember').output, result);
    const unknown = await tools.execute('memdrive_read', { ids: ['one'] });
    assert.equal(unknown.ok, false); assert.equal(unknown.error.code, 'TOOL_EXECUTION_FAILED');
    for (const encoded of [JSON.stringify(result), JSON.stringify(unknown)])
        for (const text of ['private-token', 'stack', 'cause', 'credential']) assert.equal(encoded.includes(text), false);
});
