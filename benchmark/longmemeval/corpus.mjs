import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { prepareCase, hash, jsonHash } from './protocol.mjs';
import { readJSON, atomic, exists, Journal, ingest, cleanup, storageProfile } from './runtime.mjs';

export const questionPath = (root, id) => path.join(root, 'questions', hash(id));
export const newUsage = () => ({ databaseOperations: 0, cleanupOperations: 0, receiptNumber: 0, modelTokens: 0, models: {} });
export async function dataset(root, profile) {
    const bytes = await readFile(path.join(root, 'dataset.json'));
    assert.equal(bytes.length, profile.bytes, 'Dataset byte count differs');
    assert.equal(hash(bytes), profile.sha256, 'Dataset hash differs');
    const rows = JSON.parse(bytes); assert.equal(rows.length, profile.questions);
    const byId = new Map(rows.map(row => [row.question_id, row]));
    assert.equal(byId.size, rows.length, 'Duplicate question IDs');
    return byId;
}
export async function lease(root, operation) {
    const canonical = await realpath(root), guard = path.join(canonical, '.corpus-active');
    await mkdir(guard); // One exclusive lease serializes ingestion, preparation, retrieval and deletion.
    try {
        await writeFile(path.join(guard, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
        return await operation(canonical);
    } finally { await rm(guard, { recursive: true }); }
}
export function selectedIds(manifest, limit) {
    assert(Number.isSafeInteger(limit) && limit > 0 && limit <= manifest.ids.length, 'Invalid corpus limit');
    return manifest.ids.slice(0, limit);
}
export function compatible(manifest, rows, config, ids = manifest.ids) {
    assert.equal(manifest.protocol, 'longmemeval-corpus-v1');
    assert.deepEqual(manifest.dataset, config.dataset, 'Corpus dataset differs; use another corpus');
    assert.deepEqual(manifest.storage, storageProfile(), 'Corpus storage settings differ; use another corpus');
    for (const id of ids) assert.equal(jsonHash(prepareCase(rows.get(id), config).mems), manifest.sources[id],
        'Corpus archived originals differ; use another corpus');
}
export async function initialize(root, config) {
    const rows = await dataset(root, config.dataset), file = path.join(root, 'corpus.json');
    if (await exists(file)) {
        const manifest = await readJSON(file); compatible(manifest, rows, config); return { manifest, rows };
    }
    const owner = hash(randomBytes(32)), ids = [...rows.keys()].sort();
    const manifest = { protocol: 'longmemeval-corpus-v1', owner, dataset: config.dataset, storage: storageProfile(), ids,
        sources: Object.fromEntries(ids.map(id => [id, jsonHash(prepareCase(rows.get(id), config).mems)])),
        collections: Object.fromEntries(ids.map(id => [id, { collection: `mdlme_${randomBytes(12).toString('hex')}`,
            owner, scope: jsonHash([owner, id]) }])), lifecycle: { limits: config.limits } };
    await writeFile(file, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { manifest, rows };
}
export async function corpusState(root, manifest) {
    const file = path.join(root, 'corpus-state.json');
    const state = await exists(file) ? await readJSON(file) : { binding: jsonHash(manifest), connection: null, retired: false, questions: {} };
    assert.equal(state.binding, jsonHash(manifest), 'Corpus state belongs to another manifest');
    return state;
}
export async function ingestCorpus(root, config, keys, limit, { fetcher = fetch, signal } = {}) {
    return lease(root, async canonical => {
        const { manifest, rows } = await initialize(canonical, config), ids = selectedIds(manifest, limit);
        const state = await corpusState(canonical, manifest), save = () => atomic(path.join(canonical, 'corpus-state.json'), state);
        assert(!state.retired, 'Corpus is retired; create a new corpus directory');
        assert(state.connection === null || state.connection === keys.connection, 'Corpus connection differs');
        state.connection = keys.connection; await save();
        const phaseSignal = AbortSignal.any([signal, AbortSignal.timeout(config.limits.runHours * 3600000)].filter(Boolean));
        for (const id of ids) {
            phaseSignal.throwIfAborted();
            const existing = state.questions[id];
            if (existing?.status === 'ready') {
                assert.equal(existing.sourceHash, manifest.sources[id]); assert.deepEqual(existing.entry, { ...manifest.collections[id], absent: false });
                continue;
            }
            assert(!existing, 'Prior ingestion is incomplete or failed; inspect receipts and explicitly clean the corpus, never retry ambiguous writes');
            const q = { ...newUsage(), id, status: 'pending', sourceHash: manifest.sources[id], entry: { ...manifest.collections[id], absent: false } };
            state.questions[id] = q; await save(); // Ownership is durable before create can reach the service.
            const journal = new Journal({ root: questionPath(canonical, id), config, binding: state.binding, credentials: keys, state: q, save, fetcher,
                signal: AbortSignal.any([phaseSignal, AbortSignal.timeout(config.limits.questionSeconds * 1000)]) });
            try {
                await ingest(journal, prepareCase(rows.get(id), config), q.entry, manifest.storage);
                q.status = 'ready'; q.readyAt = new Date().toISOString(); await save();
            } catch (error) { q.status = 'failed'; await save(); throw error; }
        }
        return { ready: Object.values(state.questions).filter(q => q.status === 'ready').length, planned: manifest.ids.length,
            databaseOperations: Object.values(state.questions).reduce((sum, q) => sum + q.databaseOperations, 0) };
    });
}
export async function proof(root, config, limit) {
    const manifest = await readJSON(path.join(root, 'corpus.json')), rows = await dataset(root, config.dataset);
    const ids = selectedIds(manifest, limit); compatible(manifest, rows, config, ids);
    const state = await corpusState(root, manifest); assert(!state.retired, 'Corpus is retired');
    const entries = Object.fromEntries(ids.map(id => {
        const q = state.questions[id]; assert.equal(q?.status, 'ready', `Corpus question is not ready: ${id}`);
        assert.equal(q.sourceHash, manifest.sources[id]); assert.deepEqual(q.entry, { ...manifest.collections[id], absent: false });
        return [id, { sourceHash: q.sourceHash, entry: q.entry, readyAt: q.readyAt }];
    }));
    return { manifest, connection: state.connection, entries };
}
export async function cleanupCorpus(root, keys, { fetcher = fetch } = {}) {
    return lease(root, async canonical => {
        // No current dataset, evaluation config, or source fingerprint is required to delete explicitly owned resources.
        const manifest = await readJSON(path.join(canonical, 'corpus.json')), state = await corpusState(canonical, manifest);
        assert.equal(state.connection, keys.connection, 'Corpus connection differs');
        const save = () => atomic(path.join(canonical, 'corpus-state.json'), state);
        state.retired = true; await save();
        for (const [id, q] of Object.entries(state.questions)) {
            assert(manifest.ids.includes(id)); assert.deepEqual({ ...q.entry, absent: false }, { ...manifest.collections[id], absent: false });
            if (q.entry.absent) continue;
            const config = { limits: { ...manifest.lifecycle.limits,
                cleanupOperations: q.cleanupOperations + manifest.lifecycle.limits.cleanupOperations } };
            await cleanup(new Journal({ root: questionPath(canonical, id), config, binding: state.binding,
                credentials: keys, state: q, save, fetcher }), q.entry);
            q.status = 'deleted'; await save();
        }
    });
}
