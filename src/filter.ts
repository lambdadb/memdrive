import { keysOnly, metadataValues } from './config.js';
import { requireInput } from './errors.js';
import type { MetadataSchema, MetadataType } from './types.js';

type Scalar = string | number | boolean;
interface NativeFilter {
    queryString?: { query: string; defaultField?: string };
    bool?: NativeFilter[];
    occur?: 'filter' | 'should' | 'must_not';
}

const queryString = (field: string, query: string) => ({ queryString: { query, defaultField: field } });
const quote = (value: Scalar) => '"' + String(value).replace(/[\\"]/g, '\\$&') + '"';
const bool = (clauses: NativeFilter[], occur: 'filter' | 'should'): NativeFilter =>
    ({ bool: clauses.map(clause => ({ ...clause, occur })) });
const matchAll = { queryString: { query: '*:*' } };

function decimal(value: Scalar) {
    const text = String(value);
    if (!text.includes('e')) return text;
    // Native numeric query parsing requires ordinary decimal notation.
    const [mantissa, exponent] = text.split('e') as [string, string];
    const negative = mantissa.startsWith('-');
    const [integer, fraction = ''] = (negative ? mantissa.slice(1) : mantissa).split('.') as [string, string?];
    const point = integer.length + Number(exponent);
    const digits = integer + fraction;
    return (negative ? '-' : '') + (point <= 0 ? `0.${'0'.repeat(-point)}${digits}`
        : point >= digits.length ? digits + '0'.repeat(point - digits.length)
            : digits.slice(0, point) + '.' + digits.slice(point));
}

function equal(field: string, value: Scalar, type: MetadataType): NativeFilter {
    const literal = type === 'number' ? decimal(value) : type === 'boolean' ? String(value) : quote(value);
    return queryString(field, type === 'number' || type === 'datetime' ? `[${literal} TO ${literal}]` : literal);
}

function exists(field: string, type: MetadataType): NativeFilter {
    if (type === 'boolean') return bool([queryString(field, 'true'), queryString(field, 'false')], 'should');
    return queryString(field, '[* TO *]');
}

export function compileFilter(filter: unknown, schema: MetadataSchema): NativeFilter {
    const seen = new Set<object>();
    function visit(node: unknown): NativeFilter {
        requireInput(keysOnly(node, ['and', 'or', 'field', 'op', 'value']) && !seen.has(node),
            'Filter must be an acyclic Boolean expression.');
        if (Object.hasOwn(node, 'and') || Object.hasOwn(node, 'or')) {
            const isAnd = Object.hasOwn(node, 'and');
            const children = isAnd ? node.and : node.or;
            requireInput(Object.keys(node).length === 1 && Array.isArray(children) && children.length > 0,
                'Filter and/or require a nonempty array.');
            seen.add(node);
            const clauses = [...children].map(visit);
            seen.delete(node);
            return bool(clauses, isAnd ? 'filter' : 'should');
        }
        const { field, op, value } = node;
        requireInput(Object.keys(node).length === 3 && typeof field === 'string' && field.startsWith('metadata.')
            && Object.hasOwn(schema, field.slice(9)) && Object.hasOwn(node, 'value'),
        'Filter leaves require field, op and value, and must use a declared metadata field.');
        const key = field.slice(9);
        const { type } = schema[key]!;
        const scalar = (item: unknown): Scalar => {
            const values = metadataValues({ [key]: item }, schema);
            return values![key]!;
        };
        if (op === 'exists') {
            requireInput(typeof value === 'boolean', 'Filter exists requires a boolean.');
            const present = exists(field, type);
            return value ? present : { bool: [{ ...matchAll, occur: 'filter' }, { ...present, occur: 'must_not' }] };
        }
        if (op === 'in') {
            requireInput(Array.isArray(value) && value.length > 0, 'Filter in requires a nonempty array.');
            return bool([...value].map(item => equal(field, scalar(item), type)), 'should');
        }
        if (op === 'eq') return equal(field, scalar(value), type);
        if (op === 'neq') return { bool: [
            { ...exists(field, type), occur: 'filter' }, { ...equal(field, scalar(value), type), occur: 'must_not' },
        ] };
        requireInput((op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') && (type === 'number' || type === 'datetime'),
            'Ordering filters require a number or datetime.');
        const literal = type === 'number' ? decimal(scalar(value)) : quote(scalar(value));
        const inclusive = op === 'gte' || op === 'lte';
        return queryString(field, `${inclusive ? '[' : '{'}${op === 'gt' || op === 'gte' ? literal + ' TO *' : '* TO ' + literal}${inclusive ? ']' : '}'}`);
    }
    return visit(filter);
}
