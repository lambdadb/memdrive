// One replayed session: user utterances are sent in order to a Responses model
// that has the MemDrive file-tool catalog. The model sees only what an MCP
// deployment could deliver: the utterances, the SDK tool definitions and results,
// and optional server instructions. Nothing else is injected.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { get_encoding } from 'tiktoken';
import { createFileTools, fileToolError, getFileToolDefinitions } from '@functional-systems/memdrive';

// v4: text-mode `write` offers `append` and its results carry no file content.
// v3 offered the seven main-only tools, with `tree` and a path-ordered, consistent
// `list`, and returned each written file's content; v2 offered six tools without
// `tree` and an unordered, eventual `list`; v1 used 16 tools with an `at` view
// selector and published forks with merge. Their runs are not comparable.
export const protocol = 'memdrive-beam-session-replay-v4';
/** Replay protocols whose retained stores the question stage reads: v3 stores have the same layout. */
export const readableProtocols = Object.freeze(['memdrive-beam-session-replay-v3', protocol]);
/** The SDK's whole agent catalog, in its documented order. `--guide off` leaves out `guide`. */
export const toolNames = Object.freeze(['guide', 'read', 'tree', 'list', 'search', 'findText', 'write']);
export const guideSettings = Object.freeze(['on', 'off']);
/** The tools offered with a guide setting, from a full allowlist. */
export const withGuide = (tools, guide) => {
    assert(guideSettings.includes(guide), 'Use --guide on or off');
    return Object.freeze(guide === 'on' ? [...tools] : tools.filter(name => name !== 'guide'));
};
/**
 * Checkpoint names for the host hook, as the SDK README advises: a time and a random
 * suffix, so they stay unique across sessions and across any later run on the same store.
 */
export const checkpointName = () => ({ name: `turn-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}` });
// Host budgets, not model limits. The token estimator is cl100k_base.
export const limits = Object.freeze({ roundsPerTurn: 16, toolCallsPerTurn: 40, contextTokens: 120000, sessionTokens: 4000000,
    outputTokens: 8192, resultBytes: 64000, requestSeconds: 180, sessionSeconds: 3600 });

const failureMessages = {
    CONTEXT_BUDGET_EXHAUSTED: 'Context budget exhausted',
    TOKEN_BUDGET_EXHAUSTED: 'Session token budget exhausted',
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
    SESSION_TIMEOUT: 'Session timed out',
};
export const failureCodes = Object.freeze(Object.keys(failureMessages));
export class ReplayFailure extends Error {
    constructor(code) {
        super(failureMessages[code]);
        this.code = code;
    }
}
function requireReplay(condition, code) {
    if (!condition) throw new ReplayFailure(code);
}

/** The catalog advertised for the whole run, unchanged from the SDK. */
export const toolDefinitions = (tools = toolNames) => getFileToolDefinitions({ embeddingMode: 'managed', tools });

/**
 * Execute model tool calls against main of one drive. The model receives the SDK
 * result unchanged, the SDK's normalized error, or an explicit delivery-limit error;
 * never a truncated result. `tools` is the SDK allowlist; a call outside it gets the
 * SDK's `TOOL_NOT_ALLOWED`. With `checkpoint`, every `write` call is a checkpointed
 * write; the event records the name the hook gave it, which the model never sees.
 */
export function createToolHost({ drive, resultBytes = limits.resultBytes, tools: allowed = toolNames, checkpoint }) {
    let named;
    const tools = createFileTools({ drive, tools: allowed,
        ...(checkpoint ? { checkpoint: () => (named = checkpoint().name, { name: named }) } : {}) });
    return async function call(name, rawArguments, { signal } = {}) {
        let event;
        try {
            const args = JSON.parse(rawArguments);
            named = undefined;
            try { event = { name, args, ok: true, result: await tools.execute(name, structuredClone(args), { signal }) }; }
            catch (error) { event = { name, args, ok: false, error: fileToolError(error).error }; }
            // The hook runs once per write call that reaches the SDK; its tag exists only after a success.
            if (named !== undefined) event.checkpoint = named;
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            event = { name, rawArguments, ok: false, error: { code: 'INVALID_JSON', message: 'Tool arguments must be valid JSON.' } };
        }
        event = structuredClone(event);
        let output = JSON.stringify(event.ok ? event.result : { ok: false, error: event.error });
        event.delivered = Buffer.byteLength(output) <= resultBytes;
        if (!event.delivered) output = JSON.stringify({ ok: false, error: { code: 'TOOL_RESULT_TOO_LARGE',
            message: 'The operation completed but its result exceeded the host delivery limit. Inspect state; do not blindly retry a mutation. Use a bounded read or smaller query.' } });
        return { event, output };
    };
}

