// Provider-independent JSON Schema. Public SDK methods remain the authority for
// semantic checks such as declared metadata, UTF-8 limits and valid file IDs.
type Schema = Record<string, unknown>;
const string = { type: 'string' };
const scalar = { type: ['string', 'number', 'boolean'] };
const array = (items: Schema, maxItems?: number): Schema => ({ type: 'array', items, minItems: 1,
    ...(maxItems === undefined ? {} : { maxItems }) });
const object = (properties: Record<string, Schema> = {}, required: string[] = []) =>
    ({ type: 'object' as const, properties, additionalProperties: false, required });
const limit = (maximum: number) => ({ type: 'integer', minimum: 1, maximum });
const cursor = object({ cursor: string }, ['cursor']);
const continuation = (properties: Record<string, Schema>, required: string[] = []) => ({
    ...object({ ...properties, cursor: string }), oneOf: [object(properties, required), cursor],
});
const filter: Schema = { oneOf: [
    object({ and: array({ $ref: '#/$defs/filter' }) }, ['and']),
    object({ or: array({ $ref: '#/$defs/filter' }) }, ['or']),
    object({ field: { type: 'string', pattern: '^metadata\\..+' },
        op: { enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'] }, value: scalar }, ['field', 'op', 'value']),
    object({ field: { type: 'string', pattern: '^metadata\\..+' }, op: { const: 'in' }, value: array(scalar) }, ['field', 'op', 'value']),
    object({ field: { type: 'string', pattern: '^metadata\\..+' }, op: { const: 'exists' }, value: { type: 'boolean' } }, ['field', 'op', 'value']),
] };
const metadata = { type: 'object', additionalProperties: scalar };
const fileId = { type: 'string', description: 'A stable fileId returned by MemDrive.' };
const path = { type: 'string', description: 'An absolute file path within the bound drive.' };

export function fileToolSchemas(external: boolean, main: boolean) {
    const refVersion = main ? { version: { type: 'string', pattern: '^v(0|[1-9][0-9]*)$',
        description: 'Exact retained main publication, such as v3, or the retained initial v0. Omit for current main.' } } : {};
    const content = external ? array({ type: 'number' }) : string;
    const create = object({ op: { const: 'create' }, path, content, metadata }, ['op', 'path', 'content']);
    const updateProperties = { op: { const: 'update' }, fileId, newPath: path, content, metadata,
        ...(external ? {} : { edits: array(object({ oldText: { type: 'string', minLength: 1 }, newText: string }, ['oldText', 'newText'])) }) };
    const update = { ...object(updateProperties, ['op', 'fileId']),
        anyOf: ['newPath', 'content', 'metadata', ...(external ? [] : ['edits'])].map(key => ({ required: [key] })),
        ...(external ? {} : { not: { required: ['content', 'edits'] } }) };
    const remove = object({ op: { const: 'delete' }, fileId }, ['op', 'fileId']);
    const operation = { oneOf: [create, update, remove] };
    const batch = object({ operations: array(operation, 100) }, ['operations']);
    const searchProperties = { query: external ? array({ type: 'number' }) : { type: 'string', minLength: 1,
        description: 'Describe what you need for semantic search. For keyword search, supply focused names, identifiers or terms; not a whole conversation. Keyword input is analyzed, not query syntax or an exact-match guarantee.' },
        filter: { $ref: '#/$defs/filter' }, limit: limit(1000),
        ...(external ? {} : { mode: { enum: ['semantic', 'keyword', 'hybrid'], default: 'semantic',
            description: 'semantic: meaning and paraphrases (default). keyword: known terms. hybrid: explicitly combine both signals. No automatic mode switching.' },
        embeddingQuery: { type: 'string', minLength: 1,
            description: 'Optional separate input for embeddings and enabled reranking; defaults to query. Hybrid keeps query for keyword matching. Keyword mode permits this only with rerank enabled and does not embed it.' },
        rerank: { default: false,
            description: 'Optional additional model scoring of retrieved candidates, independent of mode. Defaults to false. true or an options object enables it, adding inference cost and latency; it cannot recover evidence outside the retrieved candidate pool.', oneOf: [
            { type: 'boolean' }, object({ fields: { ...array(string, 8), uniqueItems: true },
                onFailure: { enum: ['error', 'returnOriginal'] } }),
        ] } }) };
    const ranges = external ? {} : { startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 },
        maxChars: { type: 'integer', minimum: 2, maximum: 64000 }, offset: { type: 'integer', minimum: 0 },
        revision: { type: 'string', pattern: '^[0-9a-f]{64}$' } };
    return {
        guide: object(),
        status: object(),
        fork: object({ name: { type: 'string', minLength: 3, maxLength: 47,
            pattern: '^[A-Za-z0-9_-]+$', not: { const: 'main' } }, ...refVersion }, ['name']),
        checkpoint: object({ name: { type: 'string', minLength: 3, maxLength: 41, pattern: '^[A-Za-z0-9_-]+$' }, ...refVersion }, ['name']),
        history: continuation({ sinceVersion: { type: 'string', pattern: '^v(0|[1-9][0-9]*)$' }, limit: limit(100) }),
        list: continuation({ prefix: string, nameContains: string, delimiter: { const: '/' }, limit: limit(1000) }),
        read: { ...object({ fileId, path, paths: { ...array(path, 100), uniqueItems: true }, ...ranges }),
            oneOf: [object({ fileId, ...ranges }, ['fileId']), object({ path, ...ranges }, ['path']),
                object({ paths: { ...array(path, 100), uniqueItems: true } }, ['paths'])],
            ...(external ? {} : { dependencies: { offset: ['revision'] } }) },
        search: { ...object(searchProperties, ['query']), $defs: { filter }, ...(external ? {} : {
            if: { properties: { mode: { const: 'keyword' } }, required: ['mode', 'embeddingQuery'] },
            then: { properties: { rerank: { not: { const: false } } }, required: ['rerank'] },
        }) },
        findText: { ...continuation({ query: { type: 'string', minLength: 1 }, prefix: string,
            filter: { $ref: '#/$defs/filter' }, limit: limit(100) }, ['query']), $defs: { filter } },
        diff: object(),
        write: { ...object({ ...create.properties, ...updateProperties, op: { enum: ['create', 'update', 'delete'] },
            fileId, operations: batch.properties.operations! }),
            oneOf: [create, update, remove, batch] },
        merge: object({ requestId: { type: 'string', minLength: 1, maxLength: 128 },
            summary: { type: 'string', minLength: 1, maxLength: 1024 } }, ['requestId', 'summary']),
    };
}
