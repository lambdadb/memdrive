import assert from 'node:assert/strict';
import { context, resultSpans, selectEvidence, spanKey } from './protocol.mjs';

export function canonicalToolDefinitions(definitions) {
    const visit = value => {
        if (Array.isArray(value)) return value.map(visit);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
            key === 'enum' && Array.isArray(item) ? item.map(visit).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0) : visit(item)]));
    };
    return definitions.map(tool => ({ ...tool, inputSchema: visit(tool.inputSchema), outputSchema: visit(tool.outputSchema) }));
}

export function modelTools(definitions) {
    assert(definitions.every(tool => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint), 'Only read-only tools are allowed');
    return definitions.map(tool => ({ type: 'function', name: tool.name, description: tool.description,
        parameters: tool.inputSchema, strict: false }));
}
const unique = spans => [...new Map(spans.map(span => [spanKey(span), span])).values()];

export async function collectEvidence({ mode, tools, prepared, config, countTokens, ask, signal, onTool = async () => {}, now = Date.now }) {
    assert(['single_pass', 'agentic'].includes(mode));
    const trace = [], retrieved = [], delivered = [];
    let calls = 0;
    const execute = async (name, args, callId) => {
        assert(++calls <= config.limits.toolCalls, 'Tool-call budget exhausted');
        signal?.throwIfAborted();
        const startedAt = now();
        const raw = await tools.execute(name, args, { signal });
        const spans = resultSpans(name, raw, prepared, tools.resolveId, config.evidenceIds ? tools.resolveEvidence : undefined).map(span => ({ ...span,
            ...(['memdrive_read', 'memdrive_list'].includes(name) ? { fullOriginal: true } : {}) }));
        retrieved.push(...spans);
        const tooLarge = countTokens(JSON.stringify(raw)) > config.limits.toolResultTokens;
        const result = tooLarge ? { ok: false, error: { code: 'BENCHMARK_RESULT_LIMIT',
            message: 'Result exceeds the benchmark delivery budget. No result text was delivered. Use smaller or more targeted requests.' } } : raw;
        if (!tooLarge) delivered.push(...spans);
        const event = { callId, name, args, startedAt, raw, delivered: result };
        trace.push(event); await onTool(event);
        return result;
    };
    if (mode === 'single_pass') {
        await execute('memdrive_recall', { requests: [{ query: `User: [Question date: ${prepared.questionTimestamp}]\n${prepared.question}`,
            limit: config.retrieval.limit }] }, 'single_pass');
        assert(trace[0].raw.ok && trace[0].raw.value.results.every(result => !result.error), 'Single-pass recall failed');
        assert(trace[0].delivered.ok, 'Single-pass result exceeds delivery budget');
        return { trace, retrieved: unique(retrieved), delivered: unique(delivered), selected: unique(delivered), rounds: 0 };
    }
    assert.equal(config.collectorTransport, 'openai-responses');
    const input = [{ role: 'system', content: config.evidenceIds ? config.prompts.collectEvidenceIds : config.prompts.collect },
        { role: 'user', content: JSON.stringify(context(prepared)) }];
    const definitions = modelTools(tools.definitions), ids = new Set();
    for (let round = 0; round < config.limits.rounds; round++) {
        const request = { model: config.model.model, reasoning: { effort: config.model.reasoning_effort },
            max_output_tokens: config.model.max_completion_tokens, store: false, include: ['reasoning.encrypted_content'],
            input: structuredClone(input), tools: definitions, parallel_tool_calls: false };
        assert(countTokens(JSON.stringify(request)) + request.max_output_tokens <= config.limits.contextTokens,
            'Agent context budget exhausted');
        const response = await ask(request, round);
        assert.equal(response.status, 'completed', 'Collector response incomplete or failed');
        assert(Array.isArray(response.output) && response.output.every(item => ['reasoning', 'function_call', 'message'].includes(item.type)),
            'Unexpected collector output item');
        const toolCalls = response.output.filter(item => item.type === 'function_call');
        if (!toolCalls.length) {
            const messages = response.output.filter(item => item.type === 'message' && item.phase !== 'commentary');
            assert(messages.length && messages.every(item => item.role === 'assistant' && item.status === 'completed'
                && Array.isArray(item.content) && item.content.every(part => part.type === 'output_text')), 'Collector did not return final text');
            const text = messages.flatMap(item => item.content.map(part => part.text)).join('');
            const selected = selectEvidence(JSON.parse(text), delivered, tools.resolveId, config.evidenceIds ? tools.resolveEvidence : undefined);
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
