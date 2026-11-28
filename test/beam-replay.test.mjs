import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileToolInstructions, getFileToolDefinitions } from '@functional-systems/memdrive';
import { limits, openAI, toolNames } from '../benchmark/beam/replay-agent.mjs';
import { conversationMetrics, sessionMetrics, toolUse, toolUseTotals } from '../benchmark/beam/replay-metrics.mjs';
import { describeFailure, runReplay } from '../benchmark/beam/replay.mjs';
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

test('a scripted replay records tree and list use, lookups, checkpointed writes, a rejected write, a deletion, appends and the inventory per session', async t => {
    const files = await prepared(t);
    let now = 0;
    const { summary, manifest, results } = await runReplay({ manifest: files.manifest, conversation: '7', output: files.output, mode: 'scripted', instructions: 'none',
        clock: () => now++ });
    assert.equal(manifest.transport, 'scripted');
    assert.deepEqual(manifest.plan.map(entry => [entry.id, entry.userTurns, entry.plannedTurns]), [['s000', 3, 3], ['s001', 1, 1], ['s002', 2, 2], ['s003', 2, 2]]);
    assert.deepEqual({ planned: summary.planned, attempted: summary.attempted, completed: summary.completed, failed: summary.failed,
        complete: summary.complete, cleanup: summary.cleanup }, { planned: 4, attempted: 4, completed: 4, failed: 0, complete: true, cleanup: 'completed' });
    assert.equal(summary.modelBehavior, null, 'A scripted run is never a model measurement');
    assert.deepEqual([manifest.guide, manifest.tools, summary.guide, manifest.writes.checkpointed], ['on', [...toolNames], 'on', true]);

    const operations = (counts = {}) => ({ create: 0, updateEdits: 0, updateContent: 0, updateOther: 0, append: 0, delete: 0, ...counts });
    const tokens = { inputTokens: 0, outputTokens: 0, unknownUsageRequests: 0 };
    const noList = { listings: 0, continuations: 0, afterTree: 0, withPrefix: 0, withNameContains: 0, withDelimiter: 0, stoppedBeforeEnd: 0 };
    const used = fields => ({ firstTool: 'none', firstNonGuideTool: 'none', tree: { withPrefix: 0, withoutPrefix: 0 }, list: noList, search: 0, findText: 0,
        read: { whole: 0, ranged: 0, wholeChars: 0, rangedChars: 0 }, failedTreesByCode: {}, failedListsByCode: {}, ...fields });
    const [first, second, third] = results.map(result => result.metrics);
    assert.deepEqual(first, { userTurns: 3, modelRequests: 12, ...tokens, toolCalls: 9,
        toolCallsByName: { guide: 2, list: 1, read: 1, search: 1, tree: 1, write: 3 }, toolErrorsByCode: { PATH_EXISTS: 1 },
        toolCallsPerTurn: { mean: 3, max: 6 }, toolRounds: 9, toolRoundsPerTurn: { mean: 3, max: 6 },
        guideCalls: { index: 1, byTopic: { editing: 1 } }, writeCalls: 3, failedWritesByCode: { PATH_EXISTS: 1 },
        noSuccessfulWrite: false, turnsWithWrite: 2, turnsWithMultipleWriteCalls: 1, operations: operations({ create: 1, updateEdits: 1 }),
        filesCreated: 1, filesUpdated: 1, filesWrittenInSeveralTurns: 1, createsAfterLookup: 1, createsWithoutLookup: 0,
        filesAfter: 1, latestCheckpointAsExpected: true,
        // The whole-drive tree comes after the guide; the note's folder is listed by prefix after it.
        toolUse: used({ firstTool: 'guide', firstNonGuideTool: 'tree', tree: { withPrefix: 0, withoutPrefix: 1 },
            list: { ...noList, listings: 1, afterTree: 1, withPrefix: 1 }, search: 1,
            read: { whole: 1, ranged: 0, wholeChars: 'Scripted note.\n'.length, rangedChars: 0 } }) });
    assert.deepEqual(second, { userTurns: 1, modelRequests: 6, ...tokens, toolCalls: 5,
        toolCallsByName: { findText: 1, tree: 1, write: 3 }, toolErrorsByCode: {},
        toolCallsPerTurn: { mean: 5, max: 5 }, toolRounds: 5, toolRoundsPerTurn: { mean: 5, max: 5 },
        guideCalls: { index: 0, byTopic: {} }, writeCalls: 3, failedWritesByCode: {},
        noSuccessfulWrite: false, turnsWithWrite: 1, turnsWithMultipleWriteCalls: 1, operations: operations({ create: 1, append: 2, delete: 1 }),
        // A tree call returns no files, so the create after it still counts as without a lookup. Of the appends after
        // findText, the one to the file created earlier is an update and the one creating the log a create after a lookup.
        filesCreated: 2, filesUpdated: 1, filesWrittenInSeveralTurns: 0, createsAfterLookup: 1, createsWithoutLookup: 1,
        filesAfter: 2, latestCheckpointAsExpected: true,
        toolUse: used({ firstTool: 'tree', firstNonGuideTool: 'tree', tree: { withPrefix: 1, withoutPrefix: 0 }, findText: 1 }) });
    assert.deepEqual(third, { userTurns: 2, modelRequests: 2, ...tokens, toolCalls: 0, toolCallsByName: {}, toolErrorsByCode: {},
        toolCallsPerTurn: { mean: 0, max: 0 }, toolRounds: 0, toolRoundsPerTurn: { mean: 0, max: 0 },
        guideCalls: { index: 0, byTopic: {} }, writeCalls: 0, failedWritesByCode: {},
        noSuccessfulWrite: true, turnsWithWrite: 0, turnsWithMultipleWriteCalls: 0, operations: operations(),
        filesCreated: 0, filesUpdated: 0, filesWrittenInSeveralTurns: 0, createsAfterLookup: 0, createsWithoutLookup: 0,
        filesAfter: 2, latestCheckpointAsExpected: true, toolUse: used({}) });
    assert.deepEqual(summary.smoke, { sessions: 4, userTurns: 8, modelRequests: 22, ...tokens, toolCalls: 14,
        toolCallsByName: { findText: 1, guide: 2, list: 1, read: 1, search: 1, tree: 2, write: 6 }, toolErrorsByCode: { PATH_EXISTS: 1 },
        toolCallsPerTurn: { mean: 14 / 8, max: 6 }, toolRounds: 14, toolRoundsPerTurn: { mean: 14 / 8, max: 6 },
        guideCalls: { index: 1, byTopic: { editing: 1 } }, writeCalls: 6, failedWritesByCode: { PATH_EXISTS: 1 },
        sessionsWithoutWrite: 2, turnsWithWrite: 3, turnsWithMultipleWriteCalls: 2, operations: operations({ create: 2, updateEdits: 1, append: 2, delete: 1 }),
        filesCreated: 3, filesUpdated: 2, filesWrittenInSeveralTurns: 1, createsAfterLookup: 2, createsWithoutLookup: 1,
        finalFiles: 2, sessionsWithUnexpectedLatestCheckpoint: 0,
        toolUse: { conversations: 4, firstTool: { guide: 1, none: 2, tree: 1 }, firstNonGuideTool: { none: 2, tree: 2 },
            tree: { withPrefix: 1, withoutPrefix: 1 }, list: { ...noList, listings: 1, afterTree: 1, withPrefix: 1 },
            search: { calls: 1, mean: 0.25, max: 1 }, findText: { calls: 1, mean: 0.25, max: 1 }, withoutSearchOrFindText: 2,
            read: { whole: 1, ranged: 0, wholeChars: 'Scripted note.\n'.length, rangedChars: 0 }, failedTreesByCode: {}, failedListsByCode: {} } });
    assert.deepEqual(summary.smoke, conversationMetrics(results.map(result => result.metrics)));

    // Harness reads are recorded apart from the model's tool events.
    const sessionDirectory = path.join(files.output, 'session-001-s000');
    assert.deepEqual((await readdir(files.output)).sort(), ['manifest.json', 'session-001-s000', 'session-002-s001', 'session-003-s002', 'session-004-s003', 'summary.json']);
    const events = await jsonl(path.join(sessionDirectory, 'events.jsonl'));
    assert.deepEqual(events.map(event => [event.turn, event.name, event.ok, event.error?.code]), [[0, 'guide', true, undefined], [0, 'guide', true, undefined],
        [0, 'tree', true, undefined], [0, 'search', true, undefined], [0, 'write', true, undefined], [0, 'list', true, undefined], [1, 'read', true, undefined],
        [1, 'write', true, undefined], [1, 'write', false, 'PATH_EXISTS']]);
    // The tree before the first write is empty; the listing right after it already holds the note.
    assert.deepEqual([events[2].result, events[5].result.files.map(file => file.path)], [{ fileCount: 0, folders: [], truncated: false }, ['/notes/scripted.md']]);
    // Every write call gets its own checkpoint name; the model's results never carry one.
    const names = events.filter(event => event.name === 'write').map(event => event.checkpoint);
    assert(names.every(name => /^turn-[0-9a-z]+-[0-9a-f]{8}$/.test(name) && name.length <= 41) && new Set(names).size === 3);
    assert(!JSON.stringify(await jsonl(path.join(sessionDirectory, 'transcript.jsonl'))).includes('turn-'));
    // Main's latest checkpoint is the last successful write's; the rejected create changed nothing.
    const observation = await json(path.join(sessionDirectory, 'observation.json'));
    assert.deepEqual({ ...observation, inventory: observation.inventory.map(({ path: file, chars }) => ({ path: file, chars })) },
        { latestCheckpointBefore: null, latestCheckpointAfter: names[1], tree: { fileCount: 1, folders: [{ path: '/notes/', fileCount: 1 }], truncated: false },
            inventory: [{ path: '/notes/scripted.md', chars: 'Scripted note, revised.\n'.length }], errors: [] });
    const later = await json(path.join(files.output, 'session-002-s001', 'observation.json'));
    assert.deepEqual([later.latestCheckpointBefore, later.inventory.map(({ path: file, chars }) => [file, chars])], [names[1],
        [['/notes/log.md', 'First log entry.\n'.length], ['/notes/unsearched.md', 'Saved without looking first.\nAn entry appended later.\n'.length]]]);
    // Write results identify files without their content.
    const appended = (await jsonl(path.join(files.output, 'session-002-s001', 'events.jsonl'))).at(-1);
    assert.deepEqual(appended.result.map(file => [file.path, Object.keys(file).sort()]), ['/notes/unsearched.md', '/notes/log.md']
        .map(file => [file, ['createdAt', 'fileId', 'modifiedAt', 'path']]));
    // Each clock reading advances by one, so every timed request and tool call lasts exactly 1.
    const receipts = await jsonl(path.join(sessionDirectory, 'requests.jsonl'));
    assert(receipts.every(receipt => receipt.status === 'pending' ? !('elapsedMs' in receipt) : receipt.elapsedMs === 1));
    assert(events.every(event => event.elapsedMs === 1));
    assert.deepEqual(results[0].timing.perTurn, [{ modelRequestMs: 7, toolMs: 6 }, { modelRequestMs: 4, toolMs: 3 }, { modelRequestMs: 1, toolMs: 0 }]);
    for (const [index, result] of results.entries()) {
        const { wallMs, perTurn, ...timing } = result.timing;
        assert.deepEqual(timing, { modelRequestMs: result.metrics.modelRequests, toolMs: result.metrics.toolCalls, toolMsByName: result.metrics.toolCallsByName });
        assert.equal(perTurn.length, result.metrics.userTurns);
        assert(wallMs > timing.modelRequestMs + timing.toolMs);
        assert.deepEqual(summary.sessions[index].timing, result.timing);
        assert.deepEqual(await json(path.join(files.output, `session-00${index + 1}-${result.id}`, 'result.json')), JSON.parse(JSON.stringify(result)));
    }
    assert.deepEqual([manifest.backend, manifest.store, summary.backend, summary.store], ['native-client-fixture', null, 'native-client-fixture', null]);
    assert.equal(await exists(path.join(files.output, 'session-003-s002', 'events.jsonl')), false, 'A session without tool calls has no events');
    assert.deepEqual(await json(path.join(files.output, 'summary.json')), JSON.parse(JSON.stringify(summary)));
    await assert.rejects(runReplay({ manifest: files.manifest, conversation: '7', output: files.output, mode: 'scripted' }), { code: 'EEXIST' });

    // Without the guide tool the script skips its guide calls and nothing else changes.
    const unguided = await runReplay({ manifest: files.manifest, conversation: '7', output: path.join(files.root, 'unguided'), mode: 'scripted',
        instructions: 'none', guide: 'off', sessions: 1 });
    assert.deepEqual([unguided.manifest.tools, unguided.results[0].metrics.toolCallsByName, unguided.results[0].metrics.guideCalls],
        [['read', 'tree', 'list', 'search', 'findText', 'write'], { list: 1, read: 1, search: 1, tree: 1, write: 3 }, { index: 0, byTopic: {} }]);
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
    assert.deepEqual([both.manifest.tools, both.manifest.protocol], [['guide', 'read', 'tree', 'list', 'search', 'findText', 'write'], 'memdrive-beam-session-replay-v4']);
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

    // Without the guide tool the catalog drops it and the SDK instruction text stays as it is:
    // that text does not mention the guide.
    const unguided = await run('unguided', { instructions: 'sdk', guide: 'off', sessions: 1, turns: 1 });
    const withoutGuide = getFileToolDefinitions({ embeddingMode: 'managed', tools: ['read', 'tree', 'list', 'search', 'findText', 'write'] });
    assert.deepEqual([unguided.manifest.guide, unguided.manifest.tools, unguided.manifest.toolDefinitions, unguided.summary.guide],
        ['off', ['read', 'tree', 'list', 'search', 'findText', 'write'], withoutGuide, 'off']);
    assert.deepEqual(unguided.requests[0].request.tools.map(tool => tool.name), ['read', 'tree', 'list', 'search', 'findText', 'write']);
    assert.deepEqual(unguided.requests[0].request.input[0], { role: 'developer', content: fileToolInstructions });
    assert.doesNotMatch(fileToolInstructions, /guide/i);
    await assert.rejects(run('guide', { guide: 'none' }), /--guide on or off/);
    assert.equal(await exists(path.join(files.root, 'guide')), false);

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
    const looping = () => async request => toolCall(request, `call-${calls++}`, 'guide', {});

    const rounds = await run('rounds', looping, { roundsPerTurn: 2 });
    assert.deepEqual({ attempted: rounds.summary.attempted, completed: rounds.summary.completed, failed: rounds.summary.failed,
        complete: rounds.summary.complete, cleanup: rounds.summary.cleanup }, { attempted: 1, completed: 0, failed: 1, complete: false, cleanup: 'completed' });
    assert.equal(rounds.results[0].error.code, 'ROUND_BUDGET_EXHAUSTED');
    const metrics = rounds.results[0].metrics;
    assert.deepEqual([metrics.userTurns, metrics.modelRequests, metrics.toolCalls, metrics.toolCallsByName, metrics.inputTokens, metrics.filesAfter],
        [1, 2, 2, { guide: 2 }, 6, 0]);

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
        TOOL_CALL_ID_INVALID: request => toolCall(request, 'same', 'guide', {}),
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
    const script = [['write', '{"op":'], ['merge', {}], ['write', { at: { kind: 'main' }, op: 'create', path: '/a.md', content: 'x' }], ['guide', {}],
        ['write', { op: 'create', path: '/a.md', content: 'x' }], ['tree', 'null'], ['list', 'null'], ['read', 'null']];
    const outputs = [];
    const { results, summary } = await runReplay({ manifest: files.manifest, conversation: '7', output: files.output, mode: 'model', instructions: 'none',
        sessions: 1, turns: 1, budget: { ...limits, resultBytes: 300 },
        askFactory: () => async (request, { round }) => {
            const last = request.input.at(-1);
            if (last.type === 'function_call_output') outputs.push(JSON.parse(last.output));
            return round < script.length ? toolCall(request, `call-${round}`, ...script[round]) : reply(request);
        } });
    assert.equal(summary.complete, true);
    assert.deepEqual(outputs.slice(0, 4).map(output => output.error?.code), ['INVALID_JSON', 'TOOL_NOT_ALLOWED', 'INVALID_INPUT', 'TOOL_RESULT_TOO_LARGE']);
    assert.deepEqual([outputs[4].path, 'content' in outputs[4], 'checkpoint' in outputs[4]], ['/a.md', false, false]);
    const events = await jsonl(path.join(files.output, 'session-001-s000', 'events.jsonl'));
    assert.deepEqual(events.map(event => [event.name, event.ok, event.delivered, event.error?.code, typeof event.checkpoint]), [
        ['write', false, true, 'INVALID_JSON', 'undefined'], ['merge', false, true, 'TOOL_NOT_ALLOWED', 'undefined'],
        // A write rejected before it reaches the SDK never asks the host for a checkpoint.
        ['write', false, true, 'INVALID_INPUT', 'undefined'], ['guide', true, false, undefined, 'undefined'], ['write', true, true, undefined, 'string'],
        ['tree', false, true, 'INVALID_INPUT', 'undefined'], ['list', false, true, 'INVALID_INPUT', 'undefined'], ['read', false, true, 'INVALID_INPUT', 'undefined']]);
    assert.equal(events[0].rawArguments, '{"op":');
    assert.equal('args' in events[0], false);
    assert.equal(typeof events[3].result.content, 'string', 'The undelivered result stays in the record');
    assert.deepEqual(results[0].metrics.toolErrorsByCode, { INVALID_INPUT: 4, INVALID_JSON: 1, TOOL_NOT_ALLOWED: 1 });
    // JSON null arguments are rejected by the SDK and recorded; the tool-use splits skip them instead of failing.
    assert.deepEqual([outputs.slice(5).map(output => output.error.code), results[0].metrics.toolUse.failedTreesByCode, results[0].metrics.toolUse.list,
        results[0].metrics.toolUse.read.whole + results[0].metrics.toolUse.read.ranged], [Array(3).fill('INVALID_INPUT'), { INVALID_INPUT: 1 },
        { listings: 0, continuations: 0, afterTree: 0, withPrefix: 0, withNameContains: 0, withDelimiter: 0, stoppedBeforeEnd: 0 }, 0]);
    assert.deepEqual(results[0].metrics.failedWritesByCode, { INVALID_INPUT: 1, INVALID_JSON: 1 });
    assert.deepEqual([results[0].metrics.writeCalls, results[0].metrics.turnsWithMultipleWriteCalls, results[0].metrics.filesAfter,
        results[0].metrics.latestCheckpointAsExpected], [3, 1, 1, true]);
});

