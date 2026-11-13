import type { Filter, FilterScalar, Metadata, MetadataSchema, MetadataType } from './types.js';

import { requireInput } from './errors.js';

export const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
    && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value: object, key: PropertyKey) => Object.hasOwn(value, key);
const kinds = new Set(['string', 'number', 'boolean', 'datetime', 'string[]']);
export const matchAll = () => ({ queryString: { query: '*:*' } });

// LambdaDB datetime indexes store epoch milliseconds. Reject finer precision
// instead of silently changing equality/range semantics; trailing zeroes are exact.
export function dateValue(value: unknown) {
    if (typeof value !== 'string') return undefined;
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!m) return undefined;
    const year = m[1]!, month = m[2]!, day = m[3]!, hour = m[4]!, minute = m[5]!, second = m[6]!, fraction = m[7] ?? '', zone = m[8]!;
    if (/[1-9]/.test(fraction.slice(3))) return undefined;
    const y = Number(year), mo = Number(month), d = Number(day);
    const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (mo < 1 || mo > 12 || d < 1 || d > days[mo - 1]! || Number(hour) > 23
        || Number(minute) > 59 || Number(second) > 59
        || (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) return undefined;
    const millis = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${zone}`);
    return Number.isFinite(millis) ? BigInt(millis) + BigInt(fraction.padEnd(3, '0').slice(0, 3)) : undefined;
}

export function validateDescription(description: unknown): string | undefined {
    requireInput(description === undefined || (typeof description === 'string' && description.length <= 255),
        'Description must be text of at most 255 characters; use an empty string to clear it.');
    return description;
}

export function validateMetadataSchema(schema: unknown): MetadataSchema {
    requireInput(isObject(schema), 'metadataSchema must be an object.');
    for (const [name, declaration] of Object.entries(schema)) {
        requireInput(/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
            && !['id', '__proto__', 'prototype', 'constructor'].includes(name), 'Metadata field names must be unambiguous identifiers and cannot be reserved.');
        requireInput(isObject(declaration) && Object.keys(declaration).every(key => ['type', 'description'].includes(key))
            && own(declaration, 'type') && typeof declaration.type === 'string' && kinds.has(declaration.type), 'Declare each metadata field with a supported type and optional description.');
        validateDescription(declaration.description);
    }
    return structuredClone(schema) as MetadataSchema;
}

export function fieldType(field: unknown, schema: MetadataSchema): MetadataType | undefined {
    if (field === 'id') return 'string';
    if (field === 'timestamp') return 'datetime';
    if (typeof field === 'string' && field.startsWith('metadata.')) {
        const name = field.slice(9);
        if (own(schema, name)) return schema[name]!.type;
    }
    return undefined;
}

export function validScalar(value: unknown, type: MetadataType | undefined) {
    if (type === 'string' || type === 'string[]') return typeof value === 'string' && value.length <= 4096;
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (type === 'boolean') return typeof value === 'boolean';
    return type === 'datetime' && dateValue(value) !== undefined;
}

export function validateFilter(filter: unknown, schema: MetadataSchema): Filter | undefined {
    if (filter === undefined) return undefined;
    const seen = new Set<object>();
    const visit = (value: unknown): void => {
        requireInput(isObject(value) && !seen.has(value), 'Filter must be an acyclic explicit Boolean expression.');
        seen.add(value);
        const keys = Object.keys(value);
        if (keys.length === 1 && ['and', 'or'].includes(keys[0]!)) {
            const children = value[keys[0]!];
            requireInput(Array.isArray(children) && children.length > 0, 'and/or require nonempty arrays.');
            children.forEach(visit);
        } else {
            requireInput(keys.length === 3 && ['field', 'op', 'value'].every(key => own(value, key)), 'Filter leaves require exactly field, op and value.');
            const type = fieldType(value.field, schema);
            requireInput(type !== undefined, 'Filter field must be id, timestamp, or declared metadata.');
            if (value.op === 'exists') requireInput(typeof value.value === 'boolean', 'exists requires a boolean.');
            else if (value.op === 'in') requireInput(Array.isArray(value.value) && value.value.length > 0
                && value.value.every(item => validScalar(item, type)), 'in requires a nonempty list of correctly typed scalar values.');
            else {
                requireInput(typeof value.op === 'string' && ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'].includes(value.op), 'Unsupported filter operator.');
                requireInput(validScalar(value.value, type), 'Filter value does not match the declared field type.');
                requireInput(['eq', 'neq'].includes(value.op) || ['number', 'datetime'].includes(type), 'Ordering is supported only for numbers and datetimes.');
            }
        }
        seen.delete(value);
    };
    visit(filter);
    return structuredClone(filter) as Filter;
}

export interface NativeFilter { queryString?: {query: string; defaultField?: string}; bool?: NativeFilter[]; occur?: string | undefined }

const queryString = (field: string, query: string) => ({ queryString: { query, defaultField: field } });
// Quote even literal *:*: LambdaDB treats that exact string as match-all with skipSyntax.
const quote = (value: unknown) => `"${String(value).replace(/[\\"]/g, '\\$&')}"`;
const bool = (clauses: NativeFilter[], occur: string): NativeFilter => ({ bool: clauses.map(clause => ({ ...clause, occur })) });
function exists(field: string, type: MetadataType | undefined): NativeFilter {
    if (type === 'boolean') return bool([queryString(field, 'true'), queryString(field, 'false')], 'should');
    // A bare wildcard is rejected by the native parser's leading-wildcard policy.
    return queryString(field, '[* TO *]');
}
function decimal(value: FilterScalar) {
    const text = String(value);
    if (!text.includes('e')) return text;
    // Native numeric queries use DecimalFormat, which does not parse JS's
    // lowercase exponent syntax. Expand the shortest round-trippable decimal.
    const [mantissa, exponent] = text.split('e') as [string, string];
    const sign = mantissa.startsWith('-') ? '-' : '';
    const unsigned = sign ? mantissa.slice(1) : mantissa;
    const point = (unsigned.indexOf('.') === -1 ? unsigned.length : unsigned.indexOf('.')) + Number(exponent);
    const digits = unsigned.replace('.', '');
    return sign + (point <= 0 ? `0.${'0'.repeat(-point)}${digits}`
        : point >= digits.length ? `${digits}${'0'.repeat(point - digits.length)}`
            : `${digits.slice(0, point)}.${digits.slice(point)}`);
}
function equal(field: string, value: FilterScalar, type: MetadataType | undefined): NativeFilter {
    const literal = type === 'number' ? decimal(value) : type === 'boolean' ? String(value) : quote(value);
    return queryString(field, type === 'number' || type === 'datetime' ? `[${literal} TO ${literal}]` : literal);
}
function nativeFilter(filter: Filter | undefined, schema: MetadataSchema): NativeFilter {
    if (filter === undefined) return matchAll();
    if (filter.and) return bool(filter.and.map(item => nativeFilter(item, schema)), 'filter');
    if (filter.or) return bool(filter.or.map(item => nativeFilter(item, schema)), 'should');
    const { op, value } = filter, type = fieldType(filter.field, schema);
    const field = filter.field === 'id' ? 'memId' : filter.field;
    if (op === 'exists') return value ? exists(field, type) : { bool: [
        { ...matchAll(), occur: 'filter' }, { ...exists(field, type), occur: 'must_not' },
    ] };
    if (op === 'eq') return equal(field, value, type);
    if (op === 'neq') return { bool: [
        { ...exists(field, type), occur: 'filter' }, { ...equal(field, value, type), occur: 'must_not' },
    ] };
    if (op === 'in') return bool(value.map(item => equal(field, item, type)), 'should');
    const literal = type === 'datetime' ? quote(value) : decimal(value);
    const inclusive = ['gte', 'lte'].includes(op);
    return queryString(field, `${inclusive ? '[' : '{'}${op.startsWith('g') ? `${literal} TO *` : `* TO ${literal}`}${inclusive ? ']' : '}'}`);
}

