import { MemDriveError, requireInput, checkAbort } from './errors.js';
import { buildFilter, fieldType } from './filter.js';
import type { CountValuesResult, MetadataSchema, RequestOptions } from './types.js';

type NativeObject = Record<string, unknown>;
export type ValueSchedule = <T>(operation: (options?: RequestOptions) => Promise<T>) => Promise<T>;
interface CounterOptions {
    describe: (options?: RequestOptions) => Promise<unknown>;
    query: (body: NativeObject, options?: RequestOptions) => Promise<unknown>;
    metadataSchema: () => MetadataSchema;
    schemaTtlMs?: number;
    valuesTtlMs?: number;
    now?: () => number;
}
interface CacheEntry {
    expires: number | null;
    signal: AbortSignal | undefined;
    promise: Promise<unknown>;
}
interface FacetBucket { value: string; count: number }
const array = (value: unknown): value is unknown[] => Array.isArray(value);
const object = (value: unknown): value is NativeObject => value !== null && typeof value === 'object' && !Array.isArray(value);

// Each counter is bound to one collection/branch. Writes through any view of the
// same backend invalidate its cache; outside writes become visible after the TTL.
export function createValueCounter({ describe, query, metadataSchema,
    schemaTtlMs = 300000, valuesTtlMs = 60000, now = Date.now }: CounterOptions) {
    const cache = new Map<string, CacheEntry>();
    const cached = async <T>(key: string, ttl: number, load: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
        checkAbort(signal);
        for (const [oldKey, entry] of cache)
            if (entry.expires !== null && entry.expires <= now()) cache.delete(oldKey);
        let entry = cache.get(key);
        // Different cancellation scopes cannot share an in-flight request.
        if (!entry || (entry.expires === null && entry.signal !== signal)) {
            const loading: CacheEntry = { expires: null, signal, promise: Promise.resolve().then(load).then(value => {
                loading.expires = now() + ttl;
                loading.signal = undefined;
                return value;
            }, error => {
                if (cache.get(key) === loading) cache.delete(key);
                throw error;
            }) };
            entry = loading;
            cache.set(key, loading);
        }
        const value = await entry.promise;
        checkAbort(signal);
        // Private key namespaces bind entries to the same loader result type.
        return structuredClone(value) as T;
    };
    return {
        invalidate() { cache.clear(); },
        async countValues(input: unknown, schedule?: ValueSchedule, signal?: AbortSignal): Promise<CountValuesResult> {
            checkAbort(signal);
            let args: unknown;
            try { args = structuredClone(input); }
            catch (cause) { throw new MemDriveError('INVALID_INPUT', 'Value count input must be cloneable data.', { cause }); }
            requireInput(object(args) && Object.keys(args).every(key => ['fields', 'filter', 'excludeIds', 'limit'].includes(key)),
                'Use fields, filter, excludeIds and limit for value counts.');
            const { fields, filter, excludeIds = [], limit = 10 } = args;
            requireInput(array(fields) && fields.length > 0 && fields.length <= 5
                && fields.every((field): field is string => typeof field === 'string' && field.length > 0)
                && new Set(fields).size === fields.length, 'fields must contain 1 to 5 distinct keyword field names (the native facet limit).');
            requireInput(array(excludeIds) && excludeIds.every((id): id is string => typeof id === 'string' && id.trim().length > 0)
                && new Set(excludeIds).size === excludeIds.length, 'excludeIds must contain distinct canonical IDs.');
            requireInput(typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
                'limit must be an integer from 1 to 100.');
            const execute: ValueSchedule = schedule ?? (operation => operation({ signal }));
            const schema = await cached('schema', schemaTtlMs, async () => {
                // The backend refresh validates the complete collection configuration.
                await execute(describe);
                return metadataSchema();
            }, signal);
            requireInput(fields.every(field => ['string', 'string[]'].includes(fieldType(field, schema) ?? '')),
                'countValues supports id and declared string or string[] metadata fields.');
            const population = { bool: [
                { ...buildFilter([filter], excludeIds, schema), occur: 'filter' },
                { queryString: { query: '"mem"', defaultField: 'kind' }, occur: 'filter' },
            ] };
            const sorted = [...fields].sort();
            const size = limit < 100 ? limit + 1 : limit;
            const key = JSON.stringify(['counts', population, sorted, limit, schema]);
            return cached(key, valuesTtlMs, async () => {
                const response = await execute(options => query({ size: 0, query: population,
                    facets: Object.fromEntries(sorted.map(field => [field === 'id' ? 'memId' : field, { size }])) }, options));
                const facets = object(response) && object(response.facets) ? response.facets : undefined;
                const values = Object.fromEntries(sorted.map(field => {
                    const facet = facets?.[field === 'id' ? 'memId' : field];
                    const buckets = object(facet) ? facet.buckets : undefined;
                    if (!array(buckets) || buckets.length > size
                        || !buckets.every((bucket): bucket is FacetBucket => object(bucket) && typeof bucket.value === 'string'
                            && typeof bucket.count === 'number' && Number.isSafeInteger(bucket.count) && bucket.count >= 0)
                        || new Set(buckets.map(bucket => bucket.value)).size !== buckets.length)
                        throw new MemDriveError('INVALID_RESPONSE', 'Value counts returned invalid facet buckets.');
                    return [field, { buckets: buckets.slice(0, limit),
                        hasMore: buckets.length > limit ? true : buckets.length < 100 ? false : null }];
                }));
                return { values, asOf: new Date(now()).toISOString() };
            }, signal);
        },
    };
}
