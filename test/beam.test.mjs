import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { beamConnection, runBeamCommand } from '../benchmark/beam/run.mjs';
import { estimate, hash, packEvidence, prepareConversation, searchRequest } from '../benchmark/beam/sources.mjs';
import { nativeFixture } from './helpers/longmemeval-http.mjs';

const config = JSON.parse(await readFile(new URL('../benchmark/beam/original-config.json', import.meta.url)));
const json = async file => JSON.parse(await readFile(file, 'utf8'));

function conversation() {
    return { protocol: 'beam-original-v1', id: '42', userIdentity: 'test-user', userTraits: { profile: 'Uses a 🪁 <question>.' },
        messages: ['🧭 <question> repeat repeat', 'Understood', 'Recent one', 'Recent reply one', 'Recent two', 'Recent reply two']
            .map((content, ordinal) => ({ sourceId: `42_s001_t000${ordinal}`, turnId: `dialogue-${ordinal}`, ordinal, content,
                author: ordinal % 2 === 0 ? { role: 'user', name: 'Test User' } : { role: 'assistant', name: 'Assistant' },
                timestamp: ordinal === 0 ? '2023-02-28T12:00:00.000Z' : null })),
        questions: [{ id: 'question-1', text: 'Where is the compass?' }, { id: 'question-2', text: 'What changed earlier?' }] };
}

async function preparedManifest(root, source) {
    await mkdir(path.join(root, 'conversations'), { recursive: true });
    const runtime = `conversations/${source.id}.json`, bytes = JSON.stringify(source);
    await writeFile(path.join(root, runtime), bytes);
    const manifestFile = path.join(root, 'manifest.json'), cohort = config.cohorts['500k'];
    await writeFile(manifestFile, JSON.stringify({ protocol: 'beam-original-v1', split: '500k', questionPosition: 'after_complete_conversation',
        datasetRevision: cohort.datasetRevision, sourceFiles: Object.fromEntries(cohort.files.map(file => [file.name, file.sha256])),
        conversations: [{ id: source.id, runtime, runtimeSha256: hash(bytes), questions: source.questions.length, evaluation: 'unavailable.json' }] }));
    return manifestFile;
}

function nativeConnection(wire, { failCreate = false } = {}) {
    return beamConnection({ LAMBDADB_BASE_URL: 'https://beam.invalid', LAMBDADB_PROJECT_NAME: 'test', LAMBDADB_PROJECT_API_KEY: 'synthetic-key' }, {
        fetcher: async (request, options) => {
            assert.equal(options.redirect, 'error');
            const response = await wire.fetcher(request.url, {
                method: request.method, body: request.body ? await request.text() : undefined,
            });
            if (failCreate && request.method === 'POST' && new URL(request.url).pathname.endsWith('/collections')) {
                throw new Error('Create response lost');
            }
            return response;
        },
    });
}

test('original BEAM partition is question-independent and keeps the first reply with its user input', () => {
    const source = conversation();
    source.messages.push({ ...source.messages[0], ordinal: 6, sourceId: 'extra', timestamp: null });
    const prepared = prepareConversation(source);
    assert.equal(prepared.boundary, 2, 'The initial boundary would cut the first recent pair');
    assert.deepEqual(prepared.files.map(file => file.path), ['/messages/0.txt', '/messages/1.txt', '/profile.json']);
    assert.deepEqual(prepared.recent.map(message => message.turnId), ['dialogue-2', 'dialogue-3', 'dialogue-4', 'dialogue-5', 'dialogue-0']);
    const raw = { retrievalInput: 'question', limit: 100, rerank: false };
    assert.deepEqual(searchRequest(source.questions[0], prepared, raw), { query: source.questions[0].text, mode: 'hybrid', limit: 100, rerank: false });
    const contextual = searchRequest(source.questions[1], prepared, { ...raw, retrievalInput: 'contextual' });
    assert.equal(contextual.query, source.questions[1].text);
    assert.deepEqual(JSON.parse(contextual.embeddingQuery), { question: source.questions[1].text,
        recent_dialogue: prepared.recent.map(({ role, content }) => ({ role, content })), context: JSON.stringify(source.userTraits) });
    assert.throws(() => prepareConversation({ ...source, questions: [{ ...source.questions[0], rubric: ['forbidden'] }] }), /Only question ID and text/);
});

test('BEAM delivery binds Unicode spans and original turn IDs and reports omissions', () => {
    const file = prepareConversation(conversation()).files[0];
    const fileId = '00000000-0000-4000-8000-000000000001', originals = new Map([[fileId, file]]);
    const hit = { ...file, fileId, content: '🧭', range: { start: 0, end: 2 } };
    const packed = packEvidence([hit, hit, { ...hit, range: undefined, content: 'repeat' },
        { ...hit, range: undefined, content: '<question>' }], originals, 1, estimate);
    assert.deepEqual(packed.context.results.map(({ fileId, sourceId, turnId, start, end, content, conversationTimestamp }) =>
        ({ fileId, sourceId, turnId, start, end, content, conversationTimestamp })), [
        { fileId, sourceId: '42_s001_t0000', turnId: 'dialogue-0', start: 0, end: 2, content: '🧭',
            conversationTimestamp: '2023-02-28T12:00:00.000Z' },
    ]);
    assert.deepEqual(packed.omitted.map(item => item.reason), ['duplicate', 'unattributed', 'budget']);
    assert.throws(() => packEvidence([{ ...hit, range: { start: 1, end: 2 } }], originals, 1, estimate), /UTF-16/);
    assert.throws(() => packEvidence([{ ...hit, fileId: 'foreign' }], originals, 1, estimate), /ineligible/);
    assert.throws(() => packEvidence([{ ...hit, metadata: { ...hit.metadata, turnId: 'changed' } }], originals, 1, estimate), /metadata/);
});

