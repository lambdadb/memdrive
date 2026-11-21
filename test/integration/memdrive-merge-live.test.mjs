import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { HTTPClient, LambdaDBClient } from '@functional-systems/lambdadb';
import { MemDrive, MemDriveError } from '@functional-systems/memdrive';

const enabled = process.env.MEMDRIVE_RUN_LIVE_TESTS === '1' && process.env.MEMDRIVE_RUN_LIVE_MERGE_TESTS === '1';
const required = ['LAMBDADB_BASE_URL', 'LAMBDADB_PROJECT_NAME', 'LAMBDADB_PROJECT_API_KEY'];
const options = () => ({ signal: AbortSignal.timeout(120_000) });
const statusOf = error => error?.status ?? error?.statusCode;
const safeFailure = (phase, error) => {
    const detail = error instanceof assert.AssertionError && !error.message.includes(process.env.LAMBDADB_PROJECT_API_KEY)
        ? ` ${error.message.split('\n')[0]}` : '';
    return new Error(`${phase} failed (${error?.code ?? error?.name ?? 'Error'}${statusOf(error) ? `, status ${statusOf(error)}` : ''}).${detail}`);
};

const original = 'Alpine compass points north.';
const changed = 'Alpine compass points west.';
const later = 'Alpine compass points east.';
const deletion = 'Marigold atlas covers old towns.';
const newPath = '/published-created.txt';
const mainRef = { kind: 'branch', name: 'main' };
const sha = value => createHash('sha256').update(value).digest('hex');

