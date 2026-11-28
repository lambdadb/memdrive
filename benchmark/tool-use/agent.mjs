import assert from 'node:assert/strict';
import { get_encoding } from 'tiktoken';
import { fileToolInstructions } from '@functional-systems/memdrive';
import { guideURI } from './host.mjs';

// v7: text-mode write and read descriptions keep standing instructions in
// /preferences.md and read it first; v6: agent-facing wording: tool descriptions
// say when to use each tool, the instructions only relate the tools and the guide
// is on-demand reference; v5:
// adds tree and path-ordered, consistent list; v4: six main-only tools and
// host-checkpointed writes; v3 wrote to main or a fork with at and restored views
// with rollback; v2 published forks with merge; v1 used host view rebinding.
export const protocol = 'memdrive-tool-use-v7';
export const limits = Object.freeze({ rounds: 16, toolCalls: 40, contextTokens: 32000, totalTokens: 160000, outputTokens: 4096, resultBytes: 64000, requestSeconds: 180 });
export const serverInstructions = fileToolInstructions + ' Writing to the shared drive is authorized when the task asks for a change. Report the actual outcome and any blocker honestly.';
export const workflowInstructions = 'Workflow guidance: search and read the relevant originals and related current guidance before editing. Preserve dated evidence and the original wording of what you save. Prefer exact edits for small changes and save each turn\'s changes with one write call. If someone else changed the text you are editing, stop and report it; do not overwrite their change or claim yours was applied.';
export const userReminder = 'Use MemDrive to check the relevant originals and related guidance, then verify any requested edits. Preserve dated evidence and report blockers.';

const failureMessages = {
    CONTEXT_BUDGET_EXHAUSTED: 'Context budget exhausted',
    TOKEN_BUDGET_EXHAUSTED: 'Token budget exhausted',
    MODEL_IDENTITY_MISMATCH: 'Model identity mismatch',
    MODEL_RESPONSE_INCOMPLETE: 'Incomplete model response',
    MODEL_OUTPUT_INVALID: 'Invalid model output',
    MODEL_OUTPUT_UNSUPPORTED: 'Unsupported model output',
    MODEL_USAGE_INVALID: 'Missing usage',
    FINAL_TEXT_MISSING: 'Missing final text',
    TOOL_CALL_BUDGET_EXHAUSTED: 'Tool-call budget exhausted',
    TOOL_CALL_ID_INVALID: 'Duplicate or invalid call ID',
    TOOL_CALL_INVALID: 'Invalid tool call',
    ROUND_BUDGET_EXHAUSTED: 'Round budget exhausted',
    MODEL_REQUEST_FAILED: 'Model request failed or outcome unknown',
    MODEL_PHASE_TIMEOUT: 'Model phase timed out',
};
export const agentFailureCodes = Object.freeze(Object.keys(failureMessages));
export class AgentFailure extends Error {
    constructor(code) {
        super(failureMessages[code]);
        this.code = code;
    }
}
function requireAgent(condition, code) {
    if (!condition) throw new AgentFailure(code);
}

