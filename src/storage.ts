import type { LambdaDBClient } from '@functional-systems/lambdadb';
import type { IndexConfigsUnion } from '@functional-systems/lambdadb/models/indexconfigsunion.js';
import type { MetadataSchema, Metadata, EmbeddingConfig, TextSearch, Filter, RequestOptions, DriveDescriptor, Mem } from './types.js';
import { Analyzer } from '@functional-systems/lambdadb/models/indexconfigsunion.js';
import { chunkSpans, CHUNKING_POLICY } from './chunking.js';
import { MemDriveError, requireInput, operationOptions, checkAbort, abortError } from './errors.js';
import { compileFilter, isObject, validScalar, validateMetadataSchema, validateDescription } from './filter.js';

type CollectionResponse = Awaited<ReturnType<ReturnType<LambdaDBClient['collection']>['get']>>['collection'];
type NativeHandle = ReturnType<LambdaDBClient['collection']>;
type NativeQuery = Parameters<NativeHandle['query']>[0];
type NativeClient = Pick<LambdaDBClient, 'collection' | 'createCollection' | 'listCollections'>;
type Connection = { client: NativeClient; name: string };
type CreateBackendOptions = Connection & { metadataSchema: unknown; textSearch?: unknown; embedding?: unknown; labels?: unknown; description?: unknown };
type Attributes = { timestamp?: string | undefined; metadata?: Metadata | undefined };
type TextMemInput = Attributes & { id?: string; content: string };
type TextMem = TextMemInput & { id: string };
type VectorMemInput = Attributes & { id?: string; embedding: number[] };
type VectorMem = VectorMemInput & { id: string };
type OriginalMem = Attributes & { id: string };
export type Evidence = Attributes & { id: string; kind: 'mem' | 'chunk'; memId: string; content: string; start: number; end: number };
export type VectorEvidence = Attributes & { id: string; kind: 'mem'; memId: string };
type StoredDocument = Record<string, unknown> & { id: string; chunkSlots?: number };
type Batch = { ids: string[]; docs: StoredDocument[] };
type Executor = <T>(operation: () => Promise<T>) => Promise<T>;
type QueryBody = Pick<NativeQuery, 'query' | 'size' | 'candidateSize' | 'rerank' | 'facets'>;
type ReadRequest = { ids: string[] };
type PageRequest = { limit?: number | undefined; cursor?: string | undefined };
type RememberRequest = { mems: unknown[] };
type ForgetRequest = { ids: string[]; filter?: never } | { filter: Filter; ids?: never };
type ConfigureRequest = { metadataSchema?: MetadataSchema | undefined; description?: string | undefined };
type CatalogRequest = PageRequest & { client: NativeClient; labels?: Record<string, string> | undefined };

// Keep v0 until release; recreate development stores after incompatible layout changes.
const format = 'mems-v0';
const encoder = new TextEncoder();
const requestBytes = 6029312;
const documentBytes = 5 * 1024 * 1024;
const defaultBranch = 'main';
const validBranchName = (name: unknown): name is string => typeof name === 'string' && /^[A-Za-z0-9_-]{3,52}$/.test(name);
function checkBranch(name: unknown): asserts name is string { requireInput(validBranchName(name), 'Branch name must be 3–52 letters, digits, underscores or hyphens.'); }
const systemIndexes: Record<string, IndexConfigsUnion> = {
    memId: { type: 'keyword' },
    kind: { type: 'keyword' },
    embedding: { type: 'vector', managedEmbedding: true, embedding: {
        provider: 'openai', model: 'text-embedding-3-small', sourceField: 'content', dimensions: 1536, similarity: 'cosine',
    } },
    timestamp: { type: 'datetime' },
};
const types = { string: 'keyword', 'string[]': 'keyword', number: 'double', boolean: 'boolean', datetime: 'datetime' } as const;
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const keysOnly = (value: unknown, keys: string[]): value is Record<string, unknown> => isObject(value) && Object.keys(value).every(key => keys.includes(key));
const keywordNames = (schema: MetadataSchema) => Object.entries(schema).filter(([, value]) => ['string', 'string[]'].includes(value.type)).map(([key]) => key).sort();

const supportedAnalyzers: ReadonlySet<unknown> = new Set(Object.values(Analyzer));
const validAnalyzers = (names: unknown): names is Analyzer[] => Array.isArray(names) && names.length > 0
    && new Set(names).size === names.length && [...names].every(name => supportedAnalyzers.has(name));
function validateTextSearch(value: unknown): TextSearch | undefined {
    if (value === undefined) return undefined;
    requireInput(keysOnly(value, ['analyzers']) && validAnalyzers(value.analyzers),
        'textSearch requires a nonempty array of distinct supported lowercase analyzers.');
    return { analyzers: [...value.analyzers] };
}
function storedTextSearch(config: unknown): TextSearch | undefined {
    if (config === undefined) return undefined;
    const names = isObject(config) ? config.analyzers ?? ['standard'] : undefined;
    if (!isObject(config) || config.type !== 'text' || !validAnalyzers(names))
        throw new MemDriveError('INCOMPATIBLE_STORE', 'The content text index must use distinct supported analyzers.');
    return { analyzers: [...names] };
}
const managedEmbedding = Object.freeze({ mode: 'managed', provider: 'openai', model: 'text-embedding-3-small',
    dimensions: 1536, similarity: 'cosine' } as const);