/**
 * Replay `turns` user utterances of one session in a fresh model conversation.
 * `state` is filled as the session runs so a failure keeps everything observed:
 * input items, request receipts, tool events and the number of utterances sent.
 * Each settled receipt and each tool event carries `elapsedMs` measured with `clock`.
 */
export async function runSession({ session, turns = session.turns.length, call, ask, model, instructions = null, definitions,
    budget = limits, signal, state = { input: [], requests: [], events: [], userTurns: 0 }, hooks = {}, clock = () => performance.now(), date = null }) {
    const encoder = get_encoding('cl100k_base');
    const tools = definitions.map(tool => ({ type: 'function', name: tool.name, description: tool.description,
        parameters: tool.inputSchema, strict: false }));
    const push = async item => { state.input.push(item); await hooks.item?.(item); };
    const seen = new Set();
    let tokens = 0;
    try {
        if (instructions !== null) await push({ role: 'developer', content: instructions });
        // An agent application tells its model the date. It is not part of the server instructions.
        if (date !== null) await push({ role: 'developer', content: `Current date: ${date}` });
        for (let turn = 0; turn < turns; turn++) {
            await push({ role: 'user', content: session.turns[turn].content });
            state.userTurns = turn + 1;
            let calls = 0, answered = false;
            for (let round = 0; round < budget.roundsPerTurn && !answered; round++) {
                signal?.throwIfAborted();
                const request = { model, reasoning: { effort: 'low' }, store: false, include: ['reasoning.encrypted_content'],
                    parallel_tool_calls: false, max_output_tokens: budget.outputTokens, tools, input: [...state.input] };
                const reservation = encoder.encode(JSON.stringify(request), [], []).length + budget.outputTokens;
                requireReplay(reservation <= budget.contextTokens, 'CONTEXT_BUDGET_EXHAUSTED');
                requireReplay(tokens + reservation <= budget.sessionTokens, 'TOKEN_BUDGET_EXHAUSTED');
                // A request is the manifest's fixed fields plus the first `inputItems` transcript items.
                const receipt = { turn, round, inputItems: state.input.length, status: 'pending' };
                state.requests.push(receipt);
                await hooks.receipt?.(receipt);
                let response;
                const started = clock();
                try {
                    response = await ask(request, { session: session.index, turn, round, signal });
                } catch (error) {
                    receipt.elapsedMs = clock() - started;
                    receipt.status = 'failed_or_uncertain';
                    // Never record service error bodies, headers, credentials or stacks.
                    receipt.error = error?.code === 'MODEL_HTTP_ERROR' && Number.isInteger(error.status)
                        ? { code: 'MODEL_HTTP_ERROR', status: error.status } : { code: 'REQUEST_FAILED' };
                    await hooks.receipt?.(receipt);
                    throw new ReplayFailure(signal?.aborted ? 'SESSION_TIMEOUT' : 'MODEL_REQUEST_FAILED');
                }
                receipt.elapsedMs = clock() - started;
                receipt.status = 'completed';
                receipt.response = response;
                receipt.usage = response?.usage;
                await hooks.receipt?.(receipt);
                requireReplay(response?.model === model, 'MODEL_IDENTITY_MISMATCH');
                requireReplay(response.status === 'completed', 'MODEL_RESPONSE_INCOMPLETE');
                requireReplay(Array.isArray(response.output), 'MODEL_OUTPUT_INVALID');
                requireReplay(response.output.every(item => item && ['reasoning', 'function_call', 'message'].includes(item.type)), 'MODEL_OUTPUT_UNSUPPORTED');
                for (const key of ['input_tokens', 'output_tokens'])
                    requireReplay(Number.isSafeInteger(response.usage?.[key]) && response.usage[key] >= 0, 'MODEL_USAGE_INVALID');
                tokens += response.usage.input_tokens + response.usage.output_tokens;
                requireReplay(tokens <= budget.sessionTokens, 'TOKEN_BUDGET_EXHAUSTED');
                // Retain opaque reasoning items and message phase fields for stateless continuation.
                for (const item of structuredClone(response.output)) await push(item);
                const batch = response.output.filter(item => item.type === 'function_call');
                if (!batch.length) {
                    const messages = response.output.filter(item => item.type === 'message' && item.role === 'assistant');
                    requireReplay(messages.length && messages.every(item => Array.isArray(item.content)
                        && item.content.every(part => part?.type === 'output_text' && typeof part.text === 'string')), 'FINAL_TEXT_MISSING');
                    answered = true;
                    break;
                }
                requireReplay(calls + batch.length <= budget.toolCallsPerTurn, 'TOOL_CALL_BUDGET_EXHAUSTED');
                for (const item of batch) {
                    requireReplay(typeof item.call_id === 'string' && item.call_id && !seen.has(item.call_id), 'TOOL_CALL_ID_INVALID');
                    seen.add(item.call_id);
                    calls++;
                    requireReplay(typeof item.name === 'string' && typeof item.arguments === 'string', 'TOOL_CALL_INVALID');
                    const started = clock();
                    const { event, output } = await call(item.name, item.arguments, { signal });
                    const recorded = { turn, round, ...event, elapsedMs: clock() - started };
                    state.events.push(recorded);
                    await hooks.event?.(recorded);
                    await push({ type: 'function_call_output', call_id: item.call_id, output });
                }
            }
            requireReplay(answered, 'ROUND_BUDGET_EXHAUSTED');
        }
        return state;
    } catch (error) {
        if (signal?.aborted && error === signal.reason) throw new ReplayFailure('SESSION_TIMEOUT');
        throw error;
    } finally { encoder.free(); }
}

