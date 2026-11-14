import assert from 'node:assert/strict';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { LambdaDBClient, HTTPClient } from '@functional-systems/lambdadb';
import { create, open } from '@functional-systems/memdrive';
import { get_encoding } from 'tiktoken';
import { createTools } from '@functional-systems/memdrive/tools';
import { jsonHash, metadataSchema, integer } from './protocol.mjs';

export const readJSON = async file => JSON.parse(await readFile(file, 'utf8'));
export async function atomic(file, value) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await rename(file + '.tmp', file);
}
export async function exists(file) {
    try { await readFile(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export function status(error) {
    for (let value = error, seen = new Set(); value && !seen.has(value); value = value.cause) {
        seen.add(value);
        if (Number.isInteger(value.status ?? value.statusCode)) return value.status ?? value.statusCode;
    }
}
export function credentials(env, databaseRequired = true) {
    if (!databaseRequired) return { modelKey: env.LLM_API_KEY, judgeKey: env.TYPESAFE_API_KEY };
    for (const key of ['LAMBDADB_BASE_URL', 'LAMBDADB_PROJECT_NAME', 'LAMBDADB_PROJECT_API_KEY']) assert(env[key]?.trim(), `Missing ${key}`);
    const url = new URL(env.LAMBDADB_BASE_URL);
    assert(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 'Expected HTTPS database URL');
    const project = env.LAMBDADB_PROJECT_NAME;
    const database = url.href.replace(/\/$/, '');
    return { database, project, databaseKey: env.LAMBDADB_PROJECT_API_KEY, modelKey: env.LLM_API_KEY, judgeKey: env.TYPESAFE_API_KEY,
        connection: jsonHash([database, project]) };
}

export class Journal {
    constructor({ root, config, binding, credentials: keys, state, save, fetcher = fetch, signal, replay = false, onReplayReceipt = () => {}, readOnly = false }) {
        Object.assign(this, { root, config, binding, keys, state, save, fetcher, signal, replay, onReplayReceipt, readOnly });
    }
    async request({ file, url, body, key, kind, method = 'POST', cleanup = false }) {
        const request = { kind, method, url, body: body ?? null }, requestHash = jsonHash(request);
        if (await exists(file)) {
            const receipt = await readJSON(file);
            assert.equal(receipt.binding, this.binding); assert.equal(receipt.requestHash, requestHash);
            assert.equal(receipt.status, 'complete', 'An interrupted or failed request cannot be replayed automatically');
            this.onReplayReceipt(receipt);
            return receipt;
        }
        assert(!this.replay, 'Missing recorded request during offline replay');
        assert(key?.trim(), `Missing ${kind} credential`);
        const startedAt = new Date(Date.now()).toISOString();
        await atomic(file, { binding: this.binding, requestHash, request, startedAt, status: 'pending' });
        const started = performance.now();
        const signal = cleanup ? AbortSignal.timeout(this.config.limits.requestSeconds * 1000)
            : AbortSignal.any([this.signal, AbortSignal.timeout(this.config.limits.requestSeconds * 1000)].filter(Boolean));
        let receipt, dispatched = false;
        try {
            signal.throwIfAborted();
            dispatched = true;
            const response = await this.fetcher(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                headers: { 'content-type': 'application/json', [kind === 'database' ? 'x-api-key' : 'authorization']:
                    kind === 'database' ? key : `Bearer ${key}` }, signal, redirect: 'error' });
            const raw = await response.text(); signal.throwIfAborted();
            // No request headers or credentials enter receipts, including service error bodies.
            assert(![this.keys.databaseKey, this.keys.modelKey, this.keys.judgeKey].filter(Boolean).some(secret => raw.includes(secret)),
                'Service response contained a credential; raw body was not saved');
            receipt = { binding: this.binding, requestHash, request, startedAt, status: 'complete', httpStatus: response.status,
                raw, completedAt: Date.now(), milliseconds: performance.now() - started };
            await atomic(file, receipt);
        } catch {
            await atomic(file, { binding: this.binding, requestHash, request, startedAt, status: dispatched ? 'uncertain' : 'aborted',
                milliseconds: performance.now() - started });
            throw new Error(`${kind} request failed or was interrupted; inspect its receipt before retrying`);
        }
        return receipt;
    }
    async model(kind, request, filename) {
        assert(['collector', 'answer', 'judge'].includes(kind));
        const isJudge = kind === 'judge', file = path.join(this.root, filename);
        if (!isJudge && !await exists(file)) {
            const encoder = get_encoding('cl100k_base');
            try {
                const reservation = encoder.encode(JSON.stringify(request), [], []).length
                    + (kind === 'collector' ? request.max_output_tokens : request.max_completion_tokens);
                assert(reservation <= this.config.limits.contextTokens, 'Model context budget exhausted');
                assert(this.state.modelTokens + reservation <= this.config.limits.modelTokensPerQuestion, 'Model token budget exhausted before request');
            } finally { encoder.free(); }
        }
        const usage = this.state.models[kind] ??= { calls: 0, inputTokens: 0, outputTokens: 0, unknownUsageCalls: 0, milliseconds: 0 };
        usage.calls++; usage.unknownUsageCalls++; await this.save();
        const receipt = await this.request({ file, url: isJudge ? this.config.judge.endpoint
            : kind === 'collector' ? this.config.collectorEndpoint : this.config.modelEndpoint,
            body: request, key: isJudge ? this.keys.judgeKey : this.keys.modelKey, kind });
        usage.milliseconds += receipt.milliseconds;
        await this.save();
        assert.equal(receipt.httpStatus, 200, `${kind} service returned HTTP ${receipt.httpStatus}`);
        const response = JSON.parse(receipt.raw);
        const input = response.usage?.[kind === 'answer' ? 'prompt_tokens' : 'input_tokens'];
        const output = response.usage?.[kind === 'answer' ? 'completion_tokens' : 'output_tokens'];
        if (integer(input) && (isJudge || integer(output))) {
            usage.unknownUsageCalls--; usage.inputTokens += input;
            usage.outputTokens = integer(output) && usage.outputTokens !== null ? usage.outputTokens + output : null;
            if (!isJudge) this.state.modelTokens += input + output;
        }
        await this.save();
        assert(integer(input) && (isJudge || integer(output)), 'Missing model usage');
        assert.equal(response.model, isJudge ? this.config.judge.model : this.config.model.model, 'Model identity differs');
        assert(this.state.modelTokens <= this.config.limits.modelTokensPerQuestion, 'Model token budget exhausted');
        return response;
    }
    native(cleanup = false) {
        const { database: baseUrl, project: projectName, databaseKey: projectApiKey } = this.keys;
        const prefix = `${baseUrl}/projects/${encodeURIComponent(projectName)}/`;
        const fetcher = async request => {
            assert(request.url.startsWith(prefix), 'Database request escaped the configured project');
            if (this.readOnly) assert((request.method === 'GET' && /\/collections\/[^/]+$/.test(new URL(request.url).pathname))
                || (request.method === 'POST' && /\/(query|docs\/(fetch|list))$/.test(new URL(request.url).pathname)),
                'Evaluation attempted a database mutation');
            if (cleanup) {
                assert(this.state.cleanupOperations < this.config.limits.cleanupOperations, 'Cleanup operation budget exhausted');
                this.state.cleanupOperations++;
            } else {
                assert(this.state.databaseOperations < this.config.limits.databaseOperationsPerQuestion, 'Database operation budget exhausted');
                this.state.databaseOperations++;
            }
            const number = ++this.state.receiptNumber;
            await this.save();
            const receipt = await this.request({ file: path.join(this.root, `database/${number}.json`), url: request.url,
                method: request.method, body: request.body ? JSON.parse(await request.text()) : undefined,
                key: projectApiKey, kind: 'database', cleanup });
            return new Response(receipt.raw, { status: receipt.httpStatus, headers: { 'content-type': 'application/json' } });
        };
        return new LambdaDBClient({ baseUrl, projectName, projectApiKey, retryConfig: { strategy: 'none' },
            debugLogger: { log() {}, group() {}, groupEnd() {} }, httpClient: new HTTPClient({ fetcher }),
            transferClient: new HTTPClient({ fetcher: async () => { throw new Error('External result downloads are outside this receipt protocol'); } }) });
    }
}

export const storageProfile = () => ({ source: 'longmemeval-original-messages-v1', metadataSchema,
    embedding: { mode: 'managed', provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536, similarity: 'cosine' },
    textSearch: { analyzers: ['english'] } });

function validateDescriptor(descriptor, entry, profile) {
    assert.equal(descriptor.name, entry.collection);
    assert.equal(descriptor.labels['eval.owner'], entry.owner); assert.equal(descriptor.labels['eval.scope'], entry.scope);
    assert.deepEqual(descriptor.metadataSchema, profile.metadataSchema, 'Corpus metadata schema differs');
    assert.deepEqual(descriptor.embedding, profile.embedding, 'Corpus embedding configuration differs');
    assert.deepEqual(descriptor.textSearch, profile.textSearch, 'Corpus text search configuration differs');
}
async function validateOriginals(drive, journal, prepared) {
    for (let index = 0; index < prepared.mems.length; index += 100) {
        const expected = prepared.mems.slice(index, index + 100);
        const read = await drive.read({ ids: expected.map(mem => mem.id) }, { signal: journal.signal });
        assert.deepEqual(read.mems, expected, 'Stored original readback differs');
    }
}
export async function ingest(journal, prepared, entry, profile = storageProfile()) {
    const drive = await create({ client: journal.native(), name: entry.collection, metadataSchema: profile.metadataSchema, maxConcurrentRequests: 1,
        description: 'Reusable LongMemEval conversation history.', labels: { 'eval.owner': entry.owner, 'eval.scope': entry.scope },
        embedding: { mode: 'managed' }, textSearch: profile.textSearch }, { signal: journal.signal });
    validateDescriptor(await drive.describe({ signal: journal.signal }), entry, profile);
    // Bound the number of originals in each managed-embedding request.
    for (let index = 0; index < prepared.mems.length; index += 20)
        await drive.remember({ mems: prepared.mems.slice(index, index + 20) }, { signal: journal.signal });
    await validateOriginals(drive, journal, prepared);
    return createTools({ drive, shortIds: journal.config.shortIds ?? false }, { signal: journal.signal });
}
export async function reuse(journal, prepared, entry, profile = storageProfile()) {
    const drive = await open({ client: journal.native(), name: entry.collection, maxConcurrentRequests: 1 }, { signal: journal.signal });
    validateDescriptor(await drive.describe({ signal: journal.signal }), entry, profile);
    await validateOriginals(drive, journal, prepared);
    return createTools({ drive, shortIds: journal.config.shortIds ?? false }, { signal: journal.signal });
}

export async function cleanup(journal, entry) {
    assert(/^mdlme_[a-f0-9]{24}$/.test(entry.collection));
    assert(/^[a-f0-9]{64}$/.test(entry.owner) && /^[a-f0-9]{64}$/.test(entry.scope));
    if (entry.absent) return;
    const handle = journal.native(true).collection(entry.collection);
    let collection;
    try { collection = (await handle.get()).collection; }
    catch (error) { if (status(error) === 404) { entry.absent = true; await journal.save(); return; } throw error; }
    assert.equal(collection.tags?.['eval.owner'], entry.owner, 'Cleanup owner mismatch');
    assert.equal(collection.tags?.['eval.scope'], entry.scope, 'Cleanup scope mismatch');
    await handle.delete();
    for (let attempt = 0; attempt < 10; attempt++) {
        try { await handle.get(); }
        catch (error) { if (status(error) === 404) { entry.absent = true; await journal.save(); return; } throw error; }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('Collection absence was not confirmed');
}
