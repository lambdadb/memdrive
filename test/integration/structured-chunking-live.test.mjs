import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
    let collision = false;
    let phase = 'create store';
    try {
        const main = await MemDrive.create({ client, name, chunker }, options());
        phase = 'create working fork';
        const fork = await main.fork({ name: 'draft' }, options());
        phase = 'write structured original';
        const file = await fork.write({ op: 'create', path: '/note.md', content: '# Heading\n\nHello world.' }, options());
        phase = 'search working chunks';
        const before = await fork.search({ query: 'Hello world', rerank: false }, options());
        assert.equal(before.hits.length, 1);
        assert.equal(before.hits[0].content, 'Hello world.');
        assert.deepEqual(before.hits[0].range, { start: 11, end: 23 });
        phase = 'publish structured chunks';
        // Publication already waits for definite cold-snapshot rejections.
        // Allow both source and target stages their documented wait budgets.
        await fork.merge({ requestId: 'publish-structured', summary: 'Publish synthetic structured note' },
            { signal: AbortSignal.timeout(270_000) });
        phase = 'checkpoint published snapshot';
        // First-write tag visibility is a separate backend readiness check.
        // This test pins the already confirmed published tag instead.
        const checkpoint = await main.checkpoint({ name: 'saved' }, options());
        phase = 'reopen published original without parser';
        const reopened = await MemDrive.open({ client: new LambdaDBClient(connection), name }, options());
        assert.deepEqual(await reopened.read({ fileId: file.fileId }, options()), file);
        assert.deepEqual(await checkpoint.read({ fileId: file.fileId }, options()), file);
        phase = 'search published chunks';
        const after = await reopened.search({ query: 'Hello world', rerank: false }, options());
        assert.deepEqual(after.hits, before.hits);

        phase = 'preserve explicit working checkpoint';
        const firstVersion = (await main.history({}, options())).entries[0].version;
        const workingSaved = await fork.checkpoint({ name: 'working-saved' }, options());
        assert.deepEqual(await workingSaved.read({ fileId: file.fileId }, options()), file);
        phase = 'publish a later revision';
        const updated = await fork.write({ op: 'update', fileId: file.fileId, content: '# Heading\n\nGoodbye world.' }, options());
        await fork.merge({ requestId: 'publish-later', summary: 'Publish later synthetic revision' },
            { signal: AbortSignal.timeout(270_000) });
        phase = 'create historical refs after later publication';
        const mainPast = await main.fork({ name: 'main-past', version: firstVersion }, options());
        const savedPast = await main.checkpoint({ name: 'main-past', version: firstVersion }, options());
        const forkPast = await workingSaved.fork({ name: 'fork-past' }, options());
        for (const past of [mainPast, savedPast, forkPast])
            assert.deepEqual(await past.read({ fileId: file.fileId }, options()), file);
        assert.deepEqual(await main.read({ fileId: file.fileId }, options()), updated);

        for (const view of [main, fork, workingSaved])
            await assert.rejects(view.fork({ name: 'removed-time', asOf: new Date().toISOString() }, options()), { code: 'INVALID_INPUT' });

        phase = 'prepare aged retention fixture';
        await main.configure({ retentionInDays: 1 }, options());
        const { collection } = await client.collection(name).get(options());
        const driveId = createHash('sha256').update(JSON.stringify([name, collection.projectName, collection.createdAt.toISOString()])).digest('hex');
        const journal = client.collection(`md-journal-${driveId.slice(0, 40)}`);
        const metadata = (await journal.get(options())).collection;
        assert.equal(metadata.tags['memdrive.owner'], driveId);
        assert.equal(metadata.tags['memdrive.format'], 'merge-publication-v1');
        const ref = { ref: { kind: 'branch', name: 'main' }, consistentRead: true };
        const completion = (await journal.docs.fetch({ ...ref, ids: ['completion:1'] }, options())).docs[0].doc;
        assert.equal(completion.driveId, driveId);
        assert.equal(completion.status, 'published');
        assert.equal(completion.version, 'v1');
        // Age only timestamps in this owned synthetic fixture. This validates
        // the real cleanup path without pretending a day elapsed in real time.
        const aged = Date.now() - 2 * 86_400_000;
        await journal.docs.update({ branch: 'main', docs: [
            { id: 'reservation:1', startedAt: new Date(aged - 1000).toISOString() },
            { id: 'completion:1', completedAt: new Date(aged).toISOString() },
        ] }, options());
        const retentionClient = new LambdaDBClient(connection);
        const retentionMain = await MemDrive.open({ client: retentionClient, name }, options());
        const history = await retentionMain.history({}, options());
        const reservation = (await journal.docs.fetch({ ...ref, ids: ['reservation:1'] }, options())).docs[0].doc;
        assert(reservation.sourceTag.startsWith('merge-capture-'));
        assert.equal('pruneHistory' in retentionMain, false);
        phase = 'automatic retention after merge replay';
        const retry = await MemDrive.open({ client: retentionClient, name, at: { fork: 'draft' } }, options());
        // Each automatic pass is best effort and has a short budget. A later
        // terminal replay retries unfinished cleanup without changing its result.
        let removed = false;
        for (let attempt = 0; attempt < 5 && !removed; attempt++) {
            assert.equal((await retry.merge({ requestId: 'publish-structured', summary: 'Publish synthetic structured note' }, options())).version, 'v1');
            try { await client.collection(name).tags.get(reservation.sourceTag, options()); }
            catch (error) {
                if ((error.status ?? error.statusCode) !== 404) throw error;
                removed = true;
            }
        }
        assert(removed, 'Automatic retention did not remove the expired capture within five merge replays.');
        assert.deepEqual(await retentionMain.history({}, options()), history);
        assert.deepEqual(await retentionMain.read({ fileId: file.fileId }, options()), updated);
        assert.deepEqual(await savedPast.read({ fileId: file.fileId }, options()), file);
        assert.deepEqual(await checkpoint.read({ fileId: file.fileId }, options()), file);
        assert.equal((await retry.merge({ requestId: 'publish-structured', summary: 'Publish synthetic structured note' }, options())).version, 'v1');
    } catch (error) {
        collision = error?.code === 'STORE_EXISTS';
        const detail = error instanceof assert.AssertionError ? ` ${error.message}` : '';
        const status = error?.status ?? error?.statusCode;
        throw new Error(`Structured live ${phase} failed (${error?.code ?? error?.name ?? 'Error'}${status ? `, status ${status}` : ''}).${detail}`);
    } finally {
        // Creation can fail after the native collection exists. Clean the
        // unique test name in that case too, but never touch a name collision.
        if (!collision) {
            try { await MemDrive.destroy({ client, name }, options()); }
            catch (error) { throw new Error(`Structured live cleanup failed (${error?.code ?? error?.name ?? 'Error'}).`); }
            await assert.rejects(client.collection(name).get(options()), error => (error.status ?? error.statusCode) === 404);
        }
    }
});