/** One OpenAI request per call to `responses` or `chat/completions`; never retried. */
export function openAI({ key, fetcher = fetch, endpoint = 'responses' }) {
    assert(typeof key === 'string' && key.trim(), 'Missing LLM_API_KEY');
    assert(['responses', 'chat/completions'].includes(endpoint), 'Unsupported OpenAI endpoint');
    return async (request, { signal }) => {
        const response = await fetcher(`https://api.openai.com/v1/${endpoint}`, {
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

/**
 * Deterministic transport and metrics smoke only; never evidence of model behavior.
 * Session 0 reads the guide, describes the whole drive with `tree`, searches, creates
 * a note and lists its folder by `prefix` in its first turn; in its second, when it
 * has one, it reads the note, edits it exactly and tries to create it again
 * (`PATH_EXISTS`, which changes nothing). Session 1 describes the note's folder with
 * `tree`, creates a file without a lookup (`tree` is none), finds the note literally
 * and deletes it, then appends by path to the file it created and to a new log, which
 * the append creates. Every other turn only replies. A step whose tool the run does not
 * offer (`guide` with `--guide off`) is skipped.
 */
export function scriptedTransport() {
    const note = '/notes/scripted.md';
    const steps = (session, turn) => {
        const list = [];
        const add = (name, args) => list.push({ name, args });
        if (session === 0 && turn === 0) {
            add('guide', {});
            add('guide', { topic: 'editing' });
            add('tree', {});
            add('search', { query: 'scripted note', mode: 'keyword' });
            add('write', { op: 'create', path: note, content: 'Scripted note.\n' });
            add('list', { prefix: '/notes/' });
        } else if (session === 0 && turn === 1) {
            add('read', { path: note });
            add('write', previous => ({ op: 'update', fileId: previous.fileId, edits: [{ oldText: 'Scripted note.', newText: 'Scripted note, revised.' }] }));
            add('write', { op: 'create', path: note, content: 'A second note at the same path.\n' });
        } else if (session === 1 && turn === 0) {
            add('tree', { prefix: '/notes/' });
            add('write', { op: 'create', path: '/notes/unsearched.md', content: 'Saved without looking first.\n' });
            add('findText', { query: 'revised', prefix: '/notes/' });
            add('write', previous => ({ op: 'delete', fileId: previous.hits[0].fileId }));
            add('write', { operations: [{ op: 'append', path: '/notes/unsearched.md', content: 'An entry appended later.\n' },
                { op: 'append', path: '/notes/log.md', content: 'First log entry.\n' }] });
        }
        return list;
    };
    return async (request, { session, turn, round }) => {
        const offered = new Set(request.tools.map(tool => tool.name));
        const step = steps(session, turn).filter(item => offered.has(item.name))[round];
        const prior = request.input.filter(item => item.type === 'function_call_output').at(-1);
        const output = step
            ? [{ type: 'function_call', call_id: `scripted-${session}-${turn}-${round}`, name: step.name,
                arguments: JSON.stringify(typeof step.args === 'function' ? step.args(JSON.parse(prior.output)) : step.args) }]
            : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Scripted reply.' }] }];
        return { model: request.model, status: 'completed', usage: { input_tokens: 0, output_tokens: 0 }, output };
    };
}
