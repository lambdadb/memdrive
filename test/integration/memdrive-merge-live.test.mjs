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

test('live public merge publishes immutable views, rolls main back after failures and publishes the same fork again', {
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
    const rollbacks = [], tagDeletes = [];
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
            const journalRecord = request.method === 'POST' && collection !== name && /\/docs\/upsert$/.test(url.pathname)
                && body?.docs?.some(doc => doc.kind === 'publication-v1');
            if (fault?.kind === 'record' && journalRecord) {
                fault.rejected++;
                return new Response(JSON.stringify({ message: 'Synthetic rejection of the publication record' }), {
                    status: 400, headers: { 'content-type': 'application/json' },
                });
            }
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
            if (collection === name && request.method === 'POST' && url.pathname.endsWith('/branches/main/rollback'))
                rollbacks.push(response.status);
            if (collection === name && request.method === 'DELETE' && parts[1] === 'tags') tagDeletes.push(decodeURIComponent(parts[2]));
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
            if (fault?.kind === 'terminal' && journalRecord && response.status === 202 && !fault.dropped) {
                fault.dropped++;
                // The server accepted the publication record. Only the reply is lost.
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
        const first = { summary: 'Publish synthetic originals' };
        const firstStarted = Date.now();
        const firstResult = await merge(work, first);
        t.diagnostic(`First cold publication completed in one public call after ${Date.now() - firstStarted} ms.`);
        assert.deepEqual(firstResult, { status: 'published', version: 'v1' });
        // merge publishes only; the source fork remains.
        assert.deepEqual(await main.listForks({}, options()), { forks: [{ at: work.at }] });
        // Merging the published fork again, from a new client, is unchanged and sends no mutation.
        const beforeFirstReplay = mutations;
        assert.deepEqual(await merge(await freshFork('source'), first), { status: 'unchanged', version: 'v1' });
        assert.equal(mutations, beforeFirstReplay, 'A repeated merge sent a mutation.');
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

        phase = 'Fail after one real main mutation and roll main back';
        const second = { summary: 'Publish the moved, removed, and new files' };
        const edits = await main.write({ at: work.at, operations: [
            { op: 'update', fileId: moved.fileId, newPath: '/moved.txt', content: changed },
            { op: 'delete', fileId: removed.fileId },
            { op: 'create', path: newPath, content: '' },
        ] }, options());
        const partial = { kind: 'partial', accepted: 0, applied: 0, rejected: 0 };
        fault = partial;
        const failedAt = Date.now();
        await assert.rejects(merge(work, second), error => error instanceof MemDriveError && error.code === 'DATABASE_ERROR' && error.status === 400);
        fault = undefined;
        assert.equal(partial.applied, 1);
        assert(partial.rejected >= 1);
        // The fresh v1 tag can need its snapshot published before it is a rollback target.
        assert(rollbacks.length >= 1 && rollbacks.at(-1) < 300, `Rollback statuses: ${rollbacks.join(',')}`);
        t.diagnostic(`Partial apply: native accepts=${partial.accepted}; original mutations=${partial.applied}; injected pre-dispatch rejections=${partial.rejected}; rollback attempts=${rollbacks.join(',')} within ${Date.now() - failedAt} ms.`);
        const physical = async () => {
            const response = await client.collection(name).docs.fetch({
                ids: [moved.fileId, removed.fileId, edits[2].fileId].map(id => `file:${id}`),
                ref: mainRef, consistentRead: true, includeVectors: false,
            }, options());
            return new Map(response.docs.map(({ doc }) => [doc.fileId, doc]));
        };
        // The writable main branch holds v1 again.
        const restored = await physical();
        assert.equal(restored.get(moved.fileId)?.path, '/working.txt');
        assert.equal(restored.get(moved.fileId)?.body, original);
        assert.equal(restored.get(removed.fileId)?.kind, 'file');
        assert.equal(restored.has(edits[2].fileId), false);

        phase = 'Read the published view and keep the failed fork';
        const oldMain = await freshMain();
        assert.deepEqual(await oldMain.drive.status({}, options()), { at: { kind: 'main' }, mainVersion: 'v1' });
        await read(oldMain, '/working.txt', original);
        await read(oldMain, '/moved.txt', null);
        await read(oldMain, '/delete.txt', deletion);
        await read(oldMain, newPath, null);
        await search(oldMain, 'Alpine compass', moved.fileId, original);
        await verifyList(oldMain, [{ fileId: moved.fileId, path: '/working.txt' }, { fileId: removed.fileId, path: '/delete.txt' }]);
        const faultCheckpoint = { drive: oldMain.drive, at: (await oldMain.drive.checkpoint({ name: 'after-failure' }, options())).at };
        const faultFork = { drive: oldMain.drive, at: (await oldMain.drive.fork({ name: 'after-failure' }, options())).at };
        await read(faultFork, '/working.txt', original);
        await read(faultFork, '/moved.txt', null);
        const failedFork = await freshFork('source');
        await read(failedFork, '/moved.txt', changed);
        const failedDiff = await failedFork.drive.diff({ at: failedFork.at }, options());
        assert.deepEqual(failedDiff.map(change => change.op).sort(), ['create', 'delete', 'update']);

        phase = 'Fail at the publication record and leave an unrecorded tag';
        const record = { kind: 'record', rejected: 0 };
        fault = record;
        const rollbacksBefore = rollbacks.length;
        await assert.rejects(merge(work, second), error => error instanceof MemDriveError && error.status === 400);
        fault = undefined;
        assert.equal(record.rejected, 1);
        assert.equal((await client.collection(name).tags.get('md-main-v2', options())).tag.name, 'md-main-v2');
        assert(rollbacks.length > rollbacksBefore && rollbacks.at(-1) < 300, `Rollback statuses: ${rollbacks.join(',')}`);
        const afterRecord = await freshMain();
        assert.deepEqual(await afterRecord.drive.status({}, options()), { at: { kind: 'main' }, mainVersion: 'v1' });
        await assert.rejects(afterRecord.drive.checkpoint({ name: 'unrecorded', version: 'v2' }, options()),
            { code: 'HISTORICAL_VIEW_UNAVAILABLE' });
        await read(afterRecord, '/moved.txt', null);

        phase = 'Publish the same fork from a new client with a lost record reply';
        const terminal = { kind: 'terminal', dropped: 0 };
        fault = terminal;
        const deletesBefore = tagDeletes.length;
        const published = await merge(await freshFork('source'), second);
        fault = undefined;
        assert.equal(terminal.dropped, 1);
        // The record was read back, so the lost reply did not fail the merge.
        assert.deepEqual(published, { status: 'published', version: 'v2' });
        // The unrecorded tag was removed before its version was reused.
        assert.deepEqual(tagDeletes.slice(deletesBefore), ['md-main-v2']);
        const beforeReplay = mutations;
        assert.deepEqual(await merge(await freshFork('source'), second), { status: 'unchanged', version: 'v2' });
        assert.equal(mutations, beforeReplay, 'A repeated merge sent a mutation.');
        t.diagnostic('A failed record left an unrecorded tag that the next merge replaced; a lost record reply after HTTP 202 still published.');
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
        const afterPublication = await physical();
        assert.equal(afterPublication.get(moved.fileId)?.path, '/moved.txt');
        assert.equal(afterPublication.has(removed.fileId), false);
        assert.equal(afterPublication.has(edits[2].fileId), true);

        phase = 'Edit the published fork for its next merge';
        const reopened = await freshFork('source');
        assert.deepEqual(await reopened.drive.diff({ at: reopened.at }, options()), []);
        const edit = { op: 'update', fileId: moved.fileId, content: later };
        await main.write({ at: work.at, ...edit }, options());
        await read(reopened, '/moved.txt', later);
        assert.deepEqual(await reopened.drive.diff({ at: reopened.at }, options()), [{ op: 'update', fileId: moved.fileId, path: '/moved.txt' }]);
        await read(await freshMain(), '/moved.txt', changed);
        // Merges pinned main versions only; every other tag is a user checkpoint.
        const tagNames = (await client.collection(name).tags.list(options())).tags.map(tag => tag.name);
        assert(tagNames.length > 0 && tagNames.every(tag => /^md-main-v[1-9][0-9]*$/.test(tag) || tag.startsWith('checkpoint-')),
            'A merge left a tag other than a main version.');

        phase = 'Reject a stale target and publish an unrelated fork';
        await assert.rejects(merge(await freshFork('conflicting-edit'), { summary: 'Conflicting file' }),
            { code: 'MERGE_CONFLICT' });
        await read(await freshMain(), '/moved.txt', changed);
        assert.deepEqual(await merge(await freshFork('unrelated-edit'), { summary: 'Publish an unrelated file' }),
            { status: 'published', version: 'v3' });
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