test('metrics count operations, files, lookups, guide topics and the latest checkpoint from recorded events', () => {
    const ok = (turn, round, name, args, result, extra = {}) => ({ turn, round, name, args, ok: true, result, ...extra });
    const failed = (turn, round, name, args, code) => ({ turn, round, name, args, ok: false, error: { code } });
    const events = [
        failed(0, 0, 'search', { query: 'x' }, 'INVALID_INPUT'),
        ok(0, 1, 'write', { op: 'create', path: '/a.md', content: 'a' }, { fileId: 'a', path: '/a.md' }, { checkpoint: 'c1' }),
        ok(0, 2, 'guide', {}, {}), ok(0, 2, 'guide', { topic: 'editing' }, {}), failed(0, 3, 'guide', { topic: 'publication' }, 'INVALID_INPUT'),
        ok(1, 0, 'read', { path: '/a.md' }, { fileId: 'a' }),
        // One batch: its results follow the operations' order.
        ok(1, 1, 'write', { operations: [{ op: 'create', path: '/b.md', content: 'b' }, { op: 'update', fileId: 'a', edits: [{ oldText: 'a', newText: 'A' }] },
            { op: 'update', fileId: 'a', newPath: '/c.md' }] }, [{ fileId: 'b' }, { fileId: 'a' }, { fileId: 'a' }], { checkpoint: 'c2' }),
        failed(1, 2, 'write', { op: 'update', fileId: 'b', edits: [{ oldText: 'z', newText: 'y' }] }, 'EDIT_CONFLICT'),
        failed(1, 3, 'write', { op: 'update', fileId: 'b', content: 'B' }, 'CHECKPOINT_WRITE_FAILED'),
        ok(3, 0, 'write', { op: 'update', fileId: 'b', content: 'B' }, { fileId: 'b' }, { checkpoint: 'c3' }),
        ok(3, 0, 'write', { op: 'delete', fileId: 'a' }, { fileId: 'a' }, { checkpoint: 'c4' }),
    ];
    const observation = latestCheckpointAfter => ({ latestCheckpointBefore: 'c0', latestCheckpointAfter, inventory: [{ fileId: 'b' }], errors: [] });
    const metrics = sessionMetrics({ userTurns: 4, requests: [{ usage: { input_tokens: 5, output_tokens: 1 } }, { usage: undefined }], events,
        observation: observation('c4') });
    assert.deepEqual(metrics, { userTurns: 4, modelRequests: 2, inputTokens: 5, outputTokens: 1, unknownUsageRequests: 1, toolCalls: 11,
        toolCallsByName: { guide: 3, read: 1, search: 1, write: 6 }, toolErrorsByCode: { CHECKPOINT_WRITE_FAILED: 1, EDIT_CONFLICT: 1, INVALID_INPUT: 2 },
        // Turn 2 made no call; turn 0 used four model rounds with tools.
        toolCallsPerTurn: { mean: 11 / 4, max: 5 }, toolRounds: 9, toolRoundsPerTurn: { mean: 9 / 4, max: 4 },
        guideCalls: { index: 1, byTopic: { editing: 1, publication: 1 } }, writeCalls: 6, failedWritesByCode: { CHECKPOINT_WRITE_FAILED: 1, EDIT_CONFLICT: 1 },
        noSuccessfulWrite: false, turnsWithWrite: 3, turnsWithMultipleWriteCalls: 2,
        operations: { create: 2, updateEdits: 1, updateContent: 1, updateOther: 1, append: 0, delete: 1 },
        filesCreated: 2, filesUpdated: 2, filesWrittenInSeveralTurns: 2,
        // The first create came before any successful lookup; the failed search does not count.
        createsAfterLookup: 1, createsWithoutLookup: 1, filesAfter: 1, latestCheckpointAsExpected: true,
        // These events have no delivered flag, so the read's characters are not counted.
        toolUse: { firstTool: 'search', firstNonGuideTool: 'search', tree: { withPrefix: 0, withoutPrefix: 0 },
            list: { listings: 0, continuations: 0, afterTree: 0, withPrefix: 0, withNameContains: 0, withDelimiter: 0, stoppedBeforeEnd: 0 },
            search: 1, findText: 0, read: { whole: 1, ranged: 0, wholeChars: 0, rangedChars: 0 }, failedTreesByCode: {}, failedListsByCode: {} } });
    assert.equal(sessionMetrics({ userTurns: 4, requests: [], events, observation: observation('c2') }).latestCheckpointAsExpected, false);
    // Without a successful write the latest checkpoint must stay where it was.
    assert.equal(sessionMetrics({ userTurns: 1, requests: [], events: [], observation: observation('c0') }).latestCheckpointAsExpected, true);
    const unobserved = sessionMetrics({ userTurns: 1, requests: [], events: [],
        observation: { latestCheckpointBefore: 'c0', latestCheckpointAfter: null, inventory: null, errors: [{ step: 'describe', code: 'DATABASE_ERROR' }] } });
    assert.deepEqual([unobserved.filesAfter, unobserved.latestCheckpointAsExpected, unobserved.toolCallsPerTurn], [null, null, { mean: 0, max: 0 }]);
    const totals = conversationMetrics([metrics, unobserved]);
    assert.deepEqual([totals.sessions, totals.userTurns, totals.toolCallsPerTurn, totals.toolRoundsPerTurn, totals.sessionsWithoutWrite, totals.finalFiles,
        totals.sessionsWithUnexpectedLatestCheckpoint, totals.operations.updateEdits, totals.guideCalls],
    [2, 5, { mean: 11 / 5, max: 5 }, { mean: 9 / 5, max: 4 }, 1, null, 0, 1, { index: 1, byTopic: { editing: 1, publication: 1 } }]);
    assert.deepEqual(conversationMetrics([]).toolCallsPerTurn, { mean: null, max: null });
});

