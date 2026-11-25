import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { LambdaDBClient, MemDrive } from '@functional-systems/memdrive';
import { createDoclingChunker } from '@functional-systems/memdrive/docling';

const enabled = process.env.MEMDRIVE_RUN_LIVE_TESTS === '1';
const options = () => ({ signal: AbortSignal.timeout(60_000) });

test('live local Docling chunks retain exact originals through checkpoints, main writes and rollback', {
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
    let collision = false;
    let failure;
    let phase = 'create store';
    try {
        const main = await MemDrive.create({ client, name, chunker }, options());
        phase = 'verify store settings';
        const { collection } = await client.collection(name).get(options());
        // Native snapshot retention is one day; the description holds only the chunking settings.
        assert.equal(collection.snapshotRetentionInDays, 1);
        assert(collection.description.startsWith('memdrive-config-v1:'));
        assert.deepEqual(Object.keys(JSON.parse(collection.description.slice('memdrive-config-v1:'.length))), ['chunking']);
        assert.equal(Object.hasOwn(await main.describe(options()), 'retentionInDays'), false);
        phase = 'create working fork';
        const { at } = await main.fork({ name: 'draft' }, options());
        assert.deepEqual(at, { kind: 'fork', name: 'draft' });
        // Removed selectors fail locally.
        for (const removed of [{ version: 'v1' }, { asOf: new Date().toISOString() }])
            await assert.rejects(main.fork({ name: 'removed-selector', ...removed }, options()), { code: 'INVALID_INPUT' });
        phase = 'write structured original';
        const file = await main.write({ at, op: 'create', path: '/note.md', content: '# Heading\n\nHello world.' }, options());
        assert.equal(await main.read({ fileId: file.fileId }, options()), null);
        phase = 'search working chunks';
        const before = await main.search({ at, query: 'Hello world', rerank: false }, options());
        assert.equal(before.hits.length, 1);
        assert.equal(before.hits[0].content, 'Hello world.');
        assert.deepEqual(before.hits[0].range, { start: 11, end: 23 });
        phase = 'checkpoint the fork';
        const checkpoint = (await main.checkpoint({ at, name: 'saved' }, options())).at;
        assert.deepEqual(checkpoint, { kind: 'checkpoint', name: 'saved' });
        phase = 'reopen the checkpoint without parser';
        const reopened = await MemDrive.open({ client: new LambdaDBClient(connection), name }, options());
        assert.deepEqual(await reopened.read({ at: checkpoint, fileId: file.fileId }, options()), file);
        assert.deepEqual(await reopened.read({ at, fileId: file.fileId }, options()), file);

        phase = 'write a structured original to main';
        const mainFile = await main.write({ op: 'create', path: '/main.md', content: '# Main\n\nMain world.' }, options());
        assert.deepEqual(await reopened.read({ path: '/main.md' }, options()), mainFile);
        assert.equal(await reopened.read({ at, path: '/main.md' }, options()), null);
        const onMain = await reopened.search({ query: 'Main world', rerank: false }, options());
        assert.deepEqual(onMain.hits.map(hit => hit.fileId), [mainFile.fileId]);

        phase = 'change the fork after its checkpoint';
        const updated = await main.write({ at, op: 'update', fileId: file.fileId, content: '# Heading\n\nGoodbye world.' }, options());
        const extra = await main.write({ at, op: 'create', path: '/extra.md', content: '# Extra\n\nAfter the checkpoint.' }, options());
        assert.deepEqual(await main.read({ at, fileId: file.fileId }, options()), updated);
        assert.deepEqual(await main.read({ at: checkpoint, fileId: file.fileId }, options()), file);
        assert.equal(await main.read({ at: checkpoint, fileId: extra.fileId }, options()), null);

        phase = 'roll the fork back to its checkpoint';
        // The SDK sends one rollback. A just-created checkpoint can be rejected with a
        // definite 400 until its snapshot is published; only this test waits for that.
        const deadline = Date.now() + 120_000;
        for (let attempt = 1; ; attempt++) {
            try {
                assert.deepEqual(await main.rollback({ at, to: checkpoint }, options()), { at });
                break;
            } catch (error) {
                if (error?.status !== 400 || !/published snapshot/i.test(String(error?.cause?.message)) || Date.now() > deadline) throw error;
                await sleep(5_000);
            }
        }
        assert.deepEqual(await reopened.read({ at, fileId: file.fileId }, options()), file);
        assert.equal(await reopened.read({ at, fileId: extra.fileId }, options()), null);
        const after = await reopened.search({ at, query: 'Hello world', rerank: false }, options());
        assert.deepEqual(after.hits, before.hits);
        // Main is unaffected by a fork's rollback.
        assert.deepEqual(await reopened.read({ path: '/main.md' }, options()), mainFile);

        phase = 'fork from the checkpoint and inspect refs';
        const restored = (await main.fork({ at: checkpoint, name: 'restored' }, options())).at;
        assert.deepEqual(await main.read({ at: restored, fileId: file.fileId }, options()), file);
        // One collection per store and only user refs: no internal tags or companion collection.
        const tagNames = (await client.collection(name).tags.list(options())).tags.map(tag => tag.name).sort();
        assert.deepEqual(tagNames, ['checkpoint-saved']);
        const branchNames = (await client.collection(name).branches.list(options())).branches.map(branch => branch.name).sort();
        assert.deepEqual(branchNames, ['fork-draft', 'fork-restored', 'main']);
        assert.deepEqual(await main.listForks({}, options()), { forks: [{ at }, { at: restored }] });
        assert.deepEqual(await main.listCheckpoints({}, options()), { checkpoints: [{ at: checkpoint }] });
        assert.deepEqual(await main.deleteCheckpoint({ at: checkpoint }, options()), { at: checkpoint });
        await assert.rejects(main.read({ at: checkpoint, fileId: file.fileId }, options()), { code: 'CHECKPOINT_NOT_FOUND' });
        await assert.rejects(main.deleteCheckpoint({ at: checkpoint }, options()), { code: 'CHECKPOINT_NOT_FOUND' });
        assert.deepEqual(await main.deleteFork({ at: restored }, options()), { at: restored });
        await assert.rejects(main.read({ at: restored, fileId: file.fileId }, options()), { code: 'BRANCH_NOT_FOUND' });
    } catch (error) {
        collision = error?.code === 'STORE_EXISTS';
        const detail = error instanceof assert.AssertionError ? ` ${error.message}` : '';
        const status = error?.status ?? error?.statusCode;
        // A merge error wraps the database rejection; name its code and status too.
        const cause = error?.cause;
        const causeStatus = cause?.status ?? cause?.statusCode;
        const wrapped = cause ? `, caused by ${cause.code ?? cause.name ?? 'Error'}${causeStatus ? ` status ${causeStatus}` : ''}` : '';
        failure = new Error(`Structured live ${phase} failed (${error?.code ?? error?.name ?? 'Error'}${status ? `, status ${status}` : ''}${wrapped}).${detail}`);
        throw failure;
    } finally {
        // Creation can fail after the native collection exists. Clean the
        // unique test name in that case too, but never touch a name collision.
        if (!collision) {
            try { await MemDrive.destroy({ client, name }, options()); }
            // A cleanup failure must not hide the failure that preceded it.
            catch (error) { throw new Error(`Structured live cleanup failed (${error?.code ?? error?.name ?? 'Error'}).${failure ? ` Earlier: ${failure.message}` : ''}`); }
            await assert.rejects(client.collection(name).get(options()), error => (error.status ?? error.statusCode) === 404);
        }
    }
});
