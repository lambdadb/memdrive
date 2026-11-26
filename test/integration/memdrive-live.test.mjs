import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { HTTPClient, LambdaDBClient, MemDrive } from '@functional-systems/memdrive';

const enabled = process.env.MEMDRIVE_RUN_LIVE_TESTS === '1';
const verifyCheckpoints = process.env.MEMDRIVE_RUN_LIVE_CHECKPOINT_TESTS === '1';
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
    // Follow every next: pages continue the path-ordered sequence without repeats.
    const listAll = async (drive, request) => {
        const files = [], prefixes = [];
        for (let page = await drive.list(request, options()); ; page = await drive.list(page.next, options())) {
            files.push(...page.files);
            prefixes.push(...page.prefixes);
            if (!page.next) break;
        }
        assert.equal(new Set(files.map(file => file.fileId)).size, files.length, 'A listing repeated a file.');
        return { files, prefixes };
    };
    try {
        const main = await MemDrive.create({ client, name, metadataSchema: { topic: { type: 'string' } } }, options());
        // One collection per store: no internal journal or companion collection.
        assert.equal(collectionCreations, 1);
        assert.equal((await client.collection(name).get(options())).collection.snapshotRetentionInDays, 1);
        assert.equal(Object.hasOwn(await main.describe({}, options()), 'retentionInDays'), false);
        assert.equal((await main.describe({}, options())).latestCheckpoint, null);
        await assert.rejects(main.read({ at: { kind: 'checkpoint', name: 'never-created' }, path: '/x' }, options()),
            { code: 'CHECKPOINT_NOT_FOUND', status: 404 });
        // Checkpoints are read-only; the SDK rejects the target before any storage call.
        await assert.rejects(main.write({ at: { kind: 'checkpoint', name: 'never-created' }, op: 'create', path: '/x', content: '' }, options()),
            { code: 'INVALID_INPUT' });
        assert.deepEqual(await main.list({}, options()), { files: [], prefixes: [] });
        assert.deepEqual(await main.tree({}, options()), { fileCount: 0, folders: [], truncated: false });
        const research = { kind: 'fork', name: 'research' };
        assert.deepEqual(await main.fork({ name: 'research' }, options()), { at: research });
        const at = research;
        assert.deepEqual((await main.listForks({}, options())).forks.map(entry => entry.at), [research]);
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
        const reference = ({ fileId, path, modifiedAt, metadata }) => ({
            fileId, path, modifiedAt, ...(metadata === undefined ? {} : { metadata }),
        });
        // Listings are consistent branch reads in Unicode code point order: 's' sorts before '한'.
        const expected = [reference(nested), reference(original)];
        assert.deepEqual(await listAll(reopened, { at, prefix: '/notes/' }), { files: expected, prefixes: [] });
        assert.equal((await listAll(main, { prefix: '/notes/' })).files.length, 0);
        // A cursor from the drive returned by create continues on a drive returned by
        // open: both derive the store identity from the same collection creation time.
        const firstPage = await main.list({ at, limit: 1 }, options());
        assert.deepEqual(firstPage.files, [reference(empty)]);
        assert.deepEqual(firstPage.next?.at, at);
        await assert.rejects(reopened.list({ cursor: firstPage.next.cursor }, options()), { code: 'CURSOR_VIEW_MISMATCH' });
        assert.deepEqual((await reopened.list(firstPage.next, options())).files, [reference(nested)]);
        // With a delimiter a folder takes one entry; limit 1 puts the file and the folder on separate pages.
        const grouped = await listAll(reopened, { at, prefix: '/notes/', delimiter: '/', limit: 1 });
        assert.deepEqual(grouped, { files: [reference(original)], prefixes: ['/notes/sub/'] });
        assert.deepEqual((await listAll(reopened, { at, prefix: '/notes/', nameContains: 'also' })).files, [reference(nested)]);
        assert.deepEqual(await reopened.tree({ at }, options()), { fileCount: 3, truncated: false,
            folders: [{ path: '/notes/', fileCount: 2 }, { path: '/notes/sub/', fileCount: 1 }] });

        // Files written into two folders are counted and listed by the very next calls.
        await main.write({ operations: [
            { op: 'create', path: '/projects/b.md', content: 'Second project note.' },
            { op: 'create', path: '/people/c.md', content: 'A person note.' },
            { op: 'create', path: '/projects/a.md', content: 'First project note.' },
        ] }, options());
        let startedAt = Date.now();
        const tree = await main.tree({}, options());
        t.diagnostic(`tree answered ${Date.now() - startedAt} ms after the write returned.`);
        assert.deepEqual(tree, { fileCount: 4, truncated: false,
            folders: [{ path: '/people/', fileCount: 1 }, { path: '/projects/', fileCount: 2 }] });
        startedAt = Date.now();
        const listedMain = await main.list({}, options());
        t.diagnostic(`list answered ${Date.now() - startedAt} ms after tree.`);
        assert.deepEqual(listedMain.files.map(file => file.path), ['/main.txt', '/people/c.md', '/projects/a.md', '/projects/b.md']);
        assert.deepEqual((await main.list({ delimiter: '/' }, options())), { files: [reference(mainFile)], prefixes: ['/people/', '/projects/'] });
        assert.deepEqual((await main.tree({ prefix: '/projects/' }, options())), { fileCount: 2, folders: [], truncated: false });

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

            const listed = await listAll(reopened, { at });
            assert(listed.files.some(file => file.fileId === sample.fileId) && !listed.files.some(file => file.fileId === nested.fileId));
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
            assert.deepEqual((await pinned.list({ at: retained }, options())).files.map(file => file.fileId), [sample.fileId, empty.fileId]);
            assert.equal((await pinned.tree({ at: retained }, options())).fileCount, 2);
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
            assert.deepEqual((await main.listCheckpoints({}, options())).checkpoints.map(entry => entry.at), [copied, retained]);
            assert.deepEqual(await pinned.deleteCheckpoint({ at: copied }, options()), { at: copied });
            assert.deepEqual(await pinned.deleteCheckpoint({ at: retained }, options()), { at: retained });
            await assert.rejects(pinned.read({ at: retained, fileId: sample.fileId }, options()), { code: 'CHECKPOINT_NOT_FOUND', status: 404 });
            assert.deepEqual(await main.listCheckpoints({}, options()), { checkpoints: [] });
            assert.deepEqual((await main.listForks({}, options())).forks.map(entry => entry.at), [child, fromWorking]);
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

test('live checkpointed writes record the latest checkpoint and restore it after an injected failure', {
    skip: !enabled ? 'Set MEMDRIVE_RUN_LIVE_TESTS=1 to permit live resources.'
        : !verifyCheckpoints ? 'Checkpointed writes are opt-in through MEMDRIVE_RUN_LIVE_CHECKPOINT_TESTS=1.' : false,
    timeout: 600_000,
}, async t => {
    for (const key of required) assert(process.env[key]?.trim(), `Missing live configuration: ${key}`);
    const httpClient = new HTTPClient();
    httpClient.addHook('response', (response, request) => {
        if (!response.ok && response.status !== 404) t.diagnostic(`${request.method} ${new URL(request.url).pathname} -> HTTP ${response.status}`);
    });
    const client = new LambdaDBClient({ httpClient, baseUrl: process.env.LAMBDADB_BASE_URL,
        projectName: process.env.LAMBDADB_PROJECT_NAME, projectApiKey: process.env.LAMBDADB_PROJECT_API_KEY,
        timeoutMs: 60_000, retryConfig: { strategy: 'none' }, debugLogger: { log() {}, group() {}, groupEnd() {} } });
    const name = `memdrive-smoke-latest-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const main = { kind: 'main' };
    const turn = label => ({ kind: 'checkpoint', name: label });
    let failure, collision = false, phase = 'create the store';
    try {
        const drive = await MemDrive.create({ client, name }, options());
        const native = client.collection(name);
        assert.equal((await drive.describe({}, options())).latestCheckpoint, null);

        phase = 'first checkpointed write';
        const first = await drive.write({ op: 'create', path: '/turn.md', content: 'First turn wording.', checkpoint: { name: 'turn-1' } }, options());
        const tagged = Date.now();
        assert.deepEqual(first.checkpoint, { at: turn('turn-1') });
        assert.deepEqual(await drive.read({ fileId: first.result.fileId }, options()), first.result);
        assert.deepEqual((await drive.describe({}, options())).latestCheckpoint, { at: turn('turn-1') });
        assert.equal((await native.aliases.get('latest-main', options())).alias.targetName, 'checkpoint-turn-1');

        // Until LambdaDB publishes the new checkpoint's snapshot, a rollback to it is
        // rejected with 400. Main equals turn-1 now, so this probe changes no files.
        phase = 'wait until the first checkpoint can be restored';
        await rollbackWhenPublished(drive, { at: main, to: turn('turn-1') }, t);
        t.diagnostic(`A rollback to the just-created checkpoint succeeded ${Date.now() - tagged} ms after its checkpointed write returned.`);

        phase = 'second checkpointed write with an injected alias failure';
        // The same client, except that moving the alias fails with a definite 503.
        const failing = { collection(collection) {
            const handle = client.collection(collection), aliases = handle.aliases;
            return Object.assign(Object.create(handle), { aliases: { get: aliases.get.bind(aliases), create: aliases.create.bind(aliases),
                delete: aliases.delete.bind(aliases), listPage: aliases.listPage.bind(aliases),
                retarget: async () => { throw Object.assign(new Error('Injected alias failure'), { statusCode: 503 }); } } });
        } };
        const injected = await MemDrive.open({ client: failing, name }, options());
        const error = await injected.write({ operations: [{ op: 'create', path: '/second.md', content: 'Second turn wording.' },
            { op: 'update', fileId: first.result.fileId, content: 'Overwritten by the second turn.' }],
        checkpoint: { name: 'turn-2' } }, options()).catch(cause => cause);
        assert.equal(error?.code, 'CHECKPOINT_WRITE_FAILED', `Unexpected outcome ${error?.code} ${JSON.stringify(error?.details?.restoreCause ?? null)}`);
        assert.deepEqual([error.details.stage, error.details.restored, error.details.restoredTo, error.details.checkpointRemoved],
            ['alias', true, turn('turn-1'), true]);
        assert.deepEqual(await drive.read({ fileId: first.result.fileId }, options()), first.result);
        assert.equal(await drive.read({ path: '/second.md' }, options()), null);
        await assert.rejects(native.tags.get('checkpoint-turn-2', options()), cause => statusOf(cause) === 404);
        assert.deepEqual((await drive.describe({}, options())).latestCheckpoint, { at: turn('turn-1') });

        phase = 'third checkpointed write and paged checkpoint listing';
        const third = await drive.write({ op: 'create', path: '/third.md', content: 'Third turn wording.', checkpoint: { name: 'turn-3' } }, options());
        assert.deepEqual((await drive.describe({}, options())).latestCheckpoint, third.checkpoint);
        const listed = [];
        for (let page = await drive.listCheckpoints({ limit: 1 }, options()); ; page = await drive.listCheckpoints(page.next, options())) {
            assert(page.checkpoints.length <= 1);
            listed.push(...page.checkpoints);
            if (!page.next) break;
        }
        assert.deepEqual(listed.map(entry => entry.at), [turn('turn-1'), turn('turn-3')]);
        assert(listed.every(entry => !Number.isNaN(Date.parse(entry.createdAt)) && new Date(entry.createdAt).toISOString() === entry.createdAt));
        assert(listed[0].createdAt <= listed[1].createdAt);
        await assert.rejects(drive.deleteCheckpoint({ at: turn('turn-3') }, options()), { code: 'CHECKPOINT_IN_USE' });
        assert.deepEqual(await drive.deleteCheckpoint({ at: turn('turn-1') }, options()), { at: turn('turn-1') });

        phase = 'destroy the store';
        await MemDrive.destroy({ client, name }, options());
        await assert.rejects(native.get(options()), cause => statusOf(cause) === 404);
    } catch (error) {
        collision = error?.code === 'STORE_EXISTS';
        failure = safeFailure(`Checkpointed write smoke (${phase})`, error);
    } finally {
        if (!collision) {
            try { await client.collection(name).delete(options()); }
            catch (error) {
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
