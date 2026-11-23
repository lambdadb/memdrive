import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv from 'ajv';
import { MemDrive, createFileTools, getFileToolDefinitions } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

const names = ['guide', 'status', 'history', 'list', 'read', 'search', 'findText', 'fork', 'checkpoint',
    'listForks', 'listCheckpoints', 'deleteFork', 'deleteCheckpoint', 'diff', 'write', 'merge'];
const main = { kind: 'main' };
const fork = { kind: 'fork', name: 'draft' };
const saved = { kind: 'checkpoint', name: 'saved' };

test('advertised tool schemas accept SDK inputs and reject ambiguous selectors, invalid targets and mode mismatches', () => {
    const ajv = new Ajv({ strict: true, strictRequired: false, allowUnionTypes: true });
    for (const external of [false, true]) {
        const definitions = getFileToolDefinitions({ embeddingMode: external ? 'external' : 'managed',
            tools: names.filter(name => !external || name !== 'findText') });
        const validators = Object.fromEntries(definitions.map(tool => [tool.name, ajv.compile(tool.inputSchema)]));
        const content = external ? [1, ...Array(63).fill(0)] : 'Original';
        const valid = [
            ['guide', {}], ['guide', { topic: 'editing' }], ['history', {}], ['listForks', {}], ['listCheckpoints', {}],
            ...[undefined, main, fork, saved].map(at => ['status', at === undefined ? {} : { at }]),
            ['diff', { at: fork }], ['deleteFork', { at: fork }], ['deleteCheckpoint', { at: saved }],
            ['fork', { name: 'new-fork' }], ['fork', { name: 'x'.repeat(47) }], ['fork', { at: saved, name: 'child' }],
            ['fork', { at: fork, name: 'child' }], ['fork', { name: 'past', version: 'v3' }], ['fork', { at: main, name: 'past', version: 'v0' }],
            ['checkpoint', { name: 'main' }], ['checkpoint', { name: 'x'.repeat(41) }], ['checkpoint', { at: fork, name: 'before-edit' }],
            ['history', { sinceVersion: 'v0', limit: 1 }], ['history', { cursor: 'opaque' }],
            ['list', { prefix: '/notes/', nameContains: 'plan', delimiter: '/', limit: 1000 }], ['list', { at: fork, prefix: '/' }],
            ['list', { cursor: 'opaque' }], ['list', { at: saved, cursor: 'opaque' }],
            ['read', { path: '/plan' }], ['read', { at: fork, fileId: 'returned-id' }], ['read', { at: saved, paths: ['/one', '/two'] }],
            ['search', { at: fork, query: content, limit: 10, filter: { and: [
                { field: 'metadata.topic', op: 'in', value: ['plan', 'travel'] },
                { or: [{ field: 'metadata.year', op: 'gte', value: 2026 }, { field: 'metadata.enabled', op: 'exists', value: true }] },
            ] } }],
            ['write', { at: fork, op: 'create', path: '/plan', content, metadata: { topic: 'plan' } }],
            ['write', { at: fork, op: 'update', fileId: 'returned-id', content }],
            ['write', { at: fork, op: 'update', fileId: 'returned-id', newPath: '/moved', metadata: {} }],
            ['write', { at: fork, op: 'delete', fileId: 'returned-id' }],
            ['write', { at: fork, operations: [{ op: 'create', path: '/plan', content }, { op: 'delete', fileId: 'returned-id' }] }],
            ['merge', { at: fork, requestId: 'one', summary: 'Publish the plan.' }],
            ...(external ? [] : [
                ['read', { path: '/plan', startLine: 2, endLine: 4, maxChars: 200 }],
                ['read', { at: fork, fileId: 'id', offset: 200, revision: 'a'.repeat(64), maxChars: 200 }],
                ...['semantic', 'keyword', 'hybrid'].flatMap(mode => [
                    ['search', { query: 'checkpoint', mode }],
                    ['search', { query: 'checkpoint', mode, rerank: true, embeddingQuery: 'preserve work' }],
                ]),
                ['search', { query: 'plan', embeddingQuery: 'travel plan', rerank: { fields: ['content'], onFailure: 'returnOriginal' } }],
                ['write', { at: fork, op: 'update', fileId: 'returned-id', edits: [{ oldText: 'Original', newText: '' }] }],
                ['findText', { at: saved, query: 'a.b', prefix: '/notes/', filter: { field: 'metadata.topic', op: 'eq', value: 'plan' } }],
                ['findText', { cursor: 'opaque' }], ['findText', { at: fork, cursor: 'opaque' }],
            ]),
        ];
        for (const [name, input] of valid)
            assert(validators[name](input), `${external ? 'vector' : 'text'} ${name}: ${JSON.stringify(validators[name].errors)}`);
        const invalid = [
            ['guide', { topic: 'unknown' }], ['guide', { topic: null }], ['guide', { topic: 'editing', version: '6' }],
            ['fork', {}], ['fork', { name: 'main' }], ['fork', { name: 'xy' }],
            ['fork', { name: 'x'.repeat(48) }], ['checkpoint', { name: 'x'.repeat(42) }],
            ['checkpoint', { name: 'invalid/path' }], ['checkpoint', { name: 'valid', at: { fork: 'other' } }],
            ['fork', { at: fork, name: 'child', version: 'v1' }], ['checkpoint', { at: saved, name: 'child', version: 'v1' }],
            ['fork', { name: 'copy', version: 'v01' }], ['fork', { name: 'copy', asOf: '2026-01-01T00:00:00.000Z' }],
            ['status', { recover: true }], ['status', { at: { kind: 'main', name: 'main' } }], ['status', { at: { kind: 'fork' } }],
            ['status', { at: { kind: 'fork', name: 'main' } }], ['status', { at: { kind: 'branch', name: 'draft' } }],
            ['status', { at: { kind: 'checkpoint', name: 'x'.repeat(42) } }], ['status', { at: fork, extra: true }],
            ['listForks', { at: fork }], ['listCheckpoints', { prefix: '/' }],
            ['deleteFork', {}], ['deleteFork', { at: saved }], ['deleteFork', { at: main }], ['deleteFork', { at: fork, name: 'draft' }],
            ['deleteCheckpoint', { at: fork }], ['deleteCheckpoint', { name: 'saved' }],
            ['diff', {}], ['diff', { at: main }], ['diff', { at: saved }],
            ['read', { path: '/one', fileId: 'id' }], ['read', {}], ['read', { at: fork }],
            ['read', { paths: ['/one'], maxChars: 20 }], ['read', { path: '/one', offset: 0 }],
            ['read', { paths: [] }], ['read', { paths: ['/one', '/one'] }],
            ['history', { cursor: 'opaque', limit: 1 }], ['history', { at: main, cursor: 'opaque' }], ['history', { at: main }],
            ['list', { cursor: 'opaque', prefix: '/' }],
            ['history', { sinceVersion: 'v01' }], ['history', { limit: 101 }], ['list', { delimiter: '-' }],
            ['search', { query: content, filter: { and: [] } }],
            ['search', { query: content, filter: { field: 'metadata.topic', op: 'exists', value: 'yes' } }],
            ['write', { op: 'create', path: '/plan', content }], ['write', { at: main, op: 'create', path: '/plan', content }],
            ['write', { at: saved, op: 'delete', fileId: 'id' }],
            ['write', { at: fork, op: 'update', fileId: 'id' }], ['write', { at: fork, op: 'delete', fileId: 'id', content }],
            ['write', { at: fork, operations: [] }], ['write', { at: fork, operations: [{ op: 'create', path: '/one' }] }],
            ['write', { at: fork, operations: [], op: 'delete', fileId: 'id' }],
            ['write', { at: fork, operations: [{ at: fork, op: 'delete', fileId: 'id' }] }],
            ['write', { at: fork, op: 'create', path: '/one', content: external ? 'text' : [1] }],
            ['merge', { at: fork, requestId: 'one' }], ['merge', { requestId: 'one', summary: 'Publish.' }],
            ['merge', { at: main, requestId: 'one', summary: 'Publish.' }],
            ...(external ? [
                ['read', { path: '/one', startLine: 1 }],
                ['search', { query: 'text' }], ['search', { query: content, rerank: false }],
                ['search', { query: content, mode: 'semantic' }],
                ['write', { at: fork, op: 'update', fileId: 'id', edits: [{ oldText: 'a', newText: 'b' }] }],
            ] : [
                ['search', { query: 'plan', mode: 'auto' }],
                ['search', { query: 'plan', mode: 'keyword', embeddingQuery: 'unused' }],
                ['search', { query: 'plan', mode: 'keyword', rerank: false, embeddingQuery: 'unused' }],
                ['findText', { query: '' }], ['findText', { cursor: 'opaque', query: 'a' }],
                ['write', { at: fork, op: 'update', fileId: 'id', content: '', edits: [{ oldText: 'a', newText: 'b' }] }],
            ]),
        ];
        for (const [name, input] of invalid) assert.equal(validators[name](input), false, `${name}: ${JSON.stringify(input)}`);
        for (const definition of definitions) {
            assert.equal(validators[definition.name]({ at: { fork: 'other' } }), false);
            assert.equal(validators[definition.name]({ drive: 'other' }), false);
        }
    }
});

