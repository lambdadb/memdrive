import type { DriveDescriptor, MetadataSchema, MetadataType } from '../types.js';
import type { JsonSchema, ToolDefinition, ToolName } from './types.js';

const dialect = 'https://json-schema.org/draft/2020-12/schema';
const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
    type: 'object', properties, required, additionalProperties: false,
});
const string = (description?: string): JsonSchema => ({ type: 'string', ...(description ? { description } : {}) });
const array = (items: JsonSchema, extra: JsonSchema = {}): JsonSchema => ({ type: 'array', items, ...extra });
const id = { type: 'string', minLength: 1, maxLength: 512 };
const ids = (description: string): JsonSchema => array(id, { minItems: 1, uniqueItems: true, description });
const timestamp = string('ISO 8601 timestamp with Z or an explicit UTC offset; at most millisecond precision.');
const scalarTypes: Record<MetadataType, JsonSchema> = {
    string: { type: 'string', maxLength: 4096 },
    'string[]': array({ type: 'string', maxLength: 4096 }),
    number: { type: 'number' },
    boolean: { type: 'boolean' },
    datetime: timestamp,
};
const metadataValue: JsonSchema = { anyOf: [string(), array(string()), { type: 'number' }, { type: 'boolean' }] };
// Output metadata can reflect a schema refreshed by describe after tool creation.
const outputMetadata: JsonSchema = { type: 'object', additionalProperties: metadataValue };
const attributes = { timestamp, metadata: outputMetadata };
const usage = object({ elapsedMs: { type: 'number', minimum: 0 }, databaseRequests: { type: 'integer', minimum: 0 } },
    ['elapsedMs', 'databaseRequests']);
const error = object({ code: string(), message: string(), status: { type: 'integer' },
    details: object({ completedIds: array(id), uncertainIds: array(id), notAttemptedIds: array(id) }),
}, ['code', 'message']);

function metadataInput(schema: MetadataSchema): JsonSchema {
    return object(Object.fromEntries(Object.entries(schema).map(([name, field]) => [name, {
        ...scalarTypes[field.type], ...(field.description === undefined ? {} : { description: field.description }),
    }])));
}

function filterDefinition(schema: MetadataSchema): JsonSchema {
    const fields: Record<string, MetadataType> = { id: 'string', timestamp: 'datetime',
        ...Object.fromEntries(Object.entries(schema).map(([name, field]) => [`metadata.${name}`, field.type])),
    };
    const children = array({ $ref: '#/$defs/filter' }, { minItems: 1 });
    const branches: JsonSchema[] = [object({ and: children }, ['and']), object({ or: children }, ['or']),
        object({ field: { type: 'string', enum: Object.keys(fields) }, op: { const: 'exists' }, value: { type: 'boolean' } }, ['field', 'op', 'value'])];
    for (const type of ['string', 'number', 'boolean', 'datetime'] as const) {
        const names = Object.keys(fields).filter(name => fields[name] === type || (type === 'string' && fields[name] === 'string[]'));
        if (!names.length) continue;
        const field = { type: 'string', enum: names }, value = scalarTypes[type];
        const operators = type === 'number' || type === 'datetime' ? ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'] : ['eq', 'neq'];
        branches.push(object({ field, op: { type: 'string', enum: operators }, value }, ['field', 'op', 'value']),
            object({ field, op: { const: 'in' }, value: array(value, { minItems: 1 }) }, ['field', 'op', 'value']));
    }
    return { anyOf: branches };
}

