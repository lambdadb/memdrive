import assert from 'node:assert/strict';
import test from 'node:test';
import { MemDrive, createFileTools } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

const draft = { kind: 'fork', name: 'draft' };
async function setup(content) {
    const fixture = fileClient();
    const drive = await MemDrive.create({ client: fixture.client, name: 'range-store' });
    await drive.fork({ name: 'draft' });
    const file = await drive.write({ at: draft, op: 'create', path: '/original.txt', content });
    return { ...fixture, drive, file };
}

test('ranged reads preserve mixed line endings and full reads remain unchanged', async () => {
    const { drive, file } = await setup('first\r\nsecond\rthird\nfourth\n');
    assert.deepEqual(await drive.read({ at: draft, fileId: file.fileId }), file);
    const page = await drive.read({ at: draft, path: file.path, startLine: 2, endLine: 3 });
    assert.equal(page.content, 'second\rthird\n');
    assert.deepEqual(page.range, { startLine: 2, endLine: 3, start: 7, end: 20 });
    assert.equal(page.totalLines, 5);
    assert.deepEqual(page.at, draft);
    assert.equal(page.next, undefined);
    assert.equal((await drive.read({ at: draft, fileId: file.fileId, startLine: 5 })).content, '');
    assert.equal(await drive.read({ at: draft, path: '/absent', maxChars: 2 }), null);
});

test('bounded continuation reconstructs long lines without splitting surrogate pairs or CRLF', async () => {
    const content = 'a😀b\r\nc'.repeat(40);
    const { drive, file } = await setup(content);
    let request = { at: draft, path: file.path, maxChars: 3 }, reconstructed = '', count = 0;
    while (request) {
        const page = await drive.read(request);
        assert(page.content.length <= 3);
        assert(!/\p{Surrogate}/u.test(page.content));
        assert.equal(page.content, content.slice(page.range.start, page.range.end));
        assert.equal(page.range.start, reconstructed.length);
        assert(page.content.length > 0);
        reconstructed += page.content;
        request = page.next;
        if (request) assert.deepEqual(request.at, draft);
        assert(++count < 200);
    }
    assert.equal(reconstructed, content);
    const bounded = await drive.read({ at: draft, fileId: file.fileId, startLine: 2, endLine: 2, maxChars: 2 });
    let selected = bounded.content, next = bounded.next;
    while (next) { const page = await drive.read(next); selected += page.content; next = page.next; }
    assert.equal(selected, 'ca😀b\r\n');
});

test('range next carries its view and continues there rather than on main', async () => {
    const { drive, file } = await setup('abcdef');
    const page = await drive.read({ at: draft, fileId: file.fileId, maxChars: 2 });
    assert.deepEqual(page.next, { at: draft, fileId: file.fileId, startLine: 1, endLine: 1, maxChars: 2, offset: 2, revision: page.revision });
    assert.equal((await drive.read(page.next)).content, 'cd');
    const { at, ...withoutAt } = page.next;
    assert.deepEqual(at, draft);
    // Omitted at selects main, where the unpublished file is absent.
    assert.equal(await drive.read(withoutAt), null);
});

test('continuation rejects a changed original while a checkpoint remains readable', async () => {
    const { drive, file } = await setup('abcdef');
    const { at: before } = await drive.checkpoint({ at: draft, name: 'before' });
    const page = await drive.read({ at: draft, fileId: file.fileId, maxChars: 2 });
    const pinned = await drive.read({ at: before, fileId: file.fileId, maxChars: 2 });
    assert.equal(Object.hasOwn(pinned, 'version'), false);
    assert.deepEqual(pinned.next.at, before);
    await drive.write({ at: draft, op: 'update', fileId: file.fileId, content: 'changed' });
    await assert.rejects(drive.read(page.next), { code: 'READ_VERSION_CHANGED' });
    assert.equal((await drive.read(pinned.next)).content, 'cd');
});

test('empty files and invalid bounds have explicit behavior', async () => {
    const { drive, file, calls } = await setup('');
    const page = await drive.read({ at: draft, fileId: file.fileId, startLine: 1 });
    assert.equal(page.totalLines, 1);
    assert.equal(page.content, '');
    assert.equal(page.next, undefined);
    const before = calls.length;
    for (const options of [{ startLine: 0 }, { startLine: 2, endLine: 1 }, { maxChars: 1 }, { maxChars: 64001 },
        { offset: 0 }, { revision: 'invalid' }, { startLine: 1.5 }])
        await assert.rejects(drive.read({ at: draft, fileId: file.fileId, ...options }), { code: 'INVALID_INPUT' });
    await assert.rejects(drive.read({ at: draft, paths: [file.path], maxChars: 2 }), { code: 'INVALID_INPUT' });
    assert.equal(calls.length, before);
    await assert.rejects(drive.read({ at: draft, fileId: file.fileId, startLine: 2 }), { code: 'INVALID_INPUT' });
});

test('the common tool returns SDK range pages on main without view selectors and external mode rejects range fields', async () => {
    const { drive, client } = await setup('one\ntwo\nthree');
    const file = await drive.write({ op: 'create', path: '/main.txt', content: 'one\ntwo\nthree' });
    const tools = createFileTools({ drive, tools: ['read'] });
    const request = { fileId: file.fileId, startLine: 2, maxChars: 3 };
    const { at, next: { at: nextAt, ...next }, ...page } = await drive.read(request);
    assert.deepEqual([at, nextAt], [{ kind: 'main' }, { kind: 'main' }]);
    const delivered = await tools.execute('read', request);
    assert.deepEqual(delivered, { ...page, next });
    assert.equal((await tools.execute('read', delivered.next)).content, (await drive.read({ ...delivered.next, at: { kind: 'main' } })).content);
    await assert.rejects(tools.execute('read', { ...request, at: { kind: 'main' } }), { code: 'INVALID_INPUT' });
    const external = await MemDrive.create({ client, name: 'external-range',
        embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'fixture' } });
    await assert.rejects(external.read({ path: '/file', maxChars: 20 }), { code: 'INVALID_INPUT' });
});
