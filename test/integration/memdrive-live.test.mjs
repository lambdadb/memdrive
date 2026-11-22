import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { HTTPClient, LambdaDBClient } from '@functional-systems/lambdadb';
import { MemDrive } from '@functional-systems/memdrive';

const enabled = process.env.MEMDRIVE_RUN_LIVE_TESTS === '1';
const verifyCheckpoints = process.env.MEMDRIVE_RUN_LIVE_CHECKPOINT_TESTS === '1';
const verifyListConvergence = process.env.MEMDRIVE_RUN_LIVE_LIST_TESTS === '1';
const required = ['LAMBDADB_BASE_URL', 'LAMBDADB_PROJECT_NAME', 'LAMBDADB_PROJECT_API_KEY'];
const options = () => ({ signal: AbortSignal.timeout(60_000) });
const statusOf = error => error?.status ?? error?.statusCode;
const safeFailure = (phase, error) => {
    // Assertions inspect only the synthetic fixtures, never native requests.
    const detail = error instanceof assert.AssertionError ? ` ${error.message}` : '';
    return new Error(`${phase} failed (${error?.code ?? error?.name ?? 'Error'}${statusOf(error) ? `, status ${statusOf(error)}` : ''}).${detail}`);
};

test('live file store writes, searches, lists and reopens a fresh fork with verified cleanup', {
    skip: enabled ? false : 'Set MEMDRIVE_RUN_LIVE_TESTS=1 to permit live resources.',
    timeout: 600_000,
}, async t => {
    for (const key of required) assert(process.env[key]?.trim(), `Missing live configuration: ${key}`);
    assert(!/[\r\n]/.test(process.env.LAMBDADB_PROJECT_API_KEY.trim()), 'Expected a single project API key.');
    const httpClient = new HTTPClient();
    httpClient.addHook('response', (response, request) => {
        // Log only the failing operation, without hostname, query, headers or body.
        if (!response.ok && response.status !== 404)
            t.diagnostic(`${request.method} ${new URL(request.url).pathname} -> HTTP ${response.status}`);
    });
    const connection = { httpClient, baseUrl: process.env.LAMBDADB_BASE_URL,
        projectName: process.env.LAMBDADB_PROJECT_NAME, projectApiKey: process.env.LAMBDADB_PROJECT_API_KEY,
        timeoutMs: 60_000, retryConfig: { strategy: 'none' },
        debugLogger: { log() {}, group() {}, groupEnd() {} } };
    const client = new LambdaDBClient(connection);
    const name = `memdrive-smoke-files-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    let failure, collision = false;
    try {
        const main = await MemDrive.create({ client, name, metadataSchema: { topic: { type: 'string' } } }, options());
        assert.equal('write' in main, false);
        assert.equal('diff' in main, false);
        await assert.rejects(MemDrive.open({ client, name, at: { checkpoint: 'never-created' } }, options()),
            { code: 'CHECKPOINT_NOT_FOUND', status: 404 });
        assert.deepEqual(await main.list({}, options()), { files: [], prefixes: [], consistency: 'eventual' });
        const fork = await main.fork({ name: 'research' }, options());
        assert.deepEqual(await main.listForks(options()), [{ name: 'research' }]);
        assert.deepEqual(await main.listCheckpoints(options()), []);
        const path = '/notes/한글 "draft":*?.md';
        const content = '# Synthetic note\r\n Trailing space \n';
        const [original, empty, nested] = await fork.write([
            { op: 'create', path, content, metadata: { topic: 'synthetic' } },
            { op: 'create', path: '/empty.txt', content: '' },
            { op: 'create', path: '/notes/sub/also "draft":*?.txt', content: '' },
        ], options());
        const reopened = await MemDrive.open({ client: new LambdaDBClient(connection), name, at: { fork: 'research' } }, options());
        const additions = [original, empty, nested].map(({ fileId, path }) => ({ op: 'create', fileId, path }))
            .sort((a, b) => a.fileId.localeCompare(b.fileId));
        assert.deepEqual(await reopened.diff(options()), additions);
        const listStartedAt = Date.now();
        let listed = await reopened.list({ prefix: '/notes/' }, options());
        t.diagnostic(`Initial list observed ${listed.files.length} file(s).`);
        const reference = ({ fileId, path, modifiedAt, metadata }) => ({
            fileId, path, modifiedAt, ...(metadata === undefined ? {} : { metadata }),
        });
        const expected = [reference(nested), reference(original)];
        assert.deepEqual(listed, {
            files: expected.filter(file => listed.files.some(row => row.fileId === file.fileId)),
            prefixes: [], consistency: 'eventual',
        });
        assert.deepEqual(await main.list({ prefix: '/notes/' }, options()), { files: [], prefixes: [], consistency: 'eventual' });

        // The release smoke checks the preview contract without a freshness
        // deadline. The opt-in diagnostic observes convergence in this run.
        if (verifyListConvergence) {
            const deadline = listStartedAt + 150_000;
            while (listed.files.length < expected.length && Date.now() < deadline) {
                await sleep(Math.min(5_000, Math.max(0, deadline - Date.now())));
                const remaining = deadline - Date.now();
                if (remaining <= 0) break;
                listed = await reopened.list({ prefix: '/notes/' }, { signal: AbortSignal.timeout(remaining) });
            }
            t.diagnostic(`Expected file set checked ${Date.now() - listStartedAt} ms after the first list request started.`);
            assert.deepEqual(listed.files, expected);
            const first = await reopened.list({ prefix: '/notes/', nameContains: '"draft":*?', delimiter: '/', limit: 1 }, options());
            assert.deepEqual(first.prefixes, ['/notes/sub/']);
            assert.deepEqual(first.files, []);
            assert(first.cursor);
            const last = await reopened.list({ cursor: first.cursor }, options());
            assert.deepEqual(last, { files: [reference(original)], prefixes: [], consistency: 'eventual' });
            assert.deepEqual(await reopened.list({ cursor: first.cursor }, options()), last);
            assert.deepEqual((await reopened.list({ prefix: '/notes/', nameContains: 'also' }, options())).files, [reference(nested)]);
        }

        assert.deepEqual(await reopened.read({ path }, options()), original);
        assert.equal(original.content, content);
        assert.deepEqual(original.metadata, { topic: 'synthetic' });
        assert.deepEqual(await reopened.read({ fileId: original.fileId }, options()), original);
        assert.deepEqual(await reopened.read({ path: '/empty.txt' }, options()), empty);
        assert.equal(empty.content, '');
        await assert.rejects(reopened.write({ op: 'create', path, content: 'Duplicate' }, options()), { code: 'PATH_EXISTS' });
        assert.equal(await main.read({ fileId: original.fileId }, options()), null);
        const ranked = await reopened.search({ query: 'synthetic note', limit: 4 }, options());
        assert.equal(ranked.reranked, true);
        assert.deepEqual(ranked.hits, [{ ...original, range: { start: 0, end: content.length } }]);
        const fused = await reopened.search({ query: 'synthetic note', limit: 4, rerank: false }, options());
        assert.equal(fused.reranked, false);
        assert.deepEqual(fused.hits, ranked.hits);

        const topic = value => ({ field: 'metadata.topic', op: 'eq', value });
        const distractor = await reopened.write({
            op: 'create', path: '/unmatched.txt', content, metadata: { topic: 'unmatched' },
        }, options());
        const filtered = await reopened.search({ query: 'synthetic note', filter: topic('synthetic'), limit: 1 }, options());
        assert.equal(filtered.reranked, true);
        assert.deepEqual(filtered.hits, ranked.hits);
        const unmatched = await reopened.search({
            query: 'synthetic note', filter: topic('unmatched'), rerank: false,
        }, options());
        assert.deepEqual(unmatched.hits.map(hit => hit.fileId), [distractor.fileId]);
        await reopened.write({ op: 'delete', fileId: distractor.fileId }, options());

        const native = client.collection(name);
        const branchRead = { ref: { kind: 'branch', name: 'fork-research' }, consistentRead: true };
        const chunkIds = async () => (await native.query({ ...branchRead, size: 10, fields: { include: ['id'] },
            query: { queryString: { query: '"chunk"', defaultField: 'kind' } } }, options())).docs.map(hit => hit.doc.id);
        const oldIds = await chunkIds();
        assert.equal(oldIds.length, 1);
        const moved = await reopened.write({ op: 'update', fileId: original.fileId, newPath: '/archive/synthetic.md' }, options());
        assert.equal(moved.content, original.content);
        assert.deepEqual(moved.metadata, original.metadata);
        assert.equal(await reopened.read({ path }, options()), null);
        assert.deepEqual(await reopened.read({ path: moved.path }, options()), moved);
        assert.deepEqual(await chunkIds(), oldIds);
        const renamedTopic = await reopened.write({
            op: 'update', fileId: moved.fileId, metadata: { topic: 'updated' },
        }, options());
        assert.equal(renamedTopic.content, moved.content);
        assert.deepEqual((await reopened.search({
            query: 'synthetic note', filter: topic('updated'), rerank: false,
        }, options())).hits.map(hit => hit.fileId), [moved.fileId]);
        assert.deepEqual((await reopened.search({
            query: 'synthetic note', filter: topic('synthetic'), rerank: false,
        }, options())).hits, []);
        const changed = await reopened.write({ op: 'update', fileId: moved.fileId, metadata: {},
            edits: [{ oldText: 'Synthetic note', newText: 'Updated fixture' }] }, options());
        assert.equal(changed.content, content.replace('Synthetic note', 'Updated fixture'));
        assert.equal(Object.hasOwn(changed, 'metadata'), false);
        assert.deepEqual(await reopened.read({ fileId: changed.fileId }, options()), changed);
        assert.equal((await native.docs.fetch({ ...branchRead, ids: oldIds }, options())).docs.length, 0);
        const newIds = await chunkIds();
        assert.equal(newIds.length, 1);
        assert.notDeepEqual(newIds, oldIds);
        const changedResults = await reopened.search({ query: 'Updated fixture', rerank: false }, options());
        assert.deepEqual(changedResults.hits, [{ ...changed, range: { start: 0, end: changed.content.length } }]);
        const absentTopic = { field: 'metadata.topic', op: 'exists', value: false };
        assert.deepEqual((await reopened.search({
            query: 'Updated fixture', filter: absentTopic, rerank: false,
        }, options())).hits, changedResults.hits);
        assert.deepEqual((await reopened.search({
            query: 'Updated fixture', filter: topic('updated'), rerank: false,
        }, options())).hits, []);
        t.diagnostic('Managed search scoped candidates to matching chunk metadata after replacement and clear.');
        assert.deepEqual(await reopened.diff(options()), additions.map(change =>
            change.fileId === changed.fileId ? { ...change, path: changed.path } : change));
        assert.deepEqual(await reopened.write({ op: 'delete', fileId: changed.fileId }, options()), { fileId: changed.fileId });
        assert.equal(await reopened.read({ fileId: changed.fileId }, options()), null);
        assert.equal(await reopened.read({ path: changed.path }, options()), null);
        assert.deepEqual(await reopened.diff(options()), additions.filter(change => change.fileId !== changed.fileId));
        assert.equal((await native.docs.fetch({ ...branchRead, ids: newIds }, options())).docs.length, 0);
        assert.deepEqual(await reopened.write({ op: 'delete', fileId: changed.fileId }, options()), { fileId: changed.fileId });

        if (verifyCheckpoints) {
            const sample = await reopened.write({
                op: 'create', path: '/checkpoint.txt', content: 'Synthetic reference retained in the checkpoint.',
            }, options());
            // Seed a published-style original in this disposable store for the tombstone assertion.
            await native.docs.update({ branch: 'fork-research', docs: [{
                id: `file:${nested.fileId}`, version: 'synthetic-base', changed: false,
            }] }, options());
            await reopened.write({ op: 'delete', fileId: nested.fileId }, options());

            // The setup waits for observable file state before calling checkpoint once.
            const deadline = Date.now() + 150_000;
            let prepared = false;
            for (let remaining = deadline - Date.now(); remaining > 0; remaining = deadline - Date.now()) {
                const listed = await reopened.list({}, { signal: AbortSignal.timeout(remaining) });
                prepared = listed.files.some(file => file.fileId === sample.fileId)
                    && !listed.files.some(file => file.fileId === nested.fileId);
                if (prepared) break;
                await sleep(Math.min(5_000, Math.max(0, deadline - Date.now())));
            }
            assert(prepared, 'Checkpoint fixture did not reach the expected list state.');
            const checkpoint = await reopened.checkpoint({ name: 'retained' }, options());
            assert.equal('write' in checkpoint, false);
            const directChild = await reopened.fork({ name: 'from-working' }, options());
            assert.deepEqual(await directChild.read({ fileId: sample.fileId }, options()), sample);
            assert.equal(await directChild.read({ fileId: nested.fileId }, options()), null);
            const movedSource = await reopened.write({ op: 'update', fileId: sample.fileId, newPath: '/after-checkpoint.txt' }, options());
            assert.deepEqual(await checkpoint.read({ paths: [sample.path, movedSource.path] }, options()), [sample]);
            await reopened.delete(options());
            await assert.rejects(native.branches.get('fork-research', options()), error => statusOf(error) === 404);
            t.diagnostic('Working source deletion verified before reopening and forking the checkpoint.');

            const pinned = await MemDrive.open({ client: new LambdaDBClient(connection), name,
                at: { checkpoint: 'retained' } }, options());
            assert.deepEqual(await pinned.read({ fileId: sample.fileId }, options()), sample);
            assert.equal((await pinned.list({}, options())).consistency, 'eventual');
            const child = await pinned.fork({ name: 'from-checkpoint' }, options());
            assert.deepEqual(await child.read({ fileId: sample.fileId }, options()), sample);
            assert.deepEqual(await child.write({ op: 'update', fileId: sample.fileId, newPath: '/child-only.txt' }, options()),
                await child.read({ path: '/child-only.txt' }, options()));
            assert.deepEqual(await pinned.read({ fileId: sample.fileId }, options()), sample);
            assert.equal(await pinned.read({ fileId: nested.fileId }, options()), null);
            assert.equal(await child.read({ fileId: nested.fileId }, options()), null);
            assert.deepEqual((await child.diff(options())).find(change => change.fileId === nested.fileId),
                { op: 'delete', fileId: nested.fileId, previousPath: nested.path });
            const rankedPin = await pinned.search({ query: 'Synthetic reference', rerank: false }, options());
            assert.deepEqual(rankedPin.hits, [{ ...sample, range: { start: 0, end: sample.content.length } }]);
            const copied = await pinned.checkpoint({ name: 'copied' }, options());
            assert.deepEqual(await copied.read({ fileId: sample.fileId }, options()), sample);
            assert.deepEqual(await main.listCheckpoints(options()), [{ name: 'copied' }, { name: 'retained' }]);
            await copied.delete(options());
            await pinned.delete(options());
            assert.deepEqual(await main.listCheckpoints(options()), []);
        } else {
            t.diagnostic('Checkpoint capture and fork validation are opt-in through MEMDRIVE_RUN_LIVE_CHECKPOINT_TESTS=1.');
            await reopened.delete(options());
            assert.deepEqual(await main.listForks(options()), []);
        }
        await MemDrive.destroy({ client, name }, options());
        await assert.rejects(main.status(options()), { code: 'STORE_DELETED' });
        await assert.rejects(client.collection(name).get(options()), error => statusOf(error) === 404);
        t.diagnostic('Public ref deletion and store destruction confirmed.');
    } catch (error) {
        collision = error?.code === 'STORE_EXISTS';
        failure = safeFailure('File store smoke', error);
    } finally {
        if (!collision) {
            try {
                await client.collection(name).delete(options());
            } catch (error) {
                if (statusOf(error) !== 404) {
                    const cleanup = safeFailure(`Cleanup of ${name}`, error);
                    failure = failure ? new AggregateError([failure, cleanup], 'Smoke and cleanup failed.') : cleanup;
                }
            }
            try {
                await assert.rejects(client.collection(name).get(options()), error => statusOf(error) === 404);
                t.diagnostic(`Temporary collection ${name} deletion verified with HTTP 404.`);
            } catch (error) {
                const cleanup = safeFailure(`Deletion verification for ${name}`, error);
                failure = failure ? new AggregateError([failure, cleanup], 'Smoke or cleanup verification failed.') : cleanup;
            }
        }
    }
    if (failure) throw failure;
});