function validateEmbedding(value: unknown): EmbeddingConfig {
    if (value === undefined || (isObject(value) && value.mode === 'managed')) {
        requireInput(value === undefined || keysOnly(value, ['mode']), 'Managed embedding accepts only mode; its model settings are fixed.');
        return managedEmbedding;
    }
    requireInput(keysOnly(value, ['mode', 'dimensions', 'similarity', 'identity']) && value.mode === 'external'
        && typeof value.dimensions === 'number' && Number.isInteger(value.dimensions) && value.dimensions >= 64 && value.dimensions <= 4096
        && value.similarity === 'cosine' && typeof value.identity === 'string' && value.identity.trim().length > 0
        && value.identity.length <= 127 && !/[:#,]/.test(value.identity),
    'External embedding requires dimensions 64–4096, cosine similarity and a nonblank identity of at most 127 characters without :, # or comma.');
    return Object.freeze({ mode: 'external', dimensions: value.dimensions, similarity: 'cosine', identity: value.identity });
}
function storedEmbedding(collection: CollectionResponse): EmbeddingConfig {
    const candidate = collection.indexConfigs?.embedding;
    const vector: Record<string, unknown> | undefined = isObject(candidate) ? candidate : undefined;
    const rawEmbedding = vector?.embedding;
    const embedding = isObject(rawEmbedding) ? rawEmbedding : undefined;
    if (vector?.type === 'vector' && rawEmbedding === undefined && vector.managedEmbedding !== true) {
        try { return validateEmbedding({ mode: 'external', dimensions: vector.dimensions,
            similarity: vector.similarity, identity: collection.tags?.['memory.embedding'] }); }
        catch (cause) { throw new MemDriveError('INCOMPATIBLE_STORE', 'Invalid external embedding configuration.', { cause }); }
    }
    if (vector?.type !== 'vector' || vector.managedEmbedding === false || embedding?.provider !== managedEmbedding.provider
        || embedding.model !== managedEmbedding.model || embedding.sourceField !== 'content'
        || embedding.dimensions !== managedEmbedding.dimensions || embedding.similarity !== managedEmbedding.similarity
        || vector.dimensions !== undefined || vector.similarity !== undefined || collection.tags?.['memory.embedding'] !== undefined)
        throw new MemDriveError('INCOMPATIBLE_STORE', 'Invalid managed embedding configuration.');
    return managedEmbedding;
}
function indexConfigs(schema: MetadataSchema, textSearch: TextSearch | undefined, embedding: EmbeddingConfig): Record<string, IndexConfigsUnion> {
    const result = structuredClone(systemIndexes);
    if (embedding.mode === 'external') result.embedding = { type: 'vector', dimensions: embedding.dimensions, similarity: embedding.similarity };
    if (textSearch) result.content = { type: 'text', analyzers: [...textSearch.analyzers] as Analyzer[] };
    if (Object.keys(schema).length) result.metadata = { type: 'object', objectIndexConfigs:
        Object.fromEntries(Object.entries(schema).map(([key, { type, description }]) => [key, { type: types[type],
            ...(description === undefined ? {} : { description }) }])) };
    return result;
}

// Native tags allow five short values, not an arbitrary JSON schema. Native index
// types recover scalar types; this canonical bitmap preserves array cardinality
// over sorted keyword metadata names. Changing that order regenerates the bitmap.
function arrayTag(schema: MetadataSchema) {
    const names = keywordNames(schema), bits = new Uint8Array(Math.ceil(names.length / 8));
    names.forEach((key, i) => { if (schema[key]!.type === 'string[]') bits[i >> 3] = bits[i >> 3]! | 1 << (i % 8); });
    const encoded = bits.length ? btoa(String.fromCharCode(...bits)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') : '-';
    requireInput(encoded.length <= 127, 'Metadata keyword declarations exceed the native format-tag capacity.');
    return encoded;
}
function validateLabels(labels: unknown = {}): Record<string, string> {
    // Match native Java whitespace exactly, including control separators.
    // eslint-disable-next-line no-control-regex
    const blank = /^[\u0009-\u000d\u001c-\u0020\u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]*$/u;
    requireInput(isObject(labels) && Object.keys(labels).length <= 5 && Object.entries(labels).every(([key, value]) =>
        /^[A-Za-z0-9_.-]{1,63}$/.test(key) && !key.startsWith('memory.') && typeof value === 'string'
        && value.length >= 1 && value.length <= 127 && !/[:#,]/.test(value) && !blank.test(value)),
    'Labels must use native-safe tag names and values; memory.* names are reserved.');
    return structuredClone(labels) as Record<string, string>;
}
function collectionLabels(collection: CollectionResponse) {
    try {
        requireInput(isObject(collection.tags) && Object.keys(collection.tags).length <= 5, 'Invalid collection tags.');
        return validateLabels(Object.fromEntries(Object.entries(collection.tags).filter(([key]) => !key.startsWith('memory.'))));
    } catch (cause) { throw new MemDriveError('INCOMPATIBLE_STORE', 'Invalid MemDrive labels.', { cause }); }
}
function descriptor(collection: CollectionResponse): DriveDescriptor {
    const metadataSchema = schemaFromCollection(collection, collection.collectionName);
    const textSearch = storedTextSearch(collection.indexConfigs.content);
    return { name: collection.collectionName, ...(collection.description === undefined ? {} : { description: collection.description }),
        labels: collectionLabels(collection), metadataSchema,
        ...(textSearch ? { textSearch } : {}), embedding: structuredClone(storedEmbedding(collection)) };
}

function tags(schema: MetadataSchema, embedding: EmbeddingConfig) {
    return { 'memory.format': format, 'memory.arrays': arrayTag(schema),
        ...(embedding.mode === 'external' ? { 'memory.embedding': embedding.identity } : {}) };
}
function schemaFromCollection(collection: CollectionResponse | undefined, name: string): MetadataSchema {
    const fail: (condition: unknown) => asserts condition = condition => { if (!condition) throw new MemDriveError('INCOMPATIBLE_STORE', 'Collection is not a compatible MemDrive.'); };
    fail(isObject(collection) && collection.collectionName === name && collection.defaultBranchName === defaultBranch
        && collection.tags?.['memory.format'] === format
        && collection.partitionConfig === undefined && (collection.numPartitions === undefined || collection.numPartitions === 1));
    try { validateDescription(collection.description); } catch { fail(false); }
    const configs = collection.indexConfigs;
    fail(isObject(configs) && Object.keys(configs).every(key => ['id', 'content', ...Object.keys(systemIndexes), 'metadata'].includes(key)));
    storedTextSearch(configs.content);
    fail(configs.memId?.type === 'keyword' && configs.kind?.type === 'keyword'
        && configs.timestamp?.type === 'datetime' && (configs.id === undefined || configs.id.type === 'keyword'));
    const embedding = storedEmbedding(collection);
    fail(embedding.mode !== 'external' || configs.content === undefined);
    fail(configs.metadata === undefined || (configs.metadata.type === 'object' && isObject(configs.metadata.objectIndexConfigs)));
    fail(Object.values(configs.metadata?.type === 'object' ? configs.metadata.objectIndexConfigs : {}).every((config: unknown) => isObject(config)
        && typeof config.type === 'string' && ['keyword', 'double', 'boolean', 'datetime'].includes(config.type)));
    const metadataConfigs: Record<string, unknown> = configs.metadata?.type === 'object' ? configs.metadata.objectIndexConfigs : {};
    const publicTypes = { keyword: 'string', double: 'number', boolean: 'boolean', datetime: 'datetime' } as const;
    const declarations = Object.fromEntries(Object.entries(metadataConfigs).map(([key, config]) => {
        // The allowed native types were checked above; validate the complete public declaration below.
        fail(isObject(config) && typeof config.type === 'string' && Object.hasOwn(publicTypes, config.type));
        return [key, { type: publicTypes[config.type as keyof typeof publicTypes],
            ...(config.description === undefined ? {} : { description: config.description }) }];
    }));
    let schema: MetadataSchema;
    try { schema = validateMetadataSchema(declarations); } catch { fail(false); }

    const names = keywordNames(schema), encoded = collection.tags['memory.arrays'];
    fail(typeof encoded === 'string' && encoded.length <= 127 && (encoded === '-' || /^[A-Za-z0-9_-]+$/.test(encoded)));
    let raw = '';
    try { raw = encoded === '-' ? '' : atob(encoded.replaceAll('-', '+').replaceAll('_', '/')); } catch { fail(false); }
    fail(raw.length === Math.ceil(names.length / 8));
    names.forEach((key, i) => { if (raw.charCodeAt(i >> 3) & (1 << (i % 8))) schema[key]!.type = 'string[]'; });
    fail(arrayTag(schema) === encoded); // Reject padding bits and noncanonical encodings.
    return schema;
}

function validateAttributes(mem: Record<string, unknown>, schema: MetadataSchema, requireId: boolean) {
    if (requireId || Object.hasOwn(mem, 'id')) requireInput(typeof mem.id === 'string'
        && mem.id.trim().length > 0 && mem.id.length <= 512, 'Mem id must be nonempty text of at most 512 characters.');
    if (Object.hasOwn(mem, 'timestamp')) requireInput(validScalar(mem.timestamp, 'datetime'), 'timestamp must be RFC 3339 text.');
    if (Object.hasOwn(mem, 'metadata')) {
        requireInput(isObject(mem.metadata), 'metadata must be an object.');
        for (const [key, value] of Object.entries(mem.metadata)) {
            requireInput(Object.hasOwn(schema, key), 'Mem includes undeclared metadata.');
            const { type } = schema[key]!;
            requireInput(type === 'string[]' ? Array.isArray(value) && value.every(item => validScalar(item, 'string'))
                : validScalar(value, type), 'Metadata value does not match its declared type or indexing limits.');
        }
    }
}
export function validateMem(mem: unknown, schema: MetadataSchema, options: { requireId: true }): TextMem;
export function validateMem(mem: unknown, schema: MetadataSchema, options?: { requireId?: boolean }): TextMemInput;
export function validateMem(mem: unknown, schema: MetadataSchema, { requireId = false }: { requireId?: boolean } = {}): TextMemInput {
    requireInput(keysOnly(mem, ['id', 'content', 'timestamp', 'metadata']), 'Mem accepts only id, content, timestamp and metadata.');
    requireInput(typeof mem.content === 'string' && mem.content.trim().length > 0, 'Mem content must be nonempty text.');
    validateAttributes(mem, schema, requireId);
    requireInput(bytes(mem) <= documentBytes, 'Mem exceeds the native document byte limit.');
    return structuredClone(mem) as TextMemInput;
}
export function validateVector(vector: unknown, embedding: EmbeddingConfig): number[] {
    requireInput(Array.isArray(vector) && vector.length === embedding.dimensions
        && [...vector].every(value => typeof value === 'number' && Number.isFinite(value))
        && vector.some(value => value !== 0), 'Embedding must be a dense, finite, nonzero vector with the configured dimensions.');
    return [...vector];
}
export function validateVectorMem(mem: unknown, schema: MetadataSchema, embedding: EmbeddingConfig, options: { requireId: true }): VectorMem;
export function validateVectorMem(mem: unknown, schema: MetadataSchema, embedding: EmbeddingConfig, options?: { requireId?: boolean }): VectorMemInput;
export function validateVectorMem(mem: unknown, schema: MetadataSchema, embedding: EmbeddingConfig, { requireId = false }: { requireId?: boolean } = {}): VectorMemInput {
    requireInput(keysOnly(mem, ['id', 'embedding', 'timestamp', 'metadata']), 'External Mem accepts only id, embedding, timestamp and metadata.');
    validateAttributes(mem, schema, requireId);
    const result = { ...structuredClone(mem), embedding: validateVector(mem.embedding, embedding) };
    requireInput(bytes(result) <= documentBytes, 'Mem exceeds the native document byte limit.');
    return result as VectorMemInput;
}

const digest = async (id: string) => [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(id)))]
    .map(value => value.toString(16).padStart(2, '0')).join('');
export const sourceDocumentId = async (id: string) => `mem:${await digest(id)}`;
const chunkDocumentId = (sourceId: string, ordinal: number) => `chunk:${sourceId.slice(4)}:${ordinal}`;
function attributes(mem: Attributes): Attributes;
function attributes(mem: Record<string, unknown>): Record<string, unknown>;
function attributes(mem: { timestamp?: unknown; metadata?: unknown }): { timestamp?: unknown; metadata?: unknown } {
    return { ...(mem.timestamp === undefined ? {} : { timestamp: mem.timestamp }),
        ...(mem.metadata === undefined ? {} : { metadata: structuredClone(mem.metadata) }) };
}


type PublicEvidence<T> = T extends Evidence | VectorEvidence ? Omit<T, 'id'> : never;
export function publicMatch<T extends Evidence | VectorEvidence>(evidence: T): PublicEvidence<T> {
    const { id: _id, ...match } = evidence;
    return structuredClone(match) as PublicEvidence<T>;
}
export async function sourceMatch(mem: TextMem): Promise<Evidence> {
    return { id: await sourceDocumentId(mem.id), kind: 'mem', memId: mem.id, content: mem.content,
        start: 0, end: mem.content.length, ...attributes(mem) };
}
export async function validateChunk(doc: unknown, schema: MetadataSchema): Promise<Evidence> {
    if (isObject(doc) && doc.kind === 'mem') {
        requireInput(Object.hasOwn(doc, 'content'), 'A Mem without searchable content is not a search result.');
        return sourceMatch(await validateSource(doc, schema));
    }
    requireInput(keysOnly(doc, ['id', 'kind', 'memId', 'content', 'start', 'end', 'timestamp', 'metadata'])
        && doc.kind === 'chunk', 'Expected a stored chunk.');
    const mem = validateMem({ id: doc.memId, content: doc.content, ...attributes(doc) }, schema, { requireId: true });
    requireInput(typeof doc.start === 'number' && Number.isSafeInteger(doc.start) && doc.start >= 0 && typeof doc.end === 'number' && Number.isSafeInteger(doc.end)
        && doc.end > doc.start && doc.end - doc.start === mem.content.length
        && [...mem.content].length <= 800, 'Invalid chunk source span.');
    const prefix = `chunk:${await digest(mem.id)}:`;
    requireInput(typeof doc.id === 'string' && doc.id.startsWith(prefix)
        && /^(0|[1-9][0-9]*)$/.test(doc.id.slice(prefix.length))
        && Number.isSafeInteger(Number(doc.id.slice(prefix.length))), 'Invalid chunk identity.');
    return { id: doc.id, kind: 'chunk', memId: mem.id, content: mem.content, start: doc.start, end: doc.end, ...attributes(mem) };
}
export async function validateSource(doc: unknown, schema: MetadataSchema): Promise<TextMem> {
    const whole = isObject(doc) && Object.hasOwn(doc, 'content');
    requireInput(keysOnly(doc, ['id', 'kind', 'memId', whole ? 'content' : 'memContent', 'chunkCount', 'chunkSlots', 'chunkingPolicy', 'timestamp', 'metadata'])
        && doc.kind === 'mem' && doc.chunkingPolicy === CHUNKING_POLICY, 'Expected a compatible stored original Mem.');
    const mem = validateMem({ id: doc.memId, content: whole ? doc.content : doc.memContent, ...attributes(doc) }, schema, { requireId: true });
    requireInput(typeof doc.id === 'string' && doc.id === await sourceDocumentId(mem.id) && typeof doc.chunkCount === 'number' && Number.isSafeInteger(doc.chunkCount) && doc.chunkCount >= 1
        && typeof doc.chunkSlots === 'number' && Number.isSafeInteger(doc.chunkSlots) && doc.chunkSlots >= (whole ? 0 : doc.chunkCount)
        && (!whole || (doc.chunkCount === 1 && [...mem.content].length <= 800)),
    'Invalid original Mem manifest.');
    const smallestSlot = { id: chunkDocumentId(doc.id, 0), kind: 'chunk', memId: mem.id, ...attributes(mem) };
    requireInput(bytes(doc) <= documentBytes && bytes(doc) + doc.chunkSlots * (bytes(smallestSlot) + 1) <= requestBytes,
        'Original Mem manifest exceeds the complete replacement limit.');
    return mem;
}
export async function vectorSource(doc: unknown, schema: MetadataSchema): Promise<OriginalMem> {
    requireInput(keysOnly(doc, ['id', 'kind', 'memId', 'timestamp', 'metadata']) && doc.kind === 'mem',
        'Expected an external original Mem without vector values.');
    const candidate = { id: doc.memId, ...attributes(doc) };
    validateAttributes(candidate, schema, true);
    const mem = candidate as OriginalMem;
    requireInput(doc.id === await sourceDocumentId(mem.id) && bytes(doc) <= documentBytes, 'Invalid external original Mem.');
    return mem as OriginalMem;
}
export async function vectorMatch(doc: unknown, schema: MetadataSchema): Promise<VectorEvidence> {
    const mem = await vectorSource(doc, schema);
    return { id: (doc as StoredDocument).id, kind: 'mem', memId: mem.id, ...attributes(mem) };
}

function originalIds(request: unknown): string[] {
    requireInput(keysOnly(request, ['ids']) && Array.isArray(request.ids) && request.ids.length > 0
        && request.ids.every(id => typeof id === 'string' && id.trim().length > 0 && id.length <= 512)
        && new Set(request.ids).size === request.ids.length, 'read requires distinct nonempty Mem IDs.');
    return [...request.ids];
}

function databaseError(error: unknown, message: string, details?: Record<string, unknown>): MemDriveError {
    if (error instanceof MemDriveError) {
        if (details !== undefined) error.details = { ...error.details, ...details };
        return error;
    }
    const result = new MemDriveError('DATABASE_ERROR', message, { cause: error, details });
    const remote = error as { statusCode?: unknown; status?: unknown; httpStatus?: unknown } | null | undefined;
    const status = remote?.statusCode ?? remote?.status ?? remote?.httpStatus;
    if (typeof status === 'number' && Number.isInteger(status)) result.status = status;
    return result;
}

function validateConnection({ client, name }: Connection) {
    requireInput(client && typeof client.collection === 'function', 'Provide an initialized LambdaDB client.');
    requireInput(typeof name === 'string' && /^[A-Za-z0-9_-]{3,52}$/.test(name), 'MemDrive name must be 3–52 letters, digits, underscores or hyphens.');
}

async function nativeRequest<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    checkAbort(signal);
    try { return await operation(); }
    catch (cause) { throw abortError(cause, signal); }
}
const nativeOptions = (signal?: AbortSignal) => signal === undefined ? {} : { signal };
const guarded = (assertActive: () => void, signal?: AbortSignal) => () => { checkAbort(signal); assertActive(); };

async function load(handle: NativeHandle, name: string, options?: RequestOptions) {
    const { signal } = operationOptions(options);
    let result;
    try { result = await nativeRequest(() => handle.get(nativeOptions(signal)), signal); } catch (error) { throw databaseError(error, 'Could not inspect the MemDrive.'); }
    checkAbort(signal);
    const schema = schemaFromCollection(result?.collection, name);
    collectionLabels(result.collection);
    return { result: structuredClone(result), schema, embedding: storedEmbedding(result.collection),
        textSearch: storedTextSearch(result.collection.indexConfigs.content) };
}

function backend(handle: NativeHandle, name: string, initial: Awaited<ReturnType<typeof load>>) {
    let schema = initial.schema, textSearch = initial.textSearch, generation = 0, deleted = false;
    const embedding = initial.embedding;
    const decodeSource = (doc: unknown): Promise<Mem> => embedding.mode === 'external' ? vectorSource(doc, schema) : validateSource(doc, schema);
    let schemaUpdates = Promise.resolve();
    const branchEpochs = new Map<string, number>();
    const epoch = (branch: string) => branchEpochs.get(branch) ?? 0;
    const retire = (branch: string) => { branchEpochs.set(branch, epoch(branch) + 1); generation++; };
    const active = () => { if (deleted) throw new MemDriveError('STORE_DELETED', 'This MemDrive has been deleted.'); };
    const refresh = async (options?: RequestOptions) => {
        const { signal } = operationOptions(options);
        const check = guarded(active, signal); check();
        const state = await load(handle, name, nativeOptions(signal));
        check();
        if (!same(embedding, state.embedding)) throw new MemDriveError('INCOMPATIBLE_STORE', 'Embedding configuration changed; reopen the MemDrive.');
        if (!same(schema, state.schema) || !same(textSearch, state.textSearch)) generation++;
        schema = state.schema; textSearch = state.textSearch;
        return state.result;
    };
    const fetchOriginals = async (ids: string[], branch: string, assertActive: () => void, execute: Executor = operation => operation(), signal?: AbortSignal) => {
        const found = new Map<string, StoredDocument>();
        for (let start = 0; start < ids.length; start += 1000) {
            assertActive();
            const batch = ids.slice(start, start + 1000), expected = new Set(batch);
            const documentIds = await Promise.all(batch.map(sourceDocumentId));
            assertActive();
            let response;
            try { response = await execute(() => {
                assertActive();
                return nativeRequest(() => handle.docs.fetch({ ids: documentIds,
                    ref: { kind: 'branch', name: branch }, consistentRead: true, includeVectors: false }, nativeOptions(signal)), signal);
            }); }
            catch (error) { throw databaseError(error, 'Could not read original Mems.'); }
            assertActive();
            if (response?.isDocsInline === false || !Array.isArray(response?.docs) || response.docs.length > batch.length)
                throw new MemDriveError('INVALID_RESULT', 'Original read returned an invalid document envelope.');
            for (const hit of response.docs) {
                try {
                    requireInput(hit.collection === undefined || hit.collection === name, 'Original read returned another collection.');
                    const mem = await decodeSource(hit.doc);
                    requireInput(expected.has(mem.id) && !found.has(mem.id), 'Original read returned unexpected or duplicate Mems.');
                    found.set(mem.id, structuredClone(hit.doc) as StoredDocument);
                } catch (cause) { throw new MemDriveError('INVALID_RESULT', 'Original read returned an invalid Mem.', { cause }); }
            }
        }
        assertActive();
        return found;
    };
    const api = {
        get metadataSchema() { return structuredClone(schema); },
        get textSearch() { return structuredClone(textSearch); },
        get embedding() { return Object.freeze(structuredClone(embedding)); },
        get generation() { return generation; },
        assertActive: active,
        describe: refresh,
        async describeDescriptor(options?: RequestOptions) {
            const { signal } = operationOptions(options);
            const result = await refresh({ signal });
            guarded(active, signal)();
            return descriptor(result.collection);
        },
        at(branch: string) {
            active(); checkBranch(branch);
            const version = epoch(branch);
            const assertActive = () => {
                active();
                if (version !== epoch(branch)) throw new MemDriveError('BRANCH_INVALIDATED', 'This branch handle was invalidated by deletion; select the branch again.');
            };
            return {
                get metadataSchema() { return api.metadataSchema; },
                get textSearch() { return api.textSearch; },
                get embedding() { return api.embedding; },
                get generation() { return generation; },
                assertActive,
                describe: async (options?: RequestOptions) => { assertActive(); const result = await refresh(options); guarded(assertActive, options?.signal)(); return result; },
                describeDescriptor: async (options?: RequestOptions) => { assertActive(); const result = await api.describeDescriptor(options); guarded(assertActive, options?.signal)(); return result; },
                async query(body: QueryBody, options?: RequestOptions) { assertActive(); const result = await api.query(body, options, branch, assertActive); guarded(assertActive, options?.signal)(); return result; },
                remember: (request: RememberRequest, options?: RequestOptions) => { assertActive(); return api.remember(request, options, branch, assertActive); },
                list: (request?: PageRequest, options?: RequestOptions) => { assertActive(); return api.list(request, options, branch, assertActive); },
                read: (request: ReadRequest, execute?: Executor, options?: RequestOptions) => { assertActive(); return api.read(request, execute, options, branch, assertActive); },
                forget: (request: ForgetRequest, options?: RequestOptions) => { assertActive(); return api.forget(request, options, branch, assertActive); },
            };
        },
        branches: {
            async create(request: { name: string; source?: { branch: string } | undefined }, options?: RequestOptions) {
                const { signal } = operationOptions(options);
                const check = guarded(active, signal); check();
                requireInput(keysOnly(request, ['name', 'source']), 'Use name and optional source for branch creation.');
                checkBranch(request.name);
                const source = request.source === undefined ? { branch: defaultBranch } : request.source;
                requireInput(keysOnly(source, ['branch']), 'A branch source must contain only branch.');
                checkBranch(source.branch);
                generation++;
                try {
                    const response = await nativeRequest(() => handle.branches.create({ branchName: request.name,
                        source: { kind: 'branch', name: source.branch } }, nativeOptions(signal)), signal);
                    check();
                    if (!isObject(response?.branch) || response.branch.name !== request.name)
                        throw new MemDriveError('INVALID_RESULT', 'Branch creation returned an invalid branch.');
                    return structuredClone(response.branch);
                } catch (error) {
                    const wrapped = databaseError(error, 'MemDrive branch creation failed.');
                    if (wrapped.status === 404) wrapped.code = 'BRANCH_NOT_FOUND';
                    if (wrapped.status === 409) wrapped.code = 'BRANCH_EXISTS';
                    throw wrapped;
                } finally { generation++; }
            },
            async list(options?: RequestOptions) {
                const { signal } = operationOptions(options);
                const check = guarded(active, signal); check();
                let response;
                try { response = await nativeRequest(() => handle.branches.list(nativeOptions(signal)), signal); }
                catch (error) { throw databaseError(error, 'Could not list MemDrive branches.'); }
                check();
                if (!Array.isArray(response?.branches) || !response.branches.every(item => isObject(item) && validBranchName(item.name))
                    || new Set(response.branches.map(item => item.name)).size !== response.branches.length)
                    throw new MemDriveError('INVALID_RESULT', 'Branch listing returned invalid branches.');
                return structuredClone(response.branches);
            },
            async delete(branch: string, options?: RequestOptions) {
                const { signal } = operationOptions(options);
                const check = guarded(active, signal); check(); checkBranch(branch);
                requireInput(branch !== defaultBranch, 'The main branch cannot be deleted independently of its MemDrive.');
                generation++;
                try { await nativeRequest(() => handle.branches.delete(branch, nativeOptions(signal)), signal); }
                catch (error) {
                    const wrapped = databaseError(error, 'MemDrive branch deletion failed.');
                    // A missing or uncertain deletion must not let old handles
                    // silently bind to a later branch with the same name.
                    if (wrapped.status === 404 || !(wrapped.status !== undefined && wrapped.status >= 400 && wrapped.status < 500)) retire(branch);
                    if (wrapped.status === 404) wrapped.code = 'BRANCH_NOT_FOUND';
                    if (wrapped.status === 409) wrapped.code = 'BRANCH_CONFLICT';
                    throw wrapped;
                } finally { generation++; }
                retire(branch);
                check();
            },
        },
        async query(body: QueryBody, options?: RequestOptions, branch = defaultBranch, assertActive = active) {
            const { signal } = operationOptions(options);
            const check = guarded(assertActive, signal); check();
            requireInput(keysOnly(body, ['query', 'size', 'candidateSize', 'rerank', 'facets']), 'Query cannot override the managed read settings.');
            try {
                const result = await nativeRequest(() => handle.query({ ...structuredClone(body),
                    ref: { kind: 'branch', name: branch }, consistentRead: true, includeVectors: false }, nativeOptions(signal)), signal);
                check(); return result;
            }
            catch (error) { throw databaseError(error, 'MemDrive query failed.'); }
        },
        async read(request: ReadRequest, execute?: Executor, options?: RequestOptions, branch = defaultBranch, assertActive = active) {
            const { signal } = operationOptions(options);
            assertActive = guarded(assertActive, signal); assertActive();
            const ids = originalIds(request);
            const originals = await fetchOriginals(ids, branch, assertActive, execute, signal);
            const mems = await Promise.all(ids.filter(id => originals.has(id)).map(id => decodeSource(originals.get(id))));
            assertActive();
            return { mems };
        },
        async list(request: PageRequest = {}, options?: RequestOptions, branch = defaultBranch, assertActive = active) {
            const { signal } = operationOptions(options);
            assertActive = guarded(assertActive, signal); assertActive();
            requireInput(keysOnly(request, ['cursor', 'limit']), 'list accepts cursor and limit only.');
            const limit = request.limit ?? 100;
            requireInput(Number.isInteger(limit) && limit >= 1 && limit <= 1000, 'list limit must be between 1 and 1000.');
            requireInput(request.cursor === undefined || (typeof request.cursor === 'string' && request.cursor.length > 0),
                'list cursor must be a nonempty opaque token.');
            let response;
            try { response = await nativeRequest(() => handle.docs.list({ size: limit, ...(request.cursor === undefined ? {} : { pageToken: request.cursor }),
                includeVectors: false, ref: { kind: 'branch', name: branch } }, nativeOptions(signal)), signal); }
            catch (error) { throw databaseError(error, 'Could not list Mems.'); }
            assertActive();
            if (response?.isDocsInline === false || !Array.isArray(response?.docs) || response.docs.length > limit
                || (response.nextPageToken !== undefined && (typeof response.nextPageToken !== 'string' || !response.nextPageToken
                    || response.nextPageToken === request.cursor)))
                throw new MemDriveError('INVALID_RESULT', 'Mem listing returned an invalid page.');
            const mems: Mem[] = [], seen = new Set<string>();
            for (const hit of response.docs) {
                try {
                    requireInput((hit.collection === undefined || hit.collection === name) && isObject(hit.doc)
                        && typeof hit.doc.kind === 'string' && ['mem', 'chunk'].includes(hit.doc.kind) && typeof hit.doc.id === 'string' && !seen.has(hit.doc.id),
                    'Listing returned an unexpected or duplicate document.');
                    seen.add(hit.doc.id);
                    if (hit.doc.kind === 'mem') mems.push(await decodeSource(hit.doc));
                } catch (cause) { throw new MemDriveError('INVALID_RESULT', 'Mem listing returned an invalid document.', { cause }); }
            }
            assertActive();
            return { mems, ...(response.nextPageToken === undefined ? {} : { nextCursor: response.nextPageToken }) };
        },
        async remember(request: RememberRequest, options?: RequestOptions, branch = defaultBranch, assertActive = active) {
            const { signal } = operationOptions(options);
            assertActive = guarded(assertActive, signal); assertActive();
            requireInput(keysOnly(request, ['mems']) && Array.isArray(request.mems) && request.mems.length > 0, 'remember requires a nonempty mems array.');
            const external = embedding.mode === 'external';
            const validate = (mem: unknown, options?: { requireId?: boolean }) => external ? validateVectorMem(mem, schema, embedding, options) : validateMem(mem, schema, options);
            const mems = request.mems.map(mem => {
                const validated = validate(mem);
                validated.id ??= globalThis.crypto.randomUUID();
                return (external ? validateVectorMem(validated, schema, embedding, { requireId: true })
                    : validateMem(validated, schema, { requireId: true }));
            });
            const ids = mems.map(mem => mem.id);
            requireInput(new Set(ids).size === ids.length, 'Mem IDs must be unique within remember.');
            let originals;
            try { originals = external ? new Map() : await fetchOriginals(ids, branch, assertActive, undefined, signal); }
            catch (error) {
                if (error instanceof MemDriveError && error.code === 'ABORTED') throw databaseError(error, 'MemDrive write was aborted before dispatch.', {
                    ids, completedIds: [], uncertainIds: [], notAttemptedIds: [...ids],
                });
                throw error;
            }
            const replacements = await Promise.all(mems.map(async mem => {
                const id = await sourceDocumentId(mem.id), shared = { memId: mem.id, ...attributes(mem) };
                let docs: StoredDocument[];
                if ('embedding' in mem) docs = [{ id, kind: 'mem', ...shared, embedding: mem.embedding }];
                else {
                    const spans = chunkSpans(mem.content).filter(span => span.text.trim());
                    const whole = spans.length === 1 && spans[0]!.start === 0 && spans[0]!.end === mem.content.length;
                    const chunkSlots = Math.max(originals.get(mem.id)?.chunkSlots ?? 0, whole ? 0 : spans.length);
                    docs = [{ id, kind: 'mem', ...shared, ...(whole ? { content: mem.content } : { memContent: mem.content }),
                        chunkCount: spans.length, chunkSlots, chunkingPolicy: CHUNKING_POLICY }];
                    for (let ordinal = 0; ordinal < chunkSlots; ordinal++) {
                        const span = whole ? undefined : spans[ordinal];
                        docs.push({ id: chunkDocumentId(id, ordinal), kind: 'chunk', ...shared,
                            ...(span ? { content: span.text, start: span.start, end: span.end } : {}) });
                    }
                }
                requireInput(docs.every(doc => bytes(doc) <= documentBytes) && bytes({ docs, branch }) <= requestBytes,
                    'A complete Mem replacement exceeds the native request or document byte limit.');
                return { ids: [mem.id], docs };
            }));
            // Greedily pack complete Mem replacements. No request may contain
            // only part of a replacement, and all requests validate before writes.
            const batches: Batch[] = [];
            let batch: Batch = { ids: [], docs: [] }, size = bytes({ docs: [], branch });
            for (const replacement of replacements) {
                const addition = replacement.docs.reduce((sum, doc) => sum + bytes(doc) + 1, 0);
                const nextSize = size + addition - (batch.docs.length ? 0 : 1);
                if (batch.docs.length && nextSize > requestBytes) {
                    batches.push(batch); batch = { ids: [], docs: [] }; size = bytes({ docs: [], branch });
                }
                size += addition - (batch.docs.length ? 0 : 1);
                batch.ids.push(...replacement.ids); batch.docs.push(...replacement.docs);
            }
            if (batch.docs.length) batches.push(batch);
            const completedIds: string[] = [];
            const checkWritable = () => {
                try { assertActive(); }
                catch (error) { throw databaseError(error, 'MemDrive branch changed during write.', {
                    ids, completedIds: [...completedIds], uncertainIds: [], notAttemptedIds: ids.slice(completedIds.length),
                }); }
            };
            for (const batch of batches) {
                checkWritable();
                generation++;
                try { await nativeRequest(() => handle.docs.upsert({ docs: batch.docs, branch }, nativeOptions(signal)), signal); }
                catch (error) {
                    throw databaseError(error, 'MemDrive write failed; some mems may already have been accepted.', {
                        ids, completedIds: [...completedIds], uncertainIds: [...batch.ids],
                        notAttemptedIds: ids.slice(completedIds.length + batch.ids.length),
                    });
                } finally { generation++; }
                completedIds.push(...batch.ids);
            }
            checkWritable();
            return { ids };
        },
        async forget(request: ForgetRequest, options?: RequestOptions, branch = defaultBranch, assertActive = active) {
            const { signal } = operationOptions(options);
            const check = guarded(assertActive, signal); check();
            requireInput(keysOnly(request, ['ids', 'filter']) && Object.keys(request).length === 1, 'forget requires exactly one of ids or filter.');
            let body;
            if (Object.hasOwn(request, 'ids')) {
                requireInput(Array.isArray(request.ids) && request.ids.length > 0
                    && request.ids.every(id => typeof id === 'string' && id.trim().length > 0 && id.length <= 512)
                    && new Set(request.ids).size === request.ids.length, 'forget IDs must be nonempty and unique.');
                body = { filter: compileFilter({ field: 'id', op: 'in', value: [...request.ids] }, schema), branch };
            } else {
                requireInput(request.filter !== undefined, 'forget filter must be an explicit expression.');
                body = { filter: compileFilter(request.filter, schema), branch };
            }
            generation++;
            try { await nativeRequest(() => handle.docs.delete(body, nativeOptions(signal)), signal); }
            catch (error) { throw databaseError(error, 'Mem deletion failed.'); }
            finally { generation++; }
            check();
        },
        async configure(request: ConfigureRequest, options?: RequestOptions) {
            const { signal } = operationOptions(options);
            const check = guarded(active, signal); check();
            requireInput(keysOnly(request, ['metadataSchema', 'description'])
                && (Object.hasOwn(request, 'metadataSchema') || request.description !== undefined),
            'configure requires metadataSchema, description, or both.');
            const desired = Object.hasOwn(request, 'metadataSchema') ? validateMetadataSchema(request.metadataSchema) : undefined;
            const description = validateDescription(request.description);
            const desiredTags = desired === undefined ? undefined : tags(desired, embedding); // Check format capacity before remote operations.
            // Serialize this handle's read/validate/write/verify sequence. Native
            // PATCH has no CAS for tags: applications must use one schema writer
            // across handles/processes; this queue is not a distributed lock.
            const update = schemaUpdates.then(async () => {
                check();
                const current = await refresh({ signal });
                const before = schemaFromCollection(current.collection, name);
                requireInput(desired === undefined || Object.entries(before).every(([key, value]) => desired[key]?.type === value.type), 'Schema updates may add fields but cannot omit or change existing fields.');
                const expected = desired === undefined ? before : Object.fromEntries(Object.entries(desired).map(([key, value]) => [key,
                    { ...before[key], ...value, ...(value.description === undefined && before[key]?.description !== undefined
                        ? { description: before[key].description } : {}) }]));
                const nextIndexes = structuredClone(current.collection.indexConfigs);
                const previousMetadata = nextIndexes.metadata?.type === 'object' ? nextIndexes.metadata : undefined;
                if (desired !== undefined && Object.keys(desired).length) nextIndexes.metadata = {
                    ...(previousMetadata ?? { type: 'object' as const }),
                    objectIndexConfigs: { ...previousMetadata?.objectIndexConfigs,
                        ...Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, {
                            ...previousMetadata?.objectIndexConfigs?.[key], type: types[value.type],
                            ...(value.description === undefined ? {} : { description: value.description }),
                        }])) },
                };
                const nextTags = { ...current.collection.tags, ...desiredTags };
                requireInput(Object.keys(nextTags).length <= 5, 'Collection tags exceed the native limit.');
                generation++;
                const updateRequest: Parameters<NativeHandle['update']>[0] = desired === undefined
                    ? { description: description! }
                    : { indexConfigs: nextIndexes, tags: nextTags, ...(description === undefined ? {} : { description }) };
                try { await nativeRequest(() => handle.update(updateRequest, nativeOptions(signal)), signal); }
                catch (error) { throw databaseError(error, 'MemDrive schema update failed; reopen to verify its outcome.'); }
                // Catch an observed conflicting writer; a later writer still needs
                // application coordination because native PATCH has no condition.
                check();
                const updated = (await refresh({ signal })).collection;
                const actual = schemaFromCollection(updated, name);
                if (Object.keys(actual).length !== Object.keys(expected).length
                    || !Object.entries(expected).every(([key, value]) => actual[key]?.type === value.type
                        && (actual[key]?.description ?? '') === (value.description ?? ''))
                    || (updated.description ?? '') !== (description ?? current.collection.description ?? ''))
                    throw new MemDriveError('SCHEMA_CONFLICT', 'Stored schema changed concurrently; reopen before proceeding.');
            });
            const settled = update.finally(() => { generation++; });
            schemaUpdates = settled.catch(() => {});
            return settled;
        },
        async destroy(options?: RequestOptions) {
            const { signal } = operationOptions(options);
            const check = guarded(active, signal); check();
            generation++;
            try { await nativeRequest(() => handle.delete(nativeOptions(signal)), signal); deleted = true; checkAbort(signal); }
            catch (error) { throw databaseError(error, 'MemDrive deletion failed.'); }
        },
    };
    return api;
}

