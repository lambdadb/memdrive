import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { HTTPClient, LambdaDBClient } from '@functional-systems/lambdadb';
import { MemDrive } from '@functional-systems/memdrive';

const enabled = process.env.MEMDRIVE_RUN_LIVE_TESTS === '1' && process.env.MEMDRIVE_RUN_LIVE_STATUS_HISTORY_TESTS === '1';
const options = () => ({ signal: AbortSignal.timeout(240_000) });
const statusOf = error => error?.status ?? error?.statusCode;

test('live status and history read retained main publications without mutating the store', {
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
            if (rejectBookkeeping && collection !== name && request.method === 'POST' && pathname.endsWith('/docs/upsert')) {
                const { docs } = await request.clone().json();
                if (docs.some(doc => doc.kind === 'merge-bookkeeping-v1')) {
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
    const merge = (fork, requestId) => fork.merge({ requestId, summary: `Publish ${requestId}` }, options());
    const fresh = () => MemDrive.open({ client: native(), name }, options());
    let failure;
    try {
        const main = await MemDrive.create({ client, name }, options());
        const beforeEmptyReads = mutations;
        assert.deepEqual(await main.status(options()), { at: { kind: 'main' }, mainVersion: 'v0' });
        assert.deepEqual(await main.history({}, options()), { entries: [], throughVersion: 'v0' });
        assert.equal(mutations, beforeEmptyReads);

        phase = 'Publish and interrupt bookkeeping';
        const work = await main.fork({ name: 'history-source' }, options());
        const first = await work.write({ op: 'create', path: '/one.txt', content: 'Alpine history fixture.' }, options());
        assert.equal((await merge(work, 'first')).version, 'v1');
        const checkpoint = await main.checkpoint({ name: 'first-publication' }, options());
        assert.equal((await merge(work, 'unchanged')).status, 'unchanged');
        const second = await work.write({ op: 'create', path: '/two.txt', content: 'Marigold history fixture.' }, options());
        rejectBookkeeping = true;
        await assert.rejects(merge(work, 'second'), { code: 'MERGE_RESUMABLE',
            details: { requestId: 'second', publishedVersion: 'v3' } });
        assert.equal(interrupted, 1);
        rejectBookkeeping = false;

        phase = 'Read unfinished status and the published completion';
        const reader = await fresh();
        const beforePendingReads = mutations;
        assert.deepEqual(await reader.status(options()),
            { at: { kind: 'main' }, mainVersion: 'v3', merge: { requestId: 'second', phase: 'bookkeeping' } });
        assert.deepEqual(await work.status(options()), { at: { kind: 'fork', name: 'history-source' },
            mainVersion: 'v3', merge: { requestId: 'second', phase: 'bookkeeping' } });
        assert.deepEqual(await checkpoint.status(options()), { at: { kind: 'checkpoint', name: 'first-publication' },
            mainVersion: 'v3', merge: { requestId: 'second', phase: 'bookkeeping' } });
        await assert.rejects(reader.history({ sinceVersion: 'v2' }, options()), { code: 'VERSION_NOT_FOUND' });
        const page = await checkpoint.history({ limit: 1 }, options());
        assert(page.cursor);
        assert.equal(page.throughVersion, 'v3');
        assert.deepEqual(page.entries.map(({ version, summary, fileIds, fileIdsTruncated }) =>
            [version, summary, fileIds, fileIdsTruncated]), [['v1', 'Publish first', [first.fileId], false]]);
        assert.equal(new Date(page.entries[0].publishedAt).toISOString(), page.entries[0].publishedAt);
        assert.deepEqual((await reader.history({ sinceVersion: 'v1' }, options())).entries.map(({ fileIds }) => fileIds), [[second.fileId]]);
        assert.equal(mutations, beforePendingReads);

        phase = 'Recover and publish after the pagination cutoff';
        const recovered = await MemDrive.open({ client, name, recover: true }, options());
        assert.deepEqual(await recovered.status(options()), { at: { kind: 'main' }, mainVersion: 'v3' });
        await work.write({ op: 'delete', fileId: first.fileId }, options());
        assert.equal((await merge(work, 'third')).version, 'v4');
        const beforeContinuedReads = mutations;
        const continued = await work.history({ cursor: page.cursor }, options());
        assert.equal(continued.throughVersion, 'v3');
        assert.equal(continued.cursor, undefined);
        assert.deepEqual(continued.entries.map(({ version, fileIds }) => [version, fileIds]), [['v3', [second.fileId]]]);
        assert.deepEqual((await reader.history({ sinceVersion: 'v3' }, options())).entries.map(({ version, fileIds }) =>
            [version, fileIds]), [['v4', [first.fileId]]]);
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
