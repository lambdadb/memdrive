import { MemDriveError, requireInput, checkAbort } from './errors.js';
import { buildSearchFilter, matchesFilter, filterJsonSchema } from './filter.js';
import { validateMem, publicMatch } from './storage.js';
import type { Evidence } from './storage.js';
import type { AgentOptions, TextRecallRequest, Filter, MetadataSchema, ModelRequest, Observation, RecordEvent, TextMatch, ToolDefinition } from './types.js';

type NativeObject = Record<string, unknown>;
type SchemaSource = MetadataSchema | (() => MetadataSchema);
interface AgentTool extends ToolDefinition {
    parameters: { type: 'object'; properties: NativeObject; required: string[]; additionalProperties: false; $defs?: unknown };
}
interface QueryBody extends NativeObject { size: number }
interface ToolCall extends NativeObject { type: 'function_call'; call_id: string; name: unknown; arguments: unknown }
interface ToolResult { call: ToolCall; selected?: string[]; mems?: Evidence[]; sourceRead?: boolean; output?: unknown }
interface RunAgentOptions {
    request: TextRecallRequest;
    signal?: AbortSignal | undefined;
    agent: AgentOptions;
    limit: number;
    query: (body: QueryBody) => Promise<unknown>;
    read?: ((ids: string[]) => Promise<Evidence[]>) | undefined;
    inspector: { getSchema: () => Promise<unknown>; countValues: (args: NativeObject, filter?: unknown) => Promise<unknown> };
    metadataSchema: SchemaSource;
    keywordSearch?: boolean | undefined;
    observe?: ((event: Observation) => unknown) | undefined;
    record?: ((event: RecordEvent) => unknown) | undefined;
}
const array = (value: unknown): value is unknown[] => Array.isArray(value);

const object = (value: unknown): value is NativeObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const validQuery = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.trim() !== '*:*' && new TextEncoder().encode(value).length <= 8192;
const noop = async () => {};
const schemaValue = (schema: SchemaSource): MetadataSchema => typeof schema === 'function' ? schema() : schema;
const canonical = (value: unknown): unknown => array(value) ? value.map(canonical)
    : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const topK = { type: 'integer', minimum: 1, maximum: 20, description: 'Results to return (default 5, maximum 20).' };
const results = ' matches lists evidence IDs (e1, e2, ...) in rank order. new_evidence defines each item once; other IDs refer to earlier responses. mem_id (m1, m2, ...) identifies the original Mem for read_mems. kind mem is a complete original and needs no further read; kind chunk is an excerpt. start/end are UTF-16 source offsets. All evidence IDs remain selectable. Later searches exclude shown search results.';

function tool(name: string, description: string, properties: NativeObject, required: string[]): AgentTool {
    return { type: 'function', name, description, strict: false,
        parameters: { type: 'object', properties, required, additionalProperties: false,
            ...(properties.filter ? { $defs: filterJsonSchema.$defs } : {}) } };
}

