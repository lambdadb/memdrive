import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { HTTPClient, LambdaDBClient, MemDrive } from '@functional-systems/memdrive';

const enabled = process.env.MEMDRIVE_RUN_LIVE_TESTS === '1' && process.env.MEMDRIVE_RUN_LIVE_FIND_TEXT_TESTS === '1';
const options = () => ({ signal: AbortSignal.timeout(60_000) });
const statusOf = error => error?.status ?? error?.statusCode;

test('live findText enumerates original occurrences and resumes on main, forks and checkpoints', {
    skip: enabled ? false : 'Enable MEMDRIVE_RUN_LIVE_TESTS and MEMDRIVE_RUN_LIVE_FIND_TEXT_TESTS for isolated live resources.',
    timeout: 600_000,
}, async () => {
    for (const key of ['LAMBDADB_BASE_URL', 'LAMBDADB_PROJECT_NAME', 'LAMBDADB_PROJECT_API_KEY'])
        assert(process.env[key]?.trim(), `Missing live configuration: ${key}`);
    // Count native queries and presigned document downloads without logging requests.
    let queries = 0, downloads = 0;
    const httpClient = new HTTPClient().addHook('beforeRequest', request => {
        if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/query')) queries++;
    });
    const transferClient = new HTTPClient().addHook('beforeRequest', request => { if (request.method === 'GET') downloads++; });
    const client = new LambdaDBClient({ httpClient, transferClient, baseUrl: process.env.LAMBDADB_BASE_URL,
        projectName: process.env.LAMBDADB_PROJECT_NAME, projectApiKey: process.env.LAMBDADB_PROJECT_API_KEY,
        timeoutMs: 60_000, retryConfig: { strategy: 'none' }, debugLogger: { log() {}, group() {}, groupEnd() {} } });
    const name = `memdrive-find-text-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const collection = client.collection(name);
    let phase = 'Create store', failure, collision = false;
    try {
        const main = await MemDrive.create({ client, name, metadataSchema: { topic: { type: 'string' } } }, options());
        // Main is a live branch like a fork.
        assert.deepEqual(await main.findText({ query: 'a.*' }, options()), { hits: [], consistency: 'live' });
        phase = 'Resume a live scan on main';
        const mainFile = await main.write({ op: 'create', path: '/main/a.txt', content: 'Needle one\nneedle two' }, options());
        const mainFirst = await main.findText({ query: 'needle', limit: 1 }, options());
        assert.equal(mainFirst.consistency, 'live');
        assert.deepEqual(mainFirst.next?.at, { kind: 'main' });
        // The create drive's cursor continues on a freshly opened drive of the same store.
        const opened = await MemDrive.open({ client, name }, options());
        const mainSecond = await opened.findText(mainFirst.next, options());
        assert.equal(mainSecond.next, undefined);
        assert.deepEqual([...mainFirst.hits, ...mainSecond.hits].map(({ fileId, content, range }) => ({ fileId, content, range })), [
            { fileId: mainFile.fileId, content: 'Needle', range: { startLine: 1, endLine: 1, start: 0, end: 6 } },
            { fileId: mainFile.fileId, content: 'needle', range: { startLine: 2, endLine: 2, start: 11, end: 17 } },
        ]);
        phase = 'Create the fork';
        const { at } = await main.fork({ name: 'literal-scan' }, options());
        const body = 'x'.repeat(797) + '🙂A.*\r\n🙂a.*\r\n';
        const path = '/scan/a.txt';
        const keep = { topic: 'keep' };
        const [file] = await main.write({ at, operations: [
            { op: 'create', path, content: body, metadata: keep },
            ...Array.from({ length: 17 }, (_, index) => ({ op: 'create', path: `/scan/empty-${index}`, content: '', metadata: keep })),
            { op: 'create', path: '/scan/excluded.txt', content: body, metadata: { topic: 'exclude' } },
            { op: 'create', path: '/outside.txt', content: body, metadata: keep },
        ] }, options());
        const query = { at, query: '🙂a.*\r\n', prefix: '/scan/', filter: { field: 'metadata.topic', op: 'eq', value: 'keep' } };
        phase = 'Enumerate 18 filtered fork originals';
        const firstQueries = queries;
        const first = await main.findText(query, options());
        // The upper bound and one batch of 16 originals.
        assert.equal(queries - firstQueries, 2);
        assert.equal(first.consistency, 'live');
        assert.deepEqual(first.next?.at, at);
        await assert.rejects(main.findText({ cursor: first.next.cursor }, options()), { code: 'CURSOR_VIEW_MISMATCH' });
        const second = await main.findText(first.next, options());
        assert.equal(second.next, undefined);
        const hits = [...first.hits, ...second.hits];
        assert.deepEqual(hits.map(({ fileId, content, range }) => ({ fileId, content, range })), [
            { fileId: file.fileId, content: '🙂A.*\r\n', range: { startLine: 1, endLine: 1, start: 797, end: 804 } },
            { fileId: file.fileId, content: '🙂a.*\r\n', range: { startLine: 2, endLine: 2, start: 804, end: 811 } },
        ]);
        for (const { context } of hits) assert.equal(context.content, body.slice(context.range.start, context.range.end));

        phase = 'Capture the original checkpoint';
        const deadline = Date.now() + 150_000;
        for (;;) {
            const remaining = deadline - Date.now();
            assert(remaining > 0, 'Checkpoint source listing did not converge.');
            if ((await main.list({ at, prefix: '/scan/' }, { signal: AbortSignal.timeout(remaining) })).files.length === 19) break;
            await sleep(Math.min(5_000, Math.max(0, deadline - Date.now())));
        }
        const checkpoint = (await main.checkpoint({ at, name: 'literal-snapshot' }, options())).at;
        const narrowed = { ...query, prefix: path, limit: 1 };
        // The checkpoint is read-only.
        await assert.rejects(main.write({ at: checkpoint, op: 'delete', fileId: file.fileId }, options()), { code: 'INVALID_INPUT' });
        // A page scans one ID-ordered batch of 16 of the 18 candidates, so the
        // file can fall in a later batch behind an empty page with next.
        let held = await main.findText({ ...narrowed, at: checkpoint }, options());
        while (!held.hits.length && held.next) held = await main.findText(held.next, options());
        assert.equal(held.consistency, 'snapshot');
        assert.equal(held.hits[0]?.content, '🙂A.*\r\n');
        assert.deepEqual(held.next?.at, checkpoint);
        phase = 'Reject a changed working continuation and keep the checkpoint continuation';
        // Like the checkpoint scan, the file can sort into a later batch behind empty pages.
        // The cursor must resume inside the file for the update to invalidate it.
        let live = await main.findText(narrowed, options());
        while (!live.hits.length && live.next) live = await main.findText(live.next, options());
        assert.equal(live.hits[0]?.content, '🙂A.*\r\n');
        assert.deepEqual(live.next?.at, at);
        await main.write({ at, op: 'update', fileId: file.fileId, content: 'Updated' }, options());
        await assert.rejects(main.findText(live.next, options()), { code: 'FIND_TEXT_CURSOR_UNAVAILABLE' });
        assert.deepEqual((await main.findText(held.next, options())).hits, [hits[1]]);
        phase = 'Reject a fork continuation after the fork is deleted';
        const pending = await main.findText(narrowed, options());
        assert(pending.next, 'The fork scan should continue past its first batch.');
        assert.deepEqual(await main.deleteFork({ at }, options()), { at });
        await assert.rejects(main.findText(pending.next, options()), { code: 'FIND_TEXT_CURSOR_UNAVAILABLE' });
        await assert.rejects(main.findText(narrowed, options()), { code: 'BRANCH_NOT_FOUND', status: 404 });

        phase = 'Scan a batch larger than the inline response limit';
        // Seed raw originals directly: writing about 7 MiB through the SDK would chunk
        // and embed it. Each upsert stays below the 6 MB request limit.
        const { at: large } = await main.fork({ name: 'large-batch' }, options());
        const ids = [];
        for (let index = 0; index < 7; index++) {
            const fileId = randomUUID();
            const path = `/large/${index}.txt`;
            ids.push(fileId);
            const createdAt = new Date().toISOString();
            await collection.docs.upsert({ branch: `fork-${large.name}`, docs: [{ id: `file:${fileId}`, kind: 'file', fileId, path,
                fileName: `${index}.txt`, ancestorPaths: ['/', '/large/'], createdAt, modifiedAt: createdAt,
                body: 'y'.repeat(1_048_576) + `한글 Needle ${index}` }] }, options());
        }
        const before = { queries, downloads };
        const batch = await main.findText({ at: large, query: '한글 needle', prefix: '/large/' }, options());
        assert.equal(batch.next, undefined);
        assert.deepEqual(batch.hits.map(({ fileId, content, range }) => ({ fileId, content, range })),
            ids.sort().map(fileId => ({ fileId, content: '한글 Needle', range: { startLine: 1, endLine: 1, start: 1_048_576, end: 1_048_585 } })));
        assert.equal(queries - before.queries, 2);
        assert(downloads > before.downloads, 'The batch was returned inline; increase its size to exercise docsUrl.');
    } catch (error) {
        collision = error?.code === 'STORE_EXISTS';
        const detail = error instanceof assert.AssertionError ? ` ${error.message}` : '';
        failure = new Error(`${phase} failed (${error?.code ?? error?.name ?? 'Error'}${statusOf(error) ? `, status ${statusOf(error)}` : ''}).${detail}`);
    } finally {
        if (!collision) {
            try {
                try { await collection.delete(options()); }
                catch (error) { if (statusOf(error) !== 404) throw error; }
                await assert.rejects(collection.get(options()), error => statusOf(error) === 404);
            } catch (error) {
                const cleanup = new Error(`Cleanup verification for ${name} failed (${error?.code ?? error?.name ?? 'Error'}).`);
                failure = failure ? new AggregateError([failure, cleanup], 'Test and cleanup failed.') : cleanup;
            }
        }
    }
    if (failure) throw failure;
});
