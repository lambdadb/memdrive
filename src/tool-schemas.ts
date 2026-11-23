import { fileToolGuideTopics } from './tool-guide.js';

// Provider-independent JSON Schema. Public SDK methods remain the authority for
// semantic checks such as declared metadata, UTF-8 limits and valid file IDs.
type Schema = Record<string, unknown>;
const string = { type: 'string' };
const described = (schema: Schema, description: string, examples?: unknown[]): Schema =>
    ({ ...schema, description, ...(examples === undefined ? {} : { examples }) });
const scalar = { type: ['string', 'number', 'boolean'] };
const array = (items: Schema, maxItems?: number): Schema => ({ type: 'array', items, minItems: 1,
    ...(maxItems === undefined ? {} : { maxItems }) });
const object = (properties: Record<string, Schema> = {}, required: string[] = []) =>
    ({ type: 'object' as const, properties, additionalProperties: false, required });
const limit = (maximum: number) => ({ type: 'integer', minimum: 1, maximum });
const cursorValue = described(string, 'Opaque continuation returned by the previous page. Pass only cursor on the same view handle (history may cross views of the same store and client); expires after five minutes or eviction.');
const cursor = object({ cursor: cursorValue }, ['cursor']);
const continuation = (properties: Record<string, Schema>, required: string[] = []) => ({
    ...object({ ...properties, cursor: cursorValue }), oneOf: [object(properties, required), cursor],
});
const filter: Schema = { type: 'object', description: 'Filter declared metadata fields with comparisons or nested and/or groups.', oneOf: [
    object({ and: described(array({ $ref: '#/$defs/filter' }), 'Require all child filters to match.') }, ['and']),
    object({ or: described(array({ $ref: '#/$defs/filter' }), 'Require at least one child filter to match.') }, ['or']),
    object({ field: { type: 'string', pattern: '^metadata\\..+', description: 'Declared metadata field prefixed with metadata.', examples: ['metadata.project'] },
        op: { type: 'string', enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'], description: 'Equality, inequality or ordered comparison.' }, value: described(scalar, 'Comparison value matching the declared metadata field type.') }, ['field', 'op', 'value']),
    object({ field: { type: 'string', pattern: '^metadata\\..+', description: 'Declared metadata field prefixed with metadata.', examples: ['metadata.project'] }, op: { type: 'string', const: 'in', description: 'Match any of the supplied values.' }, value: described(array(scalar), 'Nonempty allowed values matching the field type.') }, ['field', 'op', 'value']),
    object({ field: { type: 'string', pattern: '^metadata\\..+', description: 'Declared metadata field prefixed with metadata.', examples: ['metadata.project'] }, op: { type: 'string', const: 'exists', description: 'Test whether the metadata field exists.' }, value: { type: 'boolean', description: 'true requires the field; false requires its absence.' } }, ['field', 'op', 'value']),
] };
const metadata = { type: 'object', additionalProperties: scalar, description: 'Declared metadata fields and scalar values. On update, replaces the entire metadata map; omitted metadata stays unchanged.' };
const fileId = { type: 'string', description: 'A stable fileId returned by MemDrive.' };
const path = { type: 'string', description: 'An absolute file path within the bound drive.', examples: ['/notes/decisions.md'] };

export function fileToolSchemas(external: boolean, main: boolean) {
    const refVersion = main ? { version: { type: 'string', pattern: '^v(0|[1-9][0-9]*)$',
        description: 'Exact retained main publication, such as v3, or the retained initial v0. Omit for current main.' } } : {};
    const content = external
        ? described(array({ type: 'number' }), 'Finite vector with the dimensions and embedding identity configured for this drive.')
        : described(string, 'Original text to store. On update, replaces the full content; prefer exact edits for partial changes.');
    const create = object({ op: { type: 'string', const: 'create', description: 'Create a new file by path.' }, path, content, metadata }, ['op', 'path', 'content']);
    const updateProperties = { op: { type: 'string', const: 'update', description: 'Update, move or edit an existing file by stable fileId.' }, fileId, newPath: described(path, 'New absolute path for an existing file; its fileId remains stable.'), content, metadata,
        ...(external ? {} : { edits: described(array(object({ oldText: { type: 'string', minLength: 1, description: 'Exact nonempty text that must occur once in the current original.' }, newText: described(string, 'Replacement text; use an empty string to remove the match.') }, ['oldText', 'newText'])), 'Exact nonoverlapping text replacements. Cannot accompany content; reread on EDIT_CONFLICT.') }) };
    const update = { ...object(updateProperties, ['op', 'fileId']),
        anyOf: ['newPath', 'content', 'metadata', ...(external ? [] : ['edits'])].map(key => ({ required: [key] })),
        ...(external ? {} : { not: { required: ['content', 'edits'] } }) };
    const remove = object({ op: { type: 'string', const: 'delete', description: 'Delete an existing file from this working view by stable fileId.' }, fileId }, ['op', 'fileId']);
    const operation = { type: 'object', oneOf: [create, update, remove] };
    const batch = object({ operations: described(array(operation, 100), 'One to 100 write operations. Not transactional; a failure can leave partial work.') }, ['operations']);
    const searchProperties = { query: external ? described(array({ type: 'number' }), 'Query vector matching the configured dimensions and embedding identity.') : { type: 'string', minLength: 1,
        description: 'Describe what you need for semantic search. For keyword search, supply focused names, identifiers or terms; not a whole conversation. Keyword input is analyzed, not query syntax or an exact-match guarantee.' },
        filter: { type: 'object', $ref: '#/$defs/filter', description: 'Optional declared-metadata filter; use metadata.<field> names.' }, limit: { ...limit(1000), default: 10, description: 'Maximum ranked hits, 1–1000; defaults to 10. Multiple text hits can refer to the same file.' },
        ...(external ? {} : { mode: { type: 'string', enum: ['semantic', 'keyword', 'hybrid'], default: 'semantic',
            description: 'semantic: meaning and paraphrases (default). keyword: known terms. hybrid: explicitly combine both signals. No automatic mode switching.' },
        embeddingQuery: { type: 'string', minLength: 1,
            description: 'Optional separate input for embeddings and enabled reranking; defaults to query. Hybrid keeps query for keyword matching. Keyword mode permits this only with rerank enabled and does not embed it.' },
        rerank: { type: ['boolean', 'object'], default: false,
            description: 'Optional additional model scoring of retrieved candidates, independent of mode. Defaults to false. true or an options object enables it, adding inference cost and latency; it cannot recover evidence outside the retrieved candidate pool.', oneOf: [
            { type: 'boolean' }, object({ fields: { ...array(string, 8), uniqueItems: true, description: 'One to eight distinct fields: content or declared string metadata paths such as metadata.project. Defaults to content.' },
                onFailure: { type: 'string', enum: ['error', 'returnOriginal'], default: 'error', description: 'Fail on reranking errors, or explicitly return the original candidates with reranked: false.' } }),
        ] } }) };
    const ranges = external ? {} : { startLine: { type: 'integer', minimum: 1, description: 'First line to read, one-based and inclusive; defaults to the first line.' },
        endLine: { type: 'integer', minimum: 1, description: 'Last line to read, one-based and inclusive; defaults to the last line.' },
        maxChars: { type: 'integer', minimum: 2, maximum: 64000, description: 'Maximum UTF-16 units per range page, 2–64000; defaults to 16000 for ranged reads. Omit all range options for a full original.' },
        offset: { type: 'integer', minimum: 0, description: 'Continuation offset from read.next; forward next unchanged with its revision.' },
        revision: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'Original revision from read.next. Restart without offset and revision on READ_VERSION_CHANGED.' } };
    return {
        guide: object({ topic: { type: 'string', enum: Object.keys(fileToolGuideTopics), description: 'Detailed guide topic. Omit for the index and activity-specific reading instructions.', examples: ['editing'] } }),
        status: object(),
        fork: object({ name: { type: 'string', minLength: 3, maxLength: 47,
            pattern: '^[A-Za-z0-9_-]+$', not: { const: 'main' }, description: 'New working-fork name: 3–47 letters, digits, underscores or hyphens; cannot be main.', examples: ['draft-notes'] }, ...refVersion }, ['name']),
        checkpoint: object({ name: { type: 'string', minLength: 3, maxLength: 41, pattern: '^[A-Za-z0-9_-]+$', description: 'New checkpoint name: 3–41 letters, digits, underscores or hyphens.', examples: ['before-edit'] }, ...refVersion }, ['name']),
        history: continuation({ sinceVersion: { type: 'string', pattern: '^v(0|[1-9][0-9]*)$', description: 'Exclusive observed main publication version; defaults to v0. Gaps are invalid; use the last processed version to restart.', examples: ['v3'] }, limit: { ...limit(100), description: 'Maximum history entries per page, 1–100; defaults to 20.' } }),
        list: continuation({ prefix: described(string, 'Absolute path prefix to narrow the observed inventory.', ['/notes/']), nameContains: described(string, 'Case-sensitive literal substring of the filename including its extension, not the directory path.', ['decision.md']), delimiter: { type: 'string', const: '/', description: 'Group common directory prefixes instead of returning every descendant file. Omit for an inventory.' }, limit: { ...limit(1000), description: 'Maximum entries per page, 1–1000; defaults to 100.' } }),
        read: { ...object({ fileId, path, paths: { ...array(path, 100), uniqueItems: true, description: 'One to 100 distinct absolute paths. Missing files are omitted; range options are unavailable for batches.' }, ...ranges }),
            oneOf: [object({ fileId, ...ranges }, ['fileId']), object({ path, ...ranges }, ['path']),
                object({ paths: { ...array(path, 100), uniqueItems: true, description: 'One to 100 distinct absolute paths. Missing files are omitted; range options are unavailable for batches.' } }, ['paths'])],
            ...(external ? {} : { dependencies: { offset: ['revision'] } }) },
        search: { ...object(searchProperties, ['query']), $defs: { filter }, ...(external ? {} : {
            if: { properties: { mode: { const: 'keyword' } }, required: ['mode', 'embeddingQuery'] },
            then: { properties: { rerank: { not: { const: false } } }, required: ['rerank'] },
        }) },
        findText: { ...continuation({ query: { type: 'string', minLength: 1, description: 'Nonempty literal string to find case-insensitively in originals.', examples: ['CHECKPOINT_CONFLICT'] }, prefix: described(string, 'Absolute path prefix to narrow the literal scan.', ['/notes/']),
            filter: { type: 'object', $ref: '#/$defs/filter', description: 'Optional declared-metadata filter; use metadata.<field> names.' }, limit: { ...limit(100), description: 'Maximum literal matches per page, 1–100; defaults to 20. An empty page may still return a cursor.' } }, ['query']), $defs: { filter } },
        diff: object(),
        write: { ...object({ ...create.properties, ...updateProperties, op: { type: 'string', enum: ['create', 'update', 'delete'], description: 'Single write operation. Omit when using operations for a batch.' },
            fileId, operations: batch.properties.operations! }),
            oneOf: [create, update, remove, batch] },
        merge: object({ requestId: { type: 'string', minLength: 1, maxLength: 128, description: 'Stable identifier for this publication. Retry the same merge with the identical requestId and summary.', examples: ['publish-notes-2026-11-23'] },
            summary: { type: 'string', minLength: 1, maxLength: 1024, description: 'Short description of what changed and why. Keep removed sensitive content out of this retained summary.' } }, ['requestId', 'summary']),
    };
}
