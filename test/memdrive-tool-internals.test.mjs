import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { create } from '../dist/esm/index.js';
import { createMemoryTools as createTools } from '../dist/esm/tools/factory.js';
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
const validators = tools => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    return new Map(JSON.parse(JSON.stringify(tools.definitions)).map(definition => [definition.name, {
        input: ajv.compile(definition.inputSchema), output: ajv.compile(definition.outputSchema),
    }]));
};
const conforms = (validate, value) => assert(validate(value), JSON.stringify(validate.errors));

test('short IDs are stable, session-local, detached and restricted to memory-ID fields', async () => {
    const { f, drive } = await setup();
    await drive.remember({ mems: [{ id: 'long-original', content: 'm1 is literal text', metadata: { role: 'm1', tags: ['long-original'] } },
        { id: 'm1', content: 'An actual ID can resemble an alias.' }] });
    const tools = await createTools({ drive, shortIds: true });
    const recalled = await tools.execute('memdrive_recall', { requests: [{ query: 'm1' }] });
    const matches = recalled.value.results[0].matches;
    assert.deepEqual(matches.map(item => item.memId), ['m1', 'm2']);
    assert.equal(matches[0].content, 'm1 is literal text'); assert.equal(matches[0].metadata.role, 'm1');
    assert.equal(tools.resolveId('m1'), 'long-original'); assert.equal(tools.resolveId('m2'), 'm1');
    conforms(validators(tools).get('memdrive_recall').output, recalled);
    const args = { ids: ['m2', 'm1'] };
    const read = await tools.execute('memdrive_read', args);
    assert.deepEqual(args, { ids: ['m2', 'm1'] });
    assert.deepEqual(read.value.mems.map(mem => mem.id), ['m2', 'm1']);
    read.value.mems[1].metadata.tags.push('modified');
    assert.deepEqual((await drive.read({ ids: ['long-original'] })).mems[0].metadata.tags, ['long-original']);
    const listed = await tools.execute('memdrive_list', { limit: 1 });
    assert.equal(listed.value.mems[0].id, 'm1');
    const next = await tools.execute('memdrive_list', { limit: 1, cursor: listed.value.nextCursor });
    assert.equal(next.value.mems[0].id, 'm2');
    assert.equal((await tools.execute('memdrive_read', { ids: ['long-original'] })).error.code, 'INVALID_INPUT');
    const other = await createTools({ drive, shortIds: true });
    assert.throws(() => other.resolveId('m1'), error => error.code === 'INVALID_INPUT');
    const ordinary = await createTools({ drive });
    assert.equal(ordinary.resolveId('long-original'), 'long-original');
    assert.equal((await ordinary.execute('memdrive_read', { ids: ['long-original'] })).value.mems[0].id, 'long-original');
    const before = f.calls.length;
    await assert.rejects(createTools({ drive, shortIds: true, writable: true }), error => error.code === 'INVALID_INPUT');
    assert.equal(f.calls.length, before);
});