test('live public merge publishes immutable views and resumes one interrupted request', {
    skip: enabled ? false : 'Set MEMDRIVE_RUN_LIVE_TESTS=1 and MEMDRIVE_RUN_LIVE_MERGE_TESTS=1 for live resources.',
    timeout: 600_000,
}, async t => {
    for (const key of required) assert(process.env[key]?.trim(), `Missing live configuration: ${key}`);
    const endpoint = new URL(process.env.LAMBDADB_BASE_URL);
    assert(endpoint.protocol === 'https:' && endpoint.origin === endpoint.href.slice(0, -1), 'Expected an HTTPS project origin.');
    const project = process.env.LAMBDADB_PROJECT_NAME;
    const owner = randomUUID();
    const name = 'md-live-merge-' + owner;
    const names = new Set([name]);
    const created = new Set();
    const root = `/projects/${encodeURIComponent(project)}/collections`;
    let fault, failure, driveId;
    let mutations = 0;
    let phase = 'Create an empty store';

    function native() {
        const httpClient = new HTTPClient({ fetcher: async request => {
            const url = new URL(request.url);
            assert.equal(url.origin, endpoint.origin);
            const parts = url.pathname.slice(root.length + 1).split('/');
            const collection = parts[0];
            assert(url.pathname === root || (url.pathname.startsWith(root + '/') && names.has(collection)),
                'Native request escaped the fixture collections.');
            let body;
            if (request.method === 'POST' && (url.pathname === root || /\/docs\/(upsert|update|delete)$/.test(url.pathname)))
                body = await request.clone().json();
            if (url.pathname === root && request.method === 'POST') assert(names.has(body.collectionName), 'Unknown collection create.');
            const contentMutation = request.method === 'POST' && collection === name && body?.branch === 'main'
                && /\/docs\/(upsert|update|delete)$/.test(url.pathname);
            if (fault?.kind === 'partial' && contentMutation && fault.applied > 0) {
                fault.rejected++;
                // This synthetic rejection is returned before dispatch. Writes through the first
                // original mutation reach LambdaDB normally.
                return new Response(JSON.stringify({ message: 'Synthetic interruption before a later main mutation' }), {
                    status: 400, headers: { 'content-type': 'application/json' },
                });
            }

            if (request.method === 'DELETE' || request.method === 'PATCH' || request.method === 'PUT'
                || (request.method === 'POST' && !/\/(docs\/(fetch|list)|query)$/.test(url.pathname))) mutations++;
            const response = await fetch(request, { redirect: 'error' });
            if (url.pathname === root && request.method === 'POST' && response.status === 201) {
                created.add(body.collectionName);
                if (body.collectionName === name) {
                    const { collection: metadata } = await response.clone().json();
                    const createdAt = new Date(metadata.createdAt).toISOString();
                    driveId = sha(JSON.stringify([name, metadata.projectName, createdAt]));
                    const internal = 'md-journal-' + driveId.slice(0, 40);
                    names.add(internal);
                }
            }
            if (fault?.kind === 'partial' && contentMutation && response.status === 202) {
                fault.accepted++;
                if (body.docs?.some(doc => doc.id?.startsWith('file:')) || body.ids?.some(id => id.startsWith('file:')))
                    fault.applied++;
            }
            if (fault?.kind === 'terminal' && collection !== name && response.status === 202
                && body?.docs?.some(doc => doc.kind === 'merge-result-v1' && doc.requestId === fault.requestId) && !fault.dropped) {
                fault.dropped++;
                // The server accepted the terminal record. Only the reply is lost.
                throw new Error('Synthetic transport loss after an actual HTTP 202');
            }
            if (!response.ok && response.status !== 404)
                t.diagnostic(`Native ${request.method} ${parts.slice(1).join('/')} returned HTTP ${response.status}.`);
            return response;
        } });
        return new LambdaDBClient({ baseUrl: endpoint.origin, projectName: project, projectApiKey: process.env.LAMBDADB_PROJECT_API_KEY,
            httpClient, timeoutMs: 60_000, retryConfig: { strategy: 'none' }, debugLogger: { log() {}, group() {}, groupEnd() {} } });
    }

    async function freshMain() { return MemDrive.open({ client: native(), name }, options()); }
    async function freshFork(fork) { return MemDrive.open({ client: native(), name, at: { fork } }, options()); }
    async function read(view, path, expected) {
        const file = await view.read({ path }, options());
        assert.equal(file?.content ?? null, expected, path);
        return file;
    }
    async function search(view, text, fileId, expected) {
        const result = await view.search({ query: text, limit: 8, rerank: false }, options());
        const hits = result.hits.filter(hit => hit.fileId === fileId);
        assert(hits.some(hit => hit.content.includes(expected)), 'Published search omitted the expected source.');
        assert(hits.every(hit => hit.content.includes(expected)), 'Published search exposed a different source revision.');
    }
    async function verifyList(view, expected) {
        const listing = await view.list({}, options());
        const byPath = (a, b) => a.path.localeCompare(b.path);
        const entries = listing.files.map(({ fileId, path }) => ({ fileId, path })).sort(byPath);
        const wanted = [...expected].sort(byPath);
        const complete = JSON.stringify(entries) === JSON.stringify(wanted);
        t.diagnostic(`Published list returned ${entries.length}/${wanted.length} expected IDs and paths; exact=${complete}; consistency=${listing.consistency}.`);
        assert.deepEqual(entries, wanted);
    }

    const client = native();
    try {
        const main = await MemDrive.create({ client, name, labels: { 'eval.owner': owner } }, options());
        assert.deepEqual(await (await freshMain()).list({}, options()).then(value => value.files), []);
        await read(main, '/working.txt', null);
        const work = await main.fork({ name: 'source' }, options());
        const [moved, removed] = await work.write([
            { op: 'create', path: '/working.txt', content: original },
            { op: 'create', path: '/delete.txt', content: deletion },
        ], options());
        await read(await freshMain(), '/working.txt', null);

        phase = 'Publish the first merge from a new store';
        const first = { requestId: randomUUID(), summary: 'Publish synthetic originals' };
        const firstResult = await work.merge(first, options());
        assert.equal(firstResult.requestId, first.requestId);
        assert.equal(firstResult.status, 'published');
        assert(typeof firstResult.version === 'string' && firstResult.version);
        const beforeFirstReplay = mutations;
        assert.deepEqual(await (await freshFork('source')).merge(first, options()), firstResult);
        assert.equal(mutations, beforeFirstReplay, 'Terminal replay sent a mutation.');
        const initial = await freshMain();
        await read(initial, '/working.txt', original);
        await read(initial, '/delete.txt', deletion);
        await search(initial, 'Alpine compass', moved.fileId, original);
        await verifyList(initial, [{ fileId: moved.fileId, path: '/working.txt' }, { fileId: removed.fileId, path: '/delete.txt' }]);
        const retained = await initial.checkpoint({ name: 'initial-publication' }, options());
        const stale = await initial.fork({ name: 'conflicting-edit' }, options());
        const unrelated = await retained.fork({ name: 'unrelated-edit' }, options());
        await read(stale, '/working.txt', original);
        await read(unrelated, '/delete.txt', deletion);
        await stale.write({ op: 'update', fileId: moved.fileId, content: 'Conflicting synthetic edit.' }, options());
        await unrelated.write({ op: 'create', path: '/unrelated.txt', content: '' }, options());

        phase = 'Stop after one real physical mutation';
        const second = { requestId: randomUUID(), summary: 'Publish the moved, removed, and new files' };
        const edits = await work.write([
            { op: 'update', fileId: moved.fileId, newPath: '/moved.txt', content: changed },
            { op: 'delete', fileId: removed.fileId },
            { op: 'create', path: newPath, content: '' },
        ], options());
        const partial = { kind: 'partial', accepted: 0, applied: 0, rejected: 0 };
        fault = partial;
        await assert.rejects(work.merge(second, options()), { code: 'MERGE_RESUMABLE' });
        fault = undefined;
        assert.equal(partial.applied, 1);
        assert(partial.rejected >= 1);
        const physical = await client.collection(name).docs.fetch({
            ids: [moved.fileId, removed.fileId, edits[2].fileId].map(id => `file:${id}`),
            ref: mainRef, consistentRead: true, includeVectors: false,
        }, options());
        const originals = new Map(physical.docs.map(({ doc }) => [doc.fileId, doc]));
        const movedNow = originals.get(moved.fileId)?.path === '/moved.txt';
        const removedNow = !originals.has(removed.fileId) || originals.get(removed.fileId).kind !== 'file';
        const createdNow = originals.has(edits[2].fileId);
        assert([movedNow, removedNow, createdNow].some(Boolean), 'No applied change was visible on physical main.');
        assert(![movedNow, removedNow, createdNow].every(Boolean), 'The fault did not interrupt a partial apply.');
        t.diagnostic(`Partial apply: native accepts=${partial.accepted}; original mutations=${partial.applied}; injected pre-dispatch rejections=${partial.rejected}.`);

        phase = 'Read the previous published view and block a different request';
        const oldMain = await freshMain();
        await read(oldMain, '/working.txt', original);
        await read(oldMain, '/moved.txt', null);
        await read(oldMain, '/delete.txt', deletion);
        await read(oldMain, newPath, null);
        await search(oldMain, 'Alpine compass', moved.fileId, original);
        await verifyList(oldMain, [{ fileId: moved.fileId, path: '/working.txt' }, { fileId: removed.fileId, path: '/delete.txt' }]);
        const faultCheckpoint = await oldMain.checkpoint({ name: 'during-failure' }, options());
        const faultFork = await faultCheckpoint.fork({ name: 'during-failure' }, options());
        await read(faultFork, '/working.txt', original);
        await read(faultFork, '/moved.txt', null);
        const unrelatedRequest = { requestId: randomUUID(), summary: 'Publish an unrelated file' };
        const beforeBlocked = mutations;
        await assert.rejects((await freshFork('unrelated-edit')).merge(unrelatedRequest, options()), { code: 'MERGE_BLOCKED' });
        assert.equal(mutations, beforeBlocked, 'A blocked request sent a mutation.');
        await read(await freshMain(), '/unrelated.txt', null);

        phase = 'Resume the same request while preserving later working edits';
        await work.write({ op: 'update', fileId: moved.fileId, content: later }, options());
        const terminal = { kind: 'terminal', requestId: second.requestId, dropped: 0 };
        fault = terminal;
        let resumed;
        try { resumed = await (await freshFork('source')).merge(second, options()); }
        catch (error) {
            assert(error instanceof MemDriveError && terminal.dropped === 1, 'The recovery did not reach the terminal write.');
            t.diagnostic(`The native reply loss surfaced as ${error.code} before terminal replay.`);
        }
        fault = undefined;
        assert.equal(terminal.dropped, 1);
        const beforeReplay = mutations;
        const replay = await (await freshFork('source')).merge(second, options());
        assert.equal(replay.requestId, second.requestId);
        assert.equal(replay.status, 'published');
        assert.notEqual(replay.version, firstResult.version);
        if (resumed !== undefined) assert.deepEqual(replay, resumed);
        assert.deepEqual(await (await freshFork('source')).merge(second, options()), replay);
        await assert.rejects((await freshFork('source')).merge({ ...second, summary: 'Different summary' }, options()),
            { code: 'MERGE_REQUEST_CONFLICT' });
        assert.equal(mutations, beforeReplay, 'Terminal replay sent a mutation.');
        t.diagnostic('Terminal reply dropped after a real HTTP 202; the same request replayed from two fresh clients.');
        const final = await freshMain();
        await read(final, '/working.txt', null);
        await read(final, '/moved.txt', changed);
        await read(final, '/delete.txt', null);
        await read(final, newPath, '');
        await search(final, 'Alpine compass', moved.fileId, changed);
        await verifyList(final, [{ fileId: moved.fileId, path: '/moved.txt' }, { fileId: edits[2].fileId, path: newPath }]);
        await read(retained, '/working.txt', original);
        await read(faultCheckpoint, '/delete.txt', deletion);
        await read(faultFork, '/working.txt', original);
        const reopened = await freshFork('source');
        await read(reopened, '/moved.txt', later);
        assert.deepEqual(await reopened.diff(options()), [{ op: 'update', fileId: moved.fileId, path: '/moved.txt' }]);

        phase = 'Reject a stale target and publish an unrelated fork';
        await assert.rejects((await freshFork('conflicting-edit')).merge({ requestId: randomUUID(), summary: 'Conflicting file' }, options()),
            { code: 'MERGE_CONFLICT' });
        await read(await freshMain(), '/moved.txt', changed);
        await (await freshFork('unrelated-edit')).merge(unrelatedRequest, options());
        await read(await freshMain(), '/unrelated.txt', '');
        await read(retained, '/unrelated.txt', null);
    } catch (error) {
        failure = safeFailure(phase, error);
    } finally {
        fault = undefined;
        for (const collection of [...created].reverse()) {
            try {
                const handle = client.collection(collection);
                const { collection: metadata } = await handle.get(options());
                assert.equal(metadata.collectionName, collection);
                if (collection === name) {
                    assert.equal(metadata.tags?.['eval.owner'], owner);
                } else {
                    assert.equal(metadata.tags?.['memdrive.format'], 'merge-publication-v1');
                    assert.equal(metadata.tags?.['memdrive.owner'], driveId);
                }
                await handle.delete(options());
                let absent = false;
                for (let attempt = 0; attempt < 8; attempt++) {
                    try { await handle.get(options()); }
                    catch (error) {
                        if (statusOf(error) === 404) { absent = true; break; }
                        throw error;
                    }
                    await sleep(500);
                }
                assert(absent, 'Collection cleanup was not confirmed.');
                t.diagnostic(`Owned fixture cleanup confirmed GET 404 for ${collection}.`);
            } catch (error) {
                const cleanup = safeFailure('Fixture cleanup', error);
                failure = failure ? new AggregateError([failure, cleanup]) : cleanup;
            }
        }
    }
    if (failure) throw failure;
});
