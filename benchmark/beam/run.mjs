// The benchmark owns corpus lifecycle, evidence assembly and answer requests.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { HTTPClient, LambdaDBClient } from '@functional-systems/lambdadb';
import { MemDrive } from '@functional-systems/memdrive';
import { answerRequest, estimate, frozenConversation, hash, metadataSchema, packEvidence, searchRequest } from './sources.mjs';

const protocol = 'beam-original-file-sdk-v1';
const fork = 'corpus';
const textSearch = { analyzers: ['english'] };
const embedding = { mode: 'managed', provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536, similarity: 'cosine' };
const validName = name => typeof name === 'string' && /^[A-Za-z0-9_-]{3,52}$/.test(name);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const json = value => JSON.stringify(value, null, 2) + '\n';
const privateFile = { flag: 'wx', mode: 0o600 };

async function writeLedger(file, ledger) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, json(ledger), privateFile);
    try { await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
}

function labels(owner, fingerprint) {
    return { 'beam.application': protocol, 'beam.owner': owner, 'beam.source': fingerprint };
}

function sourceMap(files, ids) {
    assert(Array.isArray(ids) && ids.length === files.length, 'File ID count differs from the frozen BEAM corpus');
    assert(ids.every(id => typeof id === 'string' && uuid.test(id)) && new Set(ids).size === ids.length, 'Invalid or duplicate file ID');
    return new Map(files.map((file, i) => [ids[i], file]));
}

function* fileBatches(files) {
    let batch = [], bytes = 0;
    for (const file of files) {
        const size = Buffer.byteLength(JSON.stringify(file));
        if (batch.length && (batch.length === 20 || bytes + size > 500_000)) {
            yield batch;
            batch = []; bytes = 0;
        }
        batch.push(file);
        bytes += size;
    }
    if (batch.length) yield batch;
}

async function checkSources(drive, prepared, fileIds) {
    const sources = sourceMap(prepared.files, fileIds);
    let offset = 0;
    for (const batch of fileBatches(prepared.files)) {
        const files = await drive.read({ paths: batch.map(file => file.path) });
        assert.deepEqual(files.map(({ fileId, path, content, metadata }) => ({ fileId, path, content, metadata })),
            batch.map((file, i) => ({ fileId: fileIds[offset + i], ...file })), 'Stored original differs from frozen BEAM input');
        offset += batch.length;
    }
    return sources;
}

async function openCorpus(client, ledger) {
    const drive = await MemDrive.open({ client, name: ledger.name, at: { fork } });
    const descriptor = await drive.describe();
    assert.equal(descriptor.name, ledger.name);
    assert.deepEqual(descriptor.labels, labels(ledger.owner, ledger.fingerprint), 'BEAM corpus owner or source differs');
    assert.deepEqual(descriptor.metadataSchema, metadataSchema, 'BEAM corpus schema differs');
    assert.deepEqual(descriptor.embedding, embedding, 'BEAM corpus embedding setup differs');
    assert.deepEqual(descriptor.textSearch, textSearch, 'BEAM corpus analyzer differs');
    return drive;
}

async function ingest(client, file, ledger) {
    const prepared = await frozenConversation(ledger.manifestFile, ledger.conversationId);
    Object.assign(ledger, { fingerprint: prepared.fingerprint, runtimeSha256: prepared.runtimeSha256,
        manifestSha256: prepared.manifestSha256, status: 'pending' });
    // A failed create or write can leave data on the server. Keep the ownership
    // receipt even if the response is lost and require explicit cleanup.
    await writeFile(file, json(ledger), privateFile);
    const main = await MemDrive.create({ client, name: ledger.name, metadataSchema, textSearch,
        labels: labels(ledger.owner, ledger.fingerprint) });
    const drive = await main.fork({ name: fork });
    const fileIds = [];
    for (const batch of fileBatches(prepared.files)) {
        const created = await drive.write(batch.map(file => ({ op: 'create', ...file })));
        assert.deepEqual(created.map(file => file.path), batch.map(file => file.path), 'File write order differs');
        fileIds.push(...created.map(file => file.fileId));
    }
    await checkSources(drive, prepared, fileIds);
    await writeLedger(file, { ...ledger, status: 'ready', fileIds });
    return { status: 'ready', name: ledger.name, files: fileIds.length, boundary: prepared.boundary };
}