export async function createBackend(options: CreateBackendOptions, requestOptions?: RequestOptions) {
    const { signal } = operationOptions(requestOptions); checkAbort(signal);
    validateConnection(options);
    requireInput(typeof options.client.createCollection === 'function', 'Client must support collection creation.');
    const schema = validateMetadataSchema(options.metadataSchema);
    const textSearch = validateTextSearch(options.textSearch);
    const embedding = validateEmbedding(options.embedding);
    requireInput(embedding.mode !== 'external' || textSearch === undefined, 'External embedding does not support a content text index.');
    const labels = validateLabels(options.labels);
    const description = validateDescription(options.description);
    const allTags = { ...labels, ...tags(schema, embedding) };
    requireInput(Object.keys(allTags).length <= 5, 'Labels and reserved MemDrive tags exceed the native five-tag limit.');
    const request = { collectionName: options.name, indexConfigs: indexConfigs(schema, textSearch, embedding), tags: allTags,
        ...(description === undefined ? {} : { description }) };
    try { await nativeRequest(() => options.client.createCollection(request, nativeOptions(signal)), signal); }
    catch (error) {
        const wrapped = databaseError(error, 'Could not create the MemDrive.');
        if (wrapped.status === 409) wrapped.code = 'STORE_EXISTS';
        throw wrapped;
    }
    checkAbort(signal);
    return openBackend(options, nativeOptions(signal));
}

