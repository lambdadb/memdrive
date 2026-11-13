import { MemDriveError, requireInput, checkAbort } from './errors.js';
import { buildFilter } from './filter.js';
import type { MetadataSchema, RequestOptions } from './types.js';

type NativeObject = Record<string, unknown>;
type SchemaSource = MetadataSchema | (() => MetadataSchema);
export type InspectionSchedule = <T>(operation: (options?: RequestOptions) => Promise<T>) => Promise<T>;
interface InspectorOptions {
    describe: (options?: RequestOptions) => Promise<unknown>;
    query: (body: NativeObject, options?: RequestOptions) => Promise<unknown>;
    metadataSchema: SchemaSource;
    schemaTtlMs?: number;
    valuesTtlMs?: number;
    now?: () => number;
}
interface InspectedField {
    type: MetadataSchema[string]['type'];
    indexType: string;
    operators: string[];
    description?: string;
}
interface SchemaInspection {
    description?: string;
    labels: NativeObject;
    fields: Record<string, InspectedField>;
    search_indexes: { content?: NativeObject; embedding: NativeObject };
    countable_fields: string[];
    filters: string;
    counts: string;
}
interface FacetBucket { value: string; count: number }
interface CountInspection {
    filter: unknown;
    limit: number;
    values: Record<string, { buckets: FacetBucket[]; has_more: boolean | null }>;
}
interface CacheEntry {
    expires: number | null;
    signal: AbortSignal | undefined;
    promise: Promise<unknown>;
}
const array = (value: unknown): value is unknown[] => Array.isArray(value);

const object = (value: unknown): value is NativeObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const schemaValue = (schema: SchemaSource): MetadataSchema => typeof schema === 'function' ? schema() : schema;
const unchanged: InspectionSchedule = operation => operation();
const baseOperators = ['eq', 'neq', 'in', 'exists'];

