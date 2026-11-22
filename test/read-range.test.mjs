import assert from 'node:assert/strict';
import test from 'node:test';
import { MemDrive, createFileTools } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

async function setup(content) {
    const fixture = fileClient();
    const main = await MemDrive.create({ client: fixture.client, name: 'range-store' });
    const work = await main.fork({ name: 'draft' });
    const file = await work.write({ op: 'create', path: '/original.txt', content });
    return { ...fixture, main, work, file };
}

test('ranged reads preserve mixed line endings and full reads remain unchanged', async () => {
    const { work, file } = await setup('first\r\nsecond\rthird\nfourth\n');
    assert.deepEqual(await work.read({ fileId: file.fileId }), file);
    const page = await work.read({ path: file.path, startLine: 2, endLine: 3 });
    assert.equal(page.content, 'second\rthird\n');
    assert.deepEqual(page.range, { startLine: 2, endLine: 3, start: 7, end: 20 });
    assert.equal(page.totalLines, 5);
    assert.deepEqual(page.at, { kind: 'fork', name: 'draft' });
    assert.equal(page.next, undefined);
    assert.equal((await work.read({ fileId: file.fileId, startLine: 5 })).content, '');
    assert.equal(await work.read({ path: '/absent', maxChars: 2 }), null);
});

test('bounded continuation reconstructs long lines without splitting surrogate pairs or CRLF', async () => {
    const content = 'a😀b\r\nc'.repeat(40);
    const { work, file } = await setup(content);
    let request = { path: file.path, maxChars: 3 }, reconstructed = '', count = 0;
    while (request) {
        const page = await work.read(request);
        assert(page.content.length <= 3);
        assert(!/\p{Surrogate}/u.test(page.content));
        assert.equal(page.content, content.slice(page.range.start, page.range.end));
        assert.equal(page.range.start, reconstructed.length);
        assert(page.content.length > 0);
        reconstructed += page.content;
        request = page.next;
        assert(++count < 200);
    }
    assert.equal(reconstructed, content);
    const bounded = await work.read({ fileId: file.fileId, startLine: 2, endLine: 2, maxChars: 2 });
    let selected = bounded.content, next = bounded.next;
    while (next) { const page = await work.read(next); selected += page.content; next = page.next; }
    assert.equal(selected, 'ca😀b\r\n');
});

test('continuation rejects a changed original while a checkpoint remains readable', async () => {
    const { main, work, file } = await setup('abcdef');
    await work.merge({ requestId: 'publish', summary: 'Publish original' });
    const checkpoint = await main.checkpoint({ name: 'before' });
    const page = await work.read({ fileId: file.fileId, maxChars: 2 });
    const pinned = await checkpoint.read({ fileId: file.fileId, maxChars: 2 });
    assert.equal(pinned.version, 'v1');
    await work.write({ op: 'update', fileId: file.fileId, content: 'changed' });
    await assert.rejects(work.read(page.next), { code: 'READ_VERSION_CHANGED' });
    assert.equal((await checkpoint.read(pinned.next)).content, 'cd');
});

test('empty files and invalid bounds have explicit behavior', async () => {
    const { work, file, calls } = await setup('');
    const page = await work.read({ fileId: file.fileId, startLine: 1 });
    assert.equal(page.totalLines, 1);
    assert.equal(page.content, '');
    assert.equal(page.next, undefined);
    const before = calls.length;
    for (const options of [{ startLine: 0 }, { startLine: 2, endLine: 1 }, { maxChars: 1 }, { maxChars: 64001 },
        { offset: 0 }, { revision: 'invalid' }, { startLine: 1.5 }])
        await assert.rejects(work.read({ fileId: file.fileId, ...options }), { code: 'INVALID_INPUT' });
    await assert.rejects(work.read({ paths: [file.path], maxChars: 2 }), { code: 'INVALID_INPUT' });
    assert.equal(calls.length, before);
    await assert.rejects(work.read({ fileId: file.fileId, startLine: 2 }), { code: 'INVALID_INPUT' });
});

test('the common tool returns SDK range pages and external mode rejects range fields', async () => {
    const { work, file, client } = await setup('one\ntwo\nthree');
    const tools = createFileTools({ drive: work, tools: ['read'] });
    const request = { fileId: file.fileId, startLine: 2, maxChars: 3 };
    assert.deepEqual(await tools.execute('read', request), await work.read(request));
    const external = await MemDrive.create({ client, name: 'external-range',
        embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'fixture' } });
    await assert.rejects(external.read({ path: '/file', maxChars: 20 }), { code: 'INVALID_INPUT' });
});
