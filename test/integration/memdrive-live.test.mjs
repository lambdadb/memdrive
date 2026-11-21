import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { HTTPClient, LambdaDBClient } from '@functional-systems/lambdadb';
import { MemDrive } from '@functional-systems/memdrive';

const enabled = process.env.MEMDRIVE_RUN_LIVE_TESTS === '1';
const required = ['LAMBDADB_BASE_URL', 'LAMBDADB_PROJECT_NAME', 'LAMBDADB_PROJECT_API_KEY'];
const options = () => ({ signal: AbortSignal.timeout(60_000) });
const statusOf = error => error?.status ?? error?.statusCode;
const safeFailure = (phase, error) => {
    // Assertions inspect only the synthetic fixtures, never native requests.
    const detail = error instanceof assert.AssertionError ? ` ${error.message}` : '';
    return new Error(`${phase} failed (${error?.code ?? error?.name ?? 'Error'}${statusOf(error) ? `, status ${statusOf(error)}` : ''}).${detail}`);
};

test('live file store writes and reopens a fresh fork with verified cleanup', {
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
        const main = await MemDrive.create({ client, name }, options());
        assert.equal('write' in main, false);
        const fork = await main.fork({ name: 'research' }, options());
        const path = '/notes/한글 "draft":*?.md';
        const content = '# Synthetic note\r\n Trailing space \n';
        const original = await fork.write({ op: 'create', path, content }, options());
        const empty = await fork.write({ op: 'create', path: '/empty.txt', content: '' }, options());
        const reopened = await MemDrive.open({ client: new LambdaDBClient(connection), name, at: { fork: 'research' } }, options());
        assert.deepEqual(await reopened.read({ path }, options()), { fileId: original.fileId, path, content });
        assert.deepEqual(await reopened.read({ fileId: original.fileId }, options()), original);
        assert.deepEqual(await reopened.read({ path: '/empty.txt' }, options()), empty);
        assert.equal(empty.content, '');
        await assert.rejects(reopened.write({ op: 'create', path, content: 'Duplicate' }, options()), { code: 'PATH_EXISTS' });
        assert.equal(await main.read({ fileId: original.fileId }, options()), null);
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
            } catch (error) {
                const cleanup = safeFailure(`Deletion verification for ${name}`, error);
                failure = failure ? new AggregateError([failure, cleanup], 'Smoke or cleanup verification failed.') : cleanup;
            }
        }
    }
    if (failure) throw failure;
});