async function cleanup(client, file, ledger) {
    if (ledger.status === 'cleaned') return { status: 'cleaned', name: ledger.name };
    const handle = client.collection(ledger.name);
    const inspect = async () => {
        try {
            const { collection } = await handle.get();
            assert.equal(collection.collectionName, ledger.name, 'Unexpected BEAM collection name');
            return collection;
        } catch (error) {
            if (error.statusCode === 404) return null;
            throw error;
        }
    };
    const collection = await inspect();
    if (collection) {
        for (const [key, expected] of Object.entries(labels(ledger.owner, ledger.fingerprint)))
            assert.equal(collection.tags?.[key], expected, 'BEAM corpus owner or source differs');
        await handle.delete();
        for (let attempt = 0; await inspect(); attempt++) {
            assert(attempt < 8, 'Deletion is unconfirmed; retain the ledger and retry cleanup');
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }
    await writeLedger(file, { ...ledger, status: 'cleaned' });
    return { status: 'cleaned', name: ledger.name };
}

async function recall(client, ledger, { questionIds, output, countTokens, ...settings }) {
    assert(typeof output === 'string' && output, 'Provide a new output directory');
    assert(Array.isArray(questionIds) && questionIds.length && new Set(questionIds).size === questionIds.length,
        'Choose distinct existing question IDs');
    assert(Number.isSafeInteger(settings.limit) && settings.limit >= 1 && settings.limit <= 1000, 'Invalid evidence limit');
    assert(Number.isSafeInteger(settings.evidenceBudget) && settings.evidenceBudget >= 0, 'Invalid evidence budget');
    assert(['contextual', 'question'].includes(settings.retrievalInput), 'Invalid retrieval input mode');
    assert(typeof settings.rerank === 'boolean', 'rerank must be a boolean');

    const prepared = await frozenConversation(ledger.manifestFile, ledger.conversationId);
    for (const key of ['manifestSha256', 'runtimeSha256', 'fingerprint'])
        assert(prepared[key] === ledger[key], 'Prepared BEAM input changed');
    const questions = questionIds.map(id => {
        const question = prepared.questions.find(question => question.id === id);
        assert(question, 'Choose distinct existing question IDs');
        return { question, request: searchRequest(question, prepared, settings) };
    });
    const started = performance.now();
    const drive = await openCorpus(client, ledger);
    const sources = await checkSources(drive, prepared, ledger.fileIds);
    const validationMilliseconds = performance.now() - started;

    await mkdir(output, { mode: 0o700 });
    const header = { protocol, name: ledger.name, conversationId: ledger.conversationId, mode: 'single_pass', ...settings,
        manifestSha256: ledger.manifestSha256, runtimeSha256: ledger.runtimeSha256, fingerprint: ledger.fingerprint,
        boundary: prepared.boundary, validationMilliseconds,
        accounting: { evidenceUnits: 'ceil(codepoints / 4)', serializedContext: countTokens === estimate ? 'ceil(codepoints / 4) estimate' : 'caller tokenizer' } };
    await writeFile(path.join(output, 'run.json'), json({ ...header, questionIds }), privateFile);
    const resultsFile = path.join(output, 'results.jsonl');
    await writeFile(resultsFile, '', privateFile);
    for (const { question, request } of questions) {
        const start = performance.now();
        const retrieved = await drive.search(request);
        const retrievalMilliseconds = performance.now() - start;
        const delivery = packEvidence(retrieved.hits, sources, settings.evidenceBudget, countTokens);
        const row = { questionId: question.id, request, retrieved, retrievalMilliseconds, delivery,
            answerRequest: answerRequest(question, prepared, delivery) };
        await appendFile(resultsFile, JSON.stringify(row) + '\n');
    }
    const summary = { status: 'complete', name: ledger.name, questions: questions.length };
    await writeFile(path.join(output, 'summary.json'), json(summary), privateFile);
    return summary;
}

export async function runBeamCommand({ command, client, connectionId, ledgerFile, manifestFile, conversationId,
    name, output, questionIds, limit = 100, evidenceBudget = 8000, retrievalInput = 'question', rerank = true, countTokens = estimate }) {
    assert(['ingest', 'recall', 'cleanup'].includes(command), 'Choose ingest, recall or cleanup');
    assert(typeof connectionId === 'string' && connectionId, 'Provide the credential-free connection identity');
    assert(typeof ledgerFile === 'string' && ledgerFile, 'Provide a persistent collection ledger');
    const directory = path.dirname(path.resolve(ledgerFile));
    if (command === 'ingest') await mkdir(directory, { recursive: true });
    const file = path.join(await realpath(directory), path.basename(ledgerFile));
    const guard = file + '.active';
    await mkdir(guard);
    try {
        if (command === 'ingest') {
            assert(validName(name), 'Choose a valid new MemDrive name');
            assert(typeof manifestFile === 'string' && manifestFile, 'Provide a prepared manifest');
            assert(typeof conversationId === 'string' && /^\d+$/.test(conversationId), 'Choose one prepared numeric conversation ID');
            return await ingest(client, file, { protocol, name, connectionId, manifestFile: path.resolve(manifestFile),
                conversationId, owner: randomUUID() });
        }
        const ledger = JSON.parse(await readFile(file, 'utf8'));
        assert.equal(ledger.protocol, protocol, 'Unexpected BEAM ledger format');
        assert.equal(ledger.connectionId, connectionId, 'Ledger belongs to another endpoint/project');
        assert(validName(ledger.name) && uuid.test(ledger.owner) && digest.test(ledger.fingerprint), 'Invalid BEAM ownership receipt');
        assert(['pending', 'ready', 'cleaned'].includes(ledger.status), 'Unexpected BEAM ledger state');
        if (command === 'cleanup') return await cleanup(client, file, ledger);
        assert.equal(ledger.status, 'ready', 'Only a completed ingestion can be recalled');
        return await recall(client, ledger, { questionIds, output, limit, evidenceBudget, retrievalInput, rerank, countTokens });
    } finally { await rm(guard, { recursive: true }); }
}

export function beamConnection(env, { fetcher = fetch } = {}) {
    const endpoint = new URL(env.LAMBDADB_BASE_URL);
    assert(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash
        && endpoint.pathname === '/', 'Use an HTTPS LambdaDB origin');
    const { LAMBDADB_PROJECT_NAME: projectName, LAMBDADB_PROJECT_API_KEY: projectApiKey } = env;
    assert(projectName?.trim() && projectApiKey?.trim(), 'Missing LambdaDB configuration');
    const prefix = `${endpoint.origin}/projects/${encodeURIComponent(projectName)}/`;
    const client = new LambdaDBClient({ baseUrl: endpoint.origin, projectName, projectApiKey, retryConfig: { strategy: 'none' },
        debugLogger: { log() {}, group() {}, groupEnd() {} },
        httpClient: new HTTPClient({ fetcher(request) {
            assert(request.url.startsWith(prefix), 'Database request escaped the configured project');
            return fetcher(request, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]), redirect: 'error' });
        } }),
        transferClient: new HTTPClient({ fetcher: async () => { throw new Error('External result downloads are disabled'); } }),
    });
    return { client, connectionId: hash(JSON.stringify([endpoint.origin, projectName])) };
}

