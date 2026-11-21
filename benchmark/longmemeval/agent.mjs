import assert from 'node:assert/strict';
import { context, fileIdPattern, resultSpans, selectEvidence, spanKey } from './protocol.mjs';

const functionTool = (name, description, properties, required) => ({ type: 'function', name, description,
    parameters: { type: 'object', properties, required, additionalProperties: false }, strict: false });

export function fileTools(config) {
    return [
        functionTool('search_files', 'Search archived files and return attributed excerpts.',
            { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: config.retrieval.limit } }, ['query']),
        functionTool('read_file', 'Read the full original of a file returned by search.',
            { fileId: { type: 'string' } }, ['fileId']),
    ];
}

const toolError = (code, message) => ({ ok: false, error: { code, message } });

export async function runTool(drive, name, args, config, signal) {
    if (args && typeof args === 'object' && !Array.isArray(args)) {
        const keys = Object.keys(args);
        if (name === 'search_files' && keys.every(key => ['query', 'limit'].includes(key))
            && typeof args.query === 'string' && args.query.trim()) {
            const limit = args.limit === undefined ? config.retrieval.limit : args.limit;
            if (Number.isSafeInteger(limit) && limit > 0 && limit <= config.retrieval.limit) {
                const value = await drive.search({ query: args.query, limit, rerank: config.retrieval.rerank }, { signal });
                return { ok: true, value };
            }
        }
        if (name === 'read_file' && keys.length === 1 && typeof args.fileId === 'string' && fileIdPattern.test(args.fileId)) {
            const value = await drive.read({ fileId: args.fileId }, { signal });
            return value === null ? toolError('FILE_NOT_FOUND', 'The file was not found.') : { ok: true, value };
        }
    }
    return toolError('INVALID_TOOL_REQUEST', 'Use the declared file tools and arguments.');
}

const unique = spans => [...new Map(spans.map(span => [spanKey(span), span])).values()];

export async function collectEvidence({ mode, definitions, executeTool, prepared, sources, config, countTokens, ask, signal, onTool = async () => {}, now = Date.now }) {
    assert(['single_pass', 'agentic'].includes(mode));
    const trace = [], retrieved = [], delivered = [];
    let calls = 0;
    const execute = async (name, args, callId) => {
        assert(++calls <= config.limits.toolCalls, 'Tool-call budget exhausted');
        signal?.throwIfAborted();
        const startedAt = now();
        const raw = await executeTool(name, args, { signal });
        const spans = resultSpans(name, raw, sources);
        retrieved.push(...spans);
        const delivery = !raw.ok ? raw : { ok: true, spans };
        if (raw.ok && name === 'search_files') {
            const attributed = new Set(spans.map(span => span.fileId));
            const otherFiles = new Map(raw.value.hits.filter(hit => !attributed.has(hit.fileId))
                .map(({ fileId, path }) => [fileId, { fileId, path }]));
            Object.assign(delivery, { reranked: raw.value.reranked, otherFiles: [...otherFiles.values()] });
        }
        const tooLarge = countTokens(JSON.stringify(delivery)) > config.limits.toolResultTokens;
        const result = tooLarge ? toolError('BENCHMARK_RESULT_LIMIT',
            'Result exceeds the benchmark delivery budget. No result text was delivered. Use smaller or more targeted requests.') : delivery;
        if (!tooLarge) delivered.push(...spans);
        const event = { callId, name, args, startedAt, raw, delivered: result };
        trace.push(event); await onTool(event);
        return result;
    };
    if (mode === 'single_pass') {
        await execute('search_files', { query: `User: [Question date: ${prepared.questionTimestamp}]\n${prepared.question}`,
            limit: config.retrieval.limit }, 'single_pass');
        assert(trace[0].raw.ok, 'Single-pass file search failed');
        assert(trace[0].delivered.ok, 'Single-pass result exceeds delivery budget');
        return { trace, retrieved: unique(retrieved), delivered: unique(delivered), selected: unique(delivered), rounds: 0 };
    }
    assert.equal(config.collectorTransport, 'openai-responses');
    const input = [{ role: 'system', content: config.prompts.collect },
        { role: 'user', content: JSON.stringify(context(prepared)) }];
    const ids = new Set();
    for (let round = 0; round < config.limits.rounds; round++) {
        const request = { model: config.model.model, reasoning: { effort: config.model.reasoning_effort },
            max_output_tokens: config.model.max_completion_tokens, store: false, include: ['reasoning.encrypted_content'],
            input: structuredClone(input), tools: definitions, parallel_tool_calls: false };
        assert(countTokens(JSON.stringify(request)) + request.max_output_tokens <= config.limits.contextTokens,
            'Agent context budget exhausted');
        const response = await ask(request, round, signal);
        assert.equal(response.status, 'completed', 'Collector response incomplete or failed');
        assert(Array.isArray(response.output) && response.output.every(item => ['reasoning', 'function_call', 'message'].includes(item.type)),
            'Unexpected collector output item');
        const toolCalls = response.output.filter(item => item.type === 'function_call');
        if (!toolCalls.length) {
            const messages = response.output.filter(item => item.type === 'message' && item.phase !== 'commentary');
            assert(messages.length && messages.every(item => item.role === 'assistant' && item.status === 'completed'
                && Array.isArray(item.content) && item.content.every(part => part.type === 'output_text')), 'Collector did not return final text');
            const text = messages.flatMap(item => item.content.map(part => part.text)).join('');
            const selected = selectEvidence(JSON.parse(text), delivered);
            return { trace, retrieved: unique(retrieved), delivered: unique(delivered), selected, rounds: round + 1 };
        }
        assert(calls + toolCalls.length <= config.limits.toolCalls, 'Tool-call budget exhausted');
        // Preserve opaque reasoning and message phase fields exactly for stateless continuation.
        input.push(...structuredClone(response.output));
        for (const call of toolCalls) {
            assert(typeof call.call_id === 'string' && call.call_id.length && !ids.has(call.call_id), 'Invalid tool call ID');
            ids.add(call.call_id);
            assert(typeof call.name === 'string' && typeof call.arguments === 'string');
            // Invalid model JSON is a recorded protocol failure, never silently repaired.
            const result = await execute(call.name, JSON.parse(call.arguments), call.call_id);
            input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
        }
    }
    throw new Error('Agent round budget exhausted before evidence selection');
}
