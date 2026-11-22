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

export function fileToolSchemas(external: boolean) {
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
    const searchProperties = { query: external ? array({ type: 'number' }) : { type: 'string', minLength: 1 },
        filter: { $ref: '#/$defs/filter' }, limit: limit(1000),
        ...(external ? {} : { embeddingQuery: { type: 'string', minLength: 1 }, rerank: { oneOf: [
            { type: 'boolean' }, object({ fields: { ...array(string, 8), uniqueItems: true },
                onFailure: { enum: ['error', 'returnOriginal'] } }),
        ] } }) };
    return {
        guide: object(),
        status: object(),
        history: continuation({ sinceVersion: { type: 'string', pattern: '^v(0|[1-9][0-9]*)$' }, limit: limit(100) }),
        list: continuation({ prefix: string, nameContains: string, delimiter: { const: '/' }, limit: limit(1000) }),
        read: { ...object({ fileId, path, paths: { ...array(path, 100), uniqueItems: true } }),
            oneOf: ['fileId', 'path', 'paths'].map(key => ({ required: [key] })) },
        search: { ...object(searchProperties, ['query']), $defs: { filter } },
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
