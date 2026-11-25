import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileToolInstructions, getFileToolDefinitions, MemDrive } from '@functional-systems/memdrive';
import { limits, openAI, toolNames } from '../benchmark/beam/replay-agent.mjs';
import { conversationMetrics, sessionMetrics } from '../benchmark/beam/replay-metrics.mjs';
import { describeFailure, checkList, runReplay } from '../benchmark/beam/replay.mjs';
import { dateOf, groupSessions, hash, loadSessions, stripMarker } from '../benchmark/beam/replay-sessions.mjs';
import { cleanupStore, lambdadbConnection } from '../benchmark/beam/replay-store.mjs';
import { fileClient } from './helpers/file-client.mjs';

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

// Like fetch, reject with the signal's reason, also when already aborted. A real request
// keeps the event loop alive until the session deadline aborts it; on Node 20 the
// deadline's own timer does not, so hold a timer until then.
const untilAborted = (request, { signal }) => new Promise((resolve, reject) => {
    const pending = setInterval(() => {}, 1000);
    const abort = () => { clearInterval(pending); reject(signal.reason); };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
});

test('sessions follow the original batches and keep only user utterances', () => {
    const sessions = groupSessions(conversation([2, 1]));
    assert.deepEqual(sessions, [
        { id: 's000', index: 0, timestamp: '2024-03-01T12:00:00.000Z', messages: 4, markersStripped: 0, turns: [
            { sourceId: '7_s000_t0000', turnId: 'id-0', content: 'User says 0.0 🧭' },
            { sourceId: '7_s000_t0002', turnId: 'id-2', content: 'User says 0.1 🧭' }] },
        { id: 's001', index: 1, timestamp: '2024-03-02T12:00:00.000Z', messages: 2, markersStripped: 0, turns: [
            { sourceId: '7_s001_t0000', turnId: 'id-4', content: 'User says 1.0 🧭' }] },
    ]);
    // The dataset's trailing generation marker is removed from user utterances, in every shape it takes.
    const marked = conversation([2, 1]);
    marked.messages[0].content += ' ->-> 1,11';
    marked.messages[2].content += ' ->-> 5,14)';
    marked.messages[4].content = 'Go left -> then right ->-> 2,N/A';
    assert.deepEqual(groupSessions(marked).map(session => [session.markersStripped, session.turns.map(turn => turn.content)]),
        [[2, ['User says 0.0 🧭', 'User says 0.1 🧭']], [1, ['Go left -> then right']]]);
    assert.deepEqual(['a ->-> 1,2, 3', 'b -> c', 'd ->-> not a marker'].map(stripMarker), ['a', 'b -> c', 'd ->-> not a marker']);
    marked.messages[0].content = ' ->-> 1,1';
    assert.throws(() => groupSessions(marked), /only a generation marker/);
    assert.deepEqual([dateOf('2024-03-01T12:00:00.000Z'), dateOf(null), dateOf('March 1')], ['2024-03-01', null, null]);
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
    let now = 0;
    const { summary, manifest, results } = await runReplay({ manifest: files.manifest, conversation: '7', output: files.output, mode: 'scripted', instructions: 'none',
        clock: () => now++ });
    assert.equal(manifest.transport, 'scripted');
    assert.deepEqual(manifest.plan.map(entry => [entry.id, entry.userTurns, entry.plannedTurns]), [['s000', 3, 3], ['s001', 1, 1], ['s002', 2, 2], ['s003', 2, 2]]);
    assert.deepEqual({ planned: summary.planned, attempted: summary.attempted, completed: summary.completed, failed: summary.failed,
        complete: summary.complete, cleanup: summary.cleanup }, { planned: 4, attempted: 4, completed: 4, failed: 0, complete: true, cleanup: 'completed' });
    assert.equal(summary.modelBehavior, null, 'A scripted run is never a model measurement');

    const [first, second, third, fourth] = results.map(result => result.metrics);
    const zeroLag = { writes: 0, merged: 0, neverMerged: 0, sameTurn: 0, meanTurns: null, maxTurns: null };
    const noList = { calls: 0, checked: 0, uncheckedByReason: {}, missedCalls: 0, missedFiles: 0 };
    assert.deepEqual(first, { userTurns: 3, modelRequests: 12, inputTokens: 0, outputTokens: 0, unknownUsageRequests: 0,
        toolCalls: 9, toolCallsByName: { diff: 2, fork: 1, list: 1, merge: 2, read: 1, write: 2 }, toolErrorsByCode: {},
        forksCreated: 1, forkNameConflicts: 0, forksDeleted: 0, merges: { published: 2, replayed: 0, unchanged: 0, failed: 0 },
        publicationLags: [0, 0], publicationLag: { writes: 2, merged: 2, neverMerged: 0, sameTurn: 2, meanTurns: 0, maxTurns: 0 },
        noSuccessfulWrite: false, turnsWithWrite: 2, turnsWithPublication: 2, utteranceToPublicationLags: [0, 1, 0],
        utteranceToPublication: { utterances: 3, followed: 3, afterLast: 0, sameTurn: 2, meanTurns: 1 / 3, maxTurns: 1 },
        publications: 2, publishedFiles: 1, republishedFiles: 1, republishedFilesIsLowerBound: false,
        forksRemaining: 1, unpublishedForks: 0, unpublishedChanges: 0, publishedForksLeft: 1, unobservedForks: 0,
        listCheck: { ...noList, calls: 1, checked: 1 } });
    assert.deepEqual(second, { userTurns: 1, modelRequests: 4, inputTokens: 0, outputTokens: 0, unknownUsageRequests: 0,
        toolCalls: 3, toolCallsByName: { fork: 2, write: 1 }, toolErrorsByCode: { BRANCH_CONFLICT: 1 },
        forksCreated: 1, forkNameConflicts: 1, forksDeleted: 0, merges: { published: 0, replayed: 0, unchanged: 0, failed: 0 },
        publicationLags: [null], publicationLag: { writes: 1, merged: 0, neverMerged: 1, sameTurn: 0, meanTurns: null, maxTurns: null },
        noSuccessfulWrite: false, turnsWithWrite: 1, turnsWithPublication: 0, utteranceToPublicationLags: [null],
        utteranceToPublication: { utterances: 1, followed: 0, afterLast: 1, sameTurn: 0, meanTurns: null, maxTurns: null },
        publications: 0, publishedFiles: 0, republishedFiles: 0, republishedFilesIsLowerBound: false,
        forksRemaining: 2, unpublishedForks: 1, unpublishedChanges: 1, publishedForksLeft: 1, unobservedForks: 0, listCheck: noList });
    assert.deepEqual(third, { userTurns: 2, modelRequests: 2, inputTokens: 0, outputTokens: 0, unknownUsageRequests: 0,
        toolCalls: 0, toolCallsByName: {}, toolErrorsByCode: {},
        forksCreated: 0, forkNameConflicts: 0, forksDeleted: 0, merges: { published: 0, replayed: 0, unchanged: 0, failed: 0 },
        publicationLags: [], publicationLag: zeroLag,
        noSuccessfulWrite: true, turnsWithWrite: 0, turnsWithPublication: 0, utteranceToPublicationLags: [null, null],
        utteranceToPublication: { utterances: 2, followed: 0, afterLast: 2, sameTurn: 0, meanTurns: null, maxTurns: null },
        publications: 0, publishedFiles: 0, republishedFiles: 0, republishedFilesIsLowerBound: false,
        forksRemaining: 2, unpublishedForks: 1, unpublishedChanges: 1, publishedForksLeft: 1, unobservedForks: 0, listCheck: noList });
    assert.deepEqual(fourth, { userTurns: 2, modelRequests: 7, inputTokens: 0, outputTokens: 0, unknownUsageRequests: 0,
        toolCalls: 5, toolCallsByName: { deleteFork: 1, diff: 1, fork: 1, merge: 1, write: 1 }, toolErrorsByCode: {},
        forksCreated: 1, forkNameConflicts: 0, forksDeleted: 1, merges: { published: 1, replayed: 0, unchanged: 0, failed: 0 },
        publicationLags: [1], publicationLag: { writes: 1, merged: 1, neverMerged: 0, sameTurn: 0, meanTurns: 1, maxTurns: 1 },
        noSuccessfulWrite: false, turnsWithWrite: 1, turnsWithPublication: 1, utteranceToPublicationLags: [1, 0],
        utteranceToPublication: { utterances: 2, followed: 2, afterLast: 0, sameTurn: 1, meanTurns: 0.5, maxTurns: 1 },
        publications: 1, publishedFiles: 1, republishedFiles: 0, republishedFilesIsLowerBound: false,
        forksRemaining: 2, unpublishedForks: 1, unpublishedChanges: 1, publishedForksLeft: 1, unobservedForks: 0, listCheck: noList });
    assert.deepEqual(summary.smoke, { sessions: 4, userTurns: 8, modelRequests: 25, inputTokens: 0, outputTokens: 0, unknownUsageRequests: 0,
        toolCalls: 17, toolCallsByName: { deleteFork: 1, diff: 3, fork: 4, list: 1, merge: 3, read: 1, write: 4 }, toolErrorsByCode: { BRANCH_CONFLICT: 1 },
        forksCreated: 3, forkNameConflicts: 1, forksDeleted: 1, merges: { failed: 0, published: 3, replayed: 0, unchanged: 0 },
        publicationLag: { writes: 4, merged: 3, neverMerged: 1, sameTurn: 2, meanTurns: 1 / 3, maxTurns: 1 },
        sessionsWithoutWrite: 1, turnsWithWrite: 4, turnsWithPublication: 3,
        // Three utterances came after their session's last publication or in a session without one.
        utteranceToPublication: { utterances: 8, followed: 5, afterLast: 3, sameTurn: 3, meanTurns: 0.4, maxTurns: 1 },
        publications: 3, republishedWithinSessions: 1, republishedFilesIsLowerBound: false,
        sessionsEndingWithUnpublishedForks: 3, finalForksRemaining: 2, finalUnpublishedForks: 1, finalUnpublishedChanges: 1, finalPublishedForksLeft: 1,
        listCheck: { ...noList, calls: 1, checked: 1 } });
    assert.deepEqual(summary.smoke, conversationMetrics(results.map(result => result.metrics)));

    // Harness reads are recorded apart from the model's tool events.
    const sessionDirectory = path.join(files.output, 'session-001-s000');
    assert.deepEqual((await readdir(files.output)).sort(), ['manifest.json', 'session-001-s000', 'session-002-s001', 'session-003-s002', 'session-004-s003', 'summary.json']);
    const events = await jsonl(path.join(sessionDirectory, 'events.jsonl'));
    assert.deepEqual(events.map(event => [event.turn, event.name, event.ok]), [[0, 'fork', true], [0, 'write', true], [0, 'list', true], [0, 'diff', true],
        [0, 'merge', true], [2, 'read', true], [2, 'write', true], [2, 'diff', true], [2, 'merge', true]]);
    // The list check is a harness read, logged apart from the model's tool calls.
    assert.deepEqual(await jsonl(path.join(sessionDirectory, 'list-checks.jsonl')), [{ turn: 0, round: 2, at: { kind: 'fork', name: 'notes' }, delivered: true,
        checked: true, existing: 1, listed: 1, missed: [] }]);
    // Each clock reading advances by one, so every timed request and tool call lasts exactly 1.
    const receipts = await jsonl(path.join(sessionDirectory, 'requests.jsonl'));
    assert(receipts.every(receipt => receipt.status === 'pending' ? !('elapsedMs' in receipt) : receipt.elapsedMs === 1));
    assert(events.every(event => event.elapsedMs === 1));
    for (const [index, result] of results.entries()) {
        const { wallMs, ...timing } = result.timing;
        assert.deepEqual(timing, { modelRequestMs: result.metrics.modelRequests, toolMs: result.metrics.toolCalls, toolMsByName: result.metrics.toolCallsByName });
        assert(wallMs > timing.modelRequestMs + timing.toolMs);
        assert.deepEqual(summary.sessions[index].timing, result.timing);
        assert.deepEqual(await json(path.join(files.output, `session-00${index + 1}-${result.id}`, 'result.json')), JSON.parse(JSON.stringify(result)));
    }
    assert.deepEqual([manifest.backend, manifest.store, summary.backend, summary.store], ['native-client-fixture', null, 'native-client-fixture', null]);
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
        // The session's batch date follows the server instructions as its own developer message.
        [{ role: 'developer', content: expected }, { role: 'developer', content: 'Current date: 2024-03-01' }, { role: 'user', content: 'User says 0.0 🧭' }],
        [{ role: 'developer', content: expected }, { role: 'developer', content: 'Current date: 2024-03-01' }, { role: 'user', content: 'User says 0.0 🧭' }, message('ok'), { role: 'user', content: 'User says 0.1 🧭' }],
        [{ role: 'developer', content: expected }, { role: 'developer', content: 'Current date: 2024-03-01' }, { role: 'user', content: 'User says 0.0 🧭' }, message('ok'), { role: 'user', content: 'User says 0.1 🧭' },
            message('ok'), { role: 'user', content: 'User says 0.2 🧭' }],
        // A new session starts a fresh conversation: only the drive persists.
        [{ role: 'developer', content: expected }, { role: 'developer', content: 'Current date: 2024-03-02' }, { role: 'user', content: 'User says 1.0 🧭' }],
    ]);
    assert.deepEqual([both.manifest.context, both.manifest.plan.map(entry => [entry.date, entry.markersStripped])],
        [{ currentDate: 'session-date', trailingMarkers: 'stripped' }, [['2024-03-01', 0], ['2024-03-02', 0]]]);
    assert.deepEqual(both.requests.map(item => [item.context.session, item.context.turn, item.context.round]), [[0, 0, 0], [0, 1, 0], [0, 2, 0], [1, 0, 0]]);
    assert.deepEqual(await jsonl(path.join(files.root, 'both', 'session-001-s000', 'transcript.jsonl')), both.requests[2].request.input.concat(message('ok')));
    const receipts = await jsonl(path.join(files.root, 'both', 'session-001-s000', 'requests.jsonl'));
    assert.deepEqual(receipts.map(receipt => [receipt.turn, receipt.round, receipt.inputItems, receipt.status]),
        [[0, 0, 3, 'pending'], [0, 0, 3, 'completed'], [1, 0, 5, 'pending'], [1, 0, 5, 'completed'], [2, 0, 7, 'pending'], [2, 0, 7, 'completed']]);
    assert.deepEqual([both.results[0].metrics.inputTokens, both.results[0].metrics.outputTokens], [9, 6]);

    const sdk = await run('sdk', { instructions: 'sdk', turns: 1 });
    assert.deepEqual(sdk.requests.map(item => item.request.input), [
        [{ role: 'developer', content: fileToolInstructions }, { role: 'developer', content: 'Current date: 2024-03-01' }, { role: 'user', content: 'User says 0.0 🧭' }],
        [{ role: 'developer', content: fileToolInstructions }, { role: 'developer', content: 'Current date: 2024-03-02' }, { role: 'user', content: 'User says 1.0 🧭' }]]);
    assert.deepEqual(sdk.manifest.plan.map(entry => entry.plannedTurns), [1, 1]);
    assert.equal(sdk.manifest.instructions.policySha256, null);

    const none = await run('none', { instructions: 'none', sessions: 1, turns: 1 });
    assert.deepEqual(none.requests.map(item => item.request.input), [[{ role: 'developer', content: 'Current date: 2024-03-01' }, { role: 'user', content: 'User says 0.0 🧭' }]]);
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
    const { elapsedMs, ...receipt } = receipts.at(-1);
    assert(elapsedMs >= 0);
    assert.deepEqual(receipt, { turn: 0, round: 0, inputItems: 2, status: 'failed_or_uncertain', error: { code: 'MODEL_HTTP_ERROR', status: 429 } });
    assert(!JSON.stringify(receipts).includes('secret'));

    const timedOut = await run('timeout', () => untilAborted, { sessionSeconds: 0.05 });
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
        { turn: 2, name: 'merge', args: fork('b'), ok: true, result: { status: 'published', version: 'v1' } },
        { turn: 3, name: 'merge', args: fork('a'), ok: true, result: { status: 'unchanged', version: 'v2' } },
        { turn: 3, name: 'write', args: fork('b'), ok: true, result: {} },
        { turn: 3, name: 'write', args: fork('b'), ok: false, error: { code: 'EDIT_CONFLICT' } },
    ], observation: { publications: [{ version: 'v1', fileIds: ['x', 'y'], fileIdsTruncated: true }, { version: 'v3', fileIds: ['x'], fileIdsTruncated: false }],
        forks: [{ ...fork('a'), changes: 2 }, { ...fork('b'), changes: null }, { ...fork('c'), changes: 0 }] } });
    // Fork a's only later merge returned unchanged, which publishes nothing.
    assert.deepEqual(metrics.publicationLags, [null, null]);
    assert.deepEqual(metrics.merges, { published: 1, replayed: 0, unchanged: 1, failed: 1 });
    assert.deepEqual(metrics.toolErrorsByCode, { EDIT_CONFLICT: 1, MERGE_CONFLICT: 1 });
    assert.deepEqual([metrics.inputTokens, metrics.outputTokens, metrics.unknownUsageRequests], [5, 1, 1]);
    assert.deepEqual([metrics.publications, metrics.publishedFiles, metrics.republishedFiles, metrics.republishedFilesIsLowerBound], [2, 2, 1, true]);
    // Only the published merge in turn 2 counts: the failed and unchanged merges publish nothing.
    assert.deepEqual([metrics.turnsWithWrite, metrics.turnsWithPublication, metrics.utteranceToPublicationLags], [2, 1, [2, 1, 0, null]]);
    assert.deepEqual(metrics.utteranceToPublication, { utterances: 4, followed: 3, afterLast: 1, sameTurn: 1, meanTurns: 1, maxTurns: 2 });
    assert.deepEqual([metrics.forksRemaining, metrics.unpublishedForks, metrics.unpublishedChanges, metrics.publishedForksLeft, metrics.unobservedForks], [3, 1, 2, 1, 1]);

    const unobserved = sessionMetrics({ userTurns: 1, requests: [], events: [], observation: { publications: null, forks: null } });
    assert.deepEqual([unobserved.publications, unobserved.publishedFiles, unobserved.republishedFiles, unobserved.republishedFilesIsLowerBound, unobserved.forksRemaining,
        unobserved.unpublishedForks, unobserved.unobservedForks], [null, null, null, null, null, null, null]);
    assert.deepEqual(unobserved.utteranceToPublication, { utterances: 1, followed: 0, afterLast: 1, sameTurn: 0, meanTurns: null, maxTurns: null });
    const totals = conversationMetrics([metrics, unobserved]);
    assert.deepEqual([totals.sessions, totals.sessionsWithoutWrite, totals.publications, totals.republishedWithinSessions, totals.sessionsEndingWithUnpublishedForks,
        totals.finalForksRemaining], [2, 1, null, null, null, null]);
    assert.deepEqual(totals.utteranceToPublication, { utterances: 5, followed: 3, afterLast: 2, sameTurn: 1, meanTurns: 1, maxTurns: 2 });
    assert.deepEqual(conversationMetrics([]).publicationLag, { writes: 0, merged: 0, neverMerged: 0, sameTurn: 0, meanTurns: null, maxTurns: null });
    assert.deepEqual(conversationMetrics([]).utteranceToPublication, { utterances: 0, followed: 0, afterLast: 0, sameTurn: 0, meanTurns: null, maxTurns: null });
});

