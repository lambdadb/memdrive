import assert from 'node:assert/strict';
import test from 'node:test';
import { create } from '@functional-systems/memdrive';
import { mergeCaptureJournal } from '../dist/esm/merge-journal.js';
import { prepareMerge } from '../dist/esm/merge-preflight.js';
import { workingWriter } from '../dist/esm/writes.js';
import { fileClient } from './helpers/file-client.mjs';

const name = 'workspace';
const identity = { name: 'workspace-internal', driveId: 'drive-generation' };
const request = { requestId: 'request-1', branch: 'fork-research', summary: 'Publish the research' };
const published = { kind: 'tag', name: 'published-main' };

async function setup() {
    const fixture = fileClient();
    await create({ client: fixture.client, name });
    await fixture.client.createCollection({ collectionName: identity.name, indexConfigs: { kind: { type: 'keyword' } } });
    const content = fixture.client.collection(name);
    const internal = fixture.client.collection(identity.name);
    await content.tags.create({ tagName: published.name, source: { kind: 'branch', name: 'main' } });
    await content.branches.create({ branchName: request.branch, source: published });
    const work = workingWriter(content, name, request.branch, {});
    return { fixture, content, internal, work, capture: mergeCaptureJournal(content, internal, identity) };
}

test('journal captures between working writes and a new owner can prepare the exact persisted capture', async () => {
    const { fixture, content, work, capture } = await setup();
    const first = work.write({ op: 'create', path: '/notes', content: 'first' });
    const captured = capture(request, work.enqueueCapture);
    const later = work.write({ op: 'create', path: '/later', content: 'second' });
    const file = await first;
    const source = await captured;
    await later;
    fixture.collections.get(name).branches.delete(request.branch);

    const reopened = mergeCaptureJournal(fixture.client.collection(name), fixture.client.collection(identity.name), identity);
    const replay = await reopened(request, workingWriter(content, name, request.branch, {}).enqueueCapture);
    assert.deepEqual(replay, source);
    const prepared = await prepareMerge(content, name, replay, published, {});
    assert.deepEqual(prepared.targets.map(target => target.file), [file]);
    const writes = fixture.calls.filter(call => call.kind === 'upsert' && call.request.docs[0].kind === 'merge-capture-v1');
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].retries, { strategy: 'none' });
    await assert.rejects(reopened({ ...request, summary: 'Changed summary' }, work.enqueueCapture), { code: 'MERGE_REQUEST_CONFLICT' });
    const another = workingWriter(content, name, 'fork-another', {});
    await assert.rejects(reopened({ ...request, branch: 'fork-another' }, another.enqueueCapture), { code: 'MERGE_REQUEST_CONFLICT' });
    const wrongGeneration = mergeCaptureJournal(content, fixture.client.collection(identity.name), { ...identity, driveId: 'another-drive' });
    await assert.rejects(wrongGeneration(request, work.enqueueCapture), { code: 'INVALID_RESULT' });
});

test('journal reconciles a lost acknowledgment and serializes duplicate requests across forks', async () => {
    const { fixture, content, work, capture } = await setup();
    const competingBranch = 'fork-other';
    await content.branches.create({ branchName: competingBranch, source: published });
    const other = workingWriter(content, name, competingBranch, {});
    fixture.afterUpsert = request => {
        if (request.docs[0].kind === 'merge-capture-v1') throw new Error('acknowledgment lost');
    };
    const first = capture(request, work.enqueueCapture);
    const duplicate = capture(request, work.enqueueCapture);
    const competing = assert.rejects(capture({ ...request, branch: competingBranch }, other.enqueueCapture), { code: 'MERGE_REQUEST_CONFLICT' });
    const source = await first;
    assert.deepEqual(await duplicate, source);
    await competing;
    const plan = await prepareMerge(content, name, source, published, {});
    assert.deepEqual(plan.targets, []);
    assert.equal(fixture.calls.filter(call => call.kind === 'upsert').length, 1);
});

