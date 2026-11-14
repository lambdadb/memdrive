import assert from 'node:assert/strict';
import { createRetriever } from '@functional-systems/memdrive/retriever';
import { canonicalToolDefinitions, modelTools } from './agent.mjs';
import { context, resultSpans, spanKey, validateSpan } from './protocol.mjs';

const unique = spans => [...new Map(spans.map(span => [spanKey(span), span])).values()];

// Provider transport, application context and audit validation stay outside the SDK.
export async function sdkCollector({ drive, prepared, config, definitions, countTokens, ask, signal,
    onTool = async () => {}, onOutcome = async () => {}, now = Date.now, beforeTool = () => {}, replayTool }) {
    assert(config.shortIds && config.evidenceIds && config.collectorTransport === 'openai-responses');
    const trace = [], retrieved = [], delivered = [], recorded = new Map();
    let startedAt, rounds = 0;
    const retriever = await createRetriever({ drive, strategy: 'agentic', agent: {
        instructions: config.prompts.collectEvidenceIds, countTokens,
        limits: { rounds: config.limits.rounds, toolCalls: config.limits.toolCalls,
            dataCalls: config.limits.dataCalls ?? 120, contextTokens: config.limits.contextTokens,
            modelTokens: config.limits.modelTokensPerQuestion, maxOutputTokens: config.model.max_completion_tokens,
            toolResultTokens: config.limits.toolResultTokens, timeoutMs: config.limits.questionSeconds * 1000 },
        model: { createSession({ instructions, tools }) {
            assert.deepEqual(canonicalToolDefinitions(tools), definitions, 'SDK tools differ from frozen definitions');
            const input = [{ role: 'system', content: instructions }, { role: 'user', content: JSON.stringify(context(prepared)) }];
            return { prepare(replies) {
                for (const reply of replies) input.push({ type: 'function_call_output', call_id: reply.id,
                    output: JSON.stringify(recorded.get(reply.id)?.delivered ?? reply.result) });
                const request = { model: config.model.model, reasoning: { effort: config.model.reasoning_effort },
                    max_output_tokens: config.model.max_completion_tokens, store: false, include: ['reasoning.encrypted_content'],
                    input: structuredClone(input), tools: modelTools(definitions), parallel_tool_calls: false };
                return { inputTokens: countTokens(JSON.stringify(request)), respond: async ({ maxOutputTokens, signal }) => {
                    assert.equal(maxOutputTokens, request.max_output_tokens);
                    const response = await ask(request, rounds++, signal);
                    const usage = { inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens };
                    if (response.status !== 'completed') return { status: 'incomplete', usage };
                    try {
                    assert(Array.isArray(response.output) && response.output.every(item => ['reasoning', 'function_call', 'message'].includes(item.type)));
                    const calls = response.output.filter(item => item.type === 'function_call');
                    if (calls.length) {
                        input.push(...structuredClone(response.output));
                        return { status: 'completed', usage, calls: calls.map(call => ({ id: call.call_id, name: call.name, arguments: JSON.parse(call.arguments) })) };
                    }
                    const messages = response.output.filter(item => item.type === 'message' && item.phase !== 'commentary');
                    assert(messages.length && messages.every(item => item.role === 'assistant' && item.status === 'completed'
                        && Array.isArray(item.content) && item.content.every(part => part.type === 'output_text')));
                    const selection = JSON.parse(messages.flatMap(item => item.content.map(part => part.text)).join(''));
                    assert(selection && Object.keys(selection).length === 1 && Array.isArray(selection.evidence));
                    return { status: 'completed', usage, evidenceIds: selection.evidence };
                    } catch { return { status: 'incomplete', usage }; }
                } };
            } };
        } },
    }, record: async event => {
        if (event.phase === 'tool_request') { beforeTool(event.call); startedAt = now(); }
        if (event.phase !== 'tool') return;
        const canonical = new Map(event.sources.map(source => [source.evidenceId, source.match]));
        const aliases = new Map();
        const values = !event.raw.ok ? [] : event.call.name === 'memdrive_recall'
            ? event.raw.value.results.flatMap(item => item.matches ?? []) : event.raw.value.mems ?? [];
        for (const value of values) aliases.set(value.memId ?? value.id, canonical.get(value.evidenceId).memId);
        const spans = resultSpans(event.call.name, event.raw, prepared, id => aliases.get(id) ?? id,
            id => { const span = canonical.get(id); assert(span); return { memId: span.memId, start: span.start, end: span.end }; })
            .map(span => ({ ...span, ...(['memdrive_read', 'memdrive_list'].includes(event.call.name) ? { fullOriginal: true } : {}) }));
        retrieved.push(...spans);
        if (event.delivered.ok) delivered.push(...spans);
        let entry = { callId: event.call.id, name: event.call.name, args: event.call.arguments, startedAt, raw: event.raw, delivered: event.delivered };
        if (replayTool) entry = replayTool(entry);
        trace.push(entry); recorded.set(entry.callId, entry); await onTool(entry);
    } }, { signal });
    return async () => {
        const outcome = await retriever.recall({ query: prepared.question, limit: config.retrieval.limit }, { signal });
        await onOutcome(outcome);
        assert.equal(outcome.completion.status, 'completed', `SDK retrieval stopped: ${outcome.completion.reason}`);
        const byKey = new Map(delivered.map(span => [spanKey(span), span]));
        const selected = outcome.matches.map(match => { const span = validateSpan(match, prepared); assert(byKey.has(spanKey(span))); return byKey.get(spanKey(span)); });
        return { trace, retrieved: unique(retrieved), delivered: unique(delivered), selected, rounds };
    };
}