test('every catalog schema compiles under strict Ajv and shares one view identity definition', () => {
    const ajv = new Ajv({ strict: true, strictRequired: false, allowUnionTypes: true });
    for (const embeddingMode of ['managed', 'external']) {
        const definitions = getFileToolDefinitions({ embeddingMode, tools: names.filter(name => embeddingMode === 'managed' || name !== 'findText') });
        let shared;
        for (const { name, inputSchema } of definitions) {
            ajv.compile(inputSchema);
            if (!inputSchema.$defs?.at) continue;
            shared ??= inputSchema.$defs;
            for (const key of ['at', 'mainAt', 'forkAt', 'checkpointAt'])
                assert.deepEqual(inputSchema.$defs[key], shared[key], `${name} ${key}`);
        }
        assert(shared);
    }
});

test('static and drive-bound definitions are identical for every view-independent selection', async () => {
    for (const external of [false, true]) {
        const fixture = fileClient();
        const drive = await MemDrive.create({ client: fixture.client, name: 'schema-fixture',
            ...(external ? { embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'fixture-v1' } } : {}) });
        const embeddingMode = external ? 'external' : 'managed';
        const tools = names.filter(name => !external || name !== 'findText');
        for (const selection of [tools, ['write', 'read'], ['fork', 'checkpoint'], []])
            assert.deepEqual(createFileTools({ drive, tools: selection }).definitions, getFileToolDefinitions({ embeddingMode, tools: selection }));
    }
});

test('advertised input properties carry types and descriptions through nested operation and filter schemas', () => {
    function inspect(schema) {
        for (const [name, property] of Object.entries(schema.properties ?? {})) {
            assert(property.type, `Missing type for ${name}`);
            assert.equal(typeof property.description, 'string', `Missing description for ${name}`);
            assert(property.description.length > 0);
            inspect(property);
        }
        for (const branch of [...(schema.oneOf ?? []), ...(schema.anyOf ?? [])]) inspect(branch);
        for (const definition of Object.values(schema.$defs ?? {})) inspect(definition);
        if (schema.items) inspect(schema.items);
    }
    for (const embeddingMode of ['managed', 'external'])
        for (const definition of getFileToolDefinitions({ embeddingMode, tools: names.filter(name => embeddingMode === 'managed' || name !== 'findText') }))
            inspect(definition.inputSchema);
});