test('a missing read after journal failure can only retry the identical captured record', async () => {
    const { fixture, content, work, capture } = await setup();
    const file = await work.write({ op: 'create', path: '/notes', content: 'capture me' });
    const attempts = [];
    fixture.beforeUpsert = ({ docs: [record] }) => {
        if (record.kind === 'merge-capture-v1') {
            attempts.push(record);
            if (attempts.length === 1) throw new Error('request was lost before acceptance');
        }
    };
    await assert.rejects(capture(request, work.enqueueCapture), { code: 'MERGE_CAPTURE_UNCONFIRMED' });
    await work.write({ op: 'update', fileId: file.fileId, content: 'after capture' });
    await assert.rejects(capture({ ...request, summary: 'different' }, work.enqueueCapture), { code: 'MERGE_REQUEST_CONFLICT' });
    const source = await capture(request, work.enqueueCapture);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0], attempts[1]);
    const plan = await prepareMerge(content, name, source, published, {});
    assert.deepEqual(plan.targets.map(target => target.file), [file]);
});

test('an unconfirmed tag or pristine source refusal never writes a binding', async () => {
    const { fixture, work, capture } = await setup();
    fixture.beforeTagCreate = () => { throw Object.assign(new Error('Source must have a snapshot'), { status: 400 }); };
    await assert.rejects(capture(request, work.enqueueCapture), { code: 'DATABASE_ERROR', status: 400 });
    fixture.beforeTagCreate = undefined;
    fixture.afterTagCreate = () => { throw new Error('acknowledgment lost'); };
    await assert.rejects(capture(request, work.enqueueCapture), { code: 'REF_CREATION_UNCONFIRMED' });
    assert.ok(!fixture.calls.some(call => call.kind === 'upsert'));
});

test('identically named stores in separate connections keep their capture bindings independent', async () => {
    const first = await setup();
    const second = await setup();
    const one = await first.capture(request, first.work.enqueueCapture);
    const two = await second.capture({ ...request, summary: 'Separate store' }, second.work.enqueueCapture);
    assert.notEqual(one.name, two.name);
    assert.ok(first.fixture.collections.get(name).tags.has(one.name));
    assert.ok(!first.fixture.collections.get(name).tags.has(two.name));
    await assert.rejects(first.capture({ ...request, summary: 'Separate store' }, first.work.enqueueCapture),
        { code: 'MERGE_REQUEST_CONFLICT' });
});

test('distinct handles for the same content collection cannot be used as a journal', async () => {
    const { content, fixture, internal } = await setup();
    const misrouted = fixture.client.collection(name);
    assert.notEqual(content, misrouted);
    assert.throws(() => mergeCaptureJournal(content, misrouted, { ...identity, name }), { code: 'INVALID_INPUT' });
    assert.throws(() => mergeCaptureJournal(content, internal, { ...identity, name: 'wrong-internal' }), { code: 'INVALID_INPUT' });
    assert.ok(!fixture.calls.some(call => call.kind === 'upsert'));
});

test('a confirmed binding replays despite an unconfirmed later source write', async () => {
    const { fixture, work, capture } = await setup();
    const source = await capture(request, work.enqueueCapture);
    fixture.beforeUpsert = () => { throw new Error('response lost with working write unavailable'); };
    await assert.rejects(work.write({ op: 'create', path: '/uncertain', content: '' }), { code: 'WRITE_UNCONFIRMED' });
    const beforeReplay = fixture.calls.length;
    assert.deepEqual(await capture(request, work.enqueueCapture), source);
    const replayCalls = fixture.calls.slice(beforeReplay);
    assert.equal(replayCalls.length, 1);
    assert.equal(replayCalls[0].kind, 'fetch');
    assert.equal(replayCalls[0].request.ref.name, 'main');

    const tagCount = fixture.calls.filter(call => call.kind === 'tag-create').length;
    await assert.rejects(capture({ ...request, requestId: 'new-request' }, work.enqueueCapture), { code: 'WRITE_UNCONFIRMED' });
    assert.equal(fixture.calls.filter(call => call.kind === 'tag-create').length, tagCount);
});