// One inspector belongs to one fixed client/collection/branch. Scheduling is
// supplied by each recall so actual cache-miss requests enter its usage ledger.
export function createInspector({ describe, query, metadataSchema,
    schemaTtlMs = 300000, valuesTtlMs = 60000, now = Date.now }: InspectorOptions) {
    requireInput(typeof describe === 'function' && typeof query === 'function', 'Provide collection inspection transports.');
    requireInput(typeof now === 'function', 'Provide an inspection clock.');
    for (const ttl of [schemaTtlMs, valuesTtlMs])
        requireInput(Number.isFinite(ttl) && ttl >= 0, 'Cache TTLs must be nonnegative milliseconds.');
    const cache = new Map<string, CacheEntry>();
    const cached = async <T extends object>(key: string, ttl: number, load: () => Promise<T>, signal?: AbortSignal): Promise<T & { as_of: string }> => {
        checkAbort(signal);
        for (const [oldKey, entry] of cache)
            if (entry.expires !== null && entry.expires <= now()) cache.delete(oldKey);
        let entry = cache.get(key);
        if (!entry || (entry.expires === null && entry.signal !== signal)) {
            const loading: CacheEntry = { expires: null, signal, promise: Promise.resolve().then(load).then(value => {
                const at = now();
                loading.expires = at + ttl;
                loading.signal = undefined;
                return { ...value, as_of: new Date(at).toISOString() };
            }, error => {
                if (cache.get(key) === loading) cache.delete(key);
                throw error;
            }) };
            entry = loading;
            cache.set(key, loading);
        }
        const value = await entry.promise;
        checkAbort(signal);
        // Private key namespaces bind each entry to the same loader result type.
        return structuredClone(value) as T & { as_of: string };
    };
    const getSchema = (schedule: InspectionSchedule = unchanged, signal?: AbortSignal) => cached<SchemaInspection>('schema', schemaTtlMs, async () => {
        const result = await schedule(describe);
        const collection = object(result) && object(result.collection) ? result.collection : undefined;
        const configs = collection?.indexConfigs;
        if (!collection || !object(configs)) throw new MemDriveError('INVALID_RESPONSE', 'Collection inspection did not return index configuration.');
        const declared = schemaValue(metadataSchema);
        const fields: Record<string, InspectedField> = {};
        const add = (name: string, type: InspectedField['type'], config: unknown, indexType: string) => {
            if (!object(config) || config.type !== indexType)
                throw new MemDriveError('INCOMPATIBLE_STORE', 'Collection indexes do not match the MemDrive schema.');
            fields[name] = { type, indexType,
                operators: [...baseOperators, ...(['number', 'datetime'].includes(type) ? ['gt', 'gte', 'lt', 'lte'] : [])],
                ...(typeof config.description === 'string' ? { description: config.description } : {}) };
        };
        add('id', 'string', configs.memId, 'keyword');
        add('timestamp', 'datetime', configs.timestamp, 'datetime');
        const metadata = object(configs.metadata) && object(configs.metadata.objectIndexConfigs) ? configs.metadata.objectIndexConfigs : undefined;
        for (const [name, { type }] of Object.entries(declared)) {
            const nativeType = { string: 'keyword', 'string[]': 'keyword', number: 'double', boolean: 'boolean', datetime: 'datetime' }[type];
            add(`metadata.${name}`, type, metadata?.[name], nativeType);
        }
        if ((configs.content !== undefined && (!object(configs.content) || configs.content.type !== 'text'))
            || !object(configs.embedding) || configs.embedding.type !== 'vector')
            throw new MemDriveError('INCOMPATIBLE_STORE', 'Memory search indexes are unavailable.');
        return {
            ...(typeof collection.description === 'string' ? { description: collection.description } : {}),
            labels: Object.fromEntries(Object.entries(collection.tags ?? {}).filter(([key]) => !key.startsWith('memory.'))),
            fields,
            search_indexes: { ...(configs.content === undefined ? {} : { content: configs.content }), embedding: configs.embedding },
            countable_fields: Object.keys(fields).filter(name => fields[name]!.indexType === 'keyword'),
            filters: 'Use a field/op/value leaf or explicit and/or arrays. Array eq/in test membership. neq requires an indexed value and excludes any matching element. exists tests indexed values, so missing fields and empty arrays are absent.',
            counts: 'Keyword fields only, over all mems matching caller and tool filters. Previously shown mems remain included. Each distinct value counts once per document; bucket sums are not a population total.',
        };
    }, signal);
    return {
        getSchema,
        invalidate() { cache.clear(); },
        async countValues(args: unknown, requiredFilter?: unknown, schedule: InspectionSchedule = unchanged, excludeIds: string[] = [], signal?: AbortSignal) {
            requireInput(object(args) && Object.keys(args).every(key => ['fields', 'filter', 'limit'].includes(key)), 'Use fields, filter and limit for value counts.');
            const { fields, filter, limit = 10 } = args;
            requireInput(array(fields) && fields.length >= 1 && fields.length <= 5
                && fields.every((field): field is string => typeof field === 'string' && field.length > 0)
                && new Set(fields).size === fields.length, 'fields must contain 1 to 5 distinct keyword field names.');
            requireInput(typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'limit must be an integer from 1 to 100.');
            const schema = await getSchema(schedule, signal);
            const population = { bool: [
                { ...buildFilter([requiredFilter, filter], excludeIds, schemaValue(metadataSchema)), occur: 'filter' },
                { queryString: { query: '"mem"', defaultField: 'kind' }, occur: 'filter' },
            ] };
            requireInput(fields.every(field => schema.countable_fields.includes(field)), 'count_values supports only keyword fields listed by get_schema.');
            const sorted = [...fields].sort();
            const size = limit < 100 ? limit + 1 : limit;
            const key = JSON.stringify(['counts', population, sorted, limit, schema.fields]);
            return cached<CountInspection>(key, valuesTtlMs, async () => {
                const response = await schedule(options => query({ size: 0, query: population,
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
                        has_more: buckets.length > limit ? true : buckets.length < 100 ? false : null }];
                }));
                return { filter: filter ?? null, limit, values };
            }, signal);
        },
    };
}