const descriptorSchema = object({
    name: string(), description: string(), labels: { type: 'object', additionalProperties: string() },
    metadataSchema: { type: 'object', additionalProperties: object({
        type: { type: 'string', enum: ['string', 'string[]', 'number', 'boolean', 'datetime'] }, description: string(),
    }, ['type']) },
    embedding: { anyOf: [
        object({ mode: { const: 'managed' }, provider: { const: 'openai' }, model: { const: 'text-embedding-3-small' },
            dimensions: { const: 1536 }, similarity: { const: 'cosine' } }, ['mode', 'provider', 'model', 'dimensions', 'similarity']),
        object({ mode: { const: 'external' }, dimensions: { type: 'integer', minimum: 64, maximum: 4096 },
            similarity: { const: 'cosine' }, identity: string() }, ['mode', 'dimensions', 'similarity', 'identity']),
    ] },
    textSearch: object({ analyzers: array(string(), { minItems: 1, uniqueItems: true }) }, ['analyzers']),
}, ['name', 'labels', 'metadataSchema', 'embedding']);

function resultSchema(value: JsonSchema): JsonSchema {
    return { $schema: dialect, type: 'object', anyOf: [
        object({ ok: { const: true }, value }, ['ok', 'value']),
        object({ ok: { const: false }, error }, ['ok', 'error']),
    ] };
}

