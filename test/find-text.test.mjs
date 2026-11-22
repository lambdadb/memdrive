import assert from 'node:assert/strict';
import test from 'node:test';
import { MemDrive } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

async function setup() {
    const fixture = fileClient();
    const name = 'literal-scan';
    const main = await MemDrive.create({ client: fixture.client, name, metadataSchema: { topic: { type: 'string' } } });
    const fork = await main.fork({ name: 'draft' });
    return { fixture, name, main, fork };
}

test('findText verifies original-case Unicode matches, overlaps and excerpt offsets across chunk boundaries', async () => {
    const { fixture, fork } = await setup();
    const content = 'a'.repeat(797) + '🙂A.*\r\nkelvin KELVIN\nBANANA\n';
    const path = '/notes/quote"/draft.md';
    const file = await fork.write({ op: 'create', path, content, metadata: { topic: 'keep' } });
    await fork.write([
        { op: 'create', path: '/notes/quote"/filtered.md', content, metadata: { topic: 'exclude' } },
        { op: 'create', path: '/notes/outside.md', content, metadata: { topic: 'keep' } },
    ]);
    const { hits, cursor, consistency } = await fork.findText({
        query: '🙂a.*\r\n', prefix: '/notes/quote"/', filter: { field: 'metadata.topic', op: 'eq', value: 'keep' },
    });
    assert.equal(consistency, 'live');
    assert.equal(cursor, undefined);
    assert.deepEqual(hits, [{
        fileId: file.fileId, path, metadata: file.metadata, modifiedAt: file.modifiedAt,
        content: '🙂A.*\r\n', range: { start: 797, end: 804 },
        context: { content: content.slice(717), range: { start: 717, end: content.length } },
    }]);
    const candidates = fixture.calls.filter(call => call.kind === 'query' && call.request.fields?.include?.includes('body'));
    assert.equal(candidates.length, 2);
    assert.deepEqual(candidates[0].request.query.bool.map(clause => clause.queryString.defaultField), ['kind', 'ancestorPaths', 'metadata.topic']);

    const checkpoint = await fork.checkpoint({ name: 'saved' });
    const overlap = await checkpoint.findText({ query: 'ana', prefix: path, limit: 1 });
    assert.equal(overlap.consistency, 'snapshot');
    assert.equal(overlap.hits[0].range.start, content.indexOf('BANANA') + 1);
    assert(overlap.cursor);
    const continuation = await checkpoint.findText({ cursor: overlap.cursor });
    assert.equal(continuation.hits[0].range.start, overlap.hits[0].range.start + 2);
    assert.deepEqual((await checkpoint.findText({ cursor: overlap.cursor })).hits, continuation.hits);
    const unicode = await checkpoint.findText({ query: 'kelvin', prefix: path });
    assert.deepEqual(unicode.hits.map(hit => hit.content), ['kelvin', 'KELVIN']);
    assert.deepEqual((await checkpoint.findText({ query: '\r\n', prefix: path })).hits.map(hit => hit.content), ['\r\n']);
});

test('findText bounds each scan page and continues through files after an empty page', async () => {
    const { fixture, name, fork } = await setup();
    // Deterministic IDs put the only matching original after a full scan page.
    const originals = fixture.collections.get(name).branches.get('fork-draft').docs;
    const modifiedAt = '2026-01-01T00:00:00.000Z';
    for (let index = 1; index <= 18; index++) {
        const fileId = `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`;
        const id = `file:${fileId}`;
        originals.set(id, { id, kind: 'file', fileId, path: `/file-${index}`, modifiedAt, body: index === 18 ? 'Match Match' : '.' });
    }
    const first = await fork.findText({ query: 'match', limit: 1 });
    assert.deepEqual(first.hits, []);
    assert(first.cursor);
    assert.equal(fixture.calls.filter(call => call.kind === 'query' && call.request.fields?.include?.includes('body')).length, 16);
    const addedId = '11111111-1111-4111-8111-999999999999';
    originals.set(`file:${addedId}`, { id: `file:${addedId}`, kind: 'file', fileId: addedId, path: '/late', modifiedAt, body: 'Match' });

    const second = await fork.findText({ cursor: first.cursor });
    assert.deepEqual(second.hits.map(hit => [hit.path, hit.range]), [['/file-18', { start: 0, end: 5 }]]);
    assert(second.cursor);
    const last = await fork.findText({ cursor: second.cursor });
    assert.deepEqual(last.hits.map(hit => [hit.path, hit.range]), [['/file-18', { start: 6, end: 11 }]]);
    assert.equal(last.cursor, undefined);

    await fork.write({ op: 'update', fileId: last.hits[0].fileId, content: 'Match skipped Match' });
    await assert.rejects(fork.findText({ cursor: second.cursor }), { code: 'FIND_TEXT_CURSOR_UNAVAILABLE' });
});