export function agentTools(limit: number, keywordSearch = false): AgentTool[] {
    const filter = { $ref: filterJsonSchema.$ref, description: 'Optional structured filter narrows the caller filter. Discover field types with get_schema. Use canonical stored values, not short aliases.' };
    return [
        ...(keywordSearch ? [tool('search_keyword', 'Search analyzed words or names with OR matching, ranked by BM25.' + results,
            { keywords: { type: 'array', items: { type: 'string' }, minItems: 1 }, top_k: topK, filter }, ['keywords'])] : []),
        tool('search_semantic', 'Search by meaning, including relevant mems with different wording.' + results,
            { query: { type: 'string' }, top_k: topK, filter }, ['query']),
        tool('get_schema', 'Show drive description and labels, searchable fields with descriptions, filter operations and keyword-countable fields. Includes a cache fetch timestamp.', {}, []),
        tool('count_values', 'Count values of keyword fields across mems matching caller and tool filters, including evidence already shown. A document can count in multiple buckets. Results may be cached; has_more=null means completeness is unknown.',
            { fields: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5, uniqueItems: true },
                filter, limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Values per field (default 10, maximum 100).' } }, ['fields']),
        tool('read_mems', 'Read complete originals for previously shown mem_id aliases (m1, m2, ...), when a chunk needs surrounding context. Caller filters and exclusions still apply. Originals are not truncated.' + results,
            { ids: { type: 'array', items: { type: 'string' }, minItems: 1, uniqueItems: true } }, ['ids']),
        tool('report_helpful_ids', `Select up to ${limit} unique previously shown evidence IDs (e1, e2, ...) needed to answer the question, in relevance order, and end retrieval. Search again when missing or conflicting information could be resolved by another lookup. Otherwise report available supporting evidence, or an empty list if none are helpful. When only this tool is available, report using evidence already shown.`,
            { ids: { type: 'array', items: { type: 'string' }, maxItems: limit, uniqueItems: true } }, ['ids']),
    ];
}

function queryBody(name: unknown, args: NativeObject, request: TextRecallRequest, excluded: string[], metadataSchema: MetadataSchema): QueryBody {
    const size = args.top_k ?? 5;
    requireInput(typeof size === 'number' && Number.isSafeInteger(size) && size >= 1 && size <= 20, 'top_k must be an integer from 1 to 20.');
    const filter = buildSearchFilter([request.filter, args.filter], request.excludeIds ?? [], excluded, metadataSchema);
    if (name === 'search_semantic') {
        requireInput(validQuery(args.query), 'query must be nonempty text of at most 8 KiB and cannot be *:*.');
        return { size, query: { knn: { field: 'embedding', queryText: args.query, k: size, filter } } };
    }
    requireInput(array(args.keywords) && args.keywords.length > 0
        && args.keywords.every(validQuery) && new TextEncoder().encode(JSON.stringify(args.keywords)).length <= 8192,
    'keywords must be a nonempty text list of at most 8 KiB; no item may be *:*.');
    return { size, query: { bool: [
        { ...filter, occur: 'filter' },
        { bool: args.keywords.map(query => ({ queryString: { query, defaultField: 'content', skipSyntax: true }, occur: 'should' })), occur: 'must' },
    ] } };
}

function statusOf(error: unknown): number | undefined {
    const visited = new Set<unknown>();
    for (let value = error; object(value) && !visited.has(value); value = value.cause) {
        visited.add(value);
        const status = value.status ?? value.statusCode ?? value.httpStatus;
        if (typeof status === 'number' && Number.isInteger(status)) return status;
    }
    return undefined;
}

function assertEvidence(evidence: unknown, metadataSchema: MetadataSchema): asserts evidence is Evidence {
    requireInput(object(evidence) && typeof evidence.id === 'string'
        && typeof evidence.start === 'number' && Number.isSafeInteger(evidence.start) && evidence.start >= 0
        && typeof evidence.end === 'number' && Number.isSafeInteger(evidence.end) && evidence.end > evidence.start
        && (evidence.kind === 'mem' || evidence.kind === 'chunk')
        && (evidence.kind !== 'mem' || evidence.start === 0)
        && typeof evidence.content === 'string' && evidence.content.length === evidence.end - evidence.start, 'Invalid evidence span.');
    const { id: _id, memId, kind: _kind, start: _start, end: _end, ...mem } = evidence;
    validateMem({ ...mem, id: memId }, metadataSchema, { requireId: true });
}

function memsFrom(response: unknown, size: number, request: TextRecallRequest, args: NativeObject, excluded: Set<string>, metadataSchema: MetadataSchema): Evidence[] {
    try {
        requireInput(object(response) && response.isDocsInline !== false && array(response.docs)
            && response.docs.length <= size, 'Invalid inline search response.');
        const mems = response.docs.map(hit => {
            const evidence = object(hit) ? hit.doc : undefined;
            assertEvidence(evidence, metadataSchema);
            return evidence;
        });
        const ids = mems.map(mem => mem.id);
        requireInput(new Set(ids).size === ids.length, 'Duplicate search result IDs.');
        for (const mem of mems) requireInput(!excluded.has(mem.id)
            && !(request.excludeIds ?? []).includes(mem.memId)
            && matchesFilter({ ...mem, id: mem.memId }, request.filter, metadataSchema)
            && matchesFilter({ ...mem, id: mem.memId }, args.filter as Filter | undefined, metadataSchema), 'Search result violates the requested filter or exclusions.');
        return mems;
    } catch (cause) {
        throw new MemDriveError('INVALID_RESPONSE', 'Search returned malformed or ineligible Mems.', { cause });
    }
}

export function validateAgent(agent: unknown): asserts agent is AgentOptions {
    requireInput(object(agent) && Object.keys(agent).every(key => ['model', 'instructions', 'maxSteps'].includes(key)), 'Provide a MemDrive agent configuration.');
    const { model, instructions, maxSteps = 15 } = agent;
    requireInput(object(model) && typeof model.name === 'string' && model.name.trim()
        && typeof model.provider === 'string' && model.provider.trim()
        && typeof model.respond === 'function' && typeof model.checkContext === 'function',
    'model requires name, provider, respond and checkContext.');
    requireInput(model.reasoning === undefined || object(model.reasoning), 'Model reasoning must be an options object.');
    requireInput(instructions === undefined || typeof instructions === 'string', 'instructions must be text or omitted.');
    requireInput(typeof maxSteps === 'number' && Number.isSafeInteger(maxSteps) && maxSteps >= 0, 'maxSteps must be a nonnegative safe integer.');
}

export async function runAgent({ request, signal, agent, limit, query, read, inspector, metadataSchema, keywordSearch = false, observe = noop, record = noop }: RunAgentOptions): Promise<Evidence[]> {
    checkAbort(signal);
    validateAgent(agent);
    requireInput(Number.isSafeInteger(limit) && limit > 0, 'Provide a positive final mem limit.');
    requireInput(typeof query === 'function' && typeof inspector?.getSchema === 'function'
        && typeof inspector?.countValues === 'function', 'Provide search and collection inspection.');
    requireInput(typeof observe === 'function' && typeof record === 'function', 'Diagnostic hooks must be functions.');
    const { model, instructions, maxSteps = 15 } = agent;
    const tools = agentTools(limit, keywordSearch), definitions = new Map(tools.map(item => [item.name, item]));
    const input: ModelRequest['input'] = [{ role: 'user', content: JSON.stringify({ question: request.query,
        ...(request.recentDialogue === undefined ? {} : { recent_dialogue: request.recentDialogue }),
        ...(request.context === undefined ? {} : { context: request.context }) }) }];
    const observed = new Map<string, { alias: string; mem: Evidence }>(), aliases = new Map<string, string>(),
        parents = new Map<string, string>(), parentAliases = new Map<string, string>(), callIds = new Set<string>();
    const spans = new Map<string, string>(), seenChunks = new Set<string>();
    for (let step = 0; step <= maxSteps; step++) {
        checkAbort(signal);
        const forced = step === maxSteps;
        const modelRequest: ModelRequest = { model: model.name, store: false, input: structuredClone(input),
            ...(model.reasoning === undefined ? {} : { reasoning: structuredClone(model.reasoning) }),
            include: ['reasoning.encrypted_content'],
            ...(instructions?.trim() ? { instructions } : {}),
            tools: forced ? [tools.at(-1)!] : tools, parallel_tool_calls: true,
            tool_choice: forced ? { type: 'function', name: 'report_helpful_ids' } : 'required' };
        if (await model.checkContext(modelRequest) === false)
            throw new MemDriveError('MODEL_CONTEXT_LIMIT', 'MemDrive retrieval exceeds the model context limit; no input was truncated.');
        await record({ phase: 'model_request', step, request: structuredClone(modelRequest) });
        checkAbort(signal);
        const response = await model.respond(modelRequest, { signal });
        checkAbort(signal);
        await record({ phase: 'model_response', step, response: structuredClone(response) });
        if (!object(response) || response.status !== 'completed' || !array(response.output)
            || !response.output.every(item => object(item) && typeof item.type === 'string'))
            throw new MemDriveError('MODEL_RESPONSE_ERROR', 'Retrieval model did not return a completed tool response.');
        const output = response.output as Array<NativeObject & { type: string }>;
        const pendingCalls = output.filter(item => item.type === 'function_call');
        if (!pendingCalls.length || pendingCalls.some(call => typeof call.call_id !== 'string' || !call.call_id
            || callIds.has(call.call_id)) || new Set(pendingCalls.map(call => call.call_id)).size !== pendingCalls.length)
            throw new MemDriveError('MODEL_RESPONSE_ERROR', 'Retrieval model returned missing or duplicate tool call IDs.');
        const calls = pendingCalls as ToolCall[];
        calls.forEach(call => callIds.add(call.call_id));
        input.push(...structuredClone(output));
        const excluded = new Set(seenChunks);
        const execute = async (call: ToolCall): Promise<ToolResult> => {
            checkAbort(signal);
            let args: unknown, body: QueryBody;
            try {
                try { args = JSON.parse(String(call.arguments)); } catch { throw new MemDriveError('INVALID_INPUT', 'Tool arguments must be valid JSON.'); }
                const definition = typeof call.name === 'string' ? definitions.get(call.name) : undefined;
                requireInput(definition && object(args)
                    && Object.keys(args).every(key => Object.hasOwn(definition.parameters.properties, key))
                    && definition.parameters.required.every(key => Object.hasOwn(args as NativeObject, key)), 'Use the documented tool name and arguments.');
                if (call.name === 'report_helpful_ids') {
                    requireInput(calls.length === 1, 'Report in a separate response after receiving search results.');
                    requireInput(array(args.ids) && args.ids.length <= limit
                        && new Set(args.ids).size === args.ids.length
                        && args.ids.every((id): id is string => typeof id === 'string' && aliases.has(id)), 'Report unique short evidence IDs already shown, within the final result limit.');
                    return { call, selected: args.ids.map(id => aliases.get(id)!) };
                }
                requireInput(!forced, 'Only report_helpful_ids is available now.');
                if (call.name === 'read_mems') {
                    requireInput(typeof read === 'function' && array(args.ids) && args.ids.length > 0
                        && new Set(args.ids).size === args.ids.length && args.ids.every((id): id is string => typeof id === 'string' && parentAliases.has(id)),
                    'Read distinct previously shown mem_id aliases (m1, m2, ...).');
                    const ids = args.ids.map(id => parentAliases.get(id)!);
                    const mems = await read(ids);
                    requireInput(Array.isArray(mems) && mems.every(mem => ids.includes(mem.memId)), 'Invalid source read response.');
                    return { call, mems, sourceRead: true };
                }
                if (call.name === 'get_schema') return { call, output: await inspector.getSchema() };
                if (call.name === 'count_values') return { call, output: await inspector.countValues(args, request.filter) };
                body = queryBody(call.name, args, request, [...excluded], schemaValue(metadataSchema));
            } catch (error) {
                if (object(error) && error.code === 'INVALID_INPUT') return { call, output: { error: error.message } };
                if (call.name === 'count_values' && statusOf(error) === 400)
                    return { call, output: { error: 'Value counts were rejected. Check keyword field types and narrow the filter if necessary.' } };
                throw error;
            }
            await record({ phase: 'query', step, call: structuredClone(call), request: structuredClone(body) });
            let response;
            try { response = await query(body); }
            catch (error) {
                if (statusOf(error) === 400) return { call, output: { error: 'Search was rejected. Check search input, filter field types and query limits.' } };
                throw error;
            }
            return { call, mems: memsFrom(response, body.size, request, args as NativeObject, excluded, schemaValue(metadataSchema)) };
        };
        const settled = await Promise.allSettled(calls.map(execute));
        checkAbort(signal);
        const failure = settled.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
        for (const result of settled) {
            if (result.status !== 'fulfilled') continue; // A rejection was propagated above.
            const value = result.value;
            if (value.selected) {
                const completion = forced ? 'forced' : 'voluntary';
                await record({ phase: 'selection', step, ids: [...value.selected], completion });
                await observe({ type: 'selected', ids: [...value.selected], matches: value.selected.map(id => publicMatch(observed.get(id)!.mem)), completion });
                return value.selected.map(id => structuredClone(observed.get(id)!.mem));
            }
            let output = value.output;
            if (value.mems) {
                const newMems: Array<Omit<TextMatch, 'memId'> & { id: string; mem_id: string }> = [], newIds: string[] = [];
                const matches = value.mems.map(mem => {
                    if (!value.sourceRead) seenChunks.add(mem.id);
                    const spanKey = JSON.stringify([mem.memId, mem.start, mem.end]);
                    const previous = observed.get(mem.id) ?? observed.get(spans.get(spanKey)!);
                    if (previous) {
                        // Same-step overlap must not bind one alias to two values.
                        if (JSON.stringify(canonical(publicMatch(previous.mem))) !== JSON.stringify(canonical(publicMatch(mem))))
                            throw new MemDriveError('INVALID_RESPONSE', 'Concurrent searches returned conflicting versions of one mem.');
                        return previous.alias;
                    }
                    const alias = `e${observed.size + 1}`;
                    if (!parents.has(mem.memId)) {
                        const parentAlias = `m${parents.size + 1}`;
                        parents.set(mem.memId, parentAlias); parentAliases.set(parentAlias, mem.memId);
                    }
                    observed.set(mem.id, { alias, mem }); aliases.set(alias, mem.id); spans.set(spanKey, mem.id);
                    const { memId: _memId, ...content } = publicMatch(mem);
                    newMems.push({ id: alias, mem_id: parents.get(mem.memId)!, ...content }); newIds.push(mem.id);
                    return alias;
                });
                output = { matches, new_evidence: newMems };
                await observe({ type: 'retrieved', ids: newIds, matches: newIds.map(id => publicMatch(observed.get(id)!.mem)) });
            }
            input.push({ type: 'function_call_output', call_id: value.call.call_id, output: JSON.stringify(output) });
            await record({ phase: 'tool', step, call: structuredClone(value.call), output: structuredClone(output) });
        }
    }
    throw new MemDriveError('FINAL_REPORT_FAILED', 'Retrieval ended without a valid final selection.');
}