test('metrics count appends as their own operation and classify each as a create or an update of its file', () => {
    const write = (turn, round, args, result) => ({ turn, round, name: 'write', args, ok: true, result, checkpoint: `c${turn}${round}` });
    const file = (fileId, createdAt, modifiedAt) => ({ fileId, path: `/${fileId}.md`, createdAt, modifiedAt });
    const events = [
        // Before any lookup, an append by path creates its file: its creation and modification times are equal.
        write(0, 0, { op: 'append', path: '/f.md', content: 'x' }, file('f', 'T1', 'T1')),
        { turn: 0, round: 1, name: 'read', args: { path: '/o.md' }, ok: true, result: { fileId: 'o' } },
        // A file of an earlier session was modified now; the new log was created now.
        write(1, 0, { operations: [{ op: 'append', path: '/o.md', content: 'y' }, { op: 'append', path: '/l.md', content: 'z' }] },
            [file('o', 'T0', 'T2'), file('l', 'T2', 'T2')]),
        // The session already wrote this file, so equal times within one millisecond still make an update.
        write(1, 1, { op: 'append', path: '/l.md', content: 'w' }, file('l', 'T2', 'T2')),
        // An append by fileId always updates.
        write(2, 0, { op: 'append', fileId: 'f', content: 'v' }, file('f', 'T1', 'T1')),
    ];
    const metrics = sessionMetrics({ userTurns: 3, requests: [], events });
    assert.deepEqual([metrics.operations, metrics.filesCreated, metrics.filesUpdated, metrics.filesWrittenInSeveralTurns,
        metrics.createsAfterLookup, metrics.createsWithoutLookup], [{ create: 0, updateEdits: 0, updateContent: 0, updateOther: 0, append: 5, delete: 0 }, 2, 3, 1, 1, 1]);
    assert.equal(conversationMetrics([metrics, metrics]).operations.append, 10);
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
    assert.deepEqual([ledger.endpoint, ledger.project, ledger.labels['beam.application']], [endpoint, project, 'memdrive-beam-session-replay-store-v3']);
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

    // A store is one collection.
    assert.deepEqual([...live.fixture.collections.keys()], [ledger.name, failedLedger.name]);
    assert.deepEqual(await cleanupStore({ output: outputs[0], ...live.connection }), { status: 'cleaned', name: ledger.name });
    assert.equal((await json(path.join(outputs[0], 'store.json'))).status, 'cleaned');
    // The store is gone; the other run's store is untouched.
    assert.equal(live.fixture.collections.has(ledger.name), false);
    assert.deepEqual([...live.fixture.collections.keys()], [failedLedger.name]);
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

    // A ledger of an earlier protocol names a store this SDK cannot destroy: cleanup refuses it before any request.
    const requests = live.fixture.calls.length;
    for (const protocol of ['memdrive-beam-session-replay-store-v1', 'memdrive-beam-session-replay-store-v2']) {
        await writeFile(path.join(outputs[1], 'store.json'), JSON.stringify({ ...failedLedger, protocol }));
        await assert.rejects(cleanupStore({ output: outputs[1], ...live.connection }), /earlier replay protocol.*LambdaDB directly/);
    }
    assert.equal(live.fixture.calls.length, requests);
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

test('tool use records first tools, tree and list narrowing, partial listings, read kinds and characters, and list and tree failures', () => {
    const call = (name, args, outcome = {}) => ({ name, args, ok: true, delivered: true, result: {}, ...outcome });
    const failed = (name, args, code) => ({ name, args, ok: false, delivered: true, error: { code } });
    const page = (paths, cursor) => ({ files: paths.map(file => ({ fileId: file, path: file })), prefixes: [], ...(cursor ? { next: { cursor } } : {}) });
    const events = [
        call('guide', {}),
        failed('list', {}, 'LIST_TOO_MANY_FILES'),
        // `/` is the whole drive for tree and list: no narrowing prefix.
        call('tree', { prefix: '/' }),
        failed('tree', { prefix: '/deep/' }, 'DATABASE_ERROR'),
        call('list', { prefix: '/', delimiter: '/' }, { result: page(['/a.md'], 'c1') }),
        // The continuation's own next is never forwarded: the model saw only part of that listing.
        call('list', { cursor: 'c1' }, { result: page(['/b.md'], 'c2') }),
        // An undelivered page's next never reached the model.
        call('list', { prefix: '/notes/', nameContains: '', limit: 1 }, { delivered: false, result: page(['/notes/a.md'], 'c3') }),
        call('list', { nameContains: 'decision' }, { result: page([]) }),
        { name: 'list', rawArguments: '{', ok: false, delivered: true, error: { code: 'INVALID_JSON' } },
        // Valid JSON that is not an object is rejected by the SDK and has no arguments to split by.
        failed('list', null, 'INVALID_INPUT'), failed('tree', [], 'INVALID_INPUT'), failed('read', 5, 'INVALID_INPUT'),
        call('read', { path: '/a.md' }, { result: { content: 'abc' } }),
        call('read', { paths: ['/a.md', '/b.md'] }, { result: [{ content: 'abc' }, { content: 'de' }] }),
        call('read', { path: '/gone.md' }, { result: null }),
        call('read', { fileId: 'x', startLine: 2, endLine: 3 }, { result: { content: 'line' } }),
        call('read', { fileId: 'x', maxChars: 10 }, { delivered: false, result: { content: '0123456789' } }),
        call('read', { fileId: 'x', offset: 4, revision: 'r' }, { result: { content: 'more' } }),
        failed('read', { fileId: 'x', startLine: 0 }, 'INVALID_INPUT'),
        call('search', { query: 'x' }), call('findText', { query: 'y' }), call('search', { query: 'z' }),
    ];
    const used = toolUse(events);
    assert.deepEqual(used, { firstTool: 'guide', firstNonGuideTool: 'list', tree: { withPrefix: 1, withoutPrefix: 1 },
        // Four new listings, three after the first tree, and one continuation; calls without an argument object are in neither.
        list: { listings: 4, continuations: 1, afterTree: 3, withPrefix: 1, withNameContains: 1, withDelimiter: 1, stoppedBeforeEnd: 1 },
        search: 2, findText: 1,
        // Characters of delivered successful results only.
        read: { whole: 3, ranged: 4, wholeChars: 'abc'.length + 'abcde'.length, rangedChars: 'line'.length + 'more'.length },
        failedTreesByCode: { DATABASE_ERROR: 1, INVALID_INPUT: 1 }, failedListsByCode: { INVALID_INPUT: 1, INVALID_JSON: 1, LIST_TOO_MANY_FILES: 1 } });
    assert.deepEqual(toolUseTotals([used, toolUse([]), toolUse([call('guide', {})])]), { conversations: 3,
        firstTool: { guide: 2, none: 1 }, firstNonGuideTool: { list: 1, none: 2 }, tree: used.tree, list: used.list,
        search: { calls: 2, mean: 2 / 3, max: 2 }, findText: { calls: 1, mean: 1 / 3, max: 1 }, withoutSearchOrFindText: 2,
        read: used.read, failedTreesByCode: used.failedTreesByCode, failedListsByCode: used.failedListsByCode });
    assert.deepEqual([toolUseTotals([]).search, toolUseTotals([]).firstTool], [{ calls: 0, mean: null, max: null }, {}]);
});

test('the model can list a folder with over 1,000 files and observation reads the complete inventory', async t => {
    const files = await prepared(t);
    const live = liveFixture();
    const seeded = Array.from({ length: 1001 }, (_, index) => `/archive/${String(index).padStart(4, '0')}.md`);
    const script = [['tree', {}], ['list', { delimiter: '/' }], ['list', { prefix: '/archive/', nameContains: '0999' }]];
    const outputs = [];
    const { results } = await runReplay({ manifest: files.manifest, conversation: '7', output: files.output, backend: 'lambdadb', connect: live.connect,
        mode: 'model', instructions: 'none', sessions: 1, turns: 1, askFactory: () => async (request, { round }) => {
            // Stored directly, as if a model had written them earlier.
            if (round === 0) live.fixture.seedFiles([...live.fixture.collections.keys()][0], 'main', seeded);
            else outputs.push(JSON.parse(request.input.at(-1).output));
            return round < script.length ? toolCall(request, `call-${round}`, ...script[round]) : reply(request);
        } });
    const tree = { fileCount: 1001, folders: [{ path: '/archive/', fileCount: 1001 }], truncated: false };
    assert.deepEqual([outputs[0], outputs[1], outputs[2].files.map(file => file.path)],
        [tree, { files: [], prefixes: ['/archive/'] }, ['/archive/0999.md']]);
    const { metrics } = results[0];
    assert.deepEqual([metrics.toolErrorsByCode, metrics.toolUse.failedListsByCode, metrics.toolUse.list.afterTree, metrics.toolUse.list.withPrefix],
        [{}, {}, 2, 1]);
    const observation = await json(path.join(files.output, 'session-001-s000', 'observation.json'));
    const { inventory, ...summary } = observation;
    assert.deepEqual(summary, { latestCheckpointBefore: null, latestCheckpointAfter: null, tree, errors: [] });
    assert.deepEqual(inventory.map(file => file.path), seeded);
    assert.deepEqual([metrics.filesAfter, metrics.latestCheckpointAsExpected], [1001, true]);
});

test('a restored write keeps the latest checkpoint and leaves only the kept file in the inventory', async t => {
    const files = await prepared(t);
    const live = liveFixture();
    // The second write call's checkpoint cannot be created, so the SDK restores main to the first one.
    let tags = 0;
    live.fixture.beforeTagCreate = () => { if (++tags === 2) throw Object.assign(new Error('tag unavailable'), { statusCode: 503 }); };
    const script = [['write', { op: 'create', path: '/one.md', content: '1' }], ['write', { op: 'create', path: '/two.md', content: '2' }]];
    const { results } = await runReplay({ manifest: files.manifest, conversation: '7', output: files.output, backend: 'lambdadb', connect: live.connect,
        mode: 'model', instructions: 'none', sessions: 1, turns: 1, askFactory: () => async (request, { round }) =>
            round < script.length ? toolCall(request, `call-${round}`, ...script[round]) : reply(request) });
    const events = await jsonl(path.join(files.output, 'session-001-s000', 'events.jsonl'));
    assert.deepEqual(events.map(event => [event.ok, event.error?.code, event.error?.details?.restored]), [[true, undefined, undefined],
        [false, 'CHECKPOINT_WRITE_FAILED', true]]);
    const observation = await json(path.join(files.output, 'session-001-s000', 'observation.json'));
    assert.deepEqual([observation.inventory.map(file => file.path), observation.latestCheckpointAfter], [['/one.md'], events[0].checkpoint]);
    assert.deepEqual([results[0].metrics.failedWritesByCode, results[0].metrics.latestCheckpointAsExpected], [{ CHECKPOINT_WRITE_FAILED: 1 }, true]);
});
