import { Analyzer, type IndexConfigsUnion } from '@functional-systems/lambdadb/models/indexconfigsunion.js';
import type { ChunkingOptions, CreateExternalFileStoreOptions, CreateFileStoreOptions, EmbeddingMode, ExternalEmbedding, FileStoreDescription, Metadata, MetadataSchema } from './types.js';
import { MemDriveError, requireInput } from './errors.js';
import { chunkingOptions } from './text-chunks.js';

export const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
    && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export const keysOnly = (value: unknown, keys: string[]): value is Record<string, unknown> =>
    isObject(value) && Object.keys(value).every(key => keys.includes(key));

const formatTag = 'memdrive.format';
export const format = 'files-v2';
const embeddingTag = 'memdrive.embedding';
export const managedEmbedding = { mode: 'managed', provider: 'openai', model: 'text-embedding-3-small',
    dimensions: 1536, similarity: 'cosine' } as const;
/** Managed chunks embed their contextualized text through the native `sources` form. */
const embeddingSource = { field: 'embeddingText', type: 'text' } as const;
const fileIndexes = {
    kind: { type: 'keyword' },
    path: { type: 'keyword' },
    fileName: { type: 'keyword' },
    ancestorPaths: { type: 'keyword' },
    createdAt: { type: 'datetime' },
    modifiedAt: { type: 'datetime' },
} as const;
const indexTypes = { string: 'keyword', number: 'double', boolean: 'boolean', datetime: 'datetime' } as const;
const supportedAnalyzers: ReadonlySet<unknown> = new Set(Object.values(Analyzer));
/** New stores keep LambdaDB's native snapshot retention at its one-day minimum. */
export const snapshotRetentionInDays = 1;
const configurationPrefix = 'memdrive-config-v1:';
/** Serialize SDK store settings into the native collection description. */
const settingsDescription = (chunking?: ChunkingOptions) => configurationPrefix + JSON.stringify(chunking ? { chunking } : {});

export const validDate = (value: unknown): value is string => typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

