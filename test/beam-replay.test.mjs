import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileToolInstructions, getFileToolDefinitions } from '@functional-systems/memdrive';
import { limits, openAI, toolNames } from '../benchmark/beam/replay-agent.mjs';
import { conversationMetrics, sessionMetrics } from '../benchmark/beam/replay-metrics.mjs';
import { runReplay } from '../benchmark/beam/replay.mjs';
import { groupSessions, hash, loadSessions } from '../benchmark/beam/replay-sessions.mjs';

const config = JSON.parse(await readFile(new URL('../benchmark/beam/original-config.json', import.meta.url)));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const jsonl = async file => (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const exists = file => access(file).then(() => true, () => false);

// Each session lists its user utterance count; every utterance is followed by a dataset reply.
function conversation(userTurns = [3, 1, 2, 2]) {
    const messages = [];
    for (const [session, count] of userTurns.entries()) for (let turn = 0; turn < count * 2; turn++) {
        const user = turn % 2 === 0;
        messages.push({ sourceId: `7_s${String(session).padStart(3, '0')}_t${String(turn).padStart(4, '0')}`, turnId: `id-${messages.length}`,
            ordinal: messages.length, content: user ? `User says ${session}.${turn / 2} 🧭` : `DATASET-ASSISTANT ${session}.${(turn - 1) / 2}`,
            author: user ? { role: 'user', name: 'Test User' } : { role: 'assistant', name: 'Assistant' },
            timestamp: turn === 0 ? `2024-03-0${session + 1}T12:00:00.000Z` : null });
    }
    return { protocol: 'beam-original-v1', id: '7', userIdentity: 'user-7', userTraits: {}, messages, questions: [{ id: 'q', text: 'Unused?' }] };
}

async function prepared(t, source = conversation()) {
    const root = await mkdtemp(path.join(tmpdir(), 'beam-replay-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'conversations'));
    const runtime = `conversations/${source.id}.json`, bytes = JSON.stringify(source), cohort = config.cohorts['100k'];
    await writeFile(path.join(root, runtime), bytes);
    const manifest = path.join(root, 'manifest.json');
    // The evaluation file does not exist: the replay must never read annotations.
    await writeFile(manifest, JSON.stringify({ protocol: 'beam-original-v1', split: '100k', questionPosition: 'after_complete_conversation',
        datasetRevision: cohort.datasetRevision, sourceFiles: Object.fromEntries(cohort.files.map(file => [file.name, file.sha256])),
        conversations: [{ id: source.id, runtime, runtimeSha256: hash(bytes), questions: source.questions.length, evaluation: 'evaluation/missing.json' }] }));
    return { root, manifest, runtime: path.join(root, runtime), output: path.join(root, 'run') };
}

const reply = request => ({ model: request.model, status: 'completed', usage: { input_tokens: 3, output_tokens: 2 },
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] });
const toolCall = (request, id, name, args) => ({ model: request.model, status: 'completed', usage: { input_tokens: 3, output_tokens: 2 },
    output: [{ type: 'function_call', call_id: id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }] });

test('sessions follow the original batches and keep only user utterances', () => {
    const sessions = groupSessions(conversation([2, 1]));
    assert.deepEqual(sessions, [
        { id: 's000', index: 0, timestamp: '2024-03-01T12:00:00.000Z', messages: 4, turns: [
            { sourceId: '7_s000_t0000', turnId: 'id-0', content: 'User says 0.0 🧭' },
            { sourceId: '7_s000_t0002', turnId: 'id-2', content: 'User says 0.1 🧭' }] },
        { id: 's001', index: 1, timestamp: '2024-03-02T12:00:00.000Z', messages: 2, turns: [
            { sourceId: '7_s001_t0000', turnId: 'id-4', content: 'User says 1.0 🧭' }] },
    ]);
    for (const sourceId of ['7_f000001', '7_p001_b0000_g0000_t0000', '8_s000_t0000']) {
        const source = conversation([1]);
        source.messages[0].sourceId = sourceId;
        assert.throws(() => groupSessions(source), /Unsupported BEAM conversation layout/);
    }
    const descending = conversation([1, 1]);
    descending.messages[2].sourceId = '7_s000_t0009';
    descending.messages[3].sourceId = '7_s000_t0010';
    descending.messages[0].sourceId = '7_s001_t0000';
    descending.messages[1].sourceId = '7_s001_t0001';
    assert.throws(() => groupSessions(descending), /ascending order/);
    const silent = conversation([1, 1]);
    silent.messages[2].author = { role: 'assistant', name: 'Assistant' };
    assert.throws(() => groupSessions(silent), /no user utterance/);
});

test('loading verifies the prepared manifest and runtime checksum without reading annotations', async t => {
    const files = await prepared(t);
    const loaded = await loadSessions(files.manifest, '7');
    assert.equal(loaded.split, '100k');
    assert.deepEqual(loaded.sessions.map(session => session.turns.length), [3, 1, 2, 2]);
    assert.equal(loaded.runtimeSha256, hash(await readFile(files.runtime)));
    await assert.rejects(loadSessions(files.manifest, '8'), /Choose one conversation/);
    await writeFile(files.runtime, JSON.stringify(conversation([1])));
    await assert.rejects(loadSessions(files.manifest, '7'), /Prepared runtime checksum changed/);
    const manifest = await json(files.manifest);
    manifest.sourceFiles['100k.parquet'] = '0'.repeat(64);
    await writeFile(files.manifest, JSON.stringify(manifest));
    await assert.rejects(loadSessions(files.manifest, '7'), /Unexpected prepared dataset source hashes/);
});

test('a scripted replay records fork, publication, republication, leftovers and deletion per session', async t => {
    const files = await prepared(t);
    const { summary, manifest, results } = await runReplay({ manifest: files.manifest, conversation: '7', output: files.output, mode: 'scripted', instructions: 'none' });
    assert.equal(manifest.transport, 'scripted');
    assert.deepEqual(manifest.plan.map(entry => [entry.id, entry.userTurns, entry.plannedTurns]), [['s000', 3, 3], ['s001', 1, 1], ['s002', 2, 2], ['s003', 2, 2]]);
    assert.deepEqual({ planned: summary.planned, attempted: summary.attempted, completed: summary.completed, failed: summary.failed,
        complete: summary.complete, cleanup: summary.cleanup }, { planned: 4, attempted: 4, completed: 4, failed: 0, complete: true, cleanup: 'completed' });
    assert.equal(summary.modelBehavior, null, 'A scripted run is never a model measurement');

    const [first, second, third, fourth] = results.map(result => result.metrics);
    const zeroLag = { writes: 0, merged: 0, neverMerged: 0, sameTurn: 0, meanTurns: null, maxTurns: null };
    assert.deepEqual(first, { userTurns: 3, modelRequests: 11, inputTokens: 0, outputTokens: 0, unknownUsageRequests: 0,
        toolCalls: 8, toolCallsByName: { diff: 2, fork: 1, merge: 2, read: 1, write: 2 }, toolErrorsByCode: {},
        forksCreated: 1, forkNameConflicts: 0, forksDeleted: 0, merges: { published: 2, unchanged: 0, failed: 0 },
        publicationLags: [0, 0], publicationLag: { writes: 2, merged: 2, neverMerged: 0, sameTurn: 2, meanTurns: 0, maxTurns: 0 },
        noSuccessfulWrite: false, publications: 2, republishedFiles: 1, republishedFilesIsLowerBound: false,
        forksRemaining: 1, unpublishedForks: 0, unpublishedChanges: 0, publishedForksLeft: 1, unobservedForks: 0 });
    assert.deepEqual(second, { userTurns: 1, modelRequests: 4, inputTokens: 0, outputTokens: 0, unknownUsageRequests: 0,
        toolCalls: 3, toolCallsByName: { fork: 2, write: 1 }, toolErrorsByCode: { BRANCH_CONFLICT: 1 },
        forksCreated: 1, forkNameConflicts: 1, forksDeleted: 0, merges: { published: 0, unchanged: 0, failed: 0 },
        publicationLags: [null], publicationLag: { writes: 1, merged: 0, neverMerged: 1, sameTurn: 0, meanTurns: null, maxTurns: null },
        noSuccessfulWrite: false, publications: 0, republishedFiles: 0, republishedFilesIsLowerBound: false,
        forksRemaining: 2, unpublishedForks: 1, unpublishedChanges: 1, publishedForksLeft: 1, unobservedForks: 0 });
    assert.deepEqual(third, { userTurns: 2, modelRequests: 2, inputTokens: 0, outputTokens: 0, unknownUsageRequests: 0,
        toolCalls: 0, toolCallsByName: {}, toolErrorsByCode: {},
        forksCreated: 0, forkNameConflicts: 0, forksDeleted: 0, merges: { published: 0, unchanged: 0, failed: 0 },
        publicationLags: [], publicationLag: zeroLag,
        noSuccessfulWrite: true, publications: 0, republishedFiles: 0, republishedFilesIsLowerBound: false,
        forksRemaining: 2, unpublishedForks: 1, unpublishedChanges: 1, publishedForksLeft: 1, unobservedForks: 0 });
    assert.deepEqual(fourth, { userTurns: 2, modelRequests: 7, inputTokens: 0, outputTokens: 0, unknownUsageRequests: 0,
        toolCalls: 5, toolCallsByName: { deleteFork: 1, diff: 1, fork: 1, merge: 1, write: 1 }, toolErrorsByCode: {},
        forksCreated: 1, forkNameConflicts: 0, forksDeleted: 1, merges: { published: 1, unchanged: 0, failed: 0 },
        publicationLags: [1], publicationLag: { writes: 1, merged: 1, neverMerged: 0, sameTurn: 0, meanTurns: 1, maxTurns: 1 },
        noSuccessfulWrite: false, publications: 1, republishedFiles: 0, republishedFilesIsLowerBound: false,
        forksRemaining: 2, unpublishedForks: 1, unpublishedChanges: 1, publishedForksLeft: 1, unobservedForks: 0 });
    assert.deepEqual(summary.smoke, { sessions: 4, userTurns: 8, modelRequests: 24, inputTokens: 0, outputTokens: 0, unknownUsageRequests: 0,
        toolCalls: 16, toolCallsByName: { deleteFork: 1, diff: 3, fork: 4, merge: 3, read: 1, write: 4 }, toolErrorsByCode: { BRANCH_CONFLICT: 1 },
        forksCreated: 3, forkNameConflicts: 1, forksDeleted: 1, merges: { failed: 0, published: 3, unchanged: 0 },
        publicationLag: { writes: 4, merged: 3, neverMerged: 1, sameTurn: 2, meanTurns: 1 / 3, maxTurns: 1 },
        sessionsWithoutWrite: 1, publications: 3, republishedFiles: 1, republishedFilesIsLowerBound: false,
        sessionsEndingWithUnpublishedForks: 3, finalForksRemaining: 2, finalUnpublishedForks: 1, finalUnpublishedChanges: 1, finalPublishedForksLeft: 1 });
    assert.deepEqual(summary.smoke, conversationMetrics(results.map(result => result.metrics)));

    // Harness reads are recorded apart from the model's tool events.
    const sessionDirectory = path.join(files.output, 'session-001-s000');
    assert.deepEqual((await readdir(files.output)).sort(), ['manifest.json', 'session-001-s000', 'session-002-s001', 'session-003-s002', 'session-004-s003', 'summary.json']);
    const events = await jsonl(path.join(sessionDirectory, 'events.jsonl'));
    assert.deepEqual(events.map(event => [event.turn, event.name, event.ok]), [[0, 'fork', true], [0, 'write', true], [0, 'diff', true], [0, 'merge', true],
        [2, 'read', true], [2, 'write', true], [2, 'diff', true], [2, 'merge', true]]);
    const observation = await json(path.join(sessionDirectory, 'observation.json'));
    assert.deepEqual({ before: observation.mainVersionBefore, publications: observation.publications.length, errors: observation.errors,
        forks: observation.forks }, { before: 'v0', publications: 2, errors: [], forks: [{ at: { kind: 'fork', name: 'notes' }, changes: 0 }] });
    assert.notEqual(observation.mainVersionAfter, 'v0');
    assert.equal(await exists(path.join(files.output, 'session-003-s002', 'events.jsonl')), false, 'A session without tool calls has no events');
    assert.deepEqual(await json(path.join(files.output, 'summary.json')), JSON.parse(JSON.stringify(summary)));
    await assert.rejects(runReplay({ manifest: files.manifest, conversation: '7', output: files.output, mode: 'scripted' }), { code: 'EEXIST' });
});

test('the model request holds only utterances, SDK tool definitions and the selected server instructions', async t => {
    const files = await prepared(t);
    const policyFile = path.join(files.root, 'policy.txt'), policy = 'Synthetic save policy for this test.\n';
    await writeFile(policyFile, policy);
    const definitions = getFileToolDefinitions({ embeddingMode: 'managed', tools: toolNames });
    const run = async (name, options) => {
        const requests = [];
        const result = await runReplay({ manifest: files.manifest, conversation: '7', output: path.join(files.root, name), mode: 'model', sessions: 2,
            askFactory: () => async (request, context) => { requests.push({ request: structuredClone(request), context }); return reply(request); }, ...options });
        return { requests, ...result };
    };

    const both = await run('both', { instructions: 'sdk', policyFile });
    const expected = fileToolInstructions + '\n\n' + policy;
    assert.deepEqual(both.manifest.instructions, { source: 'sdk', policySha256: hash(policy), text: expected, sha256: hash(expected) });
    assert.deepEqual(both.manifest.tools, [...toolNames]);
    assert.deepEqual(both.manifest.toolDefinitions, definitions);
    assert.equal(both.manifest.transport, 'injected-test');
    assert.equal(both.summary.modelBehavior, null, 'An injected transport is never a model measurement');
    assert.equal(both.requests.length, 4);
    for (const { request } of both.requests) {
        assert.deepEqual(Object.keys(request), ['model', 'reasoning', 'store', 'include', 'parallel_tool_calls', 'max_output_tokens', 'tools', 'input']);
        assert.deepEqual({ ...request, tools: null, input: null }, { model: 'gpt-6.1-sol', reasoning: { effort: 'low' }, store: false,
            include: ['reasoning.encrypted_content'], parallel_tool_calls: false, max_output_tokens: limits.outputTokens, tools: null, input: null });
        assert.deepEqual(request.tools, definitions.map(tool => ({ type: 'function', name: tool.name, description: tool.description,
            parameters: tool.inputSchema, strict: false })));
        assert(!JSON.stringify(request).includes('DATASET-ASSISTANT'), 'Dataset assistant messages are never replayed');
    }
    const message = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
    assert.deepEqual(both.requests.map(item => item.request.input), [
        [{ role: 'developer', content: expected }, { role: 'user', content: 'User says 0.0 🧭' }],
        [{ role: 'developer', content: expected }, { role: 'user', content: 'User says 0.0 🧭' }, message('ok'), { role: 'user', content: 'User says 0.1 🧭' }],
        [{ role: 'developer', content: expected }, { role: 'user', content: 'User says 0.0 🧭' }, message('ok'), { role: 'user', content: 'User says 0.1 🧭' },
            message('ok'), { role: 'user', content: 'User says 0.2 🧭' }],
        // A new session starts a fresh conversation: only the drive persists.
        [{ role: 'developer', content: expected }, { role: 'user', content: 'User says 1.0 🧭' }],
    ]);
    assert.deepEqual(both.requests.map(item => [item.context.session, item.context.turn, item.context.round]), [[0, 0, 0], [0, 1, 0], [0, 2, 0], [1, 0, 0]]);
    assert.deepEqual(await jsonl(path.join(files.root, 'both', 'session-001-s000', 'transcript.jsonl')), both.requests[2].request.input.concat(message('ok')));
    const receipts = await jsonl(path.join(files.root, 'both', 'session-001-s000', 'requests.jsonl'));
    assert.deepEqual(receipts.map(receipt => [receipt.turn, receipt.round, receipt.inputItems, receipt.status]),
        [[0, 0, 2, 'pending'], [0, 0, 2, 'completed'], [1, 0, 4, 'pending'], [1, 0, 4, 'completed'], [2, 0, 6, 'pending'], [2, 0, 6, 'completed']]);
    assert.deepEqual([both.results[0].metrics.inputTokens, both.results[0].metrics.outputTokens], [9, 6]);

    const sdk = await run('sdk', { instructions: 'sdk', turns: 1 });
    assert.deepEqual(sdk.requests.map(item => item.request.input), [
        [{ role: 'developer', content: fileToolInstructions }, { role: 'user', content: 'User says 0.0 🧭' }],
        [{ role: 'developer', content: fileToolInstructions }, { role: 'user', content: 'User says 1.0 🧭' }]]);
    assert.deepEqual(sdk.manifest.plan.map(entry => entry.plannedTurns), [1, 1]);
    assert.equal(sdk.manifest.instructions.policySha256, null);

    const none = await run('none', { instructions: 'none', sessions: 1, turns: 1 });
    assert.deepEqual(none.requests.map(item => item.request.input), [[{ role: 'user', content: 'User says 0.0 🧭' }]]);
    assert.deepEqual(none.manifest.instructions, { source: 'none', policySha256: null, text: null, sha256: null });

    const policyOnly = await run('policy', { instructions: 'none', policyFile, sessions: 1, turns: 1 });
    assert.deepEqual(policyOnly.requests[0].request.input[0], { role: 'developer', content: policy });

    await writeFile(policyFile, ' \n');
    await assert.rejects(run('empty', { policyFile }), /policy file is empty/);
    assert.equal(await exists(path.join(files.root, 'empty')), false);
    await assert.rejects(run('invalid', { instructions: 'workflow' }), /--instructions none or sdk/);
    await assert.rejects(run('caps', { turns: 0 }), /positive integers/);
});

test('budget, transport and model-response failures stop the conversation and keep what was observed', async t => {
    const files = await prepared(t);
    const run = (name, askFactory, budget = {}) => runReplay({ manifest: files.manifest, conversation: '7', output: path.join(files.root, name),
        mode: 'model', instructions: 'none', askFactory, budget: { ...limits, ...budget } });
    let calls = 0;
    const looping = () => async request => toolCall(request, `call-${calls++}`, 'listForks', {});

    const rounds = await run('rounds', looping, { roundsPerTurn: 2 });
    assert.deepEqual({ attempted: rounds.summary.attempted, completed: rounds.summary.completed, failed: rounds.summary.failed,
        complete: rounds.summary.complete, cleanup: rounds.summary.cleanup }, { attempted: 1, completed: 0, failed: 1, complete: false, cleanup: 'completed' });
    assert.equal(rounds.results[0].error.code, 'ROUND_BUDGET_EXHAUSTED');
    const metrics = rounds.results[0].metrics;
    assert.deepEqual([metrics.userTurns, metrics.modelRequests, metrics.toolCalls, metrics.toolCallsByName, metrics.inputTokens, metrics.forksRemaining],
        [1, 2, 2, { listForks: 2 }, 6, 0]);

    assert.equal((await run('tool-calls', looping, { toolCallsPerTurn: 1 })).results[0].error.code, 'TOOL_CALL_BUDGET_EXHAUSTED');
    const context = await run('context', () => async request => reply(request), { contextTokens: 10 });
    assert.equal(context.results[0].error.code, 'CONTEXT_BUDGET_EXHAUSTED');
    assert.deepEqual([context.results[0].metrics.userTurns, context.results[0].metrics.modelRequests], [1, 0]);
    assert.equal((await run('tokens', () => async request => ({ ...reply(request), usage: { input_tokens: 90000, output_tokens: 20000 } }),
        { sessionTokens: 150000 })).results[0].error.code, 'TOKEN_BUDGET_EXHAUSTED');

    const failed = await run('transport', () => async () => { throw Object.assign(new Error('secret body'), { code: 'MODEL_HTTP_ERROR', status: 429 }); });
    assert.equal(failed.results[0].error.code, 'MODEL_REQUEST_FAILED');
    assert.equal(failed.results[0].metrics.unknownUsageRequests, 1);
    const receipts = await jsonl(path.join(files.root, 'transport', 'session-001-s000', 'requests.jsonl'));
    assert.deepEqual(receipts.at(-1), { turn: 0, round: 0, inputItems: 1, status: 'failed_or_uncertain', error: { code: 'MODEL_HTTP_ERROR', status: 429 } });
    assert(!JSON.stringify(receipts).includes('secret'));

    // Like fetch, the transport rejects with the signal's reason, also when already aborted.
    const timedOut = await run('timeout', () => (request, { signal }) => new Promise((resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), { sessionSeconds: 0.05 });
    assert.equal(timedOut.results[0].error.code, 'SESSION_TIMEOUT');
    assert.equal(timedOut.results[0].metrics.userTurns, 1);
    assert.equal(timedOut.summary.cleanup, 'completed');

    const responses = {
        MODEL_IDENTITY_MISMATCH: request => ({ ...reply(request), model: 'another-model' }),
        MODEL_RESPONSE_INCOMPLETE: request => ({ ...reply(request), status: 'incomplete' }),
        MODEL_OUTPUT_UNSUPPORTED: request => ({ ...reply(request), output: [{ type: 'web_search_call' }] }),
        MODEL_USAGE_INVALID: request => ({ ...reply(request), usage: {} }),
        FINAL_TEXT_MISSING: request => ({ ...reply(request), output: [{ type: 'reasoning' }] }),
        TOOL_CALL_ID_INVALID: request => toolCall(request, 'same', 'status', {}),
    };
    for (const [code, respond] of Object.entries(responses)) {
        const result = await run(code, () => async request => respond(request));
        assert.equal(result.results[0].error.code, code);
        assert.equal(result.summary.attempted, 1);
    }
    await assert.rejects(runReplay({ manifest: files.manifest, conversation: '7', output: path.join(files.root, 'no-key'), mode: 'model' }), /Missing LLM_API_KEY/);
    assert.equal(await exists(path.join(files.root, 'no-key')), false, 'A missing credential fails before the run directory exists');
});

test('malformed arguments, rejected calls and oversized results reach the model as explicit errors', async t => {
    const files = await prepared(t);
    const script = [['write', '{"at":'], ['publish', {}], ['write', { op: 'create', path: '/a.md', content: 'x' }], ['guide', {}], ['fork', { name: 'kept' }]];
    const outputs = [];
    const { results, summary } = await runReplay({ manifest: files.manifest, conversation: '7', output: files.output, mode: 'model', instructions: 'none',
        sessions: 1, turns: 1, budget: { ...limits, resultBytes: 300 },
        askFactory: () => async (request, { round }) => {
            const last = request.input.at(-1);
            if (last.type === 'function_call_output') outputs.push(JSON.parse(last.output));
            return round < script.length ? toolCall(request, `call-${round}`, ...script[round]) : reply(request);
        } });
    assert.equal(summary.complete, true);
    assert.deepEqual(outputs.map(output => output.error?.code ?? output), ['INVALID_JSON', 'TOOL_NOT_ALLOWED', 'INVALID_INPUT', 'TOOL_RESULT_TOO_LARGE',
        { at: { kind: 'fork', name: 'kept' } }]);
    const events = await jsonl(path.join(files.output, 'session-001-s000', 'events.jsonl'));
    assert.deepEqual(events.map(event => [event.name, event.ok, event.delivered, event.error?.code]), [['write', false, true, 'INVALID_JSON'],
        ['publish', false, true, 'TOOL_NOT_ALLOWED'], ['write', false, true, 'INVALID_INPUT'], ['guide', true, false, undefined], ['fork', true, true, undefined]]);
    assert.equal(events[0].rawArguments, '{"at":');
    assert.equal('args' in events[0], false);
    assert.equal(typeof events[3].result.content, 'string', 'The undelivered result stays in the record');
    assert.deepEqual(results[0].metrics.toolErrorsByCode, { INVALID_INPUT: 1, INVALID_JSON: 1, TOOL_NOT_ALLOWED: 1 });
    assert.deepEqual([results[0].metrics.noSuccessfulWrite, results[0].metrics.forksCreated, results[0].metrics.forksRemaining,
        results[0].metrics.publishedForksLeft], [true, 1, 1, 1]);
});

test('metrics separate unchanged and failed merges, truncated history and unobserved forks', () => {
    const fork = name => ({ at: { kind: 'fork', name } });
    const metrics = sessionMetrics({ userTurns: 4, requests: [{ usage: { input_tokens: 5, output_tokens: 1 } }, { usage: undefined }], events: [
        { turn: 0, name: 'write', args: fork('a'), ok: true, result: {} },
        { turn: 1, name: 'merge', args: fork('a'), ok: false, error: { code: 'MERGE_CONFLICT' } },
        { turn: 2, name: 'merge', args: fork('b'), ok: true, result: { status: 'published' } },
        { turn: 3, name: 'merge', args: fork('a'), ok: true, result: { status: 'unchanged' } },
        { turn: 3, name: 'write', args: fork('b'), ok: true, result: {} },
        { turn: 3, name: 'write', args: fork('b'), ok: false, error: { code: 'EDIT_CONFLICT' } },
    ], observation: { publications: [{ fileIds: ['x', 'y'], fileIdsTruncated: true }, { fileIds: ['x'], fileIdsTruncated: false }],
        forks: [{ ...fork('a'), changes: 2 }, { ...fork('b'), changes: null }, { ...fork('c'), changes: 0 }] } });
    assert.deepEqual(metrics.publicationLags, [3, null]);
    assert.deepEqual(metrics.merges, { published: 1, unchanged: 1, failed: 1 });
    assert.deepEqual(metrics.toolErrorsByCode, { EDIT_CONFLICT: 1, MERGE_CONFLICT: 1 });
    assert.deepEqual([metrics.inputTokens, metrics.outputTokens, metrics.unknownUsageRequests], [5, 1, 1]);
    assert.deepEqual([metrics.publications, metrics.republishedFiles, metrics.republishedFilesIsLowerBound], [2, 1, true]);
    assert.deepEqual([metrics.forksRemaining, metrics.unpublishedForks, metrics.unpublishedChanges, metrics.publishedForksLeft, metrics.unobservedForks], [3, 1, 2, 1, 1]);

    const unobserved = sessionMetrics({ userTurns: 1, requests: [], events: [], observation: { publications: null, forks: null } });
    assert.deepEqual([unobserved.publications, unobserved.republishedFiles, unobserved.republishedFilesIsLowerBound, unobserved.forksRemaining,
        unobserved.unpublishedForks, unobserved.unobservedForks], [null, null, null, null, null, null]);
    const totals = conversationMetrics([metrics, unobserved]);
    assert.deepEqual([totals.sessions, totals.sessionsWithoutWrite, totals.publications, totals.republishedFiles, totals.sessionsEndingWithUnpublishedForks,
        totals.finalForksRemaining], [2, 1, null, null, null, null]);
    assert.deepEqual(conversationMetrics([]).publicationLag, { writes: 0, merged: 0, neverMerged: 0, sameTurn: 0, meanTurns: null, maxTurns: null });
});

test('the Responses transport sends one bounded request and reports only an HTTP status on failure', async () => {
    assert.throws(() => openAI({ key: ' ' }), /Missing LLM_API_KEY/);
    const seen = [];
    const ask = openAI({ key: 'synthetic-key', fetcher: async (url, options) => {
        seen.push({ url, options });
        return seen.length === 1 ? new Response(JSON.stringify({ status: 'completed' })) : new Response('provider detail', { status: 503 });
    } });
    assert.deepEqual(await ask({ model: 'm', input: [] }, {}), { status: 'completed' });
    assert.equal(seen[0].url, 'https://api.openai.com/v1/responses');
    assert.deepEqual([seen[0].options.method, seen[0].options.redirect, seen[0].options.headers.authorization, seen[0].options.body],
        ['POST', 'error', 'Bearer synthetic-key', '{"model":"m","input":[]}']);
    assert(seen[0].options.signal instanceof AbortSignal);
    await assert.rejects(ask({ model: 'm', input: [] }, {}), error => error.code === 'MODEL_HTTP_ERROR' && error.status === 503 && !error.message.includes('provider detail'));
});