export function compileFilter(filter: unknown, schema: MetadataSchema): NativeFilter {
    return nativeFilter(validateFilter(filter, schema), schema);
}

export function buildFilter(filters: unknown[] = [], excludeIds: string[] = [], schema: MetadataSchema = {}): NativeFilter {
    requireInput(Array.isArray(filters) && Array.isArray(excludeIds)
        && excludeIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 512), 'Invalid filters or excluded IDs.');
    const clauses = filters.filter(item => item !== undefined).map(item => ({ ...compileFilter(item, schema), occur: 'filter' }));
    if (clauses.length === 0) clauses.push({ ...matchAll(), occur: 'filter' });
    clauses.push(...excludeIds.map(id => ({ ...equal('memId', id, 'string'), occur: 'must_not' })));
    if (clauses.length === 1) { const { occur: _occur, ...clause } = clauses[0]!; return clause; }
    return { bool: clauses };
}

export function buildSearchFilter(filters: unknown[] = [], excludeIds: string[] = [], seenChunkIds: string[] = [], schema: MetadataSchema = {}): NativeFilter {
    requireInput(Array.isArray(seenChunkIds) && seenChunkIds.every(id => typeof id === 'string' && id.length > 0),
        'Invalid seen chunk IDs.');
    return { bool: [
        { ...buildFilter(filters, excludeIds, schema), occur: 'filter' },
        ...seenChunkIds.map(id => ({ ...equal('id', id, 'string'), occur: 'must_not' })),
    ] };
}

export function matchesFilter(mem: {id: string; timestamp?: string | undefined; metadata?: Metadata | undefined}, filter: Filter | undefined, schema: MetadataSchema): boolean {
    validateFilter(filter, schema);
    const visit = (node: Filter | undefined): boolean => {
        if (node === undefined) return true;
        if (node.and) return node.and.every(visit);
        if (node.or) return node.or.some(visit);
        const { field, op, value } = node;
        const stored = field.startsWith('metadata.') ? mem.metadata?.[field.slice(9)] : mem[field as 'id' | 'timestamp'];
        const values = stored === undefined ? [] : Array.isArray(stored) ? stored : [stored];
        if (op === 'exists') return (values.length > 0) === value;
        const type = fieldType(field, schema);
        const convert = (item: unknown) => type === 'datetime' ? dateValue(item) : item;
        const same = (expected: FilterScalar) => values.some(item => convert(item) === convert(expected));
        if (op === 'eq') return same(value);
        if (op === 'neq') return values.length > 0 && !same(value);
        if (op === 'in') return value.some(same);
        return values.some(item => {
            const a = convert(item) as number | bigint, b = convert(value) as number | bigint;
            if (op === 'gt') return a > b;
            if (op === 'gte') return a >= b;
            if (op === 'lt') return a < b;
            return a <= b;
        });
    };
    return visit(filter);
}