test('findText validates requests, view-local cursors, aborts and incomplete native pages', async () => {
    const { fixture, fork, main } = await setup();
    const file = await fork.write({ op: 'create', path: '/note', content: 'ok ok' });
    for (const request of [
        { query: '' }, { query: '\ud800' }, { query: 'é'.repeat(4097) }, { query: 'ok', limit: 101 },
        { query: 'ok', prefix: 'relative' }, { query: 'ok', prefix: '/a/../' },
        { query: 'ok', filter: { field: 'metadata.unindexed', op: 'eq', value: 'ok' } },
        { query: 'ok', cursor: 'tampered' },
    ]) await assert.rejects(fork.findText(request), { code: 'INVALID_INPUT' });
    const { cursor } = await fork.findText({ query: 'ok', limit: 1 });
    assert(cursor);
    await assert.rejects(main.findText({ cursor }), { code: 'FIND_TEXT_CURSOR_UNAVAILABLE' });
    await assert.rejects(fork.findText({ cursor: cursor + 'a' }), { code: 'FIND_TEXT_CURSOR_UNAVAILABLE' });
    await assert.rejects(fork.findText({ query: 'ok' }, { signal: AbortSignal.abort() }), { code: 'ABORTED' });
    const now = Date.now;
    try {
        Date.now = () => now() + 5 * 60 * 1000;
        await assert.rejects(fork.findText({ cursor }), { code: 'FIND_TEXT_CURSOR_UNAVAILABLE' });
    } finally {
        Date.now = now;
    }
    fixture.findTextQuery = request => request.fields.include.includes('body')
        ? { total: 1, isDocsInline: true, docs: [] } : undefined;
    await assert.rejects(fork.findText({ query: 'ok' }), { code: 'INVALID_RESULT' });
    fixture.findTextQuery = undefined;
    await fork.write({ op: 'delete', fileId: file.fileId });
    assert.deepEqual(await fork.findText({ query: 'ok' }), { hits: [], consistency: 'live' });
});

test('findText reads a maximum-sized original and escapes literal syntax', async () => {
    const { fixture, name, fork } = await setup();
    const fileId = '11111111-1111-4111-8111-111111111111';
    const id = `file:${fileId}`;
    const original = { id, kind: 'file', fileId, path: '/large', modifiedAt: '2026-01-01T00:00:00.000Z', body: '' };
    const literal = '[X].\\${Q}$^+?()|/';
    // Put a surrogate pair across each nominal context boundary.
    const tail = '🙂' + 'a'.repeat(79) + literal + 'a'.repeat(79) + '🙂';
    const size = 5 * 1024 * 1024;
    original.body = 'x'.repeat(size - Buffer.byteLength(JSON.stringify({ ...original, body: tail }))) + tail;
    assert.equal(Buffer.byteLength(JSON.stringify(original)), size);
    fixture.collections.get(name).branches.get('fork-draft').docs.set(id, original);
    const result = await fork.findText({ query: literal.toLowerCase() });
    const start = original.body.length - tail.length + 81;
    assert.equal(result.hits.length, 1);
    assert.deepEqual(result.hits[0].range, { start, end: start + literal.length });
    assert.equal(result.hits[0].context.content, tail);
    assert.deepEqual(result.hits[0].context.range, { start: start - 81, end: original.body.length });
});

test('findText keeps a published continuation pinned across a later merge', async () => {
    const { main, fork } = await setup();
    const file = await fork.write({ op: 'create', path: '/note', content: 'Old old' });
    await fork.merge({ requestId: 'first', summary: 'Publish the first original' });
    const first = await main.findText({ query: 'old', limit: 1 });
    assert.equal(first.consistency, 'snapshot');
    assert.equal(first.hits[0].content, 'Old');
    assert(first.cursor);
    await fork.write({ op: 'update', fileId: file.fileId, content: 'New' });
    await fork.merge({ requestId: 'second', summary: 'Publish the second original' });
    assert.deepEqual((await main.findText({ query: 'old' })).hits, []);
    assert.equal((await main.findText({ cursor: first.cursor })).hits[0].content, 'old');
});
