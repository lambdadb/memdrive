import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv from 'ajv';
import { MemDrive, createFileTools, getFileToolDefinitions } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

test('advertised tool schemas accept SDK inputs and reject ambiguous selectors, scope overrides and mode mismatches', async () => {
    const ajv = new Ajv({ strict: true, strictRequired: false, allowUnionTypes: true });
    for (const external of [false, true]) {
        const fixture = fileClient();
        const main = await MemDrive.create({ client: fixture.client, name: 'schema-fixture',
            ...(external ? { embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'fixture-v1' } } : {}) });
        const work = await main.fork({ name: 'draft' });
        const names = ['guide', 'status', 'history', 'list', 'read', 'search', 'fork', 'checkpoint', 'diff', 'write', 'merge', ...(external ? [] : ['findText'])];
        const { definitions } = createFileTools({ drive: work, tools: names });
        const validators = Object.fromEntries(definitions.map(tool => [tool.name, ajv.compile(tool.inputSchema)]));
        const content = external ? [1, ...Array(63).fill(0)] : 'Original';
        const valid = [
            ['guide', {}], ['guide', { topic: 'editing' }], ['status', {}], ['diff', {}], ['history', {}],
            ['fork', { name: 'new-fork' }], ['fork', { name: 'x'.repeat(47) }],
            ['checkpoint', { name: 'main' }], ['checkpoint', { name: 'x'.repeat(41) }],
            ['history', { sinceVersion: 'v0', limit: 1 }], ['history', { cursor: 'opaque' }],
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
            ['merge', { requestId: 'one', summary: 'Publish the plan.' }],
            ...(external ? [] : [
                ['read', { path: '/plan', startLine: 2, endLine: 4, maxChars: 200 }],
                ['read', { fileId: 'id', offset: 200, revision: 'a'.repeat(64), maxChars: 200 }],
                ...['semantic', 'keyword', 'hybrid'].flatMap(mode => [
                    ['search', { query: 'checkpoint', mode }],
                    ['search', { query: 'checkpoint', mode, rerank: true, embeddingQuery: 'preserve work' }],
                ]),
                ['search', { query: 'plan', embeddingQuery: 'travel plan', rerank: { fields: ['content'], onFailure: 'returnOriginal' } }],
                ['write', { op: 'update', fileId: 'returned-id', edits: [{ oldText: 'Original', newText: '' }] }],
                ['findText', { query: 'a.b', prefix: '/notes/', filter: { field: 'metadata.topic', op: 'eq', value: 'plan' } }],
                ['findText', { cursor: 'opaque' }],
            ]),
        ];
        for (const [name, input] of valid)
            assert(validators[name](input), `${external ? 'vector' : 'text'} ${name}: ${JSON.stringify(validators[name].errors)}`);
        const invalid = [
            ['guide', { topic: 'unknown' }], ['guide', { topic: null }], ['guide', { topic: 'editing', version: '6' }],
            ['fork', {}], ['fork', { name: 'main' }], ['fork', { name: 'xy' }],
            ['fork', { name: 'x'.repeat(48) }], ['checkpoint', { name: 'x'.repeat(42) }],
            ['checkpoint', { name: 'invalid/path' }], ['checkpoint', { name: 'valid', at: { fork: 'other' } }],
            ['status', { recover: true }], ['read', { path: '/one', fileId: 'id' }], ['read', {}],
            ['read', { paths: ['/one'], maxChars: 20 }], ['read', { path: '/one', offset: 0 }],
            ['read', { paths: [] }], ['read', { paths: ['/one', '/one'] }],
            ['history', { cursor: 'opaque', limit: 1 }], ['list', { cursor: 'opaque', prefix: '/' }],
            ['history', { sinceVersion: 'v01' }], ['history', { limit: 101 }], ['list', { delimiter: '-' }],
            ['search', { query: content, filter: { and: [] } }],
            ['search', { query: content, filter: { field: 'metadata.topic', op: 'exists', value: 'yes' } }],
            ['write', { op: 'update', fileId: 'id' }], ['write', { op: 'delete', fileId: 'id', content }],
            ['write', { operations: [] }], ['write', { operations: [{ op: 'create', path: '/one' }] }],
            ['write', { operations: [], op: 'delete', fileId: 'id' }],
            ['write', { op: 'create', path: '/one', content: external ? 'text' : [1] }],
            ['merge', { requestId: 'one' }],
            ...(external ? [
                ['read', { path: '/one', startLine: 1 }],
                ['search', { query: 'text' }], ['search', { query: content, rerank: false }],
                ['search', { query: content, mode: 'semantic' }],
                ['write', { op: 'update', fileId: 'id', edits: [{ oldText: 'a', newText: 'b' }] }],
            ] : [
                ['search', { query: 'plan', mode: 'auto' }],
                ['search', { query: 'plan', mode: 'keyword', embeddingQuery: 'unused' }],
                ['search', { query: 'plan', mode: 'keyword', rerank: false, embeddingQuery: 'unused' }],
                ['findText', { query: '' }], ['findText', { cursor: 'opaque', query: 'a' }],
                ['write', { op: 'update', fileId: 'id', content: '', edits: [{ oldText: 'a', newText: 'b' }] }],
            ]),
        ];
        for (const [name, input] of invalid) assert.equal(validators[name](input), false, `${name}: ${JSON.stringify(input)}`);
        for (const definition of definitions) {
            assert.equal(validators[definition.name]({ at: { fork: 'other' } }), false);
            assert.equal(validators[definition.name]({ drive: 'other' }), false);
        }
    }
});

