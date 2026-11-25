import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { HTTPClient, LambdaDBClient, MemDrive } from '@functional-systems/memdrive';

const enabled = process.env.MEMDRIVE_RUN_LIVE_TESTS === '1' && process.env.MEMDRIVE_RUN_LIVE_STATUS_HISTORY_TESTS === '1';
const options = () => ({ signal: AbortSignal.timeout(240_000) });
const statusOf = error => error?.status ?? error?.statusCode;

test('live status and history read retained main publications without mutating the store, including after failed bookkeeping', {
    skip: enabled ? false : 'Set MEMDRIVE_RUN_LIVE_TESTS=1 and MEMDRIVE_RUN_LIVE_STATUS_HISTORY_TESTS=1 for live resources.',
    timeout: 600_000,
}, async t => {
    for (const key of ['LAMBDADB_BASE_URL', 'LAMBDADB_PROJECT_NAME', 'LAMBDADB_PROJECT_API_KEY'])
        assert(process.env[key]?.trim(), `Missing live configuration: ${key}`);
    const endpoint = new URL(process.env.LAMBDADB_BASE_URL);
    assert(endpoint.protocol === 'https:' && endpoint.origin === endpoint.href.slice(0, -1), 'Expected an HTTPS project origin.');
    const projectName = process.env.LAMBDADB_PROJECT_NAME;
    const name = 'md-live-history-' + randomUUID();
    const root = `/projects/${encodeURIComponent(projectName)}/collections`;
    const allowed = new Set([name]);
    const created = new Set();
    let mutations = 0;
    let rejectBookkeeping = false;
    let interrupted = 0;
    let phase = 'Create store';

    function native() {
        const httpClient = new HTTPClient({ fetcher: async request => {
            const { origin, pathname } = new URL(request.url);
            const [collection] = pathname.slice(root.length + 1).split('/');
            assert.equal(origin, endpoint.origin);
            assert(pathname === root || (pathname.startsWith(root + '/') && allowed.has(collection)),
                'Native request escaped the fixture collections.');
            const read = ['GET', 'HEAD'].includes(request.method) || /\/(docs\/(fetch|list)|query)$/.test(pathname);
            if (!read) mutations++;
            if (pathname === root && request.method === 'POST')
                assert(allowed.has((await request.clone().json()).collectionName), 'Unknown collection create.');
            if (rejectBookkeeping && collection === name && request.method === 'POST' && pathname.endsWith('/docs/upsert')) {
                const { branch, docs } = await request.clone().json();
                // Source bookkeeping advances a fork original's baseline to the published version.
                if (branch === 'fork-history-source' && docs.some(doc => doc.baseline?.version === 'v2')) {
                    interrupted++;
                    return Response.json({ message: 'Synthetic interruption before bookkeeping' }, { status: 400 });
                }
            }
            const response = await fetch(request, { redirect: 'error' });
            if (pathname === root && request.method === 'POST' && response.status === 201) {
                const { collection: metadata } = await response.clone().json();
                assert(allowed.has(metadata.collectionName), 'Unexpected collection created.');
                created.add(metadata.collectionName);
                if (metadata.collectionName === name) {
                    const identity = JSON.stringify([name, metadata.projectName, new Date(metadata.createdAt).toISOString()]);
                    allowed.add('md-journal-' + createHash('sha256').update(identity).digest('hex').slice(0, 40));
                }
            }
            return response;
        } });
        return new LambdaDBClient({ baseUrl: endpoint.origin, projectName, projectApiKey: process.env.LAMBDADB_PROJECT_API_KEY,
            httpClient, timeoutMs: 60_000, retryConfig: { strategy: 'none' }, debugLogger: { log() {}, group() {}, groupEnd() {} } });
    }

    const client = native();
    const merge = (at, label) => drive.merge({ at, summary: `Publish ${label}` }, options());
    const fresh = () => MemDrive.open({ client: native(), name }, options());
    let failure, drive;
    try {
        const main = drive = await MemDrive.create({ client, name }, options());
        const beforeEmptyReads = mutations;
        assert.deepEqual(await main.status({}, options()), { at: { kind: 'main' }, mainVersion: 'v0' });
        assert.deepEqual(await main.history({}, options()), { entries: [], throughVersion: 'v0' });
        assert.equal(mutations, beforeEmptyReads);

        phase = 'Publish with failed source bookkeeping';
        const { at: work } = await main.fork({ name: 'history-source' }, options());
        const first = await main.write({ at: work, op: 'create', path: '/one.txt', content: 'Alpine history fixture.' }, options());
        assert.equal((await merge(work, 'first')).version, 'v1');
        const { at: checkpoint } = await main.checkpoint({ name: 'first-publication' }, options());
        assert.deepEqual(await merge(work, 'unchanged'), { status: 'unchanged', version: 'v1' });
        const second = await main.write({ at: work, op: 'create', path: '/two.txt', content: 'Marigold history fixture.' }, options());
        rejectBookkeeping = true;
        // Bookkeeping is best effort: the publication stands.
        assert.deepEqual(await merge(work, 'second'), { status: 'published', version: 'v2' });
        assert.equal(interrupted, 1);
        rejectBookkeeping = false;
        // Another client still sees the published file as a change; this drive settles it before its next fork operation.
        assert.deepEqual((await (await fresh()).diff({ at: work }, options())).map(({ fileId }) => fileId), [second.fileId]);
        assert.deepEqual(await main.diff({ at: work }, options()), []);

        phase = 'Read status and history';
        const reader = await fresh();
        const beforePendingReads = mutations;
        assert.deepEqual(await reader.status({}, options()), { at: { kind: 'main' }, mainVersion: 'v2' });
        assert.deepEqual(await main.status({ at: work }, options()), { at: { kind: 'fork', name: 'history-source' }, mainVersion: 'v2' });
        assert.deepEqual(await reader.status({ at: checkpoint }, options()), { at: { kind: 'checkpoint', name: 'first-publication' }, mainVersion: 'v2' });
        await assert.rejects(reader.history({ sinceVersion: 'v3' }, options()), { code: 'VERSION_NOT_FOUND' });
        const page = await main.history({ limit: 1 }, options());
        assert.deepEqual(Object.keys(page.next ?? {}), ['cursor']);
        assert.equal(page.throughVersion, 'v2');
        assert.deepEqual(page.entries.map(({ version, summary, fileIds, fileIdsTruncated }) =>
            [version, summary, fileIds, fileIdsTruncated]), [['v1', 'Publish first', [first.fileId], false]]);
        assert.equal(new Date(page.entries[0].publishedAt).toISOString(), page.entries[0].publishedAt);
        assert.deepEqual((await reader.history({ sinceVersion: 'v1' }, options())).entries.map(({ fileIds }) => fileIds), [[second.fileId]]);
        assert.equal(mutations, beforePendingReads);

        phase = 'Merge the settled fork again and publish after the pagination cutoff';
        assert.deepEqual(await merge(work, 'second again'), { status: 'unchanged', version: 'v2' });
        await main.write({ at: work, op: 'delete', fileId: first.fileId }, options());
        assert.equal((await merge(work, 'third')).version, 'v3');
        const beforeContinuedReads = mutations;
        const continued = await main.history(page.next, options());
        assert.equal(continued.throughVersion, 'v2');
        assert.equal(continued.next, undefined);
        assert.deepEqual(continued.entries.map(({ version, fileIds }) => [version, fileIds]), [['v2', [second.fileId]]]);
        assert.deepEqual((await reader.history({ sinceVersion: 'v2' }, options())).entries.map(({ version, fileIds }) =>
            [version, fileIds]), [['v3', [first.fileId]]]);
        assert.equal(mutations, beforeContinuedReads);
    } catch (error) {
        failure = new Error(`${phase} failed (${error?.code ?? error?.name ?? 'Error'}${statusOf(error) ? `, HTTP ${statusOf(error)}` : ''}).`);
    } finally {
        for (const collection of [...created].reverse()) {
            const handle = client.collection(collection);
            try {
                await handle.delete(options());
                for (let attempt = 0; ; attempt++) {
                    try { await handle.get(options()); }
                    catch (error) {
                        if (statusOf(error) === 404) break;
                        throw error;
                    }
                    assert(attempt < 7, 'Collection cleanup was not confirmed.');
                    await sleep(500);
                }
                t.diagnostic(`Verified deletion of ${collection === name ? 'content' : 'publication journal'} collection.`);
            } catch (error) {
                const cleanup = new Error(`Cleanup failed (${error?.code ?? error?.name ?? 'Error'}).`);
                failure = failure ? new AggregateError([failure, cleanup], 'Live status/history and cleanup failed.') : cleanup;
            }
        }
    }
    if (failure) throw failure;
});