test('a merge that replays an earlier published result is not a new publication', () => {
    const at = { at: { kind: 'fork', name: 'a' } };
    const merge = (turn, version) => ({ turn, name: 'merge', args: at, ok: true, result: { status: 'published', version } });
    const events = [{ turn: 0, name: 'write', args: at, ok: true, result: {} }, merge(0, 'v2'),
        // The same request repeated after another write returns v2 again and publishes nothing.
        { turn: 1, name: 'write', args: at, ok: true, result: {} }, merge(1, 'v2'),
        // A request completed in an earlier session returns its version, which this session did not publish.
        merge(2, 'v1')];
    const observed = sessionMetrics({ userTurns: 3, requests: [], events,
        observation: { publications: [{ version: 'v2', fileIds: ['x'], fileIdsTruncated: false }], forks: [] } });
    assert.deepEqual(observed.merges, { published: 1, replayed: 2, unchanged: 0, failed: 0 });
    assert.deepEqual([observed.turnsWithPublication, observed.utteranceToPublicationLags, observed.publicationLags], [1, [0, null, null], [0, null]]);
    // An unchanged outcome, first or repeated with its request ID, never publishes a write.
    const empty = { turn: 1, name: 'merge', args: at, ok: true, result: { status: 'unchanged', version: 'v2' } };
    const unchanged = sessionMetrics({ userTurns: 3, requests: [], events: [empty, { turn: 1, name: 'write', args: at, ok: true, result: {} }, { ...empty, turn: 2 }],
        observation: { publications: [], forks: [] } });
    assert.deepEqual([unchanged.publicationLags, unchanged.merges], [[null], { published: 0, replayed: 0, unchanged: 2, failed: 0 }]);
    // Without history, a version returned for the first time in the session still counts once.
    const unobserved = sessionMetrics({ userTurns: 3, requests: [], events, observation: { publications: null, forks: null } });
    assert.deepEqual(unobserved.merges, { published: 2, replayed: 1, unchanged: 0, failed: 0 });
    assert.deepEqual(unobserved.utteranceToPublicationLags, [0, 1, 0]);
    assert.deepEqual(conversationMetrics([observed, unobserved]).merges, { failed: 0, published: 3, replayed: 3, unchanged: 0 });
    // A file published once in each of two sessions was republished in neither; one published twice in both counts in both.
    const session = fileIds => sessionMetrics({ userTurns: 1, requests: [], events: [],
        observation: { publications: fileIds.map((ids, index) => ({ version: `v${index}`, fileIds: ids, fileIdsTruncated: false })), forks: [] } });
    assert.deepEqual([[['x']], [['x']]].map(session).map(metrics => metrics.republishedFiles), [0, 0]);
    assert.equal(conversationMetrics([session([['x']]), session([['x']])]).republishedWithinSessions, 0);
    assert.equal(conversationMetrics([session([['x'], ['x']]), session([['x'], ['x']])]).republishedWithinSessions, 2);
    assert.equal('republishedFiles' in conversationMetrics([session([['x']])]), false);
});

