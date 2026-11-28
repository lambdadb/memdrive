import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv from 'ajv';
import { MemDrive, createFileTools, getFileToolDefinitions } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

const names = ['guide', 'read', 'tree', 'list', 'search', 'findText', 'write'];
const fork = { kind: 'fork', name: 'draft' };

test('advertised tool schemas accept main-only SDK inputs and reject view selectors, checkpoints and mode mismatches', () => {
    const ajv = new Ajv({ strict: true, strictRequired: false, allowUnionTypes: true });
    for (const external of [false, true]) {
        const definitions = getFileToolDefinitions({ embeddingMode: external ? 'external' : 'managed',
            tools: names.filter(name => !external || name !== 'findText') });
        const validators = Object.fromEntries(definitions.map(tool => [tool.name, ajv.compile(tool.inputSchema)]));
        const content = external ? [1, ...Array(63).fill(0)] : 'Original';
        const valid = [
            ['guide', {}], ['guide', { topic: 'editing' }], ['guide', { topic: 'retrieval' }], ['tree', {}], ['tree', { prefix: '/projects/' }], ['list', {}],
            ['list', { prefix: '/notes/', nameContains: 'plan', delimiter: '/', limit: 1000 }], ['list', { cursor: 'opaque' }],
            ['read', { path: '/plan' }], ['read', { fileId: 'returned-id' }], ['read', { paths: ['/one', '/two'] }],
            ['search', { query: content, limit: 10, filter: { and: [
                { field: 'metadata.topic', op: 'in', value: ['plan', 'travel'] },
                { or: [{ field: 'metadata.year', op: 'gte', value: 2026 }, { field: 'metadata.enabled', op: 'exists', value: true }] },
            ] } }],
            ['write', { op: 'create', path: '/plan', content, metadata: { topic: 'plan' } }],
            ['write', { op: 'update', fileId: 'returned-id', content }],
            ['write', { op: 'update', fileId: 'returned-id', newPath: '/moved', metadata: {} }],
            ['write', { op: 'delete', fileId: 'returned-id' }],
            ['write', { operations: [{ op: 'create', path: '/plan', content }, { op: 'delete', fileId: 'returned-id' }] }],
            ...(external ? [] : [
                ['read', { path: '/plan', startLine: 2, endLine: 4, maxChars: 200 }],
                ['read', { fileId: 'id', offset: 200, revision: 'a'.repeat(64), maxChars: 200 }],
                ...['semantic', 'keyword', 'hybrid'].flatMap(mode => [
                    ['search', { query: 'handoff', mode }],
                    ['search', { query: 'handoff', mode, rerank: true, embeddingQuery: 'preserve work' }],
                ]),
                ['search', { query: 'plan', embeddingQuery: 'travel plan', rerank: { fields: ['content'], onFailure: 'returnOriginal' } }],
                ['write', { op: 'update', fileId: 'returned-id', edits: [{ oldText: 'Original', newText: '' }] }],
                ['write', { op: 'append', path: '/log', content: 'Entry.' }], ['write', { op: 'append', fileId: 'returned-id', content: 'Entry.' }],
                ['write', { operations: [{ op: 'append', path: '/log', content: 'Entry.' }, { op: 'create', path: '/plan', content }] }],
                ['findText', { query: 'a.b', prefix: '/notes/', filter: { field: 'metadata.topic', op: 'eq', value: 'plan' } }],
                ['findText', { cursor: 'opaque' }],
            ]),
        ];
        for (const [name, input] of valid)
            assert(validators[name](input), `${external ? 'vector' : 'text'} ${name}: ${JSON.stringify(validators[name].errors)}`);
        const invalid = [
            ['guide', { topic: 'unknown' }], ['guide', { topic: 'references' }], ['guide', { topic: null }], ['guide', { topic: 'editing', version: '6' }],
            ['tree', { at: { kind: 'main' } }], ['tree', { prefix: '/', limit: 10 }], ['tree', { cursor: 'opaque' }], ['tree', { prefix: 1 }],
            ['list', { recover: true }], ['list', { at: { kind: 'main' } }], ['list', { at: fork }], ['list', { at: fork, cursor: 'opaque' }],
            ['read', { path: '/one', fileId: 'id' }], ['read', {}], ['read', { at: fork, path: '/one' }], ['read', { at: { kind: 'main' }, path: '/one' }],
            ['read', { paths: ['/one'], maxChars: 20 }], ['read', { path: '/one', offset: 0 }],
            ['read', { paths: [] }], ['read', { paths: ['/one', '/one'] }],
            ['list', { cursor: 'opaque', prefix: '/' }], ['list', { cursor: 'opaque', limit: 1 }], ['list', { delimiter: '-' }],
            ['search', { query: content, at: fork }],
            ['search', { query: content, filter: { and: [] } }],
            ['search', { query: content, filter: { field: 'metadata.topic', op: 'exists', value: 'yes' } }],
            ['write', { at: fork, op: 'delete', fileId: 'id' }], ['write', { at: { kind: 'main' }, operations: [{ op: 'delete', fileId: 'id' }] }],
            ['write', { op: 'delete', fileId: 'id', checkpoint: { name: 'turn-1' } }],
            ['write', { operations: [{ op: 'delete', fileId: 'id' }], checkpoint: { name: 'turn-1' } }],
            ['write', { op: 'update', fileId: 'id' }], ['write', { op: 'delete', fileId: 'id', content }],
            ['write', { operations: [] }], ['write', { operations: [{ op: 'create', path: '/one' }] }],
            ['write', { operations: [], op: 'delete', fileId: 'id' }],
            ['write', { operations: [{ at: fork, op: 'delete', fileId: 'id' }] }],
            ['write', { op: 'create', path: '/one', content: external ? 'text' : [1] }],
            ...(external ? [
                ['write', { op: 'append', path: '/log', content }], ['write', { operations: [{ op: 'append', fileId: 'id', content }] }],
                ['read', { path: '/one', startLine: 1 }],
                ['search', { query: 'text' }], ['search', { query: content, rerank: false }],
                ['search', { query: content, mode: 'semantic' }],
                ['write', { op: 'update', fileId: 'id', edits: [{ oldText: 'a', newText: 'b' }] }],
            ] : [
                ['search', { query: 'plan', mode: 'auto' }],
                ['search', { query: 'plan', mode: 'keyword', embeddingQuery: 'unused' }],
                ['search', { query: 'plan', mode: 'keyword', rerank: false, embeddingQuery: 'unused' }],
                ['findText', { query: '' }], ['findText', { cursor: 'opaque', query: 'a' }], ['findText', { query: 'a', at: fork }],
                ['write', { op: 'update', fileId: 'id', content: '', edits: [{ oldText: 'a', newText: 'b' }] }],
                ['write', { op: 'append', content: 'Entry.' }], ['write', { op: 'append', path: '/log', fileId: 'id', content: 'Entry.' }],
                ['write', { op: 'append', path: '/log', content: '' }], ['write', { op: 'append', path: '/log' }],
                ['write', { op: 'append', fileId: 'id', content: 'Entry.', newPath: '/moved' }],
                ['write', { operations: [{ op: 'append', path: '/log', content: 'Entry.', metadata: {} }] }],
            ]),
        ];
        for (const [name, input] of invalid) assert.equal(validators[name](input), false, `${name}: ${JSON.stringify(input)}`);
        for (const definition of definitions) {
            assert.equal(validators[definition.name]({ drive: 'other' }), false);
            assert(!JSON.stringify(definition.inputSchema).includes('"at"'), `${definition.name} has no view selector`);
            assert(!JSON.stringify(definition.inputSchema).includes('checkpoint'), `${definition.name} has no checkpoint option`);
        }
    }
});

test('every catalog schema compiles under strict Ajv', () => {
    const ajv = new Ajv({ strict: true, strictRequired: false, allowUnionTypes: true });
    for (const embeddingMode of ['managed', 'external'])
        for (const { inputSchema } of getFileToolDefinitions({ embeddingMode, tools: names.filter(name => embeddingMode === 'managed' || name !== 'findText') }))
            ajv.compile(inputSchema);
});

test('static and drive-bound definitions are identical for every selection', async () => {
    for (const external of [false, true]) {
        const fixture = fileClient();
        const drive = await MemDrive.create({ client: fixture.client, name: 'schema-fixture',
            ...(external ? { embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'fixture-v1' } } : {}) });
        const embeddingMode = external ? 'external' : 'managed';
        const tools = names.filter(name => !external || name !== 'findText');
        for (const selection of [tools, ['write', 'read'], ['guide'], []])
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
