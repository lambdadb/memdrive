import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { HTTPClient, LambdaDBClient, MemDrive } from '@functional-systems/memdrive';

const enabled = process.env.MEMDRIVE_RUN_LIVE_TESTS === '1' && process.env.MEMDRIVE_RUN_LIVE_EXTERNAL_VECTOR_TESTS === '1';
const required = ['LAMBDADB_BASE_URL', 'LAMBDADB_PROJECT_NAME', 'LAMBDADB_PROJECT_API_KEY'];
const options = () => ({ signal: AbortSignal.timeout(270_000) });
const statusOf = error => error?.status ?? error?.statusCode;
const vector = (...coordinates) => [...coordinates, ...Array(64 - coordinates.length).fill(0)];
const branch = name => ({ kind: 'branch', name });
const tag = name => ({ kind: 'tag', name });
const originalId = fileId => `file:${fileId}`;

test('live external vectors preserve private application text, checkpoints and rollback', {
    skip: enabled ? false : 'Set MEMDRIVE_RUN_LIVE_TESTS=1 and MEMDRIVE_RUN_LIVE_EXTERNAL_VECTOR_TESTS=1 for live resources.',
    timeout: 600_000,
}, async t => {
    for (const key of required) assert(process.env[key]?.trim(), `Missing live configuration: ${key}`);
    const project = process.env.LAMBDADB_PROJECT_NAME, key = process.env.LAMBDADB_PROJECT_API_KEY;
    const endpoint = new URL(process.env.LAMBDADB_BASE_URL);
    assert(endpoint.protocol === 'https:' && endpoint.href === endpoint.origin + '/', 'Expected an HTTPS project origin.');
    const owner = randomUUID(), name = 'md-live-vector-' + owner;
    const root = `/projects/${encodeURIComponent(project)}/collections`;
    const names = new Set([name]), created = new Set();
    const privateMarker = `synthetic-local-only-${randomUUID()}`;
    const localTexts = new Map();
    const privateNotes = [0, 1, 2].map(index => `${privateMarker} document ${index}`);
    const topic = 'owner "synth" * 한글';
    const observed = { vectors: [], queries: [] };
    const model = { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'synthetic-sillymemory-v1' };
    const input = vector(2.437500000100123, 0.12345678901234566, -0.0312500019);
    const canonical = input.map(Math.fround);
    const query = vector(1);
    const orthogonal = vector(0, 1.75);
    const opposite = vector(-1.875);
    const capturedVector = vector(0, 0, 1.75);
    const laterVector = vector(0, 0, 0, 1.375);
    const sourceRef = branch('fork-source-vector');
    let failure;
    let phase = 'Create the external vector fixture';

    const safeFailure = (step, error) => {
        const detail = error instanceof assert.AssertionError && !error.message.includes(key) && !error.message.includes(privateMarker)
            ? ' ' + error.message.split('\n')[0] : '';
        return new Error(`${step} failed (${error?.code ?? error?.name ?? 'Error'}${statusOf(error) ? `, status ${statusOf(error)}` : ''}).${detail}`);
    };
    const noPayloadText = doc => {
        assert(!Object.hasOwn(doc, 'body') && !Object.hasOwn(doc, 'content'), 'An external vector record exposed raw text.');
        assert.notEqual(doc.kind, 'chunk', 'An external vector record was written as a chunk.');
    };

    function client() {
        const httpClient = new HTTPClient({ fetcher: async request => {
            const url = new URL(request.url);
            assert.equal(url.origin, endpoint.origin);
            const collection = url.pathname.slice(root.length + 1).split('/')[0];
            assert(url.pathname === root || (url.pathname.startsWith(root + '/') && names.has(collection)),
                'Native request escaped its isolated fixture.');
            if (request.method === 'POST' && request.body) {
                const raw = await request.clone().text();
                assert(!raw.includes(privateMarker), 'Application-only text appeared on the wire.');
                const body = JSON.parse(raw);
                if (url.pathname === root) assert(names.has(body.collectionName), 'Unknown collection creation.');
                if (collection === name) {
                    for (const doc of body.docs ?? []) {
                        noPayloadText(doc);
                        if (doc.embedding !== undefined) observed.vectors.push({ branch: body.branch, id: doc.id, vector: doc.embedding });
                    }
                    assert(!raw.includes('"queryText"') && !Object.hasOwn(body, 'rerank'), 'Vector lookup requested managed inference.');
                    if (body.query?.knn) observed.queries.push(body.query.knn.queryVector);
                }
            }
            const response = await fetch(request, { redirect: 'error' });
            if (url.pathname === root && request.method === 'POST' && response.status === 201) {
                const body = await response.clone().json();
                const found = body.collection;
                assert(names.has(found.collectionName), 'The collection response does not match the fixture.');
                created.add(found.collectionName);
            }
            if (!response.ok && response.status !== 404)
                t.diagnostic(`Native ${request.method} ${url.pathname.split('/').at(-1)} returned HTTP ${response.status}.`);
            return response;
        } });
        return new LambdaDBClient({ baseUrl: endpoint.origin, projectName: project, projectApiKey: key, httpClient,
            timeoutMs: 60_000, retryConfig: { strategy: 'none' }, debugLogger: { log() {}, group() {}, groupEnd() {} } });
    }

    const native = client(), handle = native.collection(name);
    // A view is one drive object plus an explicit at; omitted at selects main.
    const open = async at => ({ drive: await MemDrive.open({ client: client(), name, mode: 'external' }, options()), at });
    // The SDK sends a rollback once. A just-created checkpoint can be rejected with a
    // definite 400 until its snapshot is published; only the test waits for that.
    async function rollbackWhenPublished(drive, request) {
        const deadline = Date.now() + 120_000;
        for (;;) {
            try { return await drive.rollback(request, options()); }
            catch (error) {
                if (error?.status !== 400 || !/published snapshot/i.test(String(error?.cause?.message)) || Date.now() > deadline) throw error;
                await sleep(5_000);
            }
        }
    }
    async function records(ref, ids) {
        const response = await handle.docs.fetch({ ref, ids: ids.map(originalId), includeVectors: true,
            consistentRead: ref.kind === 'branch' }, options());
        assert.equal(response.total, response.docs.length);
        assert(response.docs.every(hit => hit.collection === name));
        return new Map(response.docs.map(({ doc }) => {
            noPayloadText(doc);
            assert.equal(doc.kind, 'file');
            return [doc.fileId, doc.embedding];
        }));
    }
    async function nearest(view, expected, { probe = query, limit = expected.length, filter } = {}) {
        const { hits, reranked } = await view.drive.search({ at: view.at, query: probe, limit, ...(filter ? { filter } : {}) }, options());
        assert.equal(reranked, false);
        assert.deepEqual(hits.map(hit => hit.fileId), expected);
        for (const hit of hits) {
            noPayloadText(hit);
            assert(!Object.hasOwn(hit, 'embedding'), 'A public search result exposed the stored vector.');
        }
        return hits;
    }

    try {
        const main = await MemDrive.create({ client: native, name, embedding: model, labels: { 'eval.owner': owner },
            metadataSchema: { topic: { type: 'string' }, rank: { type: 'number' } } }, options());
        assert.deepEqual((await main.describe({}, options())).embedding, model);
        // The store is a single collection: the fetcher rejects any other collection creation.
        assert.deepEqual([...created], [name]);
        assert.deepEqual((await (await open()).drive.list({}, options())).files, []);

        const { collection } = await handle.get(options());
        assert.equal(collection.indexConfigs.embedding.type, 'vector');
        assert.equal(collection.indexConfigs.embedding.dimensions, 64);
        assert.equal(collection.indexConfigs.embedding.similarity, 'cosine');
        assert(!collection.indexConfigs.embedding.managedEmbedding && !collection.indexConfigs.embedding.embedding);
        assert(!Object.hasOwn(collection.indexConfigs, 'content') && !Object.hasOwn(collection.indexConfigs, 'body'));
        assert.equal(collection.snapshotRetentionInDays, 1);
        const work = { drive: main, at: (await main.fork({ name: 'source-vector' }, options())).at };
        assert.deepEqual(work.at, { kind: 'fork', name: 'source-vector' });
        const [a, b, c] = await main.write({ at: work.at, operations: [
            { op: 'create', path: '/opaque/a', content: input, metadata: { topic: 'initial', rank: 12 } },
            { op: 'create', path: '/opaque/b', content: orthogonal, metadata: { topic, rank: 1 } },
            { op: 'create', path: '/opaque/c', content: opposite, metadata: { topic: 'owner "synth" X 한글', rank: 12 } },
        ] }, options());
        const ids = [a.fileId, b.fileId, c.fileId];
        for (const [index, fileId] of ids.entries()) localTexts.set(fileId, privateNotes[index]);
        const sent = observed.vectors.find(({ branch, id }) => branch === sourceRef.name && id === originalId(a.fileId));
        assert.deepEqual(sent?.vector, canonical, 'Wire payload must use exact caller-equivalent Float32 coordinates.');
        assert.notDeepEqual(sent.vector, input, 'Fixture must distinguish JavaScript and Float32 precision.');

        phase = 'Inspect native originals and hydrate reference-only search';
        const nativeVectors = await records(sourceRef, ids);
        assert.deepEqual(nativeVectors.get(a.fileId).map(Math.fround), canonical);
        assert.deepEqual(nativeVectors.get(b.fileId).map(Math.fround), orthogonal);
        assert.deepEqual(nativeVectors.get(c.fileId).map(Math.fround), opposite);
        const scan = await handle.query({ ref: sourceRef, consistentRead: true, includeVectors: true, size: 10 }, options());
        assert.equal(scan.docs.length, ids.length);
        assert(scan.docs.every(hit => hit.doc.kind === 'file'));
        assert.deepEqual(scan.docs.map(hit => hit.doc.fileId).sort(), [...ids].sort());
        const fresh = await open({ kind: 'fork', name: 'source-vector' });
        const results = await nearest(fresh, [a.fileId, b.fileId], { probe: input });
        assert.deepEqual(results.map(hit => localTexts.get(hit.fileId)), [localTexts.get(a.fileId), localTexts.get(b.fileId)]);
        assert(observed.queries.some(probe => JSON.stringify(probe) === JSON.stringify(canonical)),
            'Query must preserve the same Float32 coordinates on the wire.');
        const read = await fresh.drive.read({ at: fresh.at, fileId: a.fileId }, options());
        noPayloadText(read);
        assert(!Object.hasOwn(read, 'embedding'), 'A public read exposed the stored vector.');

        phase = 'Move and update metadata without changing the vector';
        await main.write({ at: work.at, op: 'update', fileId: a.fileId, newPath: '/moved/a', metadata: { topic, rank: 12 } }, options());
        assert.deepEqual((await records(sourceRef, [a.fileId])).get(a.fileId), nativeVectors.get(a.fileId));
        await nearest(fresh, [a.fileId, b.fileId]);
        const [filtered] = await nearest(fresh, [a.fileId], { limit: 3, filter: { and: [
            { field: 'metadata.topic', op: 'eq', value: topic }, { field: 'metadata.rank', op: 'gte', value: 10 },
            { field: 'metadata.rank', op: 'lt', value: 13 },
        ] } });
        assert.equal(filtered.path, '/moved/a');
        assert.deepEqual(filtered.metadata, { topic, rank: 12 });
        t.diagnostic('Native records were file-only; Float32 wire was exact and the non-unit vector survived a path/metadata change.');

        phase = 'Write a vector file to main';
        // Omitted at writes to main; the fork stays isolated from it.
        const mainFile = await main.write({ op: 'create', path: '/main/vector', content: laterVector, metadata: { topic: 'main', rank: 3 } }, options());
        noPayloadText(mainFile);
        assert.deepEqual(await main.read({ fileId: mainFile.fileId }, options()), mainFile);
        assert.equal(await main.read({ at: work.at, fileId: mainFile.fileId }, options()), null);
        assert.equal(await main.read({ fileId: a.fileId }, options()), null);
        assert.deepEqual((await records(branch('main'), [mainFile.fileId])).get(mainFile.fileId).map(Math.fround), laterVector);
        await nearest(await open(), [mainFile.fileId], { probe: laterVector, limit: 1 });

        phase = 'Checkpoint the fork and change it afterwards';
        const checkpointAt = (await main.checkpoint({ at: work.at, name: 'initial-vector-view' }, options())).at;
        const checkpointRef = tag('checkpoint-initial-vector-view');
        await assert.rejects(main.write({ at: checkpointAt, op: 'delete', fileId: b.fileId }, options()), { code: 'INVALID_INPUT' });
        await main.write({ at: work.at, op: 'update', fileId: a.fileId, content: capturedVector }, options());
        assert.deepEqual(await main.write({ at: work.at, op: 'delete', fileId: b.fileId }, options()), { fileId: b.fileId });
        assert.equal(await main.read({ at: work.at, fileId: b.fileId }, options()), null);
        assert.equal((await records(sourceRef, [b.fileId])).size, 0);
        assert.deepEqual((await records(sourceRef, [a.fileId])).get(a.fileId).map(Math.fround), capturedVector);
        const checkpoint = await open(checkpointAt);
        assert.deepEqual((await records(checkpointRef, [a.fileId])).get(a.fileId), nativeVectors.get(a.fileId));
        assert.equal((await checkpoint.drive.read({ at: checkpoint.at, fileId: b.fileId }, options())).path, b.path);
        await nearest(checkpoint, [a.fileId, b.fileId]);
        await nearest(fresh, [a.fileId], { probe: capturedVector, limit: 1 });

        phase = 'Roll the fork back to its checkpoint';
        assert.deepEqual(await rollbackWhenPublished(fresh.drive, { at: work.at, to: checkpointAt }), { at: work.at });
        assert.deepEqual((await records(sourceRef, [a.fileId, b.fileId])).get(a.fileId), nativeVectors.get(a.fileId));
        assert.equal((await fresh.drive.read({ at: work.at, fileId: b.fileId }, options())).path, b.path);
        await nearest(fresh, [a.fileId, b.fileId]);
        // Main is unaffected by a fork's rollback.
        assert.deepEqual(await main.read({ fileId: mainFile.fileId }, options()), mainFile);
        t.diagnostic('The checkpoint froze the fork vectors; rollback restored the moved vector and the deleted file.');

        phase = 'List and delete refs';
        const listed = (await main.list({ at: work.at, limit: 1000 }, options())).files;
        for (const file of listed) {
            noPayloadText(file);
            assert(!Object.hasOwn(file, 'embedding'), 'A public list exposed the stored vector.');
        }
        assert.deepEqual((await main.listForks({}, options())).forks.map(entry => entry.at), [work.at]);
        assert.deepEqual((await main.listCheckpoints({}, options())).checkpoints.map(entry => entry.at), [checkpointAt]);
        // The fork's latest checkpoint cannot be deleted until the fork, and its alias, are gone.
        await assert.rejects(main.deleteCheckpoint({ at: checkpointAt }, options()), { code: 'CHECKPOINT_IN_USE' });
        assert.deepEqual(await main.deleteFork({ at: work.at }, options()), { at: work.at });
        await assert.rejects(main.read({ at: work.at, fileId: a.fileId }, options()), { code: 'BRANCH_NOT_FOUND' });
        assert.deepEqual(await main.deleteCheckpoint({ at: checkpointAt }, options()), { at: checkpointAt });
        await assert.rejects(main.read({ at: checkpointAt, fileId: a.fileId }, options()), { code: 'CHECKPOINT_NOT_FOUND' });
        assert.deepEqual(await main.listForks({}, options()), { forks: [] });
        assert.deepEqual(await main.listCheckpoints({}, options()), { checkpoints: [] });
    } catch (error) {
        failure = safeFailure(phase, error);
    } finally {
        for (const collection of [...created].reverse()) {
            try {
                const owned = native.collection(collection);
                const { collection: metadata } = await owned.get(options());
                assert.equal(metadata.collectionName, collection);
                assert.equal(metadata.tags?.['eval.owner'], owner);
                await owned.delete(options());
                let absent = false;
                for (let attempt = 0; attempt < 8; attempt++) {
                    try { await owned.get(options()); }
                    catch (error) {
                        if (statusOf(error) === 404) { absent = true; break; }
                        throw error;
                    }
                    await sleep(500);
                }
                assert(absent, 'Fixture cleanup was not confirmed.');
                t.diagnostic(`Owned fixture cleanup confirmed GET 404 for ${collection}.`);
            } catch (error) {
                const cleanup = safeFailure('Fixture cleanup', error);
                failure = failure ? new AggregateError([failure, cleanup]) : cleanup;
            }
        }
    }
    if (failure) throw failure;
});
