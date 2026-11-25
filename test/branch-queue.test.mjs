import assert from 'node:assert/strict';
import test from 'node:test';
import { create, open, destroy } from '@functional-systems/memdrive';
// Internal test hook of the same module instance the package root loads; not part of the public API.
import { queueSizes } from '../dist/esm/branch-queue.js';
import { fileClient } from './helpers/file-client.mjs';

const name = 'queued';
const fork = { kind: 'fork', name: 'draft' };
const fileCreate = (path, content) => ({ op: 'create', path, content });
const tick = () => new Promise(resolve => setImmediate(resolve));

/** Two drive objects of one store, with a hook that holds the next upsert on a branch. */
async function setup() {
    const fixture = fileClient();
    const connection = { client: fixture.client, name };
    const drive = await create(connection);
    const other = await open({ client: { ...fixture.client }, name });
    await drive.fork({ name: 'draft' });
    const hold = (branch = 'main') => {
        let entered, release;
        const arrived = new Promise(resolve => { entered = resolve; });
        const released = new Promise(resolve => { release = resolve; });
        fixture.beforeUpsert = async request => {
            if (request.branch !== branch) return;
            fixture.beforeUpsert = undefined;
            entered();
            await released;
        };
        return { arrived, release };
    };
    return { ...fixture, fixture, connection, drive, other, hold };
}
const count = (calls, kind) => calls.filter(call => call.kind === kind).length;
/** Let queued operations reach their wait; they issue no request until the queue reaches them. */
async function settleUntil(condition) {
    for (let turn = 0; turn < 100 && !condition(); turn++) await tick();
    assert(condition());
}

test.afterEach(() => assert.deepEqual(queueSizes(), []));

test('concurrent updates of one file through two drive objects keep chunks matching the final content', async () => {
    const { drive, other, hold, calls, collections } = await setup();
    const file = await drive.write(fileCreate('/a.txt', 'zero'));
    const held = hold();
    const first = drive.write({ op: 'update', fileId: file.fileId, content: 'first' });
    await held.arrived;
    const before = calls.length;
    const second = other.write({ op: 'update', fileId: file.fileId, content: 'second' });
    await settleUntil(() => queueSizes()[0] === 2);
    assert.equal(calls.length, before);
    held.release();
    await first;
    assert.equal((await second).content, 'second');
    const docs = collections.get(name).branches.get('main').docs;
    const original = docs.get(`file:${file.fileId}`);
    const chunks = [...docs.values()].filter(doc => doc.kind === 'chunk' && doc.fileId === file.fileId);
    assert.deepEqual(chunks.map(chunk => [chunk.content, chunk.revision]), [['second', original.revision]]);
    assert.deepEqual((await drive.search({ query: 'second', rerank: false })).hits.map(hit => hit.content), ['second']);
});

