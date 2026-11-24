import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { HTTPClient, LambdaDBClient, MemDrive, MemDriveError } from '@functional-systems/memdrive';

const enabled = process.env.MEMDRIVE_RUN_LIVE_TESTS === '1' && process.env.MEMDRIVE_RUN_LIVE_MERGE_TESTS === '1';
const required = ['LAMBDADB_BASE_URL', 'LAMBDADB_PROJECT_NAME', 'LAMBDADB_PROJECT_API_KEY'];
const options = () => ({ signal: AbortSignal.timeout(270_000) });
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

test('live public merge publishes immutable views, holds its fork still and resumes one interrupted request', {
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
                && body?.docs?.some(doc => doc.kind === 'merge-result-v1' && doc.status === 'published') && !fault.dropped) {
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

    // A view is one drive object plus an explicit at; omitted at selects main.
    const forkAt = fork => ({ kind: 'fork', name: fork });
    async function freshMain() { return { drive: await MemDrive.open({ client: native(), name }, options()) }; }
    async function freshFork(fork) { return { drive: await MemDrive.open({ client: native(), name }, options()), at: forkAt(fork) }; }
    async function read(view, path, expected) {
        const file = await view.drive.read({ at: view.at, path }, options());
        assert.equal(file?.content ?? null, expected, path);
        return file;
    }
    async function search(view, text, fileId, expected) {
        const result = await view.drive.search({ at: view.at, query: text, limit: 8, rerank: false }, options());
        const hits = result.hits.filter(hit => hit.fileId === fileId);
        assert(hits.some(hit => hit.content.includes(expected)), 'Published search omitted the expected source.');
        assert(hits.every(hit => hit.content.includes(expected)), 'Published search exposed a different source revision.');
    }
    async function verifyList(view, expected) {
        const listing = await view.drive.list({ at: view.at }, options());
        const byPath = (a, b) => a.path.localeCompare(b.path);
        const entries = listing.files.map(({ fileId, path }) => ({ fileId, path })).sort(byPath);
        const wanted = [...expected].sort(byPath);
        const complete = JSON.stringify(entries) === JSON.stringify(wanted);
        t.diagnostic(`Published list returned ${entries.length}/${wanted.length} expected IDs and paths; exact=${complete}; consistency=${listing.consistency}.`);
        assert.deepEqual(entries, wanted);
    }
    const merge = (view, request) => view.drive.merge({ at: view.at, ...request }, options());

    const client = native();
    try {
        const main = await MemDrive.create({ client, name, labels: { 'eval.owner': owner } }, options());
        assert.deepEqual(await (await freshMain()).drive.list({}, options()).then(value => value.files), []);
        await read({ drive: main }, '/working.txt', null);
        const work = { drive: main, at: (await main.fork({ name: 'source' }, options())).at };
        assert.deepEqual(work.at, forkAt('source'));
        const [moved, removed] = await main.write({ at: work.at, operations: [
            { op: 'create', path: '/working.txt', content: original },
            { op: 'create', path: '/delete.txt', content: deletion },
        ] }, options());
        await read(await freshMain(), '/working.txt', null);

        phase = 'Publish the first merge from a new store';
        const first = { requestId: randomUUID(), summary: 'Publish synthetic originals' };
        const firstStarted = Date.now();
        const firstResult = await merge(work, first);
        t.diagnostic(`First cold publication completed in one public call after ${Date.now() - firstStarted} ms.`);
        assert.equal(firstResult.requestId, first.requestId);
        assert.equal(firstResult.status, 'published');
        assert(typeof firstResult.version === 'string' && firstResult.version);
        // merge publishes only; the source fork remains.
        assert.deepEqual(await main.listForks({}, options()), { forks: [{ at: work.at }] });
        const beforeFirstReplay = mutations;
        assert.deepEqual(await merge(await freshFork('source'), first), firstResult);
        assert.equal(mutations, beforeFirstReplay, 'Terminal replay sent a mutation.');
        const initial = await freshMain();
        await read(initial, '/working.txt', original);
        await read(initial, '/delete.txt', deletion);
        await search(initial, 'Alpine compass', moved.fileId, original);
        await verifyList(initial, [{ fileId: moved.fileId, path: '/working.txt' }, { fileId: removed.fileId, path: '/delete.txt' }]);
        const retained = { drive: initial.drive, at: (await initial.drive.checkpoint({ name: 'initial-publication' }, options())).at };
        const stale = { drive: initial.drive, at: (await initial.drive.fork({ name: 'conflicting-edit' }, options())).at };
        const unrelated = { drive: initial.drive, at: (await initial.drive.fork({ at: retained.at, name: 'unrelated-edit' }, options())).at };
        await read(stale, '/working.txt', original);
        await read(unrelated, '/delete.txt', deletion);
        await stale.drive.write({ at: stale.at, op: 'update', fileId: moved.fileId, content: 'Conflicting synthetic edit.' }, options());
        await unrelated.drive.write({ at: unrelated.at, op: 'create', path: '/unrelated.txt', content: '' }, options());

        phase = 'Stop after one real physical mutation';
        const second = { requestId: randomUUID(), summary: 'Publish the moved, removed, and new files' };
        const edits = await main.write({ at: work.at, operations: [
            { op: 'update', fileId: moved.fileId, newPath: '/moved.txt', content: changed },
            { op: 'delete', fileId: removed.fileId },
            { op: 'create', path: newPath, content: '' },
        ] }, options());
        const partial = { kind: 'partial', accepted: 0, applied: 0, rejected: 0 };
        fault = partial;
        await assert.rejects(merge(work, second), { code: 'MERGE_RESUMABLE' });
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
        const faultCheckpoint = { drive: oldMain.drive, at: (await oldMain.drive.checkpoint({ name: 'during-failure' }, options())).at };
        const faultFork = { drive: oldMain.drive, at: (await oldMain.drive.fork({ name: 'during-failure' }, options())).at };
        await read(faultFork, '/working.txt', original);
        await read(faultFork, '/moved.txt', null);
        const unrelatedRequest = { requestId: randomUUID(), summary: 'Publish an unrelated file' };
        const blockedFork = await freshFork('unrelated-edit');
        const beforeBlocked = mutations;
        await assert.rejects(merge(blockedFork, unrelatedRequest), { code: 'MERGE_BLOCKED' });
        // Drain this fork's queue so a stray background mutation is observable.
        await blockedFork.drive.diff({ at: blockedFork.at }, options());
        assert.equal(mutations, beforeBlocked, 'A blocked request sent a mutation.');
        await read(await freshMain(), '/unrelated.txt', null);

        phase = 'Hold the fork of the unfinished merge still';
        // The writer that saw the interruption and a new client that reads the
        // journal before its first write both reject writes without a mutation.
        const edit = { op: 'update', fileId: moved.fileId, content: later };
        const heldFork = await freshFork('source');
        const beforeHeld = mutations;
        for (const drive of [main, heldFork.drive]) {
            await assert.rejects(drive.write({ at: work.at, ...edit }, options()),
                error => error.code === 'MERGE_BLOCKED' && error.details.requestId === second.requestId);
            await assert.rejects(drive.write({ at: work.at, op: 'create', path: '/during-merge.txt', content: '' }, options()),
                { code: 'MERGE_BLOCKED' });
        }
        assert.equal(mutations, beforeHeld, 'A write to the held fork sent a mutation.');
        // Reads, diff and references from the held fork still work.
        await read(heldFork, '/moved.txt', changed);
        const heldDiff = await heldFork.drive.diff({ at: heldFork.at }, options());
        assert.deepEqual(heldDiff.map(change => change.op).sort(), ['create', 'delete', 'update']);
        const heldChild = { drive: heldFork.drive, at: (await heldFork.drive.fork({ at: heldFork.at, name: 'during-merge' }, options())).at };
        await read(heldChild, '/moved.txt', changed);
        // A fork whose merge was only blocked reserved nothing and stays writable.
        await blockedFork.drive.write({ at: blockedFork.at, op: 'create', path: '/unrelated-later.txt', content: '' }, options());

        phase = 'Resume the same request from the held fork';
        const terminal = { kind: 'terminal', dropped: 0 };
        fault = terminal;
        let resumed;
        try { resumed = await merge(await freshFork('source'), second); }
        catch (error) {
            assert(error instanceof MemDriveError && terminal.dropped === 1, 'The recovery did not reach the terminal write.');
            t.diagnostic(`The native reply loss surfaced as ${error.code} before terminal replay.`);
        }
        fault = undefined;
        assert.equal(terminal.dropped, 1);
        const beforeReplay = mutations;
        const replay = await merge(await freshFork('source'), second);
        assert.equal(replay.requestId, second.requestId);
        assert.equal(replay.status, 'published');
        assert.notEqual(replay.version, firstResult.version);
        if (resumed !== undefined) assert.deepEqual(replay, resumed);
        assert.deepEqual(await merge(await freshFork('source'), second), replay);
        await assert.rejects(merge(await freshFork('source'), { ...second, summary: 'Different summary' }),
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
        phase = 'Edit the settled fork for its next merge';
        const reopened = await freshFork('source');
        assert.deepEqual(await reopened.drive.diff({ at: reopened.at }, options()), []);
        // The original writer observes the settlement by another client and writes again.
        await main.write({ at: work.at, ...edit }, options());
        await read(reopened, '/moved.txt', later);
        assert.deepEqual(await reopened.drive.diff({ at: reopened.at }, options()), [{ op: 'update', fileId: moved.fileId, path: '/moved.txt' }]);
        await read(await freshMain(), '/moved.txt', changed);
        // Merges pinned main versions only; every other tag is a user checkpoint.
        const tagNames = (await client.collection(name).tags.list(options())).tags.map(tag => tag.name);
        assert(tagNames.length > 0 && tagNames.every(tag => /^md-main-v[1-9][0-9]*$/.test(tag) || tag.startsWith('checkpoint-')),
            'A merge left a tag other than a main version.');

        phase = 'Reject a stale target and publish an unrelated fork';
        await assert.rejects(merge(await freshFork('conflicting-edit'), { requestId: randomUUID(), summary: 'Conflicting file' }),
            { code: 'MERGE_CONFLICT' });
        await read(await freshMain(), '/moved.txt', changed);
        await merge(await freshFork('unrelated-edit'), unrelatedRequest);
        await read(await freshMain(), '/unrelated.txt', '');
        await read(retained, '/unrelated.txt', null);

        phase = 'Delete a source fork explicitly while retaining history, then destroy the store';
        const historyBefore = await final.drive.history({}, options());
        assert.deepEqual(await reopened.drive.deleteFork({ at: reopened.at }, options()), { at: reopened.at });
        assert.deepEqual(await final.drive.history({}, options()), historyBefore);
        assert(!(await final.drive.listForks({}, options())).forks.some(fork => fork.at.name === 'source'));
        await MemDrive.destroy({ client: native(), name }, options());
        for (const collection of created)
            await assert.rejects(client.collection(collection).get(options()), error => statusOf(error) === 404);
        t.diagnostic('Public destruction confirmed absence of the owned journal and content collection.');
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
                if (statusOf(error) === 404) continue;
                const cleanup = safeFailure('Fixture cleanup', error);
                failure = failure ? new AggregateError([failure, cleanup]) : cleanup;
            }
        }
    }
    if (failure) throw failure;
});
