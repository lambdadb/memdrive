import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { HTTPClient, LambdaDBClient } from '@functional-systems/lambdadb';
import { MemDrive } from '@functional-systems/memdrive';

const enabled = process.env.MEMDRIVE_RUN_LIVE_TESTS === '1' && process.env.MEMDRIVE_RUN_LIVE_FIND_TEXT_TESTS === '1';
const options = () => ({ signal: AbortSignal.timeout(60_000) });
const statusOf = error => error?.status ?? error?.statusCode;

test('live findText enumerates original occurrences and resumes on branches and checkpoints', {
    skip: enabled ? false : 'Enable MEMDRIVE_RUN_LIVE_TESTS and MEMDRIVE_RUN_LIVE_FIND_TEXT_TESTS for isolated live resources.',
    timeout: 600_000,
}, async () => {
    for (const key of ['LAMBDADB_BASE_URL', 'LAMBDADB_PROJECT_NAME', 'LAMBDADB_PROJECT_API_KEY'])
        assert(process.env[key]?.trim(), `Missing live configuration: ${key}`);
    const client = new LambdaDBClient({ httpClient: new HTTPClient(), baseUrl: process.env.LAMBDADB_BASE_URL,
        projectName: process.env.LAMBDADB_PROJECT_NAME, projectApiKey: process.env.LAMBDADB_PROJECT_API_KEY,
        timeoutMs: 60_000, retryConfig: { strategy: 'none' }, debugLogger: { log() {}, group() {}, groupEnd() {} } });
    const name = `memdrive-find-text-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const collection = client.collection(name);
    let phase = 'Create store', failure, collision = false;
    try {
        const main = await MemDrive.create({ client, name, metadataSchema: { topic: { type: 'string' } } }, options());
        assert.deepEqual(await main.findText({ query: 'a.*' }, options()), { hits: [], consistency: 'snapshot' });
        const fork = await main.fork({ name: 'literal-scan' }, options());
        const body = 'x'.repeat(797) + '🙂A.*\r\n🙂a.*\r\n';
        const path = '/scan/a.txt';
        const keep = { topic: 'keep' };
        const [file] = await fork.write([
            { op: 'create', path, content: body, metadata: keep },
            ...Array.from({ length: 17 }, (_, index) => ({ op: 'create', path: `/scan/empty-${index}`, content: '', metadata: keep })),
            { op: 'create', path: '/scan/excluded.txt', content: body, metadata: { topic: 'exclude' } },
            { op: 'create', path: '/outside.txt', content: body, metadata: keep },
        ], options());
        const query = { query: '🙂a.*\r\n', prefix: '/scan/', filter: { field: 'metadata.topic', op: 'eq', value: 'keep' } };
        phase = 'Enumerate 18 filtered fork originals';
        const first = await fork.findText(query, options());
        assert.equal(first.consistency, 'live');
        assert(first.cursor);
        const second = await fork.findText({ cursor: first.cursor }, options());
        assert.equal(second.cursor, undefined);
        const hits = [...first.hits, ...second.hits];
        assert.deepEqual(hits.map(({ fileId, content, range }) => ({ fileId, content, range })), [
            { fileId: file.fileId, content: '🙂A.*\r\n', range: { start: 797, end: 804 } },
            { fileId: file.fileId, content: '🙂a.*\r\n', range: { start: 804, end: 811 } },
        ]);
        for (const { context } of hits) assert.equal(context.content, body.slice(context.range.start, context.range.end));

        phase = 'Capture the original checkpoint';
        const deadline = Date.now() + 150_000;
        for (;;) {
            const remaining = deadline - Date.now();
            assert(remaining > 0, 'Checkpoint source listing did not converge.');
            if ((await fork.list({ prefix: '/scan/' }, { signal: AbortSignal.timeout(remaining) })).files.length === 19) break;
            await sleep(Math.min(5_000, Math.max(0, deadline - Date.now())));
        }
        const checkpoint = await fork.checkpoint({ name: 'literal-snapshot' }, options());
        const narrowed = { ...query, prefix: path, limit: 1 };
        const held = await checkpoint.findText(narrowed, options());
        assert.equal(held.consistency, 'snapshot');
        assert.equal(held.hits[0]?.content, '🙂A.*\r\n');
        assert(held.cursor);
        phase = 'Reject a changed working continuation and keep the checkpoint continuation';
        const live = await fork.findText(narrowed, options());
        assert(live.cursor);
        await fork.write({ op: 'update', fileId: file.fileId, content: 'Updated' }, options());
        await assert.rejects(fork.findText({ cursor: live.cursor }, options()), { code: 'FIND_TEXT_CURSOR_UNAVAILABLE' });
        assert.deepEqual((await checkpoint.findText({ cursor: held.cursor }, options())).hits, [hits[1]]);
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