test('concurrent creates at one path through two drive objects produce one file and one PATH_EXISTS', async () => {
    const { drive, other, hold, calls } = await setup();
    const held = hold();
    const first = drive.write(fileCreate('/same.txt', 'one'));
    await held.arrived;
    const before = calls.length;
    const second = other.write(fileCreate('/same.txt', 'two'));
    await settleUntil(() => queueSizes()[0] === 2);
    // The second create has not checked the path yet; it does so after the first finishes.
    assert.equal(calls.length, before);
    held.release();
    const results = await Promise.allSettled([first, second]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    assert.equal(results[1].reason.code, 'PATH_EXISTS');
    assert.deepEqual(await other.read({ path: '/same.txt' }), results[0].value);
});

test('a checkpoint requested while a write runs captures the finished write', async () => {
    const { drive, other, hold, calls } = await setup();
    const held = hold('fork-draft');
    const writing = drive.write({ at: fork, ...fileCreate('/a.txt', 'kept') });
    await held.arrived;
    const checkpointing = other.checkpoint({ at: fork, name: 'saved' });
    await settleUntil(() => queueSizes()[0] === 2);
    assert.equal(count(calls, 'tag-create'), 0);
    held.release();
    const file = await writing;
    assert.deepEqual(await checkpointing, { at: { kind: 'checkpoint', name: 'saved' } });
    assert.deepEqual(await drive.read({ at: { kind: 'checkpoint', name: 'saved' }, path: '/a.txt' }), file);
    // A checkpoint source is immutable and needs no queue.
    await drive.fork({ at: { kind: 'checkpoint', name: 'saved' }, name: 'copy' });
});

test('rollback waits for a running write on that branch', async () => {
    const { drive, other, hold, calls } = await setup();
    await drive.checkpoint({ at: fork, name: 'empty' });
    const held = hold('fork-draft');
    const writing = drive.write({ at: fork, ...fileCreate('/a.txt', 'rolled back') });
    await held.arrived;
    const rolling = other.rollback({ at: fork, to: { kind: 'checkpoint', name: 'empty' } });
    await settleUntil(() => queueSizes()[0] === 2);
    assert.equal(count(calls, 'branch-rollback'), 0);
    held.release();
    await writing;
    await rolling;
    assert.equal(await drive.read({ at: fork, path: '/a.txt' }), null);
});

test('writes on different branches run concurrently and reads never wait', async () => {
    const { drive, other, hold } = await setup();
    const existing = await drive.write(fileCreate('/existing.txt', 'existing words'));
    const held = hold('main');
    const writing = drive.write(fileCreate('/held.txt', 'held'));
    await held.arrived;
    assert.equal((await other.write({ at: fork, ...fileCreate('/fork.txt', 'fork') })).path, '/fork.txt');
    assert.deepEqual(await other.read({ path: '/existing.txt' }), existing);
    assert.equal((await other.list()).files.length, 1);
    assert.equal((await other.search({ query: 'existing', rerank: false })).hits.length, 1);
    assert.equal((await other.findText({ query: 'existing' })).hits.length, 1);
    assert.deepEqual(await other.listForks(), { forks: [{ at: fork }] });
    assert.deepEqual(await other.listCheckpoints(), { checkpoints: [] });
    assert.equal((await other.describe()).name, name);
    held.release();
    await writing;
});

test('a rejected or aborted operation does not block the next one', async () => {
    const { fixture, drive, other, hold, calls } = await setup();
    fixture.beforeUpsert = () => { throw Object.assign(new Error('Rejected'), { statusCode: 400 }); };
    await assert.rejects(drive.write(fileCreate('/rejected.txt', 'no')), { code: 'DATABASE_ERROR', status: 400 });
    fixture.beforeUpsert = undefined;
    assert.equal((await other.write(fileCreate('/next.txt', 'yes'))).path, '/next.txt');

    const held = hold();
    const writing = drive.write(fileCreate('/a.txt', 'a'));
    await held.arrived;
    const controller = new AbortController();
    const aborted = other.write(fileCreate('/aborted.txt', 'never'), { signal: controller.signal });
    const after = other.write(fileCreate('/after.txt', 'after'));
    await settleUntil(() => queueSizes()[0] === 3);
    controller.abort();
    await assert.rejects(aborted, { code: 'ABORTED' });
    // The aborted turn keeps its place until the running write finishes.
    assert.deepEqual(queueSizes(), [3]);
    held.release();
    await writing;
    assert.equal((await after).path, '/after.txt');
    assert.equal(calls.some(call => JSON.stringify(call.request ?? {}).includes('/aborted.txt')), false);
    assert.equal(await drive.read({ path: '/aborted.txt' }), null);
});

test('destroy waits for a running write and later state-changing calls fail cleanly', async () => {
    const { connection, drive, other, hold, calls, collections } = await setup();
    const held = hold();
    const writing = drive.write(fileCreate('/a.txt', 'finished'));
    await held.arrived;
    const destroying = destroy(connection);
    // The main queue holds the write and the deletion, plus the store's deletion entry.
    await settleUntil(() => queueSizes().length === 2);
    const before = calls.length;
    const late = other.write(fileCreate('/late.txt', 'late'));
    const lateFork = other.write({ at: fork, ...fileCreate('/late.txt', 'late') });
    await tick();
    assert.equal(calls.length, before);
    held.release();
    assert.equal((await writing).path, '/a.txt');
    await destroying;
    assert.equal(collections.has(name), false);
    assert.equal(count(calls, 'collection-delete'), 1);
    await assert.rejects(late, { code: 'STORE_NOT_FOUND' });
    await assert.rejects(lateFork, { code: 'STORE_NOT_FOUND' });
    // A store recreated under the same name is a new generation with its own queues.
    const replacement = await create(connection);
    assert.equal((await replacement.write(fileCreate('/new.txt', 'new'))).path, '/new.txt');
});