test('BEAM ingests via the public SDK, reuses one owned fork and prepares both retrieval modes without annotation files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'beam-files-'));
    try {
        const source = conversation(), manifestFile = await preparedManifest(root, source), wire = nativeFixture();
        const ledgerFile = path.join(root, 'ledger.json'), name = 'beam_test';
        const execute = args => runBeamCommand({ ...nativeConnection(wire), name, manifestFile, ledgerFile, conversationId: source.id, ...args });
        assert.deepEqual(await execute({ command: 'ingest' }), { status: 'ready', name, files: 3, boundary: 2 });
        assert.equal(wire.collections.size, 1);
        const branch = wire.collections.get(name).branches.get('fork-corpus');
        assert.deepEqual([...branch.docs.values()].filter(doc => doc.kind === 'file').map(doc => doc.path),
            ['/messages/0.txt', '/messages/1.txt', '/profile.json']);
        const ledger = await json(ledgerFile);
        const beforeReuse = wire.requests.length;
        for (const retrievalInput of [undefined, 'contextual']) {
            const output = path.join(root, retrievalInput ?? 'question');
            assert.deepEqual(await execute({ command: 'recall', retrievalInput, output, questionIds: source.questions.map(q => q.id) }),
                { status: 'complete', name, questions: 2 });
            const rows = (await readFile(path.join(output, 'results.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
            assert.equal((await json(path.join(output, 'run.json'))).boundary, 2);
            assert.equal(rows.length, 2);
            for (const [index, row] of rows.entries()) {
                assert.equal(row.request.query, source.questions[index].text);
                assert.equal(row.request.embeddingQuery !== undefined, retrievalInput === 'contextual');
                const passage = row.delivery.context.results.find(result => result.sourceId === source.messages[0].sourceId);
                assert.equal(passage.fileId, ledger.fileIds[0]);
                assert.equal(passage.turnId, 'dialogue-0');
                assert.equal(passage.content, source.messages[0].content);
                const answer = row.answerRequest.messages[0].content;
                assert.match(answer, /Recent reply two/);
                assert.match(answer, /Uses a 🪁 <question>/);
                assert.match(answer, /dialogue-0/);
            }
        }
        assert(wire.requests.slice(beforeReuse).every(({ pathname, method }) => method === 'GET'
            || (method === 'POST' && /\/(query|docs\/fetch)$/.test(pathname))), 'Recall must not mutate the corpus');

        const original = [...branch.docs.values()].find(doc => doc.kind === 'file');
        original.body = 'changed after preparation';
        await assert.rejects(execute({ command: 'recall', output: path.join(root, 'changed'), questionIds: ['question-1'] }), /Stored original/);

        const collection = wire.collections.get(name).metadata;
        collection.tags['beam.owner'] = 'foreign';
        await rm(manifestFile);
        await assert.rejects(execute({ command: 'cleanup' }), /owner or source differs/);
        assert.equal(wire.collections.size, 1);
        collection.tags['beam.owner'] = ledger.owner;
        assert.equal((await execute({ command: 'cleanup' })).status, 'cleaned');
        assert.equal(wire.collections.size, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('BEAM keeps ownership after ambiguous create and rejects overlong contextual input before remote requests', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'beam-recovery-'));
    try {
        const source = conversation();
        source.messages.at(-1).content = '🧭'.repeat(2_100);
        const manifestFile = await preparedManifest(root, source), wire = nativeFixture();
        const defaults = { manifestFile, conversationId: source.id, name: 'beam_recovery', ledgerFile: path.join(root, 'pending.json') };
        await assert.rejects(runBeamCommand({ ...defaults, ...nativeConnection(wire, { failCreate: true }), command: 'ingest' }));
        const connection = nativeConnection(wire);
        assert.equal((await json(defaults.ledgerFile)).status, 'pending');
        assert.equal(wire.collections.size, 1);
        const beforeRetry = wire.requests.length;
        await assert.rejects(runBeamCommand({ ...defaults, ...connection, command: 'ingest' }), { code: 'EEXIST' });
        assert.equal(wire.requests.length, beforeRetry, 'Never retry an uncertain create');
        assert.equal((await runBeamCommand({ ...defaults, ...connection, command: 'cleanup' })).status, 'cleaned');
        assert.equal(wire.collections.size, 0);

        defaults.ledgerFile = path.join(root, 'ready.json');
        await runBeamCommand({ ...defaults, ...connection, command: 'ingest' });
        const beforeRecall = wire.requests.length;
        await assert.rejects(runBeamCommand({ ...defaults, ...connection, command: 'recall', output: path.join(root, 'contextual'),
            questionIds: ['question-1'], retrievalInput: 'contextual' }), /exceeds 8192 UTF-8 bytes/);
        assert.equal(wire.requests.length, beforeRecall);
        await runBeamCommand({ ...defaults, ...connection, command: 'recall', output: path.join(root, 'question'), questionIds: ['question-1'] });
        await runBeamCommand({ ...defaults, ...connection, command: 'cleanup' });
    } finally { await rm(root, { recursive: true, force: true }); }
});