export async function runAgent({ host, scenario, ask, model = 'gpt-6.1-sol', guide = 'tool', instruction = 'server', signal,
    budget = limits, onReceipt = async () => {} }) {
    assert(['none', 'tool', 'resource'].includes(guide));
    assert(['server', 'workflow', 'user'].includes(instruction));
    const encoder = get_encoding('cl100k_base');
    const input = [{ role: 'developer', content: serverInstructions },
        ...(instruction === 'workflow' ? [{ role: 'developer', content: workflowInstructions }] : []),
        { role: 'user', content: scenario.task + (instruction === 'user' ? '\n\n' + userReminder : '') }];
    if (guide === 'resource') {
        const listed = host.resourcesList();
        assert(listed.resources.some(item => item.uri === guideURI));
        const resources = listed.resources.map(item => host.resourcesRead(item.uri));
        input.splice(1, 0, ...resources.map(resource => ({ role: 'developer', content: resource.contents[0].text })));
    }
    const offered = [], seen = new Set();
    let calls = 0, tokens = 0;
    const usage = { requests: 0, inputTokens: 0, outputTokens: 0 };
    try {
        for (let round = 0; round < budget.rounds; round++) {
            signal?.throwIfAborted();
            const definitions = host.toolsList().tools;
            const tools = definitions.map(tool => ({ type: 'function', name: tool.name, description: tool.description,
                parameters: tool.inputSchema, strict: false }));
            offered.push({ round, definitions });
            const request = { model, reasoning: { effort: 'low' }, store: false, include: ['reasoning.encrypted_content'], parallel_tool_calls: false,
                max_output_tokens: budget.outputTokens, tools, input: [...input] };
            const reservation = encoder.encode(JSON.stringify(request), [], []).length + budget.outputTokens;
            requireAgent(reservation <= budget.contextTokens, 'CONTEXT_BUDGET_EXHAUSTED');
            requireAgent(tokens + reservation <= budget.totalTokens, 'TOKEN_BUDGET_EXHAUSTED');
            usage.requests++;
            const response = await ask(request, { round, signal });
            await onReceipt({ round, request, response });
            requireAgent(response?.model === model, 'MODEL_IDENTITY_MISMATCH');
            requireAgent(response.status === 'completed', 'MODEL_RESPONSE_INCOMPLETE');
            requireAgent(Array.isArray(response.output), 'MODEL_OUTPUT_INVALID');
            requireAgent(response.output.every(item => item && ['reasoning', 'function_call', 'message'].includes(item.type)), 'MODEL_OUTPUT_UNSUPPORTED');
            for (const key of ['input_tokens', 'output_tokens'])
                requireAgent(Number.isSafeInteger(response.usage?.[key]) && response.usage[key] >= 0, 'MODEL_USAGE_INVALID');
            usage.inputTokens += response.usage.input_tokens;
            usage.outputTokens += response.usage.output_tokens;
            tokens += response.usage.input_tokens + response.usage.output_tokens;
            requireAgent(tokens <= budget.totalTokens, 'TOKEN_BUDGET_EXHAUSTED');
            const batch = response.output.filter(item => item.type === 'function_call');
            // Retain opaque reasoning items and message phase fields for stateless continuation.
            input.push(...structuredClone(response.output));
            if (!batch.length) {
                const messages = response.output.filter(item => item.type === 'message' && item.role === 'assistant');
                requireAgent(messages.length && messages.every(item => Array.isArray(item.content) && item.content.every(part => part?.type === 'output_text' && typeof part.text === 'string')), 'FINAL_TEXT_MISSING');
                return { finalText: messages.flatMap(item => item.content.map(part => part.text)).join('\n'), offered, usage, rounds: round + 1 };
            }
            requireAgent(calls + batch.length <= budget.toolCalls, 'TOOL_CALL_BUDGET_EXHAUSTED');
            for (const call of batch) {
                requireAgent(typeof call.call_id === 'string' && call.call_id && !seen.has(call.call_id), 'TOOL_CALL_ID_INVALID');
                seen.add(call.call_id); calls++;
                requireAgent(typeof call.name === 'string' && typeof call.arguments === 'string', 'TOOL_CALL_INVALID');
                let result;
                try { result = await host.toolsCall(call.name, JSON.parse(call.arguments), { signal }); }
                catch (error) {
                    if (!(error instanceof SyntaxError)) throw error;
                    result = { ok: false, error: { code: 'INVALID_JSON', message: 'Tool arguments must be valid JSON.' } };
                    host.events.push({ kind: 'tool', name: call.name, rawArguments: call.arguments, result });
                }
                let output = JSON.stringify(result);
                if (Buffer.byteLength(output) > budget.resultBytes) output = JSON.stringify({ ok: false,
                    error: { code: 'TOOL_RESULT_TOO_LARGE', message: 'The operation completed but its result exceeded the host delivery limit. Inspect state; do not blindly retry a mutation. Use a bounded read or smaller query.' } });
                host.events.findLast(event => event.kind === 'tool').delivery = { truncated: Buffer.byteLength(JSON.stringify(result)) > budget.resultBytes };
                input.push({ type: 'function_call_output', call_id: call.call_id, output });
            }
        }
        throw new AgentFailure('ROUND_BUDGET_EXHAUSTED');
    } finally { encoder.free(); }
}

export function openAI({ key, fetcher = fetch }) {
    assert(typeof key === 'string' && key.trim(), 'Missing LLM_API_KEY');
    return async (request, { signal }) => {
        const response = await fetcher('https://api.openai.com/v1/responses', {
            method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
            body: JSON.stringify(request), redirect: 'error', signal: AbortSignal.any([
                ...(signal ? [signal] : []), AbortSignal.timeout(limits.requestSeconds * 1000),
            ]),
        });
        // Never record service error bodies, headers, credentials or exception stacks.
        if (!response.ok) throw Object.assign(new Error(`Model HTTP ${response.status}`), { code: 'MODEL_HTTP_ERROR', status: response.status });
        const raw = await response.text();
        assert(!raw.includes(key), 'Response contained a credential');
        return JSON.parse(raw);
    };
}