test('short IDs translate nested filters, exclusions and only ID facet values', async () => {
    const { f, drive } = await setup();
    await drive.remember({ mems: [{ id: 'first-original', content: 'one' }, { id: 'second-original', content: 'two' }] });
    const tools = await createTools({ drive, shortIds: true });
    await tools.execute('memdrive_recall', { requests: [{ query: 'initial' }] });
    const filter = { and: [{ field: 'id', op: 'eq', value: 'm1' }, { or: [
        { field: 'id', op: 'neq', value: 'm2' }, { field: 'id', op: 'in', value: ['m1', 'm2'] },
        { field: 'id', op: 'exists', value: true }, { field: 'metadata.role', op: 'eq', value: 'm1' }] }] };
    const args = { requests: [{ query: 'm1', excludeIds: ['m2'], filter }] };
    const original = structuredClone(args);
    assert.equal((await tools.execute('memdrive_recall', args)).ok, true);
    assert.deepEqual(args, original);
    const native = f.calls.filter(call => call.kind === 'query').at(-1).request;
    const leaves = []; const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (node.queryString) leaves.push(node.queryString);
        for (const child of Object.values(node)) visit(child);
    };
    visit(native.query);
    assert(leaves.some(leaf => leaf.defaultField === 'memId' && leaf.query === '"first-original"'));
    assert(leaves.some(leaf => leaf.defaultField === 'memId' && leaf.query === '"second-original"'));
    assert(leaves.some(leaf => leaf.defaultField === 'metadata.role' && leaf.query === '"m1"'));
    f.search = () => ({ docs: [], facets: { memId: { buckets: [{ value: 'second-original', count: 2 }] },
        'metadata.role': { buckets: [{ value: 'm2', count: 1 }] } } });
    const counted = await tools.execute('memdrive_count_values', { fields: ['id', 'metadata.role'], excludeIds: ['m1'], filter });
    assert.equal(counted.ok, true, JSON.stringify(counted));
    assert.equal(counted.value.values.id.buckets[0].value, 'm2');
    assert.equal(counted.value.values['metadata.role'].buckets[0].value, 'm2');
    conforms(validators(tools).get('memdrive_count_values').output, counted);
    const before = f.calls.length;
    for (const [name, input] of [['memdrive_read', { ids: ['m99'] }], ['memdrive_count_values', { fields: ['id'], filter: { field: 'id', op: 'eq', value: 'm99' } }]])
        assert.equal((await tools.execute(name, input)).error.code, 'INVALID_INPUT');
    assert.equal(f.calls.length, before);
    const cycle = { and: [] }; cycle.and.push(cycle);
    const invalid = await tools.execute('memdrive_recall', { requests: [{ query: 'q', filter: cycle }] });
    assert.equal(invalid.value.results[0].error.code, 'INVALID_INPUT');
    assert.equal(f.calls.length, before);
});