export async function openBackend(options: Connection, requestOptions?: RequestOptions) {
    const { signal } = operationOptions(requestOptions); checkAbort(signal);
    validateConnection(options);
    const handle = options.client.collection(options.name);
    let state;
    try { state = await load(handle, options.name, nativeOptions(signal)); }
    catch (error) {
        if (error instanceof MemDriveError && error.status === 404) error.code = 'STORE_NOT_FOUND';
        throw error;
    }
    checkAbort(signal);
    return backend(handle, options.name, state);
}


export async function listBackends(request: CatalogRequest, options?: RequestOptions) {
    const { signal } = operationOptions(options); checkAbort(signal);
    requireInput(keysOnly(request, ['client', 'limit', 'cursor', 'labels']) && typeof request.client?.listCollections === 'function'
        && typeof request.client?.collection === 'function', 'Provide a LambdaDB client and documented catalog arguments.');
    const { client, cursor } = request;
    const limit = request.limit ?? 10, labels = validateLabels(request.labels);
    requireInput(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'Catalog limit must be between 1 and 100.');
    requireInput(cursor === undefined || (typeof cursor === 'string' && cursor.length > 0),
        'Catalog cursor must be a nonempty opaque token.');
    let page;
    try { page = await nativeRequest(() => client.listCollections({ size: limit,
        ...(cursor === undefined ? {} : { pageToken: cursor }) }, nativeOptions(signal)), signal); }
    catch (error) { throw databaseError(error, 'Could not list MemDrives.'); }
    checkAbort(signal);
    if (!Array.isArray(page?.collections) || page.collections.length > limit
        || !page.collections.every(item => isObject(item) && typeof item.collectionName === 'string'
            && /^[A-Za-z0-9_-]{3,52}$/.test(item.collectionName))
        || new Set(page.collections.map(item => item.collectionName)).size !== page.collections.length
        || (page.nextPageToken !== undefined && (typeof page.nextPageToken !== 'string'
            || !page.nextPageToken || page.nextPageToken === cursor)))
        throw new MemDriveError('INVALID_RESULT', 'MemDrive catalog returned an invalid page.');
    const drives: DriveDescriptor[] = [];
    const matches = (collection: CollectionResponse) => Object.entries(labels).every(([key, value]) => collection.tags?.[key] === value);
    for (let collection of page.collections) {
        checkAbort(signal);
        if (collection.tags?.['memory.format'] !== format || !matches(collection)) continue;
        try {
            if (collection.indexConfigs === undefined)
                collection = (await load(client.collection(collection.collectionName), collection.collectionName, nativeOptions(signal))).result.collection;
            const drive = descriptor(collection);
            if (matches(collection)) drives.push(drive);
        } catch (error) {
            if (!(error instanceof MemDriveError) || error.code !== 'INCOMPATIBLE_STORE') throw error;
        }
    }
    checkAbort(signal);
    return { drives, ...(page.nextPageToken === undefined ? {} : { nextCursor: page.nextPageToken }) };
}

export type Backend = ReturnType<typeof backend>;
export type DataBackend = Backend | ReturnType<Backend['at']>;
