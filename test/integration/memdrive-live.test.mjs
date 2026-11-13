import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { HTTPClient, LambdaDBClient } from '@functional-systems/lambdadb';
import { create, open } from '@functional-systems/memdrive';
import { createTools } from '@functional-systems/memdrive/tools';

const enabled = process.env.MEMDRIVE_RUN_LIVE_TESTS === '1';
const required = ['LAMBDADB_BASE_URL', 'LAMBDADB_PROJECT_NAME', 'LAMBDADB_PROJECT_API_KEY'];
const metadataSchema = {
    topic: { type: 'string', description: 'Topic of the synthetic memory' },
    tags: { type: 'string[]', description: 'Synthetic test labels' },
};
const options = () => ({ signal: AbortSignal.timeout(60_000) });
const statusOf = error => error?.status ?? error?.statusCode;
const safeFailure = (phase, error) => {
    // Assertions inspect only the synthetic fixtures, never native requests.
    const detail = error instanceof assert.AssertionError ? ` ${error.message}` : '';
    return new Error(`${phase} failed (${error?.code ?? error?.name ?? 'Error'}${statusOf(error) ? `, status ${statusOf(error)}` : ''}).${detail}`);
};

// Fixed workload: three temporary collections, one branch, eight managed searches
// (two with default reranking) and one external-vector search. No answer model,
// retries or quality scoring; all stored content is synthetic and under 6 KiB.
async function withDrive(client, variant, configuration, run) {
    const name = `memdrive-smoke-${variant}-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    let drive, failure, collision = false;
    try {
        drive = await create({ client, name, metadataSchema, labels: { purpose: 'sdk-smoke' },
            description: 'Temporary MemDrive live smoke', ...configuration }, options());
        await run(drive, name);
    } catch (error) {
        collision = error?.code === 'STORE_EXISTS';
        // Native errors can retain HTTP requests, so never print their causes.
        failure = safeFailure(`${variant} smoke`, error);
    } finally {
        if (!collision) {
            try {
                // A create can succeed server-side even if opening the handle fails.
                // Delete only this unique test name; never list or sweep collections.
                if (drive) await drive.destroy(options());
                else await client.collection(name).delete(options());
            } catch (error) {
                if (statusOf(error) !== 404) {
                    const cleanup = safeFailure(`Cleanup of ${name}`, error);
                    failure = failure ? new AggregateError([failure, cleanup], 'Smoke and cleanup failed.') : cleanup;
                }
            }
            try {
                await assert.rejects(client.collection(name).get(options()), error => statusOf(error) === 404);
            } catch (error) {
                const cleanup = safeFailure(`Deletion verification for ${name}`, error);
                failure = failure ? new AggregateError([failure, cleanup], 'Smoke or cleanup verification failed.') : cleanup;
            }
        }
    }
    if (failure) throw failure;
}

function matching(result, id) {
    assert(result.matches.length > 0, `Expected evidence for ${id}`);
    assert(result.matches.every(match => match.memId === id), `Filter escaped ${id}`);
    return result.matches;
}

async function managedSmoke(client, textSearch) {
    const variant = textSearch ? 'hybrid' : 'vector';
    await withDrive(client, variant, textSearch ? { textSearch } : {}, async (drive, name) => {
        const long = Array.from({ length: 28 }, (_, index) =>
            `Record ${index + 1}: The observatory rehearsal is scheduled for Friday at noon.\n`).join('');
        const short = 'The workshop meets on Monday in the library.';
        const timestamp = '2026-01-02T12:00:00.000Z';
        const saved = await drive.remember({ mems: [
            { id: 'long', content: long, timestamp, metadata: { topic: 'rehearsal', tags: ['music'] } },
            { id: 'short', content: short, timestamp, metadata: { topic: 'workshop', tags: ['reading'] } },
        ] }, options());
        assert.deepEqual(saved.ids, ['long', 'short']);
        const reopened = await open({ client, name }, options());
        const descriptor = await reopened.describe(options());
        assert.deepEqual(descriptor.metadataSchema, metadataSchema);
        assert.deepEqual(descriptor.textSearch, textSearch);
        const originals = await reopened.read({ ids: ['long', 'short', 'missing'] }, options());
        assert.deepEqual(originals.mems.map(mem => [mem.id, mem.content]), [['long', long], ['short', short]]);
        assert.equal(originals.mems[0].timestamp, timestamp);

        const tools = await createTools({ drive: reopened }, options());
        const recalled = await tools.execute('memdrive_recall', { requests: [
            { query: 'When is the observatory rehearsal?', filter: { field: 'id', op: 'eq', value: 'long' }, limit: 10 },
            { query: 'When does the workshop meet?', filter: { field: 'metadata.topic', op: 'eq', value: 'workshop' }, limit: 5, rerank: false },
        ] }, options());
        assert.equal(recalled.ok, true);
        assert.equal(recalled.value.results.length, 2);
        const chunks = matching(recalled.value.results[0], 'long');
        assert(chunks.every(match => match.kind === 'chunk' && match.content === long.slice(match.start, match.end)));
        const full = matching(recalled.value.results[1], 'short');
        assert.equal(full.length, 1);
        assert.equal(full[0].kind, 'mem');
        assert.equal(full[0].content, short);
        const read = await tools.execute('memdrive_read', { ids: ['long'] }, options());
        assert.equal(read.ok, true);
        assert.equal(read.value.mems[0].content, long);
        const counts = await reopened.countValues({ fields: ['metadata.topic'], limit: 10 }, options());
        assert.deepEqual(counts.values['metadata.topic'].buckets.sort((a, b) => a.value.localeCompare(b.value)),
            [{ value: 'rehearsal', count: 1 }, { value: 'workshop', count: 1 }]);

        // A smaller replacement must retire the old searchable chunks.
        const replacement = 'The observatory rehearsal moved to Tuesday at noon.';
        await reopened.remember({ mems: [{ id: 'long', content: replacement, metadata: { topic: 'updated' } }] }, options());
        const replaced = matching(await reopened.recall({ query: 'observatory rehearsal',
            filter: { field: 'id', op: 'eq', value: 'long' }, limit: 10, rerank: false }, options()), 'long');
        assert.deepEqual(replaced.map(match => [match.kind, match.content]), [['mem', replacement]]);
        assert.deepEqual((await reopened.recall({ query: 'workshop', filter: { field: 'id', op: 'eq', value: 'short' },
            excludeIds: ['short'], rerank: false }, options())).matches, []);
        await reopened.forget({ filter: { field: 'metadata.topic', op: 'eq', value: 'updated' } }, options());
        assert.deepEqual((await reopened.read({ ids: ['long', 'short'] }, options())).mems.map(mem => mem.id), ['short']);
    });
}

async function externalSmoke(client) {
    await withDrive(client, 'external', { embedding: { mode: 'external', dimensions: 64,
        similarity: 'cosine', identity: 'memdrive-live-synthetic-v1' } }, async drive => {
        // Create the branch while empty; this test checks isolation, not snapshot
        // commit latency or inheritance of pending writes.
        await drive.branches.create({ name: 'alternate' }, options());
        const alternate = drive.at({ branch: 'alternate' });
        const embedding = [1, ...Array(63).fill(0)];
        await drive.remember({ mems: [{ id: 'same', embedding, metadata: { topic: 'main' } }] }, options());
        await alternate.remember({ mems: [{ id: 'same', embedding, metadata: { topic: 'alternate' } }] }, options());
        assert.deepEqual((await drive.read({ ids: ['same'] }, options())).mems,
            [{ id: 'same', metadata: { topic: 'main' } }]);
        const tools = await createTools({ drive, branch: 'alternate', writable: true }, options());
        const recalled = await tools.execute('memdrive_recall', { requests: [{ queryVector: embedding, limit: 1 }] }, options());
        assert.equal(recalled.ok, true);
        assert.deepEqual(recalled.value.results[0].matches,
            [{ kind: 'mem', memId: 'same', metadata: { topic: 'alternate' } }]);
        assert.deepEqual(await tools.execute('memdrive_forget', { ids: ['same', 'missing'] }, options()),
            { ok: true, value: { acknowledged: true } });
        assert.deepEqual((await alternate.read({ ids: ['same'] }, options())).mems, []);
        assert.equal((await drive.read({ ids: ['same'] }, options())).mems.length, 1);
        await drive.branches.delete('alternate', options());
        assert(!(await drive.branches.list(options())).some(branch => branch.name === 'alternate'));
    });
}

test('live managed and external memory contracts with verified cleanup', {
    skip: enabled ? false : 'Set MEMDRIVE_RUN_LIVE_TESTS=1 to permit live resources and provider usage.',
    timeout: 600_000,
}, async t => {
    for (const key of required) assert(process.env[key]?.trim(), `Missing live configuration: ${key}`);
    assert(!/[\r\n]/.test(process.env.LAMBDADB_PROJECT_API_KEY.trim()), 'Expected a single project API key.');
    const httpClient = new HTTPClient();
    httpClient.addHook('response', (response, request) => {
        // A 404 is expected when verifying cleanup. Log only the failing operation,
        // with no hostname, query string, headers, body or native error object.
        if (!response.ok && response.status !== 404)
            t.diagnostic(`${request.method} ${new URL(request.url).pathname} -> HTTP ${response.status}`);
    });
    const client = new LambdaDBClient({ httpClient, baseUrl: process.env.LAMBDADB_BASE_URL,
        projectName: process.env.LAMBDADB_PROJECT_NAME, projectApiKey: process.env.LAMBDADB_PROJECT_API_KEY,
        timeoutMs: 60_000, retryConfig: { strategy: 'none' },
        debugLogger: { log() {}, group() {}, groupEnd() {} } });
    await t.test('managed vector retrieval and native reranking', () => managedSmoke(client));
    await t.test('managed hybrid retrieval and native reranking', () => managedSmoke(client, { analyzers: ['english'] }));
    await t.test('external vectors and branch isolation', () => externalSmoke(client));
});
