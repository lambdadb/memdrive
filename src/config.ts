import { Analyzer, type IndexConfigsUnion } from '@functional-systems/lambdadb/models/indexconfigsunion.js';
import type { CreateFileStoreOptions, FileStoreDescription, Metadata, MetadataSchema } from './types.js';
import { MemDriveError, requireInput } from './errors.js';

export const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
    && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export const keysOnly = (value: unknown, keys: string[]): value is Record<string, unknown> =>
    isObject(value) && Object.keys(value).every(key => keys.includes(key));

export const formatTag = 'memdrive.format';
export const format = 'files-v0';
export const managedEmbedding = { mode: 'managed', provider: 'openai', model: 'text-embedding-3-small',
    dimensions: 1536, similarity: 'cosine' } as const;
const fileIndexes = {
    kind: { type: 'keyword' },
    path: { type: 'keyword' },
    fileName: { type: 'keyword' },
    ancestorPaths: { type: 'keyword' },
    changed: { type: 'boolean' },
    modifiedAt: { type: 'datetime' },
} as const;
const indexTypes = { string: 'keyword', number: 'double', boolean: 'boolean', datetime: 'datetime' } as const;
const supportedAnalyzers: ReadonlySet<unknown> = new Set(Object.values(Analyzer));

export const validDate = (value: unknown): value is string => typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

function labelEntries(value: unknown = {}): Record<string, string> {
    // Match the native tag restrictions, including Java's definition of whitespace.
    // eslint-disable-next-line no-control-regex
    const blank = /^[\u0009-\u000d\u001c-\u0020\u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]*$/u;
    requireInput(isObject(value) && Object.keys(value).length <= 4 && Object.entries(value).every(([key, item]) =>
        /^[A-Za-z0-9_.-]{1,63}$/.test(key) && !key.startsWith('memdrive.') && typeof item === 'string'
        && item.length <= 127 && !/[:#,]/.test(item) && !blank.test(item)), 'Labels must use native-safe names and values. memdrive.* names are reserved.');
    return { ...value } as Record<string, string>;
}

function schemaEntries(value: unknown = {}): MetadataSchema {
    requireInput(isObject(value) && Object.entries(value).every(([key, entry]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !['id', 'constructor', 'prototype', '__proto__'].includes(key)
        && keysOnly(entry, ['type', 'description']) && typeof entry.type === 'string' && Object.hasOwn(indexTypes, entry.type)
        && (entry.description === undefined || (typeof entry.description === 'string' && entry.description.length <= 255))),
    'Metadata schema requires named scalar types and optional field descriptions.');
    return structuredClone(value) as MetadataSchema;
}

function textAnalyzers(value: unknown = { analyzers: ['standard'] }): Analyzer[] {
    requireInput(keysOnly(value, ['analyzers']) && Array.isArray(value.analyzers) && value.analyzers.length > 0
        && new Set(value.analyzers).size === value.analyzers.length && [...value.analyzers].every(item => supportedAnalyzers.has(item)),
    'Set a nonempty array of distinct supported text analyzers.');
    return [...value.analyzers] as Analyzer[];
}

export function metadataValues(value: unknown, schema: MetadataSchema): Metadata | undefined {
    if (value === undefined) return undefined;
    requireInput(isObject(value) && Object.entries(value).every(([key, item]) => {
        if (!Object.hasOwn(schema, key)) return false;
        switch (schema[key]!.type) {
            case 'string': return typeof item === 'string' && item.length <= 4096 && !/\p{Surrogate}/u.test(item);
            case 'number': return typeof item === 'number' && Number.isFinite(item);
            case 'boolean': return typeof item === 'boolean';
            case 'datetime': return validDate(item);
        }
    }), 'Metadata values must match their declared scalar types. Datetimes use ISO UTC with milliseconds.');
    return Object.keys(value).length ? { ...value } as Metadata : undefined;
}

export function storeConfiguration(options: CreateFileStoreOptions) {
    const name = options.name;
    const metadataSchema = schemaEntries(options.metadataSchema);
    const labels = labelEntries(options.labels);
    const analyzers = textAnalyzers(options.textSearch);
    const indexConfigs: Record<string, IndexConfigsUnion> = {
        ...fileIndexes,
        body: { type: 'text', analyzers },
        content: { type: 'text', analyzers },
        embedding: { type: 'vector', managedEmbedding: true, embedding: {
            provider: managedEmbedding.provider, model: managedEmbedding.model, dimensions: managedEmbedding.dimensions,
            similarity: managedEmbedding.similarity, sourceField: 'content',
        } },
    };
    if (Object.keys(metadataSchema).length) indexConfigs.metadata = { type: 'object', objectIndexConfigs:
        Object.fromEntries(Object.entries(metadataSchema).map(([key, value]) => [key, { ...value, type: indexTypes[value.type] }])) };
    const description: FileStoreDescription = { name, labels, metadataSchema, textSearch: { analyzers }, embedding: { ...managedEmbedding } };
    return { indexConfigs, tags: { ...labels, [formatTag]: format }, description };
}

export function parseStore(collection: unknown, name: string): FileStoreDescription {
    try {
        requireInput(isObject(collection) && collection.collectionName === name && collection.defaultBranchName === 'main'
            && isObject(collection.tags) && collection.tags[formatTag] === format && isObject(collection.indexConfigs),
        'Collection format or main branch is incompatible.');
        const { tags, indexConfigs } = collection;
        const labels = labelEntries(Object.fromEntries(Object.entries(tags).filter(([key]) => key !== formatTag)));
        requireInput(Object.entries(fileIndexes).every(([field, config]) => isObject(indexConfigs[field])
            && indexConfigs[field].type === config.type), 'Required file indexes are missing.');
        const { embedding, content, body, metadata } = indexConfigs;
        requireInput(isObject(embedding) && embedding.type === 'vector' && embedding.managedEmbedding !== false && isObject(embedding.embedding)
            && embedding.embedding.provider === managedEmbedding.provider && embedding.embedding.model === managedEmbedding.model
            && embedding.embedding.dimensions === managedEmbedding.dimensions && embedding.embedding.similarity === managedEmbedding.similarity
            && embedding.embedding.sourceField === 'content', 'Managed chunk embedding index is incompatible.');
        requireInput(isObject(content) && content.type === 'text' && isObject(body) && body.type === 'text', 'Text indexes are missing.');
        const analyzers = textAnalyzers({ analyzers: content.analyzers ?? ['standard'] });
        requireInput(JSON.stringify(analyzers) === JSON.stringify(textAnalyzers({ analyzers: body.analyzers ?? ['standard'] })),
            'Original and chunk analyzers must match.');
        let metadataSchema: MetadataSchema = {};
        if (metadata !== undefined) {
            requireInput(isObject(metadata) && metadata.type === 'object' && isObject(metadata.objectIndexConfigs),
                'Metadata index is incompatible.');
            metadataSchema = schemaEntries(Object.fromEntries(Object.entries(metadata.objectIndexConfigs).map(([key, value]) => {
                requireInput(isObject(value), 'Invalid metadata field index.');
                return [key, { type: Object.entries(indexTypes).find(([, native]) => native === value.type)?.[0],
                    ...(value.description === undefined ? {} : { description: value.description }) }];
            })));
        }
        return { name, labels, metadataSchema, textSearch: { analyzers }, embedding: { ...managedEmbedding } };
    } catch (cause) {
        throw new MemDriveError('INCOMPATIBLE_STORE', 'The collection is not a compatible MemDrive file store.', { cause });
    }
}
