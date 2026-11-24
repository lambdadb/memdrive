// Ask a finished replay's BEAM probing questions against the LambdaDB store it kept, and
// judge each answer with upstream BEAM's per-rubric-item prompt. This stage is the only
// reader of the evaluation annotations. It offers the model read tools only, and the
// harness itself only reads: nothing writes, merges, forks or deletes in the store.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { MemDrive, getFileToolDefinitions } from '@functional-systems/memdrive';
import { createToolHost, failureCodes, limits, openAI, protocol as replayProtocol, ReplayFailure, runSession } from './replay-agent.mjs';
import { fingerprint, groupSessions, hash } from './replay-sessions.mjs';
import { assertOwner, lambdadbConnection, ledgerFile, readLedger } from './replay-store.mjs';

export const questionsProtocol = 'memdrive-beam-replay-questions-v1';
export const readToolNames = Object.freeze(['guide', 'status', 'history', 'list', 'read', 'search', 'findText', 'listForks', 'listCheckpoints']);
export const defaultJudgeModel = 'gpt-4.1-mini-2025-04-14';
// `unresolved` questions cite a message ID the conversation lacks and are never asked.
const scopes = { replayed: ['user_replayed', 'no_sources'], all: ['user_replayed', 'no_sources', 'needs_assistant', 'not_replayed'] };
const retrievalTools = new Set(['search', 'read', 'findText']);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const json = value => JSON.stringify(value, null, 2) + '\n';
const privateFile = { mode: 0o600 };
const readJSON = async file => JSON.parse(await readFile(file, 'utf8'));
const tally = (items, key) => {
    const result = {};
    for (const item of items) result[key(item)] = (result[key(item)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
};
const sumMaps = maps => {
    const result = {};
    for (const map of maps) for (const [key, value] of Object.entries(map)) result[key] = (result[key] ?? 0) + value;
    return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
};
const sum = (items, value) => items.reduce((total, item) => total + value(item), 0);

// The judge prompt is upstream `unified_llm_judge_base_prompt`, copied byte for byte from
// `src/prompts.py` at the pinned revision; its text hash is pinned here.
const config = await readJSON(new URL('./original-config.json', import.meta.url));
const judgeSource = await readJSON(new URL('./original-judge-prompt.json', import.meta.url));
export const judgePromptSha256 = '593373c642a288a7b590577d8a8fc92c3f9a2b70e2f64ad6e59a040a6c56b7f5';
export const judgePrompt = judgeSource.unified_llm_judge_base_prompt;
assert.equal(judgeSource.upstreamRevision, config.upstream.revision, 'Judge prompt revision differs from the pinned upstream');
assert.equal(judgeSource.upstreamFileSha256, config.upstream.files[judgeSource.upstreamFile], 'Judge prompt source file is not pinned');
assert.equal(hash(judgePrompt), judgePromptSha256, 'The stored judge prompt changed');

/** Every number or string inside nested arrays and objects, in order, as turn IDs. */
export function flattenSourceIds(value) {
    if (value === undefined) return [];
    if (Array.isArray(value)) return value.flatMap(flattenSourceIds);
    if (value !== null && typeof value === 'object') return Object.values(value).flatMap(flattenSourceIds);
    assert(Number.isSafeInteger(value) || (typeof value === 'string' && value !== ''), 'Unsupported source_chat_ids value');
    return [String(value)];
}

/** Turn IDs of the user utterances a run sent: in completed sessions only, up to the utterances it reported. */
export function sentTurnIds(sessions, plan, results) {
    const sent = new Set();
    for (const entry of plan) {
        const result = results.find(session => session.id === entry.id);
        if (result?.status !== 'completed') continue;
        for (const turn of sessions[entry.index].turns.slice(0, Math.min(entry.plannedTurns, result.metrics.userTurns))) sent.add(turn.turnId);
    }
    return sent;
}

/**
 * Classify every question by its evidence messages (`annotation.source_chat_ids`, matched to
 * runtime `turnId`s): `no_sources`, `unresolved` (an ID matching no message or several),
 * `needs_assistant` (a dataset assistant message, never sent by the replay), `not_replayed`
 * (a user message the run did not send) or `user_replayed`.
 */
export function classifyQuestions(messages, evaluation, sent) {
    const byTurn = new Map();
    for (const message of messages) byTurn.set(message.turnId, [...(byTurn.get(message.turnId) ?? []), message]);
    return evaluation.map(({ id, category, annotation }) => {
        const sources = flattenSourceIds(annotation?.source_chat_ids).map(turnId => {
            const found = byTurn.get(turnId) ?? [];
            return found.length === 1 ? { turnId, sourceId: found[0].sourceId, role: found[0].author.role, sent: sent.has(turnId) }
                : { turnId, sourceId: null, role: null, sent: false };
        });
        const kind = !sources.length ? 'no_sources' : sources.some(source => source.sourceId === null) ? 'unresolved'
            : sources.some(source => source.role === 'assistant') ? 'needs_assistant'
                : sources.every(source => source.sent) ? 'user_replayed' : 'not_replayed';
        return { id, category, class: kind, sources };
    });
}

/** The questions a scope asks, in dataset order, optionally only the first `limit`. */
export function selectQuestions(classified, scope = 'replayed', limit) {
    assert(Object.hasOwn(scopes, scope), 'Use --scope replayed or all');
    assert(limit === undefined || (Number.isSafeInteger(limit) && limit >= 1), 'limit must be a positive integer');
    return classified.filter(question => scopes[scope].includes(question.class)).slice(0, limit);
}

/** Upstream's substitution order: the rubric item, then the response. The QUESTION is never substituted upstream. */
export const judgeRequest = (model, item, answer) => ({ model, temperature: 0, messages: [{ role: 'user',
    content: judgePrompt.replaceAll('<rubric_item>', () => item).replaceAll('<llm_response>', () => answer) }] });

/**
 * Upstream `parse_json_response`: an optional code fence, then the whole text as JSON, then
 * the first embedded object or array. Upstream's `json_repair` fallback is not applied: any
 * other text, or a score other than exactly 1, 0.5 or 0, is invalid (null).
 */
export function parseJudgeOutput(text) {
    let body = text.trim();
    if (body.startsWith('```')) {
        const fenced = /```(?:json)?\s*(\[[\s\S]*\]|\{[\s\S]*\})\s*```/.exec(body);
        if (fenced) body = fenced[1].trim();
    }
    let value;
    try { value = JSON.parse(body); } catch {
        const embedded = /(\{[\s\S]*?\}|\[[\s\S]*?\])/.exec(body);
        if (!embedded) return null;
        try { value = JSON.parse(embedded[1]); } catch { return null; }
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value) || ![1, 0.5, 0].includes(value.score)) return null;
    return { score: value.score, reason: typeof value.reason === 'string' ? value.reason : null };
}

/** One Chat Completions judge request for one rubric item, without retry. Never records error bodies. */
export async function judgeItem({ judge, model, item, answer, clock = () => performance.now() }) {
    const started = clock();
    let response;
    try { response = await judge(judgeRequest(model, item, answer), {}); } catch (error) {
        return { status: 'failed', code: 'JUDGE_REQUEST_FAILED', elapsedMs: clock() - started,
            ...(error?.code === 'MODEL_HTTP_ERROR' && Number.isInteger(error.status) ? { httpStatus: error.status } : {}) };
    }
    const elapsedMs = clock() - started;
    const usage = response?.usage ?? null, content = response?.choices?.[0]?.message?.content;
    const outcome = { model: response?.model ?? null, usage, content: typeof content === 'string' ? content : null, elapsedMs };
    const fail = code => ({ status: 'failed', code, ...outcome });
    if (response?.model !== model) return fail('JUDGE_IDENTITY_MISMATCH');
    if (!['prompt_tokens', 'completion_tokens'].every(key => Number.isSafeInteger(usage?.[key]) && usage[key] >= 0)) return fail('JUDGE_USAGE_INVALID');
    if (!Array.isArray(response.choices) || response.choices.length !== 1 || response.choices[0].finish_reason !== 'stop'
        || typeof content !== 'string') return fail('JUDGE_RESPONSE_INVALID');
    const parsed = parseJudgeOutput(content);
    return parsed ? { status: 'scored', ...parsed, ...outcome } : fail('JUDGE_OUTPUT_INVALID');
}

/** The mean over a question's rubric items, or null unless every item was scored. */
export const questionScore = items => items.length && items.every(item => item.status === 'scored')
    ? sum(items, item => item.score) / items.length : null;

function scoreStats(records) {
    const judged = records.filter(record => record.score !== null);
    const failed = records.filter(record => record.status === 'failed').length;
    return { asked: records.length, answered: records.length - failed, failed, judged: judged.length, unjudged: records.length - judged.length,
        meanOverJudged: judged.length ? sum(judged, record => record.score) / judged.length : null };
}

/**
 * Judge scores of the asked questions, overall, per class and per category. Each mean is over
 * judged questions only; `failed` (not answered) and `unjudged` (failed or with a failed
 * judge request) give what it leaves out. `records`: { class, category, status, score }.
 */
export function scoreSummary(records) {
    const group = key => Object.fromEntries([...new Set(records.map(record => record[key]))].sort()
        .map(value => [value, scoreStats(records.filter(record => record[key] === value))]));
    return { overall: scoreStats(records), byClass: group('class'), byCategory: group('category') };
}

/** Class counts of every question, overall and per category. */
export function classCounts(classified) {
    const categories = [...new Set(classified.map(question => question.category))].sort();
    return { total: classified.length, byClass: tally(classified, question => question.class),
        byCategory: Object.fromEntries(categories.map(category => [category,
            tally(classified.filter(question => question.category === category), question => question.class)])) };
}

const validUsage = usage => ['input_tokens', 'output_tokens'].every(key => Number.isSafeInteger(usage?.[key]) && usage[key] >= 0);
function answerMetrics({ requests, events }) {
    return { modelRequests: requests.length, inputTokens: sum(requests, request => validUsage(request.usage) ? request.usage.input_tokens : 0),
        outputTokens: sum(requests, request => validUsage(request.usage) ? request.usage.output_tokens : 0),
        unknownUsageRequests: requests.filter(request => !validUsage(request.usage)).length,
        toolCalls: events.length, toolCallsByName: tally(events, event => event.name),
        toolErrorsByCode: tally(events.filter(event => !event.ok), event => event.error?.code ?? 'UNKNOWN'),
        retrievalCall: events.some(event => retrievalTools.has(event.name)) };
}

/** The final assistant text: every output_text part of the last response, in order. */
const finalText = response => response.output.filter(item => item.type === 'message' && item.role === 'assistant')
    .flatMap(item => item.content.map(part => part.text)).join('\n\n');

const refState = async drive => ({ mainVersion: (await drive.status()).mainVersion,
    forks: (await drive.listForks()).forks.map(fork => fork.at.name), checkpoints: (await drive.listCheckpoints()).checkpoints.map(ref => ref.at.name) });

export function summarizeQuestions(manifest, results, store = null) {
    const judgeItems = results.flatMap(result => result.judge?.items ?? []);
    const judgeUsage = judgeItems.filter(item => ['prompt_tokens', 'completion_tokens'].every(key => Number.isSafeInteger(item.usage?.[key])));
    const measured = manifest.transport === 'openai-responses' && manifest.judgeTransport === 'openai-chat-completions';
    return { protocol: questionsProtocol, transport: manifest.transport, judgeTransport: manifest.judgeTransport, measured,
        conversationId: manifest.source.conversationId, run: manifest.run.directory, scope: manifest.scope, limit: manifest.limit,
        model: manifest.model, judgeModel: manifest.judgeModel,
        questions: { ...classCounts(manifest.classification), selected: manifest.selected.length, asked: results.length,
            complete: results.length === manifest.selected.length },
        scores: scoreSummary(results),
        retrieval: { questionsWithRetrievalCall: results.filter(result => result.metrics.retrievalCall).length,
            toolCallsByName: sumMaps(results.map(result => result.metrics.toolCallsByName)) },
        tokens: { answer: { input: sum(results, result => result.metrics.inputTokens), output: sum(results, result => result.metrics.outputTokens),
            unknownUsageRequests: sum(results, result => result.metrics.unknownUsageRequests) },
        judge: { requests: judgeItems.length, failedRequests: judgeItems.filter(item => item.status === 'failed').length,
            prompt: sum(judgeUsage, item => item.usage.prompt_tokens), completion: sum(judgeUsage, item => item.usage.completion_tokens),
            unknownUsageRequests: judgeItems.length - judgeUsage.length } },
        timing: Object.fromEntries(['wallMs', 'modelRequestMs', 'toolMs', 'judgeMs'].map(key => [key, sum(results, result => result.timing[key])])),
        store: { name: manifest.store.name, ...(store ?? {}) },
        questionResults: results.map(({ id, category, class: kind, status, error, score, judge, metrics }) => ({ id, category, class: kind, status,
            ...(error ? { error: error.code } : {}), score, judge: judge?.status ?? null, retrievalCall: metrics.retrievalCall,
            toolCallsByName: metrics.toolCallsByName })),
        limitations: ['Rubric judge only: one request per rubric item with upstream BEAM\'s unified judge prompt at temperature 0, no retries and one run. Not a reproduction of the BEAM paper\'s scores.',
            'event_ordering reports only the rubric judge score; upstream\'s headline event-ordering metric (Kendall tau-b times F1 after an LLM alignment) is not computed.',
            'The answering model has the run\'s instructions, read-only file tools and its own general knowledge; nothing restricts its answer to the drive.',
            'needs_assistant and not_replayed questions cite messages the replay never sent; scores are reported per class and must not be pooled across classes.',
            ...(measured ? [] : ['Injected test transports exercise the harness; they are not model or judge measurements.'])] };
}

/**
 * Ask the selected questions of one finished LambdaDB replay run, each in a fresh model
 * conversation with the run's instructions and the read-only catalog, then judge every
 * rubric item of each answered question. Everything is validated before `output` exists.
 */
export async function runQuestions({ run, manifest: manifestFile, output, scope = 'replayed', model, judgeModel = defaultJudgeModel, limit,
    key, env = {}, connect = lambdadbConnection, ask, judge, budget = limits, clock = () => performance.now() }) {
    assert(typeof run === 'string' && run && typeof manifestFile === 'string' && manifestFile, 'Provide --run RUN_DIR and --manifest FILE');
    assert(typeof output === 'string' && output, 'Provide a new output directory');
    selectQuestions([], scope, limit);
    for (const value of [model, judgeModel]) assert(value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= 100), 'Invalid model');
    // Credentials first: no run, store or output is touched without them.
    const answerTransport = ask ?? openAI({ key }), judgeTransport = judge ?? openAI({ key, endpoint: 'chat/completions' });
    const connection = connect(env);

    const runDirectory = path.resolve(run);
    const runManifestBytes = await readFile(path.join(runDirectory, 'manifest.json'));
    const runManifest = JSON.parse(runManifestBytes);
    assert.equal(runManifest.protocol, replayProtocol, 'Use a BEAM session replay run');
    assert(runManifest.backend === 'lambdadb' && runManifest.store?.ledger === ledgerFile, 'Use a LambdaDB replay run; a fixture run keeps no store');
    const runSummary = await readJSON(path.join(runDirectory, 'summary.json'));
    assert(runSummary.protocol === replayProtocol && runSummary.cleanup === 'retained' && runSummary.store?.name === runManifest.store.name,
        'The replay run is unfinished or did not retain its store');
    const ledger = await readLedger(runDirectory, connection);
    assert(ledger.name === runManifest.store.name && ledger.status === 'ready', 'The run\'s store is not ready or was cleaned up');
    const { text: instructions, sha256: instructionsSha256 } = runManifest.instructions;
    assert(instructions === null ? instructionsSha256 === null : hash(instructions) === instructionsSha256, 'Run instruction text changed');
    model ??= runManifest.model;

    // The prepared data must be the bytes the run recorded.
    const source = runManifest.source, id = source.conversationId;
    const manifestBytes = await readFile(manifestFile);
    assert.equal(hash(manifestBytes), source.manifestSha256, 'Prepared manifest differs from the run');
    const entries = JSON.parse(manifestBytes).conversations.filter(entry => entry.id === id);
    assert(entries.length === 1 && entries[0].runtime === `conversations/${id}.json` && entries[0].evaluation === `evaluation/${id}.json`,
        'Unexpected prepared conversation entry');
    const [entry] = entries, base = path.dirname(manifestFile);
    const runtimeBytes = await readFile(path.join(base, entry.runtime)), evaluationBytes = await readFile(path.join(base, entry.evaluation));
    assert(hash(runtimeBytes) === entry.runtimeSha256 && hash(runtimeBytes) === source.runtimeSha256, 'Prepared runtime differs from the run');
    assert.equal(hash(evaluationBytes), entry.evaluationSha256, 'Prepared evaluation checksum changed');
    const runtime = JSON.parse(runtimeBytes), evaluation = JSON.parse(evaluationBytes);
    const sessions = groupSessions(runtime);
    for (const planned of runManifest.plan)
        assert(sessions[planned.index]?.id === planned.id && sessions[planned.index].turns.length === planned.userTurns, 'Run plan differs from the conversation');
    assert(Array.isArray(evaluation) && evaluation.length === runtime.questions.length && evaluation.every((item, index) =>
        item.id === runtime.questions[index].id && item.question === runtime.questions[index].text && typeof item.category === 'string'
        && Array.isArray(item.rubric) && item.rubric.length > 0 && item.rubric.every(rubric => typeof rubric === 'string')),
    'Evaluation questions differ from the runtime questions');
    const classification = classifyQuestions(runtime.messages, evaluation, sentTurnIds(sessions, runManifest.plan, runSummary.sessions));
    const selected = selectQuestions(classification, scope, limit);

    // Read-only from here: open never recovers, and the model gets read tools only.
    const { client } = connection;
    const { collection } = await client.collection(ledger.name).get();
    assert.equal(collection.collectionName, ledger.name, 'Unexpected replay store name');
    assertOwner(collection, ledger);
    const drive = await MemDrive.open({ client, name: ledger.name });

    const definitions = getFileToolDefinitions({ embeddingMode: 'managed', tools: readToolNames });
    const judgeSha256 = hash(judgePrompt);
    const manifest = { protocol: questionsProtocol, transport: ask ? 'injected-test' : 'openai-responses',
        judgeTransport: judge ? 'injected-test' : 'openai-chat-completions', startedAt: new Date().toISOString(), node: process.version,
        package: (await readJSON(path.join(root, 'package.json'))).version,
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        sources: { ...Object.fromEntries(await Promise.all(['replay.mjs', 'replay-questions.mjs', 'replay-agent.mjs', 'replay-sessions.mjs', 'replay-store.mjs',
            'original-config.json', 'original-judge-prompt.json'].map(async name => [`benchmark/beam/${name}`, hash(await readFile(path.join(root, 'benchmark/beam', name)))]))),
        ...await fingerprint(path.join(root, 'dist/esm'), root), 'package-lock.json': hash(await readFile(path.join(root, 'package-lock.json'))) },
        run: { directory: path.relative(root, runDirectory) || '.', manifestSha256: hash(runManifestBytes), transport: runManifest.transport,
            model: runManifest.model, complete: runSummary.complete },
        store: { name: ledger.name },
        source: { split: source.split, conversationId: id, manifestSha256: source.manifestSha256, runtimeSha256: source.runtimeSha256,
            evaluationSha256: entry.evaluationSha256 },
        scope, limit: limit ?? null, model, judgeModel, limits: budget,
        instructions: { source: runManifest.instructions.source, sha256: instructionsSha256 },
        request: { reasoning: { effort: 'low' }, store: false, include: ['reasoning.encrypted_content'], parallel_tool_calls: false },
        judgeRequest: { temperature: 0, perRubricItem: true, retries: 0 },
        tools: readToolNames, toolDefinitions: definitions, toolDefinitionsSha256: hash(JSON.stringify(definitions)),
        judgePrompt: { file: 'benchmark/beam/original-judge-prompt.json', name: 'unified_llm_judge_base_prompt', sha256: judgeSha256,
            upstreamRevision: judgeSource.upstreamRevision, upstreamFile: judgeSource.upstreamFile, upstreamFileSha256: judgeSource.upstreamFileSha256 },
        classification, selected: selected.map(question => question.id) };

    output = path.resolve(output);
    await mkdir(path.dirname(output), { recursive: true });
    await mkdir(output); // Existing results cannot be overwritten.
    await writeFile(path.join(output, 'manifest.json'), json(manifest), privateFile);
    const results = [];
    const writeSummary = store => writeFile(path.join(output, 'summary.json'), json(summarizeQuestions(manifest, results, store)), privateFile);
    await writeSummary();
    const before = await refState(drive);
    const call = createToolHost({ drive, resultBytes: budget.resultBytes, tools: readToolNames });
    const texts = new Map(runtime.questions.map(question => [question.id, question.text]));
    const items = new Map(evaluation.map(item => [item.id, item]));
    for (const [ordinal, question] of selected.entries()) {
        const directory = path.join(output, `question-${String(ordinal + 1).padStart(3, '0')}-${question.id}`);
        await mkdir(directory);
        const append = file => value => appendFile(path.join(directory, file), JSON.stringify(value) + '\n', privateFile);
        const state = { input: [], requests: [], events: [], userTurns: 0 };
        const result = { id: question.id, category: question.category, class: question.class, status: 'failed' };
        const started = clock();
        try {
            await runSession({ session: { index: ordinal, turns: [{ content: texts.get(question.id) }] }, turns: 1, call, ask: answerTransport,
                model, instructions, definitions, budget, signal: AbortSignal.timeout(budget.sessionSeconds * 1000), state, clock,
                hooks: { item: append('transcript.jsonl'), receipt: append('requests.jsonl'), event: append('events.jsonl') } });
            result.status = 'answered';
            result.answer = finalText(state.requests.at(-1).response);
        } catch (error) {
            result.error = { code: error instanceof ReplayFailure && failureCodes.includes(error.code) ? error.code : 'REPLAY_ERROR',
                message: 'Inspect the request receipts and tool events; no automatic retry was attempted. Not judged.' };
        }
        const answeredAt = clock();
        result.metrics = answerMetrics(state);
        result.judge = null;
        result.score = null;
        if (result.status === 'answered') {
            const outcomes = [], logJudge = append('judge.jsonl');
            for (const [index, item] of items.get(question.id).rubric.entries()) {
                const outcome = { index, rubricItem: item, ...await judgeItem({ judge: judgeTransport, model: judgeModel, item, answer: result.answer, clock }) };
                outcomes.push(outcome);
                await logJudge(outcome);
            }
            result.score = questionScore(outcomes);
            result.judge = { status: result.score === null ? 'failed' : 'judged',
                items: outcomes.map(({ index, status, score, code, usage }) => ({ index, status, ...(status === 'scored' ? { score } : { code }), usage: usage ?? null })) };
        }
        result.timing = { wallMs: clock() - started, modelRequestMs: sum(state.requests, receipt => receipt.elapsedMs ?? 0),
            toolMs: sum(state.events, event => event.elapsedMs), judgeMs: clock() - answeredAt };
        await writeFile(path.join(directory, 'result.json'), json(result), privateFile);
        results.push(result);
        await writeSummary();
    }
    // Refs and main version only; the read-only catalog is what keeps file contents unchanged.
    const after = await refState(drive);
    const store = { before, after, unchanged: JSON.stringify(before) === JSON.stringify(after) };
    await writeSummary(store);
    return { manifest, results, summary: summarizeQuestions(manifest, results, store) };
}