// Match the native tag restrictions, including Java's definition of whitespace.
// eslint-disable-next-line no-control-regex
const blankTag = /^[\u0009-\u000d\u001c-\u0020\u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]*$/u;
const validTagValue = (value: unknown): value is string => typeof value === 'string'
    && value.length <= 127 && !/[:#,]/.test(value) && !blankTag.test(value);

function labelEntries(value: unknown = {}, limit = 4): Record<string, string> {
    requireInput(isObject(value) && Object.keys(value).length <= limit && Object.entries(value).every(([key, item]) =>
        /^[A-Za-z0-9_.-]{1,63}$/.test(key) && !key.startsWith('memdrive.') && validTagValue(item)),
    'Labels must use native-safe names and values. memdrive.* names are reserved.');
    return { ...value } as Record<string, string>;
}

function externalEmbedding(value: unknown): ExternalEmbedding {
    requireInput(keysOnly(value, ['mode', 'dimensions', 'similarity', 'identity']) && value.mode === 'external'
        && typeof value.dimensions === 'number' && Number.isInteger(value.dimensions) && value.dimensions >= 64 && value.dimensions <= 4096
        && value.similarity === 'cosine' && validTagValue(value.identity) && value.identity.trim().length > 0 && !/\p{Surrogate}/u.test(value.identity),
    'External embedding requires dimensions 64–4096, cosine similarity and a native-safe nonblank identity of at most 127 characters.');
    return { mode: 'external', dimensions: value.dimensions, similarity: 'cosine', identity: value.identity };
}

export function vectorValues(value: unknown, dimensions: number): number[] {
    requireInput(Array.isArray(value) && value.length === dimensions && [...value].every(item => typeof item === 'number'),
        'Embedding must be a dense, finite, nonzero vector with the configured dimensions.');
    // The native vector index stores float32. Canonicalize before fingerprinting so
    // input values and the server's shortest decimal representations agree.
    const vector = value.map(item => Math.fround(item));
    requireInput(vector.every(Number.isFinite) && vector.some(item => item !== 0),
        'Embedding must be a dense, finite, nonzero vector with the configured dimensions.');
    return vector;
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

export function storeConfiguration(options: CreateFileStoreOptions | CreateExternalFileStoreOptions) {
    const { name } = options;
    const metadataSchema = schemaEntries(options.metadataSchema);
    const external = options.embedding?.mode === 'external';
    const labels = labelEntries(options.labels, external ? 3 : 4);
    const tags: Record<string, string> = { ...labels, [formatTag]: format };
    const indexConfigs: Record<string, IndexConfigsUnion> = { ...fileIndexes };
    let description: FileStoreDescription<EmbeddingMode>;
    let chunking: ChunkingOptions | undefined;
    if (external) {
        const embedding = externalEmbedding(options.embedding);
        requireInput(options.textSearch === undefined && options.chunking === undefined && options.chunker === undefined, 'External embedding does not support text indexes or chunking.');
        indexConfigs.embedding = { type: 'vector', dimensions: embedding.dimensions, similarity: embedding.similarity };
        tags[embeddingTag] = embedding.identity;
        description = { name, labels, metadataSchema, embedding };
    } else {
        requireInput(options.embedding === undefined || keysOnly(options.embedding, ['mode']) && options.embedding.mode === 'managed',
            'Managed embedding accepts only mode.');
        const analyzers = textAnalyzers(options.textSearch);
        chunking = chunkingOptions(options.chunking ?? { strategy: 'auto' });
        // Originals stay unindexed: findText reads `body` as a returned field, and
        // search queries chunk fields. A future server-side substring index on
        // `body` would be set when the collection is created. The embedding source
        // `embeddingText` is stored without an index: LambdaDB embeds an unindexed
        // source field, and keyword search matches `content`.
        indexConfigs.content = { type: 'text', analyzers };
        indexConfigs.embedding = { type: 'vector', managedEmbedding: true, embedding: {
            provider: managedEmbedding.provider, model: managedEmbedding.model, dimensions: managedEmbedding.dimensions,
            similarity: managedEmbedding.similarity, sources: [{ ...embeddingSource }],
        } };
        description = { name, labels, metadataSchema, textSearch: { analyzers }, embedding: { ...managedEmbedding }, chunking };
    }
    if (Object.keys(metadataSchema).length) indexConfigs.metadata = { type: 'object', objectIndexConfigs:
        Object.fromEntries(Object.entries(metadataSchema).map(([key, value]) => [key, { ...value, type: indexTypes[value.type] }])) };
    return { indexConfigs, tags, description, collectionDescription: settingsDescription(chunking) };
}

/** Read the SDK settings stored in the native collection description. */
function storeSettings(collection: { tags?: unknown; description?: unknown }) {
    const external = isObject(collection.tags) && Object.hasOwn(collection.tags, embeddingTag);
    const configuration = typeof collection.description === 'string' && collection.description.startsWith(configurationPrefix)
        ? JSON.parse(collection.description.slice(configurationPrefix.length)) as unknown : undefined;
    requireInput(keysOnly(configuration, external ? [] : ['chunking']), 'Invalid file store configuration.');
    return { chunking: configuration.chunking === undefined ? undefined : chunkingOptions(configuration.chunking) };
}

export function parseStore(collection: unknown, name: string): FileStoreDescription<EmbeddingMode> {
    try {
        requireInput(isObject(collection) && collection.collectionName === name && collection.defaultBranchName === 'main'
            && isObject(collection.tags) && collection.tags[formatTag] === format && isObject(collection.indexConfigs),
        'Collection format or main branch is incompatible.');
        const { tags, indexConfigs } = collection;
        const { chunking } = storeSettings(collection);
        const external = Object.hasOwn(tags, embeddingTag);
        const labels = labelEntries(Object.fromEntries(Object.entries(tags).filter(([key]) => key !== formatTag && key !== embeddingTag)),
            external ? 3 : 4);
        requireInput(Object.entries(fileIndexes).every(([field, config]) => isObject(indexConfigs[field])
            && indexConfigs[field].type === config.type), 'Required file indexes are missing.');
        const { embedding, content, body, embeddingText, metadata } = indexConfigs;
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
        if (external) {
            requireInput(isObject(embedding) && embedding.type === 'vector' && embedding.managedEmbedding !== true
                && embedding.embedding === undefined && content === undefined && body === undefined,
            'External file embedding index is incompatible.');
            return { name, labels, metadataSchema, embedding: externalEmbedding({ mode: 'external',
                dimensions: embedding.dimensions, similarity: embedding.similarity, identity: tags[embeddingTag] }) };
        }
        requireInput(chunking !== undefined, 'Managed file stores require a chunking configuration.');
        requireInput(isObject(embedding) && embedding.type === 'vector' && embedding.managedEmbedding !== false && isObject(embedding.embedding)
            && embedding.embedding.provider === managedEmbedding.provider && embedding.embedding.model === managedEmbedding.model
            && embedding.embedding.dimensions === managedEmbedding.dimensions && embedding.embedding.similarity === managedEmbedding.similarity
            && embedding.embedding.sourceField === undefined && Array.isArray(embedding.embedding.sources)
            && embedding.embedding.sources.length === 1 && keysOnly(embedding.embedding.sources[0], ['field', 'type'])
            && embedding.embedding.sources[0].field === embeddingSource.field && embedding.embedding.sources[0].type === embeddingSource.type,
        'Managed chunk embedding index is incompatible.');
        requireInput(embeddingText === undefined, 'Chunk embedding text must not have a text index.');
        requireInput(isObject(content) && content.type === 'text', 'Chunk text index is missing.');
        requireInput(body === undefined, 'File originals must not have a text index.');
        const analyzers = textAnalyzers({ analyzers: content.analyzers ?? ['standard'] });
        return { name, labels, metadataSchema, textSearch: { analyzers }, embedding: { ...managedEmbedding }, chunking };
    } catch (cause) {
        throw new MemDriveError('INCOMPATIBLE_STORE', 'The collection is not a compatible MemDrive file store.', { cause });
    }
}
