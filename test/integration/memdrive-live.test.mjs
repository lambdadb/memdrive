import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { HTTPClient, LambdaDBClient, MemDrive } from '@functional-systems/memdrive';

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

// The SDK sends a rollback once. A just-created checkpoint can be rejected with a
// definite 400 until its snapshot is published; only the test waits for that.
async function rollbackWhenPublished(drive, request, t) {
    const deadline = Date.now() + 120_000;
    for (let attempt = 1; ; attempt++) {
        try { return await drive.rollback(request, options()); }
        catch (error) {
            if (error?.status !== 400 || !/published snapshot/i.test(String(error?.cause?.message)) || Date.now() > deadline) throw error;
            t.diagnostic(`Rollback attempt ${attempt} waits for the checkpoint snapshot.`);
            await sleep(5_000);
        }
    }
}

test('live file store writes main and forks, searches, lists, checkpoints and rolls back with verified cleanup', {
    skip: enabled ? false : 'Set MEMDRIVE_RUN_LIVE_TESTS=1 to permit live resources.',
    timeout: 600_000,
}, async t => {
    for (const key of required) assert(process.env[key]?.trim(), `Missing live configuration: ${key}`);
    assert(!/[\r\n]/.test(process.env.LAMBDADB_PROJECT_API_KEY.trim()), 'Expected a single project API key.');
    const httpClient = new HTTPClient();
    let collectionCreations = 0;
    httpClient.addHook('response', (response, request) => {
        const { pathname } = new URL(request.url);
        if (request.method === 'POST' && pathname.endsWith('/collections')) collectionCreations++;
        // Log only the failing operation, without hostname, query, headers or body.
        if (!response.ok && response.status !== 404)
            t.diagnostic(`${request.method} ${pathname} -> HTTP ${response.status}`);
    });
    const connection = { httpClient, baseUrl: process.env.LAMBDADB_BASE_URL,
        projectName: process.env.LAMBDADB_PROJECT_NAME, projectApiKey: process.env.LAMBDADB_PROJECT_API_KEY,
        timeoutMs: 60_000, retryConfig: { strategy: 'none' },
        debugLogger: { log() {}, group() {}, groupEnd() {} } };
    const client = new LambdaDBClient(connection);
    const name = `memdrive-smoke-files-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    let failure, collision = false;
    // Follow every next and deduplicate by fileId: pages come in native order and can repeat entries.
    const listAll = async (drive, request) => {
        const files = new Map(), prefixes = new Set();
        for (let page = await drive.list(request, options()); ; page = await drive.list(page.next, options())) {
            assert.equal(page.consistency, 'eventual');
            for (const file of page.files) files.set(file.fileId, file);
            for (const prefix of page.prefixes) prefixes.add(prefix);
            if (!page.next) break;
        }
        return { files: [...files.values()].sort((a, b) => a.path < b.path ? -1 : 1), prefixes: [...prefixes].sort() };
    };
    try {
        const main = await MemDrive.create({ client, name, metadataSchema: { topic: { type: 'string' } } }, options());
        // One collection per store: no internal journal or companion collection.
        assert.equal(collectionCreations, 1);
        assert.equal((await client.collection(name).get(options())).collection.snapshotRetentionInDays, 1);
        assert.equal(Object.hasOwn(await main.describe(options()), 'retentionInDays'), false);
        await assert.rejects(main.read({ at: { kind: 'checkpoint', name: 'never-created' }, path: '/x' }, options()),
            { code: 'CHECKPOINT_NOT_FOUND', status: 404 });
        // Checkpoints are read-only; the SDK rejects the target before any storage call.
        await assert.rejects(main.write({ at: { kind: 'checkpoint', name: 'never-created' }, op: 'create', path: '/x', content: '' }, options()),
            { code: 'INVALID_INPUT' });
        assert.deepEqual(await main.list({}, options()), { files: [], prefixes: [], consistency: 'eventual' });
        const research = { kind: 'fork', name: 'research' };
        assert.deepEqual(await main.fork({ name: 'research' }, options()), { at: research });
        const at = research;
        assert.deepEqual(await main.listForks({}, options()), { forks: [{ at: research }] });
        assert.deepEqual(await main.listCheckpoints({}, options()), { checkpoints: [] });

        // Omitted at writes to main directly; the fork created before it stays isolated.
        const mainFile = await main.write({ op: 'create', path: '/main.txt', content: 'Main synthetic text.' }, options());
        assert.deepEqual(await main.read({ path: '/main.txt' }, options()), mainFile);
        assert.deepEqual(await main.read({ at: { kind: 'main' }, fileId: mainFile.fileId }, options()), mainFile);
        assert.equal(await main.read({ at, fileId: mainFile.fileId }, options()), null);

        const path = '/notes/한글 "draft":*?.md';
        const content = '# Synthetic note\r\n Trailing space \n';
        const [original, empty, nested] = await main.write({ at, operations: [
            { op: 'create', path, content, metadata: { topic: 'synthetic' } },
            { op: 'create', path: '/empty.txt', content: '' },
            { op: 'create', path: '/notes/sub/also "draft":*?.txt', content: '' },
        ] }, options());
        // A separate drive object needs no prior state: every call resolves its at.
        const reopened = await MemDrive.open({ client: new LambdaDBClient(connection), name }, options());
        const firstRange = await reopened.read({ at, fileId: original.fileId, maxChars: 5 }, options());
        assert.equal(firstRange.content, content.slice(0, firstRange.range.end));
        assert.deepEqual(firstRange.at, at);
        assert.deepEqual(firstRange.next?.at, at);
        const nextRange = await reopened.read(firstRange.next, options());
        assert.equal(nextRange.content, content.slice(nextRange.range.start, nextRange.range.end));
        assert.equal(nextRange.revision, firstRange.revision);
        const listStartedAt = Date.now();
        const reference = ({ fileId, path, modifiedAt, metadata }) => ({
            fileId, path, modifiedAt, ...(metadata === undefined ? {} : { metadata }),
        });
        const expected = [reference(nested), reference(original)];
        let listed = await listAll(reopened, { at, prefix: '/notes/' });
        t.diagnostic(`Initial list observed ${listed.files.length} file(s).`);
        assert.deepEqual(listed.files, expected.filter(file => listed.files.some(row => row.fileId === file.fileId)));
        assert.deepEqual(listed.prefixes, []);
        assert.equal((await listAll(main, { prefix: '/notes/' })).files.length, 0);
        // A cursor from the drive returned by create continues on a drive returned by
        // open: both derive the store identity from the same collection creation time.
        for (const deadline = Date.now() + 120_000; ;) {
            const page = await main.list({ at, limit: 1 }, options());
            if (page.next) {
                await reopened.list(page.next, options());
                break;
            }
            assert(Date.now() < deadline, 'The fork listing never returned a second page.');
            await sleep(5_000);
        }

        // The release smoke checks the eventual contract without a freshness
        // deadline. The opt-in diagnostic observes convergence in this run.
        if (verifyListConvergence) {
            const deadline = listStartedAt + 150_000;
            while (listed.files.length < expected.length && Date.now() < deadline) {
                await sleep(Math.min(5_000, Math.max(0, deadline - Date.now())));
                listed = await listAll(reopened, { at, prefix: '/notes/' });
            }
            t.diagnostic(`Expected file set checked ${Date.now() - listStartedAt} ms after the first list request started.`);
            assert.deepEqual(listed.files, expected);
            // One native page per call: limit 1 forces several pages, possibly empty ones.
            const first = await reopened.list({ at, prefix: '/notes/', nameContains: '"draft":*?', delimiter: '/', limit: 1 }, options());
            assert(first.files.length + first.prefixes.length <= 1);
            assert.deepEqual(first.next?.at, at);
            await assert.rejects(reopened.list({ cursor: first.next.cursor }, options()), { code: 'CURSOR_VIEW_MISMATCH' });
            // The cursor is self-contained and continues on a fresh drive object.
            const fresh = await MemDrive.open({ client: new LambdaDBClient(connection), name }, options());
            const files = new Map(first.files.map(file => [file.fileId, file])), prefixes = new Set(first.prefixes);
            for (let page = await fresh.list(first.next, options()); ; page = await fresh.list(page.next, options())) {
                for (const file of page.files) files.set(file.fileId, file);
                for (const prefix of page.prefixes) prefixes.add(prefix);
                if (!page.next) break;
            }
            assert.deepEqual([...files.values()], [reference(original)]);
            assert.deepEqual([...prefixes], ['/notes/sub/']);
            assert.deepEqual((await listAll(reopened, { at, prefix: '/notes/', nameContains: 'also' })).files, [reference(nested)]);
        }

        assert.deepEqual(await reopened.read({ at, path }, options()), original);
        assert.equal(original.content, content);
        assert.deepEqual(original.metadata, { topic: 'synthetic' });
        assert.deepEqual(await reopened.read({ at, fileId: original.fileId }, options()), original);
        assert.deepEqual(await reopened.read({ at, path: '/empty.txt' }, options()), empty);
        assert.equal(empty.content, '');
        await assert.rejects(reopened.write({ at, op: 'create', path, content: 'Duplicate' }, options()), { code: 'PATH_EXISTS' });
        assert.equal(await main.read({ fileId: original.fileId }, options()), null);
        const semantic = await reopened.search({ at, query: 'synthetic note', limit: 4 }, options());
        assert.equal(semantic.reranked, false);
        assert.deepEqual(semantic.hits, [{ ...original, range: { start: 0, end: content.length } }]);
        for (const mode of ['semantic', 'keyword', 'hybrid']) {
            for (const rerank of [false, true]) {
                const result = await reopened.search({ at, query: 'synthetic note', mode, rerank, limit: 4 }, options());
                assert.equal(result.reranked, rerank);
                assert.deepEqual(result.hits, semantic.hits);
            }
        }

        const topic = value => ({ field: 'metadata.topic', op: 'eq', value });
        const distractor = await reopened.write({ at,
            op: 'create', path: '/unmatched.txt', content, metadata: { topic: 'unmatched' },
        }, options());
        const filtered = await reopened.search({ at, query: 'synthetic note', mode: 'keyword', rerank: true, embeddingQuery: 'synthetic note', filter: topic('synthetic'), limit: 1 }, options());
        assert.equal(filtered.reranked, true);
        assert.deepEqual(filtered.hits, semantic.hits);
        const unmatched = await reopened.search({ at,
            query: 'synthetic note', filter: topic('unmatched'), rerank: false,
        }, options());
        assert.deepEqual(unmatched.hits.map(hit => hit.fileId), [distractor.fileId]);
        await reopened.write({ at, op: 'delete', fileId: distractor.fileId }, options());

        const native = client.collection(name);
        const branchRead = { ref: { kind: 'branch', name: 'fork-research' }, consistentRead: true };
        const chunkIds = async () => (await native.query({ ...branchRead, size: 10, fields: { include: ['id'] },
            query: { queryString: { query: '"chunk"', defaultField: 'kind' } } }, options())).docs.map(hit => hit.doc.id);
        const oldIds = await chunkIds();
        assert.equal(oldIds.length, 1);
        const moved = await reopened.write({ at, op: 'update', fileId: original.fileId, newPath: '/archive/synthetic.md' }, options());
        assert.equal(moved.content, original.content);
        assert.deepEqual(moved.metadata, original.metadata);
        assert.equal(await reopened.read({ at, path }, options()), null);
        assert.deepEqual(await reopened.read({ at, path: moved.path }, options()), moved);
        assert.deepEqual(await chunkIds(), oldIds);
        const renamedTopic = await reopened.write({ at,
            op: 'update', fileId: moved.fileId, metadata: { topic: 'updated' },
        }, options());
        assert.equal(renamedTopic.content, moved.content);
        assert.deepEqual((await reopened.search({ at,
            query: 'synthetic note', filter: topic('updated'), rerank: false,
        }, options())).hits.map(hit => hit.fileId), [moved.fileId]);
        assert.deepEqual((await reopened.search({ at,
            query: 'synthetic note', filter: topic('synthetic'), rerank: false,
        }, options())).hits, []);
        const changed = await reopened.write({ at, op: 'update', fileId: moved.fileId, metadata: {},
            edits: [{ oldText: 'Synthetic note', newText: 'Updated fixture' }] }, options());
        assert.equal(changed.content, content.replace('Synthetic note', 'Updated fixture'));
        assert.equal(Object.hasOwn(changed, 'metadata'), false);
        assert.deepEqual(await reopened.read({ at, fileId: changed.fileId }, options()), changed);
        assert.equal((await native.docs.fetch({ ...branchRead, ids: oldIds }, options())).docs.length, 0);
        const newIds = await chunkIds();
        assert.equal(newIds.length, 1);
        assert.notDeepEqual(newIds, oldIds);
        const changedResults = await reopened.search({ at, query: 'Updated fixture', rerank: false }, options());
        assert.deepEqual(changedResults.hits, [{ ...changed, range: { start: 0, end: changed.content.length } }]);
        const absentTopic = { field: 'metadata.topic', op: 'exists', value: false };
        assert.deepEqual((await reopened.search({ at,
            query: 'Updated fixture', filter: absentTopic, rerank: false,
        }, options())).hits, changedResults.hits);
        assert.deepEqual((await reopened.search({ at,
            query: 'Updated fixture', filter: topic('updated'), rerank: false,
        }, options())).hits, []);
        t.diagnostic('Managed search scoped candidates to matching chunk metadata after replacement and clear.');
        // Delete removes the original and its chunks; no tombstone remains.
        assert.deepEqual(await reopened.write({ at, op: 'delete', fileId: changed.fileId }, options()), { fileId: changed.fileId });
        assert.equal(await reopened.read({ at, fileId: changed.fileId }, options()), null);
        assert.equal(await reopened.read({ at, path: changed.path }, options()), null);
        assert.equal((await native.docs.fetch({ ...branchRead, ids: [...newIds, `file:${changed.fileId}`] }, options())).docs.length, 0);
        assert.deepEqual(await reopened.write({ at, op: 'delete', fileId: changed.fileId }, options()), { fileId: changed.fileId });

        if (verifyCheckpoints) {
            const sample = await reopened.write({ at,
                op: 'create', path: '/checkpoint.txt', content: 'Synthetic reference retained in the checkpoint.',
            }, options());
            await reopened.write({ at, op: 'delete', fileId: nested.fileId }, options());

            // The setup waits for observable file state before calling checkpoint once.
            const deadline = Date.now() + 150_000;
            let prepared = false;
            for (let remaining = deadline - Date.now(); remaining > 0; remaining = deadline - Date.now()) {
                const listed = await listAll(reopened, { at });
                prepared = listed.files.some(file => file.fileId === sample.fileId)
                    && !listed.files.some(file => file.fileId === nested.fileId);
                if (prepared) break;
                await sleep(Math.min(5_000, Math.max(0, deadline - Date.now())));
            }
            assert(prepared, 'Checkpoint fixture did not reach the expected list state.');
            const retained = { kind: 'checkpoint', name: 'retained' };
            assert.deepEqual(await reopened.checkpoint({ at, name: 'retained' }, options()), { at: retained });
            await assert.rejects(reopened.checkpoint({ at, name: 'retained' }, options()), { code: 'CHECKPOINT_CONFLICT' });
            await assert.rejects(reopened.write({ at: retained, op: 'delete', fileId: sample.fileId }, options()), { code: 'INVALID_INPUT' });
            const fromWorking = { kind: 'fork', name: 'from-working' };
            assert.deepEqual(await reopened.fork({ at, name: 'from-working' }, options()), { at: fromWorking });
            assert.deepEqual(await reopened.read({ at: fromWorking, fileId: sample.fileId }, options()), sample);
            assert.equal(await reopened.read({ at: fromWorking, fileId: nested.fileId }, options()), null);
            const movedSource = await reopened.write({ at, op: 'update', fileId: sample.fileId, newPath: '/after-checkpoint.txt' }, options());
            assert.deepEqual(await reopened.read({ at: retained, paths: [sample.path, movedSource.path] }, options()), [sample]);
            assert.deepEqual(await reopened.deleteFork({ at }, options()), { at });
            await assert.rejects(native.branches.get('fork-research', options()), error => statusOf(error) === 404);
            await assert.rejects(reopened.read({ at, fileId: sample.fileId }, options()), { code: 'BRANCH_NOT_FOUND', status: 404 });
            await assert.rejects(reopened.write({ at, op: 'delete', fileId: sample.fileId }, options()), { code: 'BRANCH_NOT_FOUND' });
            t.diagnostic('Working source deletion verified before reopening and forking the checkpoint.');

            const pinned = await MemDrive.open({ client: new LambdaDBClient(connection), name }, options());
            assert.deepEqual(await pinned.read({ at: retained, fileId: sample.fileId }, options()), sample);
            assert.equal((await pinned.list({ at: retained }, options())).consistency, 'eventual');
            const child = (await pinned.fork({ at: retained, name: 'from-checkpoint' }, options())).at;
            assert.deepEqual(child, { kind: 'fork', name: 'from-checkpoint' });
            assert.deepEqual(await pinned.read({ at: child, fileId: sample.fileId }, options()), sample);
            assert.deepEqual(await pinned.write({ at: child, op: 'update', fileId: sample.fileId, newPath: '/child-only.txt' }, options()),
                await pinned.read({ at: child, path: '/child-only.txt' }, options()));
            assert.deepEqual(await pinned.read({ at: retained, fileId: sample.fileId }, options()), sample);
            assert.equal(await pinned.read({ at: retained, fileId: nested.fileId }, options()), null);
            assert.equal(await pinned.read({ at: child, fileId: nested.fileId }, options()), null);
            const rankedPin = await pinned.search({ at: retained, query: 'Synthetic reference', rerank: false }, options());
            assert.deepEqual(rankedPin.hits, [{ ...sample, range: { start: 0, end: sample.content.length } }]);
            // Roll the child fork back to the checkpoint: its move is undone.
            assert.deepEqual(await rollbackWhenPublished(pinned, { at: child, to: retained }, t), { at: child });
            assert.deepEqual(await pinned.read({ at: child, fileId: sample.fileId }, options()), sample);
            assert.equal(await pinned.read({ at: child, path: '/child-only.txt' }, options()), null);
            const copied = (await pinned.checkpoint({ at: retained, name: 'copied' }, options())).at;
            assert.deepEqual(await pinned.read({ at: copied, fileId: sample.fileId }, options()), sample);
            assert.deepEqual(await main.listCheckpoints({}, options()), { checkpoints: [{ at: copied }, { at: retained }] });
            assert.deepEqual(await pinned.deleteCheckpoint({ at: copied }, options()), { at: copied });
            assert.deepEqual(await pinned.deleteCheckpoint({ at: retained }, options()), { at: retained });
            await assert.rejects(pinned.read({ at: retained, fileId: sample.fileId }, options()), { code: 'CHECKPOINT_NOT_FOUND', status: 404 });
            assert.deepEqual(await main.listCheckpoints({}, options()), { checkpoints: [] });
            assert.deepEqual(await main.listForks({}, options()), { forks: [{ at: child }, { at: fromWorking }] });
        } else {
            t.diagnostic('Checkpoint capture, fork and rollback validation are opt-in through MEMDRIVE_RUN_LIVE_CHECKPOINT_TESTS=1.');
            assert.deepEqual(await reopened.deleteFork({ at }, options()), { at });
            assert.deepEqual(await main.listForks({}, options()), { forks: [] });
            await assert.rejects(reopened.read({ at, path }, options()), { code: 'BRANCH_NOT_FOUND' });
        }
        await MemDrive.destroy({ client, name }, options());
        await assert.rejects(main.read({ path: '/main.txt' }, options()), { code: 'STORE_NOT_FOUND', status: 404 });
        await assert.rejects(client.collection(name).get(options()), error => statusOf(error) === 404);
        // Destroying a missing store is a no-op.
        await MemDrive.destroy({ client, name }, options());
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
