import assert from 'node:assert/strict';
import { context, resultSpans, selectEvidence, spanKey } from './protocol.mjs';

export function modelTools(definitions) {
    assert(definitions.every(tool => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint), 'Only read-only tools are allowed');
    return definitions.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description,
        parameters: tool.inputSchema } }));
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
        const spans = resultSpans(name, raw, prepared).map(span => ({ ...span,
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
    const messages = [{ role: 'system', content: config.prompts.collect },
        { role: 'user', content: JSON.stringify(context(prepared)) }];
    const definitions = modelTools(tools.definitions), ids = new Set();
    for (let round = 0; round < config.limits.rounds; round++) {
        const request = { ...config.model, messages: structuredClone(messages), tools: definitions, parallel_tool_calls: false };
        assert(countTokens(JSON.stringify(request)) + config.model.max_completion_tokens <= config.limits.contextTokens,
            'Agent context budget exhausted');
        const response = await ask(request, round);
        const choice = response.choices?.[0], message = choice?.message;
        assert(message?.role === 'assistant', 'Expected assistant response');
        if (choice.finish_reason === 'stop') {
            assert(!message.tool_calls?.length && typeof message.content === 'string');
            const selected = selectEvidence(JSON.parse(message.content), delivered);
            return { trace, retrieved: unique(retrieved), delivered: unique(delivered), selected, rounds: round + 1 };
        }
        assert(choice.finish_reason === 'tool_calls' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0,
            'Collector did not finish or call a tool');
        assert(calls + message.tool_calls.length <= config.limits.toolCalls, 'Tool-call budget exhausted');
        messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls });
        for (const call of message.tool_calls) {
            assert(call.type === 'function' && typeof call.id === 'string' && call.id.length && !ids.has(call.id), 'Invalid tool call ID');
            ids.add(call.id);
            assert(typeof call.function?.name === 'string' && typeof call.function.arguments === 'string');
            // Invalid model JSON is a recorded protocol failure, never silently repaired.
            const result = await execute(call.function.name, JSON.parse(call.function.arguments), call.id);
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
    }
    throw new Error('Agent round budget exhausted before evidence selection');
}