test('unknown short IDs preserve recall slots, diagnostics indices and cancellation precedence', async () => {
    const recorded = [], observed = [];
    const { f, drive } = await setup({ record: event => recorded.push(event), observe: event => observed.push(event) });
    await drive.remember({ mems: [{ id: 'original', content: 'evidence' }] });
    const tools = await createTools({ drive, shortIds: true });
    const result = await tools.execute('memdrive_recall', { requests: [{ query: 'first' },
        { query: 'invalid', excludeIds: ['m99'] }, { query: 'last' }] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.results.map(item => item.error?.code ?? item.matches[0].memId), ['m1', 'INVALID_INPUT', 'm1']);
    assert.deepEqual(result.value.results.map(item => item.usage.databaseRequests), [1, 0, 1]);
    assert.deepEqual(recorded.filter(event => event.phase === 'query').map(event => event.requestIndex), [0, 2]);
    assert.deepEqual(observed.map(event => event.requestIndex).sort(), [0, 2]);
    assert.equal(f.calls.filter(call => call.kind === 'query').length, 2);
    const shared = { query: 'q', filter: { field: 'id', op: 'eq', value: 'm1' } };
    const repeated = await tools.execute('memdrive_recall', { requests: [shared, shared] });
    assert(repeated.value.results.every(item => !item.error));
    const controller = new AbortController(); controller.abort();
    const aborted = await tools.execute('memdrive_recall', { requests: [{ query: 'q', excludeIds: ['m99'] }] }, { signal: controller.signal });
    assert.equal(aborted.error.code, 'ABORTED');
    assert.equal(f.calls.filter(call => call.kind === 'query').length, 4);
});

test('evidence IDs identify exact canonical spans across recall/read/list without changing memory inputs', async () => {
    const { drive } = await setup();
    const original = { id: 'canonical', content: 'abcdef', metadata: { role: 'user', tags: ['x'] } };
    await drive.remember({ mems: [original] });
    const tools = await createTools({ drive, shortIds: true, evidenceIds: true });
    const recalled = await tools.execute('memdrive_recall', { requests: [{ query: 'first' }, { query: 'second' }] });
    assert.deepEqual(recalled.value.results.map(result => result.matches[0].evidenceId), ['e1', 'e1']);
    assert.equal(recalled.value.results[0].matches[0].memId, 'm1');
    const reference = tools.resolveEvidence('e1'); assert.deepEqual(reference, { memId: 'canonical', start: 0, end: 6 });
    reference.start = 4; assert.equal(tools.resolveEvidence('e1').start, 0);
    for (const [name, args] of [['memdrive_read', { ids: ['m1'] }], ['memdrive_list', {}]]) {
        const result = await tools.execute(name, args);
        conforms(validators(tools).get(name).output, result);
        assert.equal(result.value.mems[0].evidenceId, 'e1'); assert.equal(result.value.mems[0].content, original.content);
    }
    assert.equal((await tools.execute('memdrive_read', { ids: ['e1'] })).error.code, 'INVALID_INPUT');
    assert.throws(() => tools.resolveEvidence('e99'), error => error.code === 'INVALID_INPUT');
    const other = await createTools({ drive, evidenceIds: true });
    assert.throws(() => other.resolveEvidence('e1'), error => error.code === 'INVALID_INPUT');
    const listed = await other.execute('memdrive_list', {});
    assert.equal(listed.value.mems[0].id, 'canonical'); assert.equal(listed.value.mems[0].evidenceId, 'e1');
    const ordinary = await createTools({ drive });
    assert.throws(() => ordinary.resolveEvidence('e1'), error => error.code === 'INVALID_INPUT');
    assert.equal((await ordinary.execute('memdrive_list', {})).value.mems[0].evidenceId, undefined);
    await assert.rejects(createTools({ drive, evidenceIds: true, writable: true }), error => error.code === 'INVALID_INPUT');
    await drive.remember({ mems: [{ ...original, content: 'ABCDEF' }] });
    assert.equal((await tools.execute('memdrive_read', { ids: ['m1'] })).error.code, 'INVALID_RESULT');
    assert.deepEqual(tools.resolveEvidence('e1'), { memId: 'canonical', start: 0, end: 6 });
});

test('evidence conflicts fail per recall item, preserve siblings and never allocate failed references', async () => {
    const { drive } = await setup();
    const usage = { elapsedMs: 1, databaseRequests: 1 };
    const span = { kind: 'chunk', memId: 'source', start: 0, end: 3, content: 'abc', metadata: { role: 'user', tags: ['x'] } };
    let results = [{ matches: [span], usage }];
    const handle = { ...drive, recall: async () => ({ results }) };
    const tools = await createTools({ drive: handle, evidenceIds: true });
    assert.equal((await tools.execute('memdrive_recall', { requests: [{ query: 'q' }] })).value.results[0].matches[0].evidenceId, 'e1');
    results = [{ matches: [{ ...span, metadata: { tags: ['x'], role: 'user' } }], usage },
        { matches: [{ ...span, start: 3, end: 6, content: 'def' }, { ...span, content: 'xyz' }], usage },
        { matches: [{ ...span, start: 3, end: 6, content: 'def' }], usage }];
    const output = await tools.execute('memdrive_recall', { requests: [{ query: 'one' }, { query: 'two' }, { query: 'three' }] });
    assert.deepEqual(output.value.results.map(item => item.error?.code ?? item.matches[0].evidenceId), ['e1', 'INVALID_RESULT', 'e2']);
    assert.deepEqual(output.value.results.map(item => item.usage), [usage, usage, usage]);
    assert.deepEqual(tools.resolveEvidence('e2'), { memId: 'source', start: 3, end: 6 });
    assert.equal(results[0].matches[0].evidenceId, undefined, 'Underlying results remain detached');
    conforms(validators(tools).get('memdrive_recall').output, output);
    for (const changed of [{ ...span, timestamp: '2025-01-01T00:00:00Z' }, { ...span, metadata: { role: 'assistant' } }]) {
        results = [{ matches: [changed], usage }];
        assert.equal((await tools.execute('memdrive_recall', { requests: [{ query: 'q' }] })).value.results[0].error.code, 'INVALID_RESULT');
    }
});

test('external-vector evidence references never invent source offsets or text', async () => {
    const { drive } = await setup({ embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'fixture-v1' } });
    const embedding = [1, ...Array(63).fill(0)];
    await drive.remember({ mems: [{ id: 'vector', embedding, metadata: { role: 'user' } }] });
    const tools = await createTools({ drive, evidenceIds: true });
    const recalled = await tools.execute('memdrive_recall', { requests: [{ queryVector: embedding }] });
    assert.deepEqual(recalled.value.results[0].matches[0], { kind: 'mem', memId: 'vector', metadata: { role: 'user' }, evidenceId: 'e1' });
    assert.deepEqual(tools.resolveEvidence('e1'), { memId: 'vector' });
    const read = await tools.execute('memdrive_read', { ids: ['vector'] });
    assert.deepEqual(read.value.mems[0], { id: 'vector', metadata: { role: 'user' }, evidenceId: 'e1' });
    conforms(validators(tools).get('memdrive_recall').output, recalled);
    conforms(validators(tools).get('memdrive_read').output, read);
});