/** Common definitions for direct tool calling and MCP; no provider wire format. */
export function toolDefinitions(descriptor: DriveDescriptor, writable = false, shortIds = false, evidenceIds = false, retrieval = false): ToolDefinition[] {
    const external = descriptor.embedding.mode === 'external';
    const vector = array({ type: 'number' }, { minItems: descriptor.embedding.dimensions,
        maxItems: descriptor.embedding.dimensions, description: 'Caller-supplied embedding in this drive\'s vector space. Do not invent vector coordinates.' });
    const filter: JsonSchema = { $ref: '#/$defs/filter', description: 'Narrow by id, timestamp or declared metadata. Use explicit and/or arrays. Array eq/in test membership; neq requires a stored value and excludes matching elements. Discover fields with memdrive_describe.' };
    const exclusions = array(id, { uniqueItems: true, description: shortIds
        ? 'Exclude each returned session memory ID and all of its chunks, not only previously seen excerpts.'
        : 'Exclude each canonical Mem ID and all of its chunks. This excludes whole memories, not only previously seen chunks; do not use temporary aliases.' });
    const request = object({
        ...(external ? { queryVector: vector } : {
            query: { type: 'string', minLength: 1, description: 'Question or search terms. Cannot be the exact match-all expression *:*. Query and constructed context each have an 8 KiB native limit.' },
            context: string('Optional context relevant to this query; it is incorporated into the embedding and rerank query without an agent call.'),
            recentDialogue: array(object({ role: { type: 'string', enum: ['user', 'assistant'] }, content: string() }, ['role', 'content']),
                { description: 'Optional recent dialogue relevant to this query. No silent truncation is performed.' }),
        }),
        filter, excludeIds: exclusions,
        limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Maximum matches for this query; default 10.' },
        rerank: external ? { const: false, description: 'External vectors do not support reranking; omit or pass false.' }
            : { type: 'boolean', description: 'Use native reranking; default true. False preserves native search order.' },
    }, [external ? 'queryVector' : 'query']);
    const evidence = evidenceIds ? { evidenceId: string('Session evidence reference (e1, e2, ...); use for citations, not memory-ID inputs.') } : {};
    const evidenceRequired = evidenceIds ? ['evidenceId'] : [];
    const match = external
        ? object({ kind: { const: 'mem' }, memId: id, ...attributes, ...evidence }, ['kind', 'memId', ...evidenceRequired])
        : object({ kind: { type: 'string', enum: ['mem', 'chunk'] }, memId: id, content: string(),
            start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1 }, ...attributes, ...evidence },
        ['kind', 'memId', 'content', 'start', 'end', ...evidenceRequired]);
    const mem = object({ id, ...(!external ? { content: string() } : {}), ...attributes, ...evidence }, [...(external ? ['id'] : ['id', 'content']), ...evidenceRequired]);
    const completion = object({ status: { enum: ['completed', 'budget_exhausted', 'aborted', 'failed'] }, reason: string() }, ['status']);
    const counts = Object.fromEntries(['knownRecallDatabaseRequests', 'dataCalls', 'toolCalls', 'modelCalls', 'inputTokens', 'outputTokens', 'unknownUsageCalls']
        .map(key => [key, { type: 'integer', minimum: 0 }]));
    const retrievalUsage = object({ elapsedMs: { type: 'number', minimum: 0 }, databaseRequests: { type: ['integer', 'null'], minimum: 0 }, ...counts },
        ['elapsedMs', 'databaseRequests', ...Object.keys(counts)]);
    const resultUsage = retrieval ? retrievalUsage : usage;
    const completionFields = retrieval ? { completion } : {};
    const requiredCompletion = retrieval ? ['completion'] : [];
    const recallResult = { anyOf: [object({ matches: array(match), usage: resultUsage, ...completionFields }, ['matches', 'usage', ...requiredCompletion]),
        object({ error: object({ code: string(), message: string(), status: { type: 'integer' } }, ['code', 'message']), usage: resultUsage, ...completionFields }, ['error', 'usage', ...requiredCompletion])] };
    const countable = ['id', ...Object.entries(descriptor.metadataSchema)
        .filter(([, field]) => field.type === 'string' || field.type === 'string[]').map(([name]) => `metadata.${name}`)];
    const define = (name: ToolName, title: string, description: string, input: JsonSchema, output: JsonSchema,
        hasFilter = false, write: 'remember' | 'forget' | false = false): ToolDefinition => ({
        name, title, description: (shortIds && name !== 'memdrive_describe'
            ? description.replaceAll('canonical ', '').replaceAll('Canonical ', '')
                + ' Memory IDs are session aliases (m1, m2, ...). Reuse only returned aliases; raw IDs and invented aliases are rejected.'
            : description) + (evidenceIds && ['memdrive_recall', 'memdrive_read', 'memdrive_list'].includes(name)
                ? ' evidenceId identifies this exact returned evidence; reuse it for citations. Memory-ID inputs still use memId/id.' : ''),
        inputSchema: { $schema: dialect, ...input, ...(hasFilter ? { $defs: { filter: filterDefinition(descriptor.metadataSchema) } } : {}) },
        outputSchema: resultSchema(output),
        annotations: { readOnlyHint: !write, destructiveHint: !!write, idempotentHint: write !== 'remember', openWorldHint: false },
    });
    const definitions = [
        define('memdrive_recall', 'Search memories', retrieval
            ? 'Retrieve source evidence for 1 to 5 independent requests using the host-configured strategy. Requests run concurrently with isolated per-request budgets. Results preserve input order. Check each completion.status; incomplete retrieval returns no fallback matches. Model and strategy settings cannot be changed through tool arguments.'
            : external
            ? 'Search this drive with caller-supplied vectors; submit one to five independent requests, returned in input order. Results contain canonical memId values and metadata, without vectors or source text; the caller reconstructs originals. Inspect per-request errors and refine the supplied query when more evidence is needed.'
            : `Search stored memories for evidence relevant to one to five questions using ${descriptor.textSearch ? 'hybrid keyword and vector' : 'vector'} retrieval, with native reranking enabled by default. Independent requests run concurrently and results retain input order; kind mem is a complete original, while kind chunk is an excerpt with UTF-16 start/end offsets and memId identifies the original for memdrive_read. When evidence is missing, query the missing facts or narrow filters; results are not an answer and previous searches are not automatically excluded.`,
        object({ requests: array(request, { minItems: 1, maxItems: 5,
            description: 'Independent search requests; returned results correspond to this array by index.' }) }, ['requests']),
        object({ results: array(recallResult, { minItems: 1, maxItems: 5 }) }, ['results']), true),
        define('memdrive_read', 'Read original memories', external
            ? 'Read canonical memory references and metadata by ID. External-vector memories return neither source text nor vectors; the caller owns source reconstruction. Missing IDs are omitted.'
            : 'Read complete originals by canonical Mem ID when an excerpt needs surrounding context. Use memId from search results; kind mem already contains the complete original and needs no additional read. Missing IDs are omitted and originals are not truncated.',
        object({ ids: ids(shortIds ? 'Returned session memory IDs to read, usually matches[].memId from memdrive_recall.'
            : 'Canonical Mem IDs to read, usually matches[].memId from memdrive_recall.') }, ['ids']),
        object({ mems: array(mem) }, ['mems'])),
        define('memdrive_describe', 'Describe memory drive',
            'Inspect the drive description, labels, declared metadata fields and their meanings, embedding configuration and text-search analyzers. Use this before constructing unfamiliar metadata filters or choosing fields to count. This is a fresh schema lookup, not a list of stored memories or metadata values.',
        object({}), descriptorSchema),
        define('memdrive_count_values', 'Count metadata values',
            'Inspect value distributions for id or declared string/string[] metadata fields, over original memories rather than chunks. Filters and excluded Mem IDs restrict the population; an array can put one memory in multiple buckets, so bucket sums are not a memory total. Results may be cached for 60 seconds: asOf is the fetch time and hasMore=null means completeness is unknown at the native bucket limit.',
        object({ fields: array({ type: 'string', enum: countable }, { minItems: 1, maxItems: 5, uniqueItems: true,
            description: 'One to five keyword fields. Numeric, boolean and datetime fields can filter but cannot be counted.' }),
        filter, excludeIds: exclusions, limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Values per field; default 10, maximum 100.' } }, ['fields']),
        object({ values: { type: 'object', additionalProperties: object({
            buckets: array(object({ value: string(), count: { type: 'integer', minimum: 0 } }, ['value', 'count']), { maxItems: 100 }),
            hasMore: { type: ['boolean', 'null'] },
        }, ['buckets', 'hasMore']) }, asOf: string('ISO 8601 UTC fetch time.') }, ['values', 'asOf']), true),
        define('memdrive_list', 'List stored memories',
            'Browse complete original memories when no relevance query is needed; this is inventory, not ranked search. Pass nextCursor unchanged as cursor to continue, including after an empty logical page. Listing uses committed state and may lag recent writes; use memdrive_read or memdrive_recall when the latest accepted write must be visible.',
        object({ limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Physical documents per page; default 100. Returned original memories may be fewer.' },
            cursor: { type: 'string', minLength: 1, description: 'Opaque nextCursor from the previous page; omit on the first request.' } }),
        object({ mems: array(mem), nextCursor: string() }, ['mems'])),
    ];
    if (writable) {
        const inputMem = object({ id: { ...id, description: 'Omit to generate an ID. Supplying an existing ID fully replaces that memory.' },
            ...(external ? { embedding: vector } : { content: { type: 'string', minLength: 1, description: 'Original memory text; the SDK handles chunking. Content must contain non-whitespace text.' } }),
            timestamp, metadata: { ...metadataInput(descriptor.metadataSchema), description: 'Declared application metadata only. Omitted fields are not preserved when replacing an existing memory.' },
        }, [external ? 'embedding' : 'content']);
        definitions.push(define('memdrive_remember', 'Store memories',
            'Store new memories or fully replace existing memories with the supplied IDs, including metadata. Omit an ID to create a new memory; repeating such a request creates another memory. IDs are returned in input order; partial write errors distinguish completed, uncertain and unattempted IDs, so do not blindly retry the entire request.',
        object({ mems: array(inputMem, { minItems: 1, description: 'Memories to store; supplied IDs must be unique within this request.' }) }, ['mems']),
        object({ ids: array(id, { minItems: 1 }) }, ['ids']), false, 'remember'),
        define('memdrive_forget', 'Delete memories',
            'Delete whole memories and their chunks by canonical IDs or a structured filter, never both. Filter deletion can affect many memories; use the intended scope explicitly. Missing IDs are harmless and success acknowledges the deletion request without reporting how many memories existed.',
        { type: 'object', anyOf: [object({ ids: ids('Canonical Mem IDs to delete.') }, ['ids']), object({ filter }, ['filter'])] },
        object({ acknowledged: { const: true } }, ['acknowledged']), true, 'forget'));
    }
    return definitions;
}