test('ref schemas expose exact version selection only on main and reject asOf everywhere', async () => {
    const fixture = fileClient();
    const main = await MemDrive.create({ client: fixture.client, name: 'schema-checkpoint' });
    const work = await main.fork({ name: 'working' });
    const saved = await main.checkpoint({ name: 'saved' });
    const ajv = new Ajv({ strict: true });
    for (const embeddingMode of ['managed', 'external']) {
        for (const tool of getFileToolDefinitions({ embeddingMode, tools: ['fork', 'checkpoint'] })) {
            const validate = ajv.compile(tool.inputSchema);
            assert(validate({ name: 'copy', version: 'v3' }));
            assert.equal(validate({ name: 'copy', version: 'v01' }), false);
            assert.equal(validate({ name: 'copy', asOf: '2026-01-01T00:00:00.000Z' }), false);
        }
    }
    for (const drive of [main, work, saved]) {
        for (const tool of createFileTools({ drive, tools: ['fork', 'checkpoint'] }).definitions) {
            const validate = ajv.compile(tool.inputSchema);
            assert(validate({ name: 'copy' }));
            assert.equal(validate({ name: 'copy', version: 'v0' }), drive === main);
            assert.equal(validate({ name: 'copy', version: 'v3' }), drive === main);
            assert.equal(validate({ name: 'copy', version: 'v01' }), false);
            assert.equal(validate({ name: 'copy', asOf: '2026-01-01T00:00:00.000Z' }), false);
        }
    }
});


test('advertised input properties carry types and descriptions through nested operation and filter schemas', async () => {
    const fixture = fileClient();
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
    for (const external of [false, true]) {
        const main = await MemDrive.create({ client: fixture.client, name: `documented-${external}`,
            ...(external ? { embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'fixture' } } : {}) });
        const work = await main.fork({ name: 'draft' });
        const names = ['guide', 'status', 'history', 'list', 'read', 'search', 'fork', 'checkpoint', 'diff', 'write', 'merge', ...(external ? [] : ['findText'])];
        for (const definition of createFileTools({ drive: work, tools: names }).definitions) inspect(definition.inputSchema);
        for (const definition of createFileTools({ drive: main, tools: ['fork', 'checkpoint'] }).definitions) inspect(definition.inputSchema);
    }
});