const help = `Original BEAM with the MemDrive file SDK (single-pass retrieval).
  ingest --manifest FILE --conversation ID --name NAME --ledger FILE
  recall --ledger FILE --questions ID,ID --output NEW_DIR
         [--limit 100] [--evidence-budget 8000] [--retrieval-input question|contextual] [--rerank true|false]
  cleanup --ledger FILE
All commands accept --env-file FILE. Recall prepares answer requests locally.
`;

async function main() {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries([
        ...['manifest', 'conversation', 'name', 'ledger', 'env-file', 'questions', 'output', 'limit', 'evidence-budget', 'retrieval-input', 'rerank']
            .map(key => [key, { type: 'string' }]),
        ['help', { type: 'boolean' }],
    ]) });
    if (values.help) { console.log(help); return; }
    const [command] = positionals;
    const options = {
        ingest: ['manifest', 'conversation', 'name', 'ledger'],
        recall: ['ledger', 'questions', 'output', 'limit', 'evidence-budget', 'retrieval-input', 'rerank'],
        cleanup: ['ledger'],
    };
    assert(positionals.length === 1 && Object.hasOwn(options, command), help);
    assert(Object.keys(values).every(key => key === 'env-file' || options[command].includes(key)), 'Unexpected option; see --help');
    assert(values.rerank === undefined || ['true', 'false'].includes(values.rerank), 'Use --rerank true or false');
    const env = { ...process.env, ...(values['env-file'] ? parseEnv(await readFile(values['env-file'], 'utf8')) : {}) };
    const result = await runBeamCommand({ command, ...beamConnection(env), ledgerFile: values.ledger,
        manifestFile: values.manifest, conversationId: values.conversation, name: values.name, output: values.output,
        questionIds: values.questions?.split(','), limit: Number(values.limit ?? 100), evidenceBudget: Number(values['evidence-budget'] ?? 8000),
        retrievalInput: values['retrieval-input'], rerank: values.rerank !== 'false' });
    console.log(json(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch(error => {
        console.error(json({ error: error.code ?? error.name, status: error.status ?? null,
            message: error.name === 'AssertionError' ? error.message.split('\n')[0] : 'BEAM command failed; retain the ledger for verification or cleanup.' }));
        process.exitCode = 1;
    });
}
