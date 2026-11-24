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
        phase = 'verify default retention settings';
        const settings = async () => {
            const { collection } = await client.collection(name).get(options());
            assert(collection.description.startsWith('memdrive-config-v1:'));
            return { native: collection.snapshotRetentionInDays,
                window: JSON.parse(collection.description.slice('memdrive-config-v1:'.length)).retentionInDays };
        };
        // Native snapshot retention stays at its minimum; the SDK window is separate.
        assert.deepEqual(await settings(), { native: 1, window: 30 });
        assert.equal((await main.describe(options())).retentionInDays, 30);
        phase = 'create working fork';
        const { at } = await main.fork({ name: 'draft' }, options());
        assert.deepEqual(at, { kind: 'fork', name: 'draft' });
        phase = 'write structured original';
        const file = await main.write({ at, op: 'create', path: '/note.md', content: '# Heading\n\nHello world.' }, options());
        phase = 'search working chunks';
        const before = await main.search({ at, query: 'Hello world', rerank: false }, options());
        assert.equal(before.hits.length, 1);
        assert.equal(before.hits[0].content, 'Hello world.');
        assert.deepEqual(before.hits[0].range, { start: 11, end: 23 });
        phase = 'publish structured chunks';
        // Publication already waits for definite cold-snapshot rejections
        // of its target tag. Allow that stage its documented wait budget.
        await main.merge({ at, requestId: 'publish-structured', summary: 'Publish synthetic structured note' },
            { signal: AbortSignal.timeout(270_000) });
        phase = 'checkpoint published snapshot';
        // First-write tag visibility is a separate backend readiness check.
        // This test pins the already confirmed published tag instead.
        const checkpoint = (await main.checkpoint({ name: 'saved' }, options())).at;
        phase = 'reopen published original without parser';
        const reopened = await MemDrive.open({ client: new LambdaDBClient(connection), name }, options());
        assert.deepEqual(await reopened.read({ fileId: file.fileId }, options()), file);
        assert.deepEqual(await reopened.read({ at: checkpoint, fileId: file.fileId }, options()), file);
        phase = 'search published chunks';
        const after = await reopened.search({ query: 'Hello world', rerank: false }, options());
        assert.deepEqual(after.hits, before.hits);

        phase = 'preserve explicit working checkpoint';
        const firstVersion = (await main.history({}, options())).entries[0].version;
        const workingSaved = (await main.checkpoint({ at, name: 'working-saved' }, options())).at;
        assert.deepEqual(await main.read({ at: workingSaved, fileId: file.fileId }, options()), file);
        phase = 'publish a later revision';
        const updated = await main.write({ at, op: 'update', fileId: file.fileId, content: '# Heading\n\nGoodbye world.' }, options());
        const later = await main.merge({ at, requestId: 'publish-later', summary: 'Publish later synthetic revision' },
            { signal: AbortSignal.timeout(270_000) });
        phase = 'create historical refs after later publication';
        // merge publishes only; the source fork remains until deleted explicitly.
        assert.equal(later.status, 'published');
        assert.deepEqual(await main.listForks({}, options()), { forks: [{ at }] });
        const mainPast = (await main.fork({ name: 'main-past', version: firstVersion }, options())).at;
        const savedPast = (await main.checkpoint({ at: { kind: 'main' }, name: 'main-past', version: firstVersion }, options())).at;
        const forkPast = (await main.fork({ at: workingSaved, name: 'fork-past' }, options())).at;
        for (const past of [mainPast, savedPast, forkPast])
            assert.deepEqual(await main.read({ at: past, fileId: file.fileId }, options()), file);
        assert.deepEqual(await main.read({ fileId: file.fileId }, options()), updated);
        for (const source of [at, workingSaved])
            await assert.rejects(main.fork({ at: source, name: 'past-copy', version: firstVersion }, options()), { code: 'INVALID_INPUT' });

        for (const source of [undefined, at, workingSaved])
            await assert.rejects(main.fork({ ...(source ? { at: source } : {}), name: 'removed-time', asOf: new Date().toISOString() }, options()), { code: 'INVALID_INPUT' });

        phase = 'prepare aged retention fixture';
        const { collection } = await client.collection(name).get(options());
        const driveId = createHash('sha256').update(JSON.stringify([name, collection.projectName, collection.createdAt.toISOString()])).digest('hex');
        const journal = client.collection(`md-journal-${driveId.slice(0, 40)}`);
        const metadata = (await journal.get(options())).collection;
        assert.equal(metadata.tags['memdrive.owner'], driveId);
        assert.equal(metadata.tags['memdrive.format'], 'merge-publication-v1');
        const ref = { ref: { kind: 'branch', name: 'main' }, consistentRead: true };
        const completions = new Map((await journal.docs.fetch({ ...ref, ids: ['completion:1', 'completion:2'] }, options())).docs
            .map(({ doc }) => [doc.id, doc]));
        for (const [id, version] of [['completion:1', 'v1'], ['completion:2', 'v2']]) {
            assert.equal(completions.get(id).driveId, driveId);
            assert.equal(completions.get(id).status, 'published');
            assert.equal(completions.get(id).version, version);
        }
        // Age only timestamps in this owned synthetic fixture. This validates
        // the real cleanup path without pretending days elapsed in real time.
        // The second publication superseded v1, whose tag ages from that publication.
        const aged = Date.now() - 2 * 86_400_000;
        await journal.docs.update({ branch: 'main', docs: [
            { id: 'reservation:1', startedAt: new Date(aged - 3000).toISOString() },
            { id: 'completion:1', completedAt: new Date(aged - 2000).toISOString() },
            { id: 'reservation:2', startedAt: new Date(aged - 1000).toISOString() },
            { id: 'completion:2', completedAt: new Date(aged).toISOString() },
        ] }, options());
        const reservation = (await journal.docs.fetch({ ...ref, ids: ['reservation:1'] }, options())).docs[0].doc;
        assert.equal(Object.hasOwn(reservation, 'sourceTag'), false);
        // Merges pinned their versions only; the other tags are this test's checkpoints.
        const tagNames = (await client.collection(name).tags.list(options())).tags.map(tag => tag.name).sort();
        assert.deepEqual(tagNames, ['checkpoint-main-past', 'checkpoint-saved', 'checkpoint-working-saved', 'md-main-v1', 'md-main-v2']);
        const supersededPresent = async () => {
            try { await client.collection(name).tags.get('md-main-v1', options()); return true; }
            catch (error) {
                if ((error.status ?? error.statusCode) !== 404) throw error;
                return false;
            }
        };
        const retentionClient = new LambdaDBClient(connection);
        const retentionMain = await MemDrive.open({ client: retentionClient, name }, options());
        const history = await retentionMain.history({}, options());
        assert.equal('pruneHistory' in retentionMain, false);
        phase = 'retain the superseded version within the default SDK window';
        // Two days exceeds one-day native retention but not the 30-day SDK window.
        assert.equal((await retentionMain.merge({ at, requestId: 'publish-structured', summary: 'Publish synthetic structured note' }, options())).version, 'v1');
        assert(await supersededPresent(), 'A superseded version inside the SDK window was released.');
        phase = 'configure one-day SDK window';
        assert.equal((await retentionMain.configure({ retentionInDays: 1 }, options())).retentionInDays, 1);
        assert.deepEqual(await settings(), { native: 1, window: 1 });
        const observer = await MemDrive.open({ client: new LambdaDBClient(connection), name }, options());
        assert.equal((await observer.describe(options())).retentionInDays, 1);
        phase = 'automatic retention after merge replay';
        assert.equal(await MemDrive.open({ client: retentionClient, name }, options()), retentionMain);
        // Each automatic pass is best effort and has a short budget. A later
        // terminal replay retries unfinished cleanup without changing its result.
        let removed = false;
        for (let attempt = 0; attempt < 5 && !removed; attempt++) {
            assert.equal((await retentionMain.merge({ at, requestId: 'publish-structured', summary: 'Publish synthetic structured note' }, options())).version, 'v1');
            removed = !await supersededPresent();
        }
        assert(removed, 'Automatic retention did not remove the expired superseded version within five merge replays.');
        // The current version stays pinned.
        await client.collection(name).tags.get('md-main-v2', options());
        assert.deepEqual(await retentionMain.history({}, options()), history);
        assert.deepEqual(await retentionMain.read({ fileId: file.fileId }, options()), updated);
        assert.deepEqual(await retentionMain.read({ at: savedPast, fileId: file.fileId }, options()), file);
        assert.deepEqual(await retentionMain.read({ at: checkpoint, fileId: file.fileId }, options()), file);
        assert.equal((await retentionMain.merge({ at, requestId: 'publish-structured', summary: 'Publish synthetic structured note' }, options())).version, 'v1');
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
