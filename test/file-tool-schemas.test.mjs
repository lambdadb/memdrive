import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv from 'ajv';
import { MemDrive, createFileTools } from '@functional-systems/memdrive';
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
            ['guide', {}], ['status', {}], ['diff', {}], ['history', {}],
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
                ['search', { query: 'plan', embeddingQuery: 'travel plan', rerank: { fields: ['content'], onFailure: 'returnOriginal' } }],
                ['write', { op: 'update', fileId: 'returned-id', edits: [{ oldText: 'Original', newText: '' }] }],
                ['findText', { query: 'a.b', prefix: '/notes/', filter: { field: 'metadata.topic', op: 'eq', value: 'plan' } }],
                ['findText', { cursor: 'opaque' }],
            ]),
        ];
        for (const [name, input] of valid)
            assert(validators[name](input), `${external ? 'vector' : 'text'} ${name}: ${JSON.stringify(validators[name].errors)}`);
        const invalid = [
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
                ['write', { op: 'update', fileId: 'id', edits: [{ oldText: 'a', newText: 'b' }] }],
            ] : [
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