test('a CLI failure names the error code and status without its message, cause or stack', () => {
    const fixed = /^BEAM replay could not complete/;
    const sdk = describeFailure(Object.assign(new Error('secret service text'), { name: 'MemDriveError', code: 'DATABASE_ERROR', status: 503, cause: new Error('body') }));
    assert.deepEqual([sdk.error, sdk.code, sdk.status, fixed.test(sdk.message), JSON.stringify(sdk).includes('secret')], ['MemDriveError', 'DATABASE_ERROR', 503, true, false]);
    const parser = describeFailure(Object.assign(new TypeError('Unknown option'), { code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' }));
    assert.deepEqual([parser.error, parser.code, 'status' in parser, fixed.test(parser.message)], ['TypeError', 'ERR_PARSE_ARGS_UNKNOWN_OPTION', false, true]);
    assert.deepEqual(describeFailure(Object.assign(new Error('Use --backend fixture or lambdadb\n\n1 !== 2'), { name: 'AssertionError', code: 'ERR_ASSERTION' })),
        { error: 'AssertionError', code: 'ERR_ASSERTION', message: 'Use --backend fixture or lambdadb' });
    assert.deepEqual(describeFailure(undefined).error, 'Error');
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

// A synthetic LambdaDB connection backed by the in-memory fixture; no network.
const endpoint = 'https://lambdadb.example', project = 'replay-test';
function liveFixture(createCollection) {
    const fixture = fileClient();
    const client = { ...fixture.client, createCollection: request => createCollection?.(request, fixture) ?? fixture.client.createCollection(request) };
    return { fixture, connection: { client, endpoint, project }, connect: () => ({ client, endpoint, project }) };
}

test('backend and LambdaDB configuration are validated before any directory or store exists', async t => {
    const files = await prepared(t);
    const env = { LAMBDADB_BASE_URL: 'https://lambdadb.example', LAMBDADB_PROJECT_NAME: 'p', LAMBDADB_PROJECT_API_KEY: 'synthetic-key' };
    const run = options => runReplay({ manifest: files.manifest, conversation: '7', output: files.output, mode: 'scripted', ...options });
    await assert.rejects(run({ backend: 'memory' }), /--backend fixture or lambdadb/);
    for (const missing of ['LAMBDADB_BASE_URL', 'LAMBDADB_PROJECT_NAME', 'LAMBDADB_PROJECT_API_KEY'])
        await assert.rejects(run({ backend: 'lambdadb', env: { ...env, [missing]: ' ' } }), /Missing LambdaDB configuration/);
    for (const url of ['http://lambdadb.example', 'https://user:pass@lambdadb.example', 'https://lambdadb.example/api', 'https://lambdadb.example/?a=1', 'not a url'])
        await assert.rejects(run({ backend: 'lambdadb', env: { ...env, LAMBDADB_BASE_URL: url } }), error => /HTTPS LambdaDB origin/.test(error.message) && !error.message.includes('synthetic-key'));
    assert.equal(await exists(files.output), false);

    // Requests stay inside the configured project and carry a deadline; nothing is retried.
    const seen = [];
    const { client, endpoint: origin, project: name } = lambdadbConnection(env, { fetcher: async (request, init) => {
        seen.push({ url: request.url, init });
        return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    } });
    assert.deepEqual([origin, name], ['https://lambdadb.example', 'p']);
    await assert.rejects(client.collection('beam-replay-x').get());
    assert.equal(seen.length, 1);
    assert(seen[0].url.startsWith('https://lambdadb.example/projects/p/'));
    assert.equal(seen[0].init.redirect, 'error');
    assert(seen[0].init.signal instanceof AbortSignal);
});

test('a LambdaDB run records ownership before create, retains its store and cleans up only that store', async t => {
    const files = await prepared(t);
    const outputs = ['completed', 'failed', 'lost'].map(name => path.join(files.root, name));
    const ledgers = [];
    let current;
    // The store's publication journal is created through the same client later.
    const live = liveFixture(async (request, fixture) => {
        if (request.collectionName.startsWith('beam-replay-')) ledgers.push(await json(path.join(current, 'store.json')));
        return fixture.client.createCollection(request);
    });
    const run = (index, options) => runReplay({ manifest: files.manifest, conversation: '7', output: current = outputs[index], backend: 'lambdadb',
        connect: live.connect, ...options });

    const completed = await run(0, { mode: 'scripted', instructions: 'none' });
    assert.equal(ledgers[0].status, 'pending', 'The ledger exists before the create request');
    const ledger = await json(path.join(outputs[0], 'store.json'));
    assert.deepEqual(ledger, { ...ledgers[0], status: 'ready' });
    assert.deepEqual(Object.keys(ledger), ['protocol', 'name', 'endpoint', 'project', 'labels', 'status']);
    assert.match(ledger.name, /^beam-replay-[0-9a-f]{32}$/);
    assert.deepEqual([ledger.endpoint, ledger.project, ledger.labels['beam.application']], [endpoint, project, 'memdrive-beam-session-replay-store-v1']);
    assert(!JSON.stringify(ledger).includes('key'));
    assert.deepEqual([completed.manifest.backend, completed.manifest.store, completed.summary.complete, completed.summary.cleanup, completed.summary.store],
        ['lambdadb', { name: ledger.name, ledger: 'store.json' }, true, 'retained', { name: ledger.name, ledger: 'store.json' }]);
    assert.equal((await live.connection.client.collection(ledger.name).get()).collection.tags['beam.owner'], ledger.labels['beam.owner']);

    const failed = await run(1, { mode: 'model', instructions: 'none', askFactory: () => async () => { throw new Error('offline'); } });
    assert.deepEqual([failed.summary.failed, failed.summary.cleanup], [1, 'retained']);
    const failedLedger = await json(path.join(outputs[1], 'store.json'));
    assert.equal(failedLedger.status, 'ready');
    assert(live.fixture.collections.has(failedLedger.name), 'A failed run keeps its store');

    // Cleanup refuses another endpoint or project and a store whose owner label differs.
    await assert.rejects(cleanupStore({ output: outputs[0], ...live.connection, endpoint: 'https://other.example' }), /another endpoint\/project/);
    await assert.rejects(cleanupStore({ output: outputs[0], ...live.connection, project: 'other' }), /another endpoint\/project/);
    live.fixture.collections.get(failedLedger.name).metadata.tags['beam.owner'] = '00000000-0000-4000-8000-000000000000';
    await assert.rejects(cleanupStore({ output: outputs[1], ...live.connection }), /owner differs/);
    assert(live.fixture.collections.has(failedLedger.name));

    const before = [...live.fixture.collections.keys()];
    assert.deepEqual(await cleanupStore({ output: outputs[0], ...live.connection }), { status: 'cleaned', name: ledger.name });
    assert.equal((await json(path.join(outputs[0], 'store.json'))).status, 'cleaned');
    // The store and its owned journal are gone; the other run's store is untouched.
    assert.equal(live.fixture.collections.has(ledger.name), false);
    assert.deepEqual([...live.fixture.collections.keys()], [failedLedger.name]);
    assert(before.length > 2, 'The completed run also owned a publication journal');
    const deletes = live.fixture.calls.filter(call => call.kind === 'collection-delete').length;
    assert.deepEqual(await cleanupStore({ output: outputs[0], ...live.connection }), { status: 'cleaned', name: ledger.name });
    assert.equal(live.fixture.calls.filter(call => call.kind === 'collection-delete').length, deletes, 'Repeated cleanup deletes nothing');

    // A lost create response leaves a pending ledger, which cleanup also handles.
    const lost = liveFixture(async (request, fixture) => { await fixture.client.createCollection(request); throw new Error('response lost'); });
    await assert.rejects(runReplay({ manifest: files.manifest, conversation: '7', output: outputs[2], backend: 'lambdadb', mode: 'scripted', connect: lost.connect }));
    const pending = await json(path.join(outputs[2], 'store.json'));
    assert.deepEqual([pending.status, (await json(path.join(outputs[2], 'summary.json'))).cleanup], ['pending', 'retained']);
    assert(lost.fixture.collections.has(pending.name));
    await cleanupStore({ output: outputs[2], ...lost.connection });
    assert.deepEqual([lost.fixture.collections.size, (await json(path.join(outputs[2], 'store.json'))).status], [0, 'cleaned']);
});

test('per-session token and time limits reach the session budget and the manifest', async t => {
    const files = await prepared(t);
    const run = (name, options) => runReplay({ manifest: files.manifest, conversation: '7', output: path.join(files.root, name), mode: 'model',
        instructions: 'none', sessions: 1, ...options });
    const tokens = await run('tokens', { sessionTokens: 150000,
        askFactory: () => async request => ({ ...reply(request), usage: { input_tokens: 90000, output_tokens: 20000 } }) });
    assert.equal(tokens.results[0].error.code, 'TOKEN_BUDGET_EXHAUSTED');
    assert.deepEqual(tokens.manifest.limits, { ...limits, sessionTokens: 150000 });
    // The request reservation is the estimated request plus the output cap, so a small context limit stops the first request.
    const context = await run('context', { contextTokens: limits.outputTokens, askFactory: () => reply });
    assert.equal(context.results[0].error.code, 'CONTEXT_BUDGET_EXHAUSTED');
    assert.deepEqual([context.manifest.limits, context.results[0].metrics.modelRequests], [{ ...limits, contextTokens: limits.outputTokens }, 0]);
    const seconds = await run('seconds', { sessionSeconds: 1, askFactory: () => untilAborted });
    assert.equal(seconds.results[0].error.code, 'SESSION_TIMEOUT');
    assert.deepEqual(seconds.manifest.limits, { ...limits, sessionSeconds: 1 });
    for (const invalid of [{ sessionTokens: 0 }, { sessionSeconds: 1.5 }, { sessionTokens: Number('x') }, { contextTokens: -1 }])
        await assert.rejects(run('invalid', { askFactory: () => reply, ...invalid }), /positive integers/);
    assert.equal(await exists(path.join(files.root, 'invalid')), false);
});

test('the list check compares an unpaginated listing with a consistent read of every written path', async t => {
    const { client } = fileClient();
    const drive = await MemDrive.create({ client, name: 'list-check' });
    const at = { kind: 'fork', name: 'work' };
    await drive.fork({ name: 'work' });
    const created = await drive.write({ at, operations: ['/a/x.md', '/a/y.md', '/b/z.md', '/b/gone.md']
        .map(file => ({ op: 'create', path: file, content: file })) });
    await drive.write({ at, op: 'delete', fileId: created[3].fileId });
    // Unknown paths are omitted by the read; 120 of them also force a second read batch.
    const written = new Set([...created.map(file => file.path), ...Array.from({ length: 120 }, (_, i) => `/never/${i}.md`)]);
    const full = await drive.list({ at });
    const check = (args, result) => checkList(drive, { turn: 1, round: 2, args, ok: true, delivered: true, result }, written);
    const without = (result, omitted) => ({ ...result, files: result.files.filter(file => !omitted.includes(file.path)) });
    const record = { turn: 1, round: 2, at, delivered: true };

    assert.deepEqual(await check({ at }, full), { ...record, checked: true, existing: 3, listed: 3, missed: [] });
    assert.deepEqual(await check({ at }, without(full, ['/a/y.md'])), { ...record, checked: true, existing: 3, listed: 2, missed: ['/a/y.md'] });
    assert.deepEqual(await check({ at, prefix: '/a/' }, without(await drive.list({ at, prefix: '/a/' }), ['/a/x.md'])),
        { ...record, checked: true, existing: 2, listed: 1, missed: ['/a/x.md'] });
    assert.deepEqual(await check({ at, nameContains: 'z' }, await drive.list({ at, nameContains: 'z' })), { ...record, checked: true, existing: 1, listed: 1, missed: [] });
    // Main has none of the fork's files yet.
    assert.deepEqual(await check({}, await drive.list()), { ...record, at: { kind: 'main' }, checked: true, existing: 0, listed: 0, missed: [] });

    const paged = await drive.list({ at, limit: 1 });
    assert.deepEqual(await check({ at, limit: 1 }, paged), { ...record, checked: false, reason: 'next' });
    assert.deepEqual(await check(paged.next, await drive.list(paged.next)), { ...record, checked: false, reason: 'cursor' });
    assert.deepEqual(await check({ at, delimiter: '/' }, await drive.list({ at, delimiter: '/' })), { ...record, checked: false, reason: 'delimiter' });
    assert.deepEqual(await check({ at: { kind: 'fork', name: 'removed' } }, full),
        { ...record, at: { kind: 'fork', name: 'removed' }, checked: false, reason: 'read_failed', code: 'BRANCH_NOT_FOUND' });

    const metrics = sessionMetrics({ userTurns: 1, requests: [], events: [], observation: null, listChecks: [
        { checked: true, missed: [] }, { checked: true, missed: ['/a', '/b'] }, { checked: true, missed: ['/c'] },
        { checked: false, reason: 'next' }, { checked: false, reason: 'read_failed' }, { checked: false, reason: 'next' }] });
    assert.deepEqual(metrics.listCheck, { calls: 6, checked: 3, uncheckedByReason: { next: 2, read_failed: 1 }, missedCalls: 2, missedFiles: 3 });
    assert.deepEqual(conversationMetrics([metrics, metrics]).listCheck, { calls: 12, checked: 6, uncheckedByReason: { next: 4, read_failed: 2 }, missedCalls: 4, missedFiles: 6 });

    // In a run, a stale listing is counted as a miss without changing what the model received.
    const files = await prepared(t);
    const live = liveFixture();
    live.fixture.listPage = () => ({ isDocsInline: true, total: 0, docs: [] });
    const script = [['fork', { name: 'work' }], ['write', { at, op: 'create', path: '/kept.md', content: 'kept' }], ['list', { at }]];
    const listed = [];
    const run = await runReplay({ manifest: files.manifest, conversation: '7', output: files.output, backend: 'lambdadb', connect: live.connect,
        mode: 'model', instructions: 'none', sessions: 1, turns: 1, askFactory: () => async (request, { round }) => {
            const last = request.input.at(-1);
            if (round === script.length) listed.push(JSON.parse(last.output));
            return round < script.length ? toolCall(request, `call-${round}`, ...script[round]) : reply(request);
        } });
    assert.deepEqual(listed, [{ files: [], prefixes: [], consistency: 'eventual' }]);
    assert.deepEqual([run.results[0].metrics.toolCalls, run.results[0].metrics.listCheck], [3, { calls: 1, checked: 1, uncheckedByReason: {}, missedCalls: 1, missedFiles: 1 }]);
    assert.deepEqual((await jsonl(path.join(files.output, 'session-001-s000', 'list-checks.jsonl'))).map(entry => entry.missed), [['/kept.md']]);
});
