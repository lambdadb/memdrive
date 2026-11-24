import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileToolInstructions, getFileToolDefinitions, MemDrive } from '@functional-systems/memdrive';
import { classCounts, defaultJudgeModel, flattenSourceIds, judgeAgreement, judgeItem, judgePrompt, judgePromptSha256, parseJudgeOutput, questionScore,
    readToolNames, runQuestions, runRejudge, scoreSummary } from '../benchmark/beam/replay-questions.mjs';
import { runReplay } from '../benchmark/beam/replay.mjs';
import { hash } from '../benchmark/beam/replay-sessions.mjs';
import { fileClient } from './helpers/file-client.mjs';

const config = JSON.parse(await readFile(new URL('../benchmark/beam/original-config.json', import.meta.url)));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const jsonl = async file => (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const exists = file => access(file).then(() => true, () => false);

// Each session lists its user utterance count; every utterance is followed by a dataset
// reply. Turn IDs are the ordinals as strings, like BEAM's numeric message IDs.
function conversation(userTurns = [3, 1, 2, 2]) {
    const messages = [];
    for (const [session, count] of userTurns.entries()) for (let turn = 0; turn < count * 2; turn++) {
        const user = turn % 2 === 0;
        messages.push({ sourceId: `7_s${String(session).padStart(3, '0')}_t${String(turn).padStart(4, '0')}`, turnId: String(messages.length),
            ordinal: messages.length, content: user ? `User says ${session}.${turn / 2}` : `DATASET-ASSISTANT ${session}.${(turn - 1) / 2}`,
            author: user ? { role: 'user', name: 'Test User' } : { role: 'assistant', name: 'Assistant' },
            timestamp: turn === 0 ? `2024-03-0${session + 1}T12:00:00.000Z` : null });
    }
    return messages;
}

// With `--sessions 2 --turns 2` and a failing second session, the run sends only user
// messages 0 and 2: message 4 is beyond plannedTurns, 6 is in the failed session and 8
// in a session outside the plan. Odd messages are dataset assistant replies.
const annotations = [
    ['information_extraction', 3, [0]],
    ['contradiction_resolution', 2, { first_statement: [0], second_statement: ['2'] }],
    ['event_ordering', 1, [[0], [2, [4]]]],
    ['knowledge_update', 1, { original_info: [0], updated_info: [6] }],
    ['temporal_reasoning', 1, { first_event: [8], second_event: [] }],
    ['summarization', 1, [0, 1]],
    ['abstention', 1, undefined],
    ['preference_following', 1, []],
    ['multi_session_reasoning', 1, [0, 999]],
    ['instruction_following', 1, { a: [], b: { c: [] } }],
];
const expectedClasses = ['user_replayed', 'user_replayed', 'not_replayed', 'not_replayed', 'not_replayed', 'needs_assistant', 'no_sources',
    'no_sources', 'unresolved', 'no_sources'];
const ids = annotations.map(([category]) => `7_${category}_0`);

async function prepared(t) {
    const root = await mkdtemp(path.join(tmpdir(), 'beam-questions-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'conversations'));
    await mkdir(path.join(root, 'evaluation'));
    const questions = annotations.map(([category], index) => ({ id: ids[index], text: `Question ${index} about ${category.length} things?` }));
    const evaluation = annotations.map(([category, items, sources], index) => ({ id: ids[index], category, question: questions[index].text,
        rubric: Array.from({ length: items }, (_, item) => `RUBRIC-MARKER ${index}.${item}`),
        annotation: { question: questions[index].text, answer: 'ANSWER-MARKER', rubric: [], ...(sources === undefined ? {} : { source_chat_ids: sources }) } }));
    const runtime = JSON.stringify({ protocol: 'beam-original-v1', id: '7', userIdentity: 'user-7', userTraits: {}, messages: conversation(), questions });
    const evaluationBytes = JSON.stringify(evaluation);
    await writeFile(path.join(root, 'conversations/7.json'), runtime);
    await writeFile(path.join(root, 'evaluation/7.json'), evaluationBytes);
    const cohort = config.cohorts['100k'], manifest = path.join(root, 'manifest.json');
    await writeFile(manifest, JSON.stringify({ protocol: 'beam-original-v1', split: '100k', questionPosition: 'after_complete_conversation',
        datasetRevision: cohort.datasetRevision, sourceFiles: Object.fromEntries(cohort.files.map(file => [file.name, file.sha256])),
        conversations: [{ id: '7', runtime: 'conversations/7.json', runtimeSha256: hash(runtime), questions: questions.length,
            evaluation: 'evaluation/7.json', evaluationSha256: hash(evaluationBytes) }] }));
    return { root, manifest, questions, evaluation };
}

const endpoint = 'https://lambdadb.example', project = 'replay-test';
const message = (request, text) => ({ model: request.model, status: 'completed', usage: { input_tokens: 3, output_tokens: 2 },
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] });
const toolCall = (request, id, name, args) => ({ model: request.model, status: 'completed', usage: { input_tokens: 3, output_tokens: 2 },
    output: [{ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }] });
const verdict = (request, content, overrides = {}) => ({ model: request.model, usage: { prompt_tokens: 10, completion_tokens: 5 },
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], ...overrides });
const scored = score => request => verdict(request, JSON.stringify({ score, reason: `scored ${score}` }));

/** A finished LambdaDB replay on the in-memory fixture: session 0 publishes a note, session 1 fails. */
async function replayed(t) {
    const files = await prepared(t);
    const fixture = fileClient();
    const run = path.join(files.root, 'run');
    const at = { kind: 'fork', name: 'notes' };
    const script = [['fork', { name: 'notes' }], ['write', { at, op: 'create', path: '/notes.md', content: 'Synthetic note.\n' }],
        ['merge', { at, requestId: 'synthetic-1', summary: 'Add a note' }]];
    const replay = await runReplay({ manifest: files.manifest, conversation: '7', output: run, backend: 'lambdadb', mode: 'model', instructions: 'sdk',
        sessions: 2, turns: 2, connect: () => ({ client: fixture.client, endpoint, project }),
        askFactory: () => async (request, { session, turn, round }) => {
            if (session === 1) throw new Error('offline');
            return turn === 0 && round < script.length ? toolCall(request, `call-${round}`, ...script[round]) : message(request, 'ok');
        } });
    assert.deepEqual(replay.summary.sessions.map(session => [session.id, session.status, session.metrics.userTurns]), [['s000', 'completed', 2], ['s001', 'failed', 1]]);
    // A new client object, as in a separate process: the stage opens the store cold.
    const connect = () => ({ client: { ...fixture.client }, endpoint, project });
    const counts = { ask: 0, judge: 0 };
    const stage = (name, options = {}) => runQuestions({ run, manifest: files.manifest, output: path.join(files.root, name), connect,
        ask: async request => { counts.ask++; return message(request, 'answer'); },
        judge: async request => { counts.judge++; return scored(1)(request); }, ...options });
    return { ...files, fixture, run, replay, connect, stage, counts };
}

test('source IDs flatten generically and every question is classified against what the run sent', async t => {
    assert.deepEqual(flattenSourceIds({ a: [1, [2, { b: '3' }]], c: [] }), ['1', '2', '3']);
    assert.deepEqual(flattenSourceIds(undefined), []);
    for (const invalid of [[null], [1.5], [''], [true]]) assert.throws(() => flattenSourceIds(invalid), /Unsupported source_chat_ids/);

    const { stage, counts } = await replayed(t);
    const { manifest, summary } = await stage('replayed');
    assert.deepEqual(manifest.classification.map(question => question.class), expectedClasses);
    assert.deepEqual(manifest.classification.map(question => question.id), ids);
    const sources = Object.fromEntries(manifest.classification.map(question => [question.id, question.sources]));
    assert.deepEqual(sources['7_event_ordering_0'], [{ turnId: '0', sourceId: '7_s000_t0000', role: 'user', sent: true },
        { turnId: '2', sourceId: '7_s000_t0002', role: 'user', sent: true }, { turnId: '4', sourceId: '7_s000_t0004', role: 'user', sent: false }]);
    assert.deepEqual(sources['7_knowledge_update_0'][1], { turnId: '6', sourceId: '7_s001_t0000', role: 'user', sent: false });
    assert.deepEqual(sources['7_multi_session_reasoning_0'][1], { turnId: '999', sourceId: null, role: null, sent: false });
    assert.deepEqual(sources['7_abstention_0'], []);
    assert.deepEqual(summary.questions.byClass, { needs_assistant: 1, no_sources: 3, not_replayed: 3, unresolved: 1, user_replayed: 2 });
    assert.deepEqual(summary.questions.byCategory.event_ordering, { not_replayed: 1 });
    assert.equal(summary.questions.total, 10);

    // replayed (default) asks user_replayed and no_sources; all adds the other answerable classes.
    const byIndex = indexes => indexes.map(index => ids[index]);
    assert.deepEqual(manifest.selected, byIndex([0, 1, 6, 7, 9]));
    assert.equal(counts.ask, 5);
    assert.deepEqual((await stage('all', { scope: 'all' })).manifest.selected, byIndex([0, 1, 2, 3, 4, 5, 6, 7, 9]));
    const limited = await stage('limited', { limit: 2 });
    assert.deepEqual([limited.manifest.selected, limited.manifest.limit, limited.results.length], [byIndex([0, 1]), 2, 2]);
    await assert.rejects(stage('scope', { scope: 'unresolved' }), /--scope replayed or all/);
    await assert.rejects(stage('limit', { limit: 0 }), /positive integer/);
});

test('each question is a fresh read-only conversation with the run instructions and the verbatim question only', async t => {
    const files = await replayed(t);
    const requests = [];
    const { manifest, results, summary } = await files.stage('requests', { ask: async (request, context) => {
        requests.push({ request: structuredClone(request), context });
        // The first question searches once before answering.
        return context.session === 0 && context.round === 0 ? toolCall(request, 'search-1', 'search', { query: 'note' }) : message(request, `Answer ${context.session}`);
    } });
    const definitions = getFileToolDefinitions({ embeddingMode: 'managed', tools: readToolNames });
    assert.deepEqual([...readToolNames], ['guide', 'status', 'history', 'list', 'read', 'search', 'findText', 'listForks', 'listCheckpoints']);
    assert.deepEqual([manifest.tools, manifest.toolDefinitions, manifest.model, manifest.judgeModel], [readToolNames, definitions, 'gpt-6.1-sol', defaultJudgeModel]);
    assert.equal(manifest.instructions.sha256, hash(fileToolInstructions));
    assert.equal(files.replay.manifest.instructions.text, fileToolInstructions);
    const texts = Object.fromEntries(files.questions.map(question => [question.id, question.text]));
    assert.deepEqual(requests.map(({ context }) => [context.session, context.turn, context.round]), [[0, 0, 0], [0, 0, 1], [1, 0, 0], [2, 0, 0], [3, 0, 0], [4, 0, 0]]);
    for (const { request, context } of requests) {
        assert.deepEqual(Object.keys(request), ['model', 'reasoning', 'store', 'include', 'parallel_tool_calls', 'max_output_tokens', 'tools', 'input']);
        assert.deepEqual(request.tools, definitions.map(tool => ({ type: 'function', name: tool.name, description: tool.description,
            parameters: tool.inputSchema, strict: false })));
        assert.deepEqual(request.input.slice(0, 2), [{ role: 'developer', content: fileToolInstructions },
            { role: 'user', content: texts[manifest.selected[context.session]] }]);
        const body = JSON.stringify(request);
        for (const hidden of ['RUBRIC-MARKER', 'ANSWER-MARKER', 'source_chat_ids', 'DATASET-ASSISTANT', 'User says']) assert(!body.includes(hidden), hidden);
    }
    assert.equal(requests[0].request.input.length, 2);
    assert.equal(requests[1].request.input.at(-1).type, 'function_call_output');
    assert.deepEqual(results.map(result => result.answer), ['Answer 0', 'Answer 1', 'Answer 2', 'Answer 3', 'Answer 4']);
    assert.deepEqual([results[0].metrics.toolCallsByName, results[0].metrics.retrievalCall, results[1].metrics.retrievalCall], [{ search: 1 }, true, false]);
    assert.deepEqual([summary.retrieval, summary.measured], [{ questionsWithRetrievalCall: 1, toolCallsByName: { search: 1 } }, false]);
    const directory = path.join(files.root, 'requests', `question-001-${ids[0]}`);
    assert.deepEqual((await jsonl(path.join(directory, 'events.jsonl'))).map(event => [event.name, event.ok, typeof event.elapsedMs]), [['search', true, 'number']]);
    assert.deepEqual(await jsonl(path.join(directory, 'transcript.jsonl')), requests[1].request.input.concat(message(requests[1].request, 'Answer 0').output));
    assert.equal((await jsonl(path.join(directory, 'requests.jsonl'))).length, 4);

    // A run without instructions asks with the question alone.
    const none = { ...files.replay.manifest.instructions, source: 'none', text: null, sha256: null };
    const runManifest = await json(path.join(files.run, 'manifest.json'));
    await writeFile(path.join(files.run, 'manifest.json'), JSON.stringify({ ...runManifest, instructions: none }));
    const bare = [];
    await files.stage('bare', { limit: 1, ask: async request => { bare.push(request.input); return message(request, 'a'); } });
    assert.deepEqual(bare, [[{ role: 'user', content: files.questions[0].text }]]);
});

const refsAndFiles = async drive => {
    const history = [];
    for (let page = await drive.history({ limit: 100 }); ; page = await drive.history(page.next)) {
        history.push(...page.entries);
        if (!page.next) break;
    }
    return JSON.stringify({ main: (await drive.status()).mainVersion, history: history.length, forks: await drive.listForks(),
        checkpoints: await drive.listCheckpoints(), mainFile: await drive.read({ path: '/notes.md' }),
        forkFile: await drive.read({ at: { kind: 'fork', name: 'notes' }, path: '/notes.md' }) });
};

test('the stage leaves the store byte-for-byte unchanged, also when the model calls a tool it was not offered', async t => {
    const files = await replayed(t);
    const at = { kind: 'fork', name: 'notes' };
    const drive = await MemDrive.open({ client: files.fixture.client, name: files.replay.manifest.store.name });
    const state = () => JSON.stringify([...files.fixture.collections], (key, value) => value instanceof Map ? [...value] : value);
    const before = { state: state(), sdk: await refsAndFiles(drive), calls: files.fixture.calls.length };
    assert(JSON.parse(before.sdk).mainFile.content.includes('Synthetic note.'));
    const script = [['write', { at, op: 'create', path: '/x.md', content: 'x' }], ['merge', { at, requestId: 'x', summary: 'x' }], ['fork', { name: 'other' }],
        ['deleteFork', { at }], ['checkpoint', { at, name: 'c' }], ['list', {}], ['read', { path: '/notes.md' }], ['findText', { query: 'note' }],
        ['listCheckpoints', {}], ['history', {}], ['guide', {}]];
    const outputs = [];
    const { results, summary } = await files.stage('unchanged', { limit: 1, ask: async (request, { round }) => {
        const last = request.input.at(-1);
        if (last.type === 'function_call_output') outputs.push(JSON.parse(last.output));
        return round < script.length ? toolCall(request, `call-${round}`, ...script[round]) : message(request, 'done');
    } });
    assert.deepEqual(outputs.slice(0, 5).map(output => output.error?.code), Array(5).fill('TOOL_NOT_ALLOWED'));
    assert.deepEqual(results[0].metrics.toolErrorsByCode, { TOOL_NOT_ALLOWED: 5 });
    assert.equal(results[0].metrics.retrievalCall, true);
    assert.equal(state(), before.state);
    assert.equal(await refsAndFiles(drive), before.sdk);
    const writes = new Set(['collection-update', 'collection-delete', 'branch-create', 'branch-delete', 'tag-create', 'tag-delete', 'upsert', 'update', 'delete']);
    assert.deepEqual(files.fixture.calls.slice(before.calls).filter(call => writes.has(call.kind)), []);
    assert(files.fixture.calls.length > before.calls, 'The stage did read the store');
    assert.equal(summary.store.unchanged, true);
    assert.deepEqual(summary.store.before.forks, ['notes']);
});

test('judging follows the upstream per-rubric-item prompt and reports means with their counts', async t => {
    const files = await replayed(t);
    // Responses per dataset question index and rubric item. Question 7 fails before judging.
    const responses = { 0: [scored(1), scored(0.5), scored(0)],
        1: [scored(1), request => verdict(request, '{"score": 1, "reason": "trailing comma",}')],
        6: [request => ({ ...scored(1)(request), model: 'gpt-4.1-mini' })],
        9: [request => verdict(request, '```json\n{"score": 1.0, "reason": "fenced"}\n```')] };
    const seen = [];
    const { results, summary } = await files.stage('judged', {
        ask: async (request, { session }) => {
            if (session === 3) throw new Error('offline');
            return message(request, `Answer ${session} $& <rubric_item>`);
        },
        judge: async request => {
            const [, question, item] = /RUBRIC-MARKER (\d+)\.(\d+)/.exec(request.messages[0].content).map(Number);
            seen.push({ request, question, item });
            return responses[question][item](request);
        } });
    assert.deepEqual(seen.map(({ question, item }) => [question, item]), [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [6, 0], [9, 0]]);
    for (const { request, question, item } of seen) {
        const answer = `Answer ${[0, 1, 6, 7, 9].indexOf(question)} $& <rubric_item>`;
        // Python's chained str.replace: the rubric item first, then the response; QUESTION stays as written.
        const content = judgePrompt.split('<rubric_item>').join(`RUBRIC-MARKER ${question}.${item}`).split('<llm_response>').join(answer);
        assert.deepEqual(request, { model: defaultJudgeModel, temperature: 0, messages: [{ role: 'user', content }] });
        assert(content.includes('the QUESTION') && !content.includes(files.questions[question].text));
    }
    assert.deepEqual(results.map(result => [result.id, result.status, result.error?.code, result.judge?.status ?? null, result.score]), [
        [ids[0], 'answered', undefined, 'judged', 0.5],
        [ids[1], 'answered', undefined, 'failed', null],
        [ids[6], 'answered', undefined, 'failed', null],
        [ids[7], 'failed', 'MODEL_REQUEST_FAILED', null, null],
        [ids[9], 'answered', undefined, 'judged', 1]]);
    assert.deepEqual(results[1].judge.items.map(item => [item.status, item.score, item.code]), [['scored', 1, undefined], ['failed', undefined, 'JUDGE_OUTPUT_INVALID']]);
    assert.equal(results[2].judge.items[0].code, 'JUDGE_IDENTITY_MISMATCH');
    const log = await jsonl(path.join(files.root, 'judged', `question-001-${ids[0]}`, 'judge.jsonl'));
    assert.deepEqual(log.map(entry => [entry.index, entry.rubricItem, entry.status, entry.score, entry.reason, entry.usage.prompt_tokens, typeof entry.elapsedMs]),
        [[0, 'RUBRIC-MARKER 0.0', 'scored', 1, 'scored 1', 10, 'number'], [1, 'RUBRIC-MARKER 0.1', 'scored', 0.5, 'scored 0.5', 10, 'number'],
            [2, 'RUBRIC-MARKER 0.2', 'scored', 0, 'scored 0', 10, 'number']]);
    assert.equal(await exists(path.join(files.root, 'judged', `question-004-${ids[7]}`, 'judge.jsonl')), false, 'A failed question is not judged');

    const stats = (asked, failed, judged, meanOverJudged) => ({ asked, answered: asked - failed, failed, judged, unjudged: asked - judged, meanOverJudged });
    assert.deepEqual(summary.scores, { overall: stats(5, 1, 2, 0.75),
        byClass: { no_sources: stats(3, 1, 1, 1), user_replayed: stats(2, 0, 1, 0.5) },
        byCategory: { abstention: stats(1, 0, 0, null), contradiction_resolution: stats(1, 0, 0, null), information_extraction: stats(1, 0, 1, 0.5),
            instruction_following: stats(1, 0, 1, 1), preference_following: stats(1, 1, 0, null) } });
    assert.deepEqual(summary.tokens.judge, { requests: 7, failedRequests: 2, prompt: 70, completion: 35, unknownUsageRequests: 0 });
    assert.deepEqual([summary.questions.selected, summary.questions.asked, summary.questions.complete], [5, 5, true]);
    assert(summary.limitations.some(text => text.includes('event_ordering') && text.includes('Kendall')));
    assert.deepEqual(await json(path.join(files.root, 'judged', 'summary.json')), JSON.parse(JSON.stringify(summary)));
});

test('the judge parser follows upstream without repairing JSON, and scores need every rubric item', async () => {
    assert.deepEqual(parseJudgeOutput(' {"score": 0.5, "reason": "partly"} '), { score: 0.5, reason: 'partly' });
    assert.deepEqual(parseJudgeOutput('```\n{"score": 0.0}\n```'), { score: 0, reason: null });
    assert.deepEqual(parseJudgeOutput('Verdict: {"score": 1, "reason": "embedded"} done'), { score: 1, reason: 'embedded' });
    for (const invalid of ['{"score": 1,}', '{"score": "1.0"}', '{"score": 0.7}', '[{"score": 1}]', 'score: 1', '', '{"reason": "none"}'])
        assert.equal(parseJudgeOutput(invalid), null, invalid);
    assert.equal(questionScore([]), null);
    assert.equal(questionScore([{ status: 'scored', score: 1 }, { status: 'scored', score: 0 }]), 0.5);
    assert.equal(questionScore([{ status: 'scored', score: 1 }, { status: 'failed' }]), null);
    const records = [{ class: 'a', category: 'x', status: 'answered', score: 1 }, { class: 'a', category: 'y', status: 'answered', score: 0 },
        { class: 'b', category: 'x', status: 'answered', score: null }, { class: 'b', category: 'x', status: 'failed', score: null }];
    assert.deepEqual(scoreSummary(records), {
        overall: { asked: 4, answered: 3, failed: 1, judged: 2, unjudged: 2, meanOverJudged: 0.5 },
        byClass: { a: { asked: 2, answered: 2, failed: 0, judged: 2, unjudged: 0, meanOverJudged: 0.5 },
            b: { asked: 2, answered: 1, failed: 1, judged: 0, unjudged: 2, meanOverJudged: null } },
        byCategory: { x: { asked: 3, answered: 2, failed: 1, judged: 1, unjudged: 2, meanOverJudged: 1 },
            y: { asked: 1, answered: 1, failed: 0, judged: 1, unjudged: 0, meanOverJudged: 0 } } });
    assert.deepEqual(classCounts([{ class: 'a', category: 'x' }, { class: 'b', category: 'x' }, { class: 'a', category: 'y' }]),
        { total: 3, byClass: { a: 2, b: 1 }, byCategory: { x: { a: 1, b: 1 }, y: { a: 1 } } });

    // Transport and response failures are recorded per item without bodies or retries.
    let calls = 0;
    const judge = respond => judgeItem({ judge: async request => { calls++; return respond(request); }, model: defaultJudgeModel, item: 'i', answer: 'a', clock: () => 0 });
    assert.deepEqual(await judge(() => { throw Object.assign(new Error('secret body'), { code: 'MODEL_HTTP_ERROR', status: 429 }); }),
        { status: 'failed', code: 'JUDGE_REQUEST_FAILED', elapsedMs: 0, httpStatus: 429 });
    assert.equal((await judge(request => ({ ...scored(1)(request), usage: {} }))).code, 'JUDGE_USAGE_INVALID');
    assert.equal((await judge(request => verdict(request, '{"score": 1}', { choices: [{ finish_reason: 'length', message: { content: '{"score": 1}' } }] }))).code,
        'JUDGE_RESPONSE_INVALID');
    assert.deepEqual(await judge(scored(0.5)), { status: 'scored', score: 0.5, reason: 'scored 0.5', model: defaultJudgeModel,
        usage: { prompt_tokens: 10, completion_tokens: 5 }, content: '{"score":0.5,"reason":"scored 0.5"}', elapsedMs: 0 });
    assert.equal(calls, 4);
});

test('stored answers are judged again without asking, and agreement is counted per rubric item', async t => {
    const files = await replayed(t);
    // The original stage: question 0 scores [1, 0.5, 0], every other item 1; question 7 is never answered.
    const original = { 0: [1, 0.5, 0] };
    const marker = request => /RUBRIC-MARKER (\d+)\.(\d+)/.exec(request.messages[0].content).slice(1).map(Number);
    const first = await files.stage('first', {
        ask: async (request, { session }) => { if (session === 3) throw new Error('offline'); return message(request, `Stored answer ${session}`); },
        judge: async request => { const [question, item] = marker(request); return scored(original[question]?.[item] ?? 1)(request); } });
    const asked = files.counts.ask;
    assert.deepEqual(first.results.map(result => result.status), ['answered', 'answered', 'answered', 'failed', 'answered']);

    // Repeat 0 agrees with the original; repeat 1 changes item 0.1 and fails on item 1.0.
    const calls = new Map(), requests = [];
    const again = await runRejudge({ answers: path.join(files.root, 'first'), manifest: files.manifest, output: path.join(files.root, 'again'),
        judgeModel: 'stronger-judge', repeats: 2, judge: async request => {
            requests.push(request);
            const [question, item] = marker(request), key = `${question}.${item}`, repeat = calls.get(key) ?? 0;
            calls.set(key, repeat + 1);
            if (repeat === 1 && key === '1.0') return verdict(request, 'not json');
            return scored(repeat === 1 && key === '0.1' ? 1 : original[question]?.[item] ?? 1)(request);
        } });
    assert.equal(files.counts.ask, asked, 'Rejudging asks nothing');
    assert(requests.every(request => request.model === 'stronger-judge' && request.temperature === 0 && !('reasoning_effort' in request)
        && /Stored answer \d/.test(request.messages[0].content)));
    assert.deepEqual(again.results.map(result => [result.id, result.originalScore, result.scores]), [
        [ids[0], 0.5, [0.5, 2 / 3]], [ids[1], 1, [1, null]], [ids[6], 1, [1, 1]], [ids[9], 1, [1, 1]]]);
    const summary = await json(path.join(files.root, 'again', 'summary.json'));
    assert.deepEqual(summary, JSON.parse(JSON.stringify(again.summary)));
    // Seven rubric items: one failed in a repeat, one changed between repeats, five stable and equal to the original.
    assert.deepEqual(summary.agreement, { items: 7, scored: 6, stable: 5, unstable: 1, comparable: 5, sameAsOriginal: 5 });
    assert.deepEqual([summary.measured, summary.originalJudgeModel, summary.judgeModel, summary.repeats, summary.questions],
        [false, defaultJudgeModel, 'stronger-judge', 2, { stored: 4, judged: 4, complete: true }]);
    assert.deepEqual(summary.scores, { original: { questions: 4, mean: 0.875 },
        repeats: [{ questions: 4, mean: 0.875 }, { questions: 3, mean: (2 / 3 + 2) / 3 }] });
    assert.deepEqual(summary.differing.map(item => [item.id, item.index, item.original, item.scores]), [[ids[0], 1, 0.5, [0.5, 1]], [ids[1], 0, 1, [1, null]]]);
    assert.deepEqual([summary.tokens.requests, summary.tokens.failedRequests], [14, 1]);
    assert.deepEqual((await jsonl(path.join(files.root, 'again', `question-001-${ids[0]}`, 'judge.jsonl'))).map(item => [item.repeat, item.index, item.score]),
        [[0, 0, 1], [0, 1, 0.5], [0, 2, 0], [1, 0, 1], [1, 1, 1], [1, 2, 0]]);

    assert.deepEqual(judgeAgreement([{ original: null, scores: [1, 1] }, { original: 0, scores: [1, 1] }, { original: 1, scores: [null] }]),
        { items: 3, scored: 2, stable: 2, unstable: 0, comparable: 1, sameAsOriginal: 0 });
    const reject = (options, message) => assert.rejects(runRejudge({ answers: path.join(files.root, 'first'), manifest: files.manifest,
        output: path.join(files.root, 'rejected'), judge: scored(1), ...options }), message);
    await reject({ answers: files.run }, /question-stage output/);
    await reject({ repeats: 0 }, /repeats/);
    await reject({ judgeEffort: 'extreme' }, /judge-effort/);
    // A reasoning judge rejects temperature 0: the effort replaces it and is recorded.
    const efforts = [];
    const reasoned = await runRejudge({ answers: path.join(files.root, 'first'), manifest: files.manifest, output: path.join(files.root, 'reasoned'),
        judgeModel: 'reasoning-judge', judgeEffort: 'high', judge: async request => { efforts.push(request); return scored(1)(request); } });
    assert(efforts.length === 7 && efforts.every(request => request.reasoning_effort === 'high' && !('temperature' in request)));
    assert.deepEqual([reasoned.manifest.judgeRequest, reasoned.summary.judgeRequest],
        [{ reasoning_effort: 'high', perRubricItem: true, retries: 0 }, { reasoning_effort: 'high', perRubricItem: true, retries: 0 }]);
    await reject({ output: path.join(files.root, 'again') }, { code: 'EEXIST' });
    await writeFile(path.join(files.root, 'evaluation', '7.json'), '[]');
    await reject({}, /Prepared evaluation differs/);
    assert.equal(await exists(path.join(files.root, 'rejected')), false);
});

test('the stored judge prompt is the pinned upstream text with two placeholders', async () => {
    const stored = JSON.parse(await readFile(new URL('../benchmark/beam/original-judge-prompt.json', import.meta.url), 'utf8'));
    assert.deepEqual(Object.keys(stored), ['upstreamRevision', 'upstreamFile', 'upstreamFileSha256', 'unified_llm_judge_base_prompt']);
    assert.deepEqual([stored.upstreamRevision, stored.upstreamFileSha256], [config.upstream.revision, config.upstream.files['src/prompts.py']]);
    // Pinned when the prompt was copied from upstream src/prompts.py at that revision.
    assert.equal(hash(stored.unified_llm_judge_base_prompt), '593373c642a288a7b590577d8a8fc92c3f9a2b70e2f64ad6e59a040a6c56b7f5');
    assert.equal(judgePromptSha256, '593373c642a288a7b590577d8a8fc92c3f9a2b70e2f64ad6e59a040a6c56b7f5');
    assert.equal(judgePrompt, stored.unified_llm_judge_base_prompt);
    assert.deepEqual(['<rubric_item>', '<llm_response>', '<question>'].map(marker => judgePrompt.split(marker).length - 1), [1, 1, 0]);
});

test('runs without a retained store, ledgers from elsewhere and existing outputs are rejected before any model request', async t => {
    const files = await replayed(t);
    const rejected = async (name, options, pattern) => {
        await assert.rejects(files.stage(name, options), pattern);
        assert.equal(await exists(path.join(files.root, name)), false, name);
    };
    const fixtureRun = path.join(files.root, 'fixture-run');
    await runReplay({ manifest: files.manifest, conversation: '7', output: fixtureRun, mode: 'scripted', instructions: 'none', sessions: 1 });
    await rejected('from-fixture', { run: fixtureRun }, /fixture run keeps no store/);
    await rejected('other-endpoint', { connect: () => ({ ...files.connect(), endpoint: 'https://other.example' }) }, /another endpoint\/project/);
    await rejected('other-project', { connect: () => ({ ...files.connect(), project: 'other' }) }, /another endpoint\/project/);
    await rejected('no-key', { ask: undefined }, /Missing LLM_API_KEY/);
    await rejected('no-judge-key', { judge: undefined }, /Missing LLM_API_KEY/);
    await rejected('no-lambdadb', { connect: undefined, env: {} }, /Missing LambdaDB configuration/);
    const existing = path.join(files.root, 'existing');
    await mkdir(existing);
    await assert.rejects(files.stage('existing'), { code: 'EEXIST' });

    // Prepared data must be the bytes the run recorded, and the store must still be owned.
    const manifest = await readFile(files.manifest, 'utf8');
    await writeFile(files.manifest, manifest + '\n');
    await rejected('changed-manifest', {}, /Prepared manifest differs from the run/);
    await writeFile(files.manifest, manifest);
    const ledger = await json(path.join(files.run, 'store.json'));
    files.fixture.collections.get(ledger.name).metadata.tags['beam.owner'] = '00000000-0000-4000-8000-000000000000';
    await rejected('other-owner', {}, /owner differs/);
    files.fixture.collections.get(ledger.name).metadata.tags['beam.owner'] = ledger.labels['beam.owner'];
    await writeFile(path.join(files.run, 'store.json'), JSON.stringify({ ...ledger, status: 'cleaned' }));
    await rejected('cleaned', {}, /not ready or was cleaned up/);
    assert.deepEqual(files.counts, { ask: 0, judge: 0 });
});
