import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFilter, buildFilter, matchesFilter, validateFilter, dateValue } from '../dist/esm/filter.js';

const schema = { tags: { type: 'string[]' }, role: { type: 'string' }, score: { type: 'number' }, active: { type: 'boolean' } };
const leaf = (field, op, value) => ({ field, op, value });

test('literal matching escapes query syntax including the native match-all special case', () => {
    assert.deepEqual(compileFilter(leaf('metadata.role', 'eq', '*:*'), schema),
        { queryString: { query: '"*:*"', defaultField: 'metadata.role' } });
    assert.deepEqual(compileFilter(leaf('metadata.role', 'eq', 'x" OR *:* \\ y'), schema),
        { queryString: { query: '"x\\" OR *:* \\\\ y"', defaultField: 'metadata.role' } });
    const native = buildFilter([leaf('metadata.role', 'eq', 'user')], ['*:*'], schema);
    assert.deepEqual(native.bool.at(-1), { queryString: { query: '"*:*"', defaultField: 'memId' }, occur: 'must_not' });
});

test('array membership distinguishes any, all, no matching values and missing values', () => {
    const mem = { id: 'one', content: 'Test', metadata: { tags: ['tennis', 'health', 'tennis'] } };
    assert(matchesFilter(mem, leaf('metadata.tags', 'in', ['travel', 'health']), schema));
    assert(matchesFilter(mem, { and: [leaf('metadata.tags', 'eq', 'tennis'), leaf('metadata.tags', 'eq', 'health')] }, schema));
    assert(!matchesFilter(mem, leaf('metadata.tags', 'neq', 'tennis'), schema));
    assert(matchesFilter(mem, leaf('metadata.tags', 'neq', 'travel'), schema));
    for (const metadata of [{}, { tags: [] }]) {
        assert(!matchesFilter({ metadata }, leaf('metadata.tags', 'neq', 'tennis'), schema));
        assert(matchesFilter({ metadata }, leaf('metadata.tags', 'exists', false), schema));
    }
    const native = compileFilter(leaf('metadata.tags', 'neq', 'tennis'), schema);
    assert.equal(native.bool[0].queryString.query, '[* TO *]');
    assert.equal(native.bool[0].occur, 'filter');
    assert.equal(native.bool[1].occur, 'must_not');
    assert.equal(native.bool[1].queryString.query, '"tennis"');
});

test('explicit ranges preserve endpoints, repeated fields and timestamp precision', () => {
    const range = { and: [leaf('metadata.score', 'gte', 3), leaf('metadata.score', 'lt', 5)] };
    assert(matchesFilter({ metadata: { score: 3 } }, range, schema));
    assert(!matchesFilter({ metadata: { score: 5 } }, range, schema));
    assert.deepEqual(compileFilter(range, schema).bool.map(x => x.queryString.query), ['[3 TO *]', '{* TO 5}']);
    const date = '2026-01-01T00:00:00.001000000Z';
    assert(matchesFilter({ timestamp: date }, leaf('timestamp', 'eq', '2026-01-01T01:00:00.001+01:00'), schema));
    assert(!matchesFilter({ timestamp: date }, leaf('timestamp', 'eq', '2026-01-01T00:00:00Z'), schema));
    assert.equal(dateValue('2025-02-29T00:00:00Z'), undefined);
    assert.equal(dateValue('2024-02-29T00:00:60Z'), undefined);
    assert.equal(dateValue('2026-01-01T00:00:00.000000001Z'), undefined);
    assert(matchesFilter({}, undefined, schema));
});

test('numeric filters expand exponent notation for the native DecimalFormat parser', () => {
    for (const [number, text] of [[1e-7, '0.0000001'], [-1.25e-7, '-0.000000125'],
        [1e21, '1000000000000000000000'], [-1.5e21, '-1500000000000000000000']]) {
        assert.equal(compileFilter(leaf('metadata.score', 'eq', number), schema).queryString.query, `[${text} TO ${text}]`);
        assert.equal(compileFilter(leaf('metadata.score', 'gt', number), schema).queryString.query, `{${text} TO *}`);
    }
    // Empty keyword values are indexed; an open range tests presence without
    // the native parser's forbidden leading wildcard.
    assert.equal(compileFilter(leaf('metadata.role', 'exists', true), schema).queryString.query, '[* TO *]');
    assert.equal(compileFilter(leaf('metadata.role', 'eq', ''), schema).queryString.query, '""');
    assert(matchesFilter({ metadata: { role: '' } }, leaf('metadata.role', 'exists', true), schema));
});

test('invalid filters cannot silently broaden the request', () => {
    const cyclic = { and: [] }; cyclic.and.push(cyclic);
    for (const filter of [{}, { and: [] }, { role: 'user' }, leaf('metadata.absent', 'eq', 'x'),
        leaf('metadata.role', 'ne', 'x'), leaf('metadata.tags', 'eq', ['x']), leaf('metadata.tags', 'gt', 'x'),
        leaf('metadata.score', 'in', [1, '2']), leaf('metadata.role', 'in', []),
        leaf('timestamp', 'eq', '2026-02-30T00:00:00Z'), cyclic]) {
        assert.throws(() => validateFilter(filter, schema), { code: 'INVALID_INPUT' });
    }
    assert.deepEqual(compileFilter(leaf('metadata.active', 'exists', true), schema), { bool: [
        { queryString: { query: 'true', defaultField: 'metadata.active' }, occur: 'should' },
        { queryString: { query: 'false', defaultField: 'metadata.active' }, occur: 'should' },
    ] });
});

test('public Mem IDs and physical seen chunk IDs occupy separate filter fields', async () => {
    const { buildSearchFilter } = await import('../dist/esm/filter.js');
    assert.deepEqual(compileFilter(leaf('id', 'eq', 'mem-one'), schema),
        { queryString: { query: '"mem-one"', defaultField: 'memId' } });
    const filter = buildSearchFilter([], ['mem-one'], ['chunk:one:0'], schema);
    assert.equal(JSON.stringify(filter).includes('"defaultField":"kind"'), false);
    assert.deepEqual(filter.bool[1], { queryString: { query: '"chunk:one:0"', defaultField: 'id' }, occur: 'must_not' });
    assert.equal(filter.bool[0].bool.at(-1).queryString.defaultField, 'memId');
});
