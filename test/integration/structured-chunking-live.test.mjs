import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { LambdaDBClient } from '@functional-systems/lambdadb';
import { MemDrive } from '@functional-systems/memdrive';
import { createDoclingChunker } from '@functional-systems/memdrive/docling';

const enabled = process.env.MEMDRIVE_RUN_LIVE_TESTS === '1';
const options = () => ({ signal: AbortSignal.timeout(60_000) });

test('live local Docling chunks retain exact originals through checkpoint and publication', {
    skip: enabled ? false : 'Set MEMDRIVE_RUN_LIVE_TESTS=1 to permit live resources.',
    timeout: 600_000,
}, async () => {
    for (const key of ['LAMBDADB_BASE_URL', 'LAMBDADB_PROJECT_NAME', 'LAMBDADB_PROJECT_API_KEY'])
        assert(process.env[key]?.trim(), `Missing live configuration: ${key}`);
    const connection = {
        baseUrl: process.env.LAMBDADB_BASE_URL, projectName: process.env.LAMBDADB_PROJECT_NAME,
        projectApiKey: process.env.LAMBDADB_PROJECT_API_KEY, timeoutMs: 60_000,
        retryConfig: { strategy: 'none' }, debugLogger: { log() {}, group() {}, groupEnd() {} },
    };
    const client = new LambdaDBClient(connection);
    const name = `memdrive-smoke-docling-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const chunker = await createDoclingChunker({
        tokenizer: new URL('../fixtures/docling-tokenizer.json', import.meta.url).pathname, maxTokens: 32,
    });
    let owned = false;
    try {
        const main = await MemDrive.create({ client, name, chunker }, options());
        owned = true;
        const fork = await main.fork({ name: 'draft' }, options());
        const file = await fork.write({ op: 'create', path: '/note.md', content: '# Heading\n\nHello world.' }, options());
        const checkpoint = await fork.checkpoint({ name: 'saved' }, options());
        const before = await fork.search({ query: 'Hello world', rerank: false }, options());
        assert.equal(before.hits.length, 1);
        assert.equal(before.hits[0].content, 'Hello world.');
        assert.deepEqual(before.hits[0].range, { start: 11, end: 23 });
        await fork.merge({ requestId: 'publish-structured', summary: 'Publish synthetic structured note' }, options());
        const reopened = await MemDrive.open({ client: new LambdaDBClient(connection), name }, options());
        assert.deepEqual(await reopened.read({ fileId: file.fileId }, options()), file);
        assert.deepEqual(await checkpoint.read({ fileId: file.fileId }, options()), file);
        const after = await reopened.search({ query: 'Hello world', rerank: false }, options());
        assert.deepEqual(after.hits, before.hits);
    } catch (error) {
        const detail = error instanceof assert.AssertionError ? ` ${error.message}` : '';
        throw new Error(`Structured live smoke failed (${error?.code ?? error?.name ?? 'Error'}).${detail}`);
    } finally {
        if (owned) {
            try { await MemDrive.destroy({ client, name }, options()); }
            catch (error) { throw new Error(`Structured live cleanup failed (${error?.code ?? error?.name ?? 'Error'}).`); }
            await assert.rejects(client.collection(name).get(options()), error => (error.status ?? error.statusCode) === 404);
        }
    }
});
