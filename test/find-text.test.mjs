import assert from 'node:assert/strict';
import test from 'node:test';
import { MemDrive } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

const at = { kind: 'fork', name: 'draft' };
async function setup() {
    const fixture = fileClient();
    const name = 'literal-scan';
    const drive = await MemDrive.create({ client: fixture.client, name, metadataSchema: { topic: { type: 'string' } } });
    await drive.fork({ name: 'draft' });
    return { fixture, name, drive };
}

test('findText verifies original-case Unicode matches, overlaps and excerpt offsets across chunk boundaries', async () => {
    const { fixture, drive } = await setup();
    const content = 'a'.repeat(797) + '🙂A.*\r\nkelvin KELVIN\nBANANA\n';
    const path = '/notes/quote"/draft.md';
    const file = await drive.write({ at, op: 'create', path, content, metadata: { topic: 'keep' } });
    await drive.write({ at, operations: [
        { op: 'create', path: '/notes/quote"/filtered.md', content, metadata: { topic: 'exclude' } },
        { op: 'create', path: '/notes/outside.md', content, metadata: { topic: 'keep' } },
    ] });
    const { hits, next, consistency } = await drive.findText({
        at, query: '🙂a.*\r\n', prefix: '/notes/quote"/', filter: { field: 'metadata.topic', op: 'eq', value: 'keep' },
    });
    assert.equal(consistency, 'live');
    assert.equal(next, undefined);
    assert.deepEqual(hits, [{
        fileId: file.fileId, path, metadata: file.metadata, modifiedAt: file.modifiedAt,
        content: '🙂A.*\r\n', range: { start: 797, end: 804 },
        context: { content: content.slice(717), range: { start: 717, end: content.length } },
    }]);
    const candidates = fixture.calls.filter(call => call.kind === 'query' && call.request.fields?.include?.includes('body'));
    assert.equal(candidates.length, 2);
    assert.deepEqual(candidates[0].request.query.bool.map(clause => clause.queryString.defaultField), ['kind', 'ancestorPaths', 'metadata.topic']);

    const { at: saved } = await drive.checkpoint({ at, name: 'saved' });
    const overlap = await drive.findText({ at: saved, query: 'ana', prefix: path, limit: 1 });
    assert.equal(overlap.consistency, 'snapshot');
    assert.equal(overlap.hits[0].range.start, content.indexOf('BANANA') + 1);
    assert.deepEqual(overlap.next.at, saved);
    const continuation = await drive.findText(overlap.next);
    assert.equal(continuation.hits[0].range.start, overlap.hits[0].range.start + 2);
    assert.deepEqual((await drive.findText(overlap.next)).hits, continuation.hits);
    const unicode = await drive.findText({ at: saved, query: 'kelvin', prefix: path });
    assert.deepEqual(unicode.hits.map(hit => hit.content), ['kelvin', 'KELVIN']);
    assert.deepEqual((await drive.findText({ at: saved, query: '\r\n', prefix: path })).hits.map(hit => hit.content), ['\r\n']);
});

test('findText bounds each scan page and continues through files after an empty page', async () => {
    const { fixture, name, drive } = await setup();
    // Deterministic IDs put the only matching original after a full scan page.
    const originals = fixture.collections.get(name).branches.get('fork-draft').docs;
    const modifiedAt = '2026-01-01T00:00:00.000Z';
    for (let index = 1; index <= 18; index++) {
        const fileId = `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`;
        const id = `file:${fileId}`;
        originals.set(id, { id, kind: 'file', fileId, path: `/file-${index}`, modifiedAt, body: index === 18 ? 'Match Match' : '.' });
    }
    const first = await drive.findText({ at, query: 'match', limit: 1 });
    assert.deepEqual(first.hits, []);
    assert.deepEqual(first.next.at, at);
    assert.equal(fixture.calls.filter(call => call.kind === 'query' && call.request.fields?.include?.includes('body')).length, 16);
    const addedId = '11111111-1111-4111-8111-999999999999';
    originals.set(`file:${addedId}`, { id: `file:${addedId}`, kind: 'file', fileId: addedId, path: '/late', modifiedAt, body: 'Match' });

    const second = await drive.findText(first.next);
    assert.deepEqual(second.hits.map(hit => [hit.path, hit.range]), [['/file-18', { start: 0, end: 5 }]]);
    assert(second.next);
    const last = await drive.findText(second.next);
    assert.deepEqual(last.hits.map(hit => [hit.path, hit.range]), [['/file-18', { start: 6, end: 11 }]]);
    assert.equal(last.next, undefined);

    await drive.write({ at, op: 'update', fileId: last.hits[0].fileId, content: 'Match skipped Match' });
    await assert.rejects(drive.findText(second.next), { code: 'FIND_TEXT_CURSOR_UNAVAILABLE' });
});

test('findText validates requests, view-bound cursors, aborts and incomplete native pages', async () => {
    const { fixture, drive } = await setup();
    const file = await drive.write({ at, op: 'create', path: '/note', content: 'ok ok' });
    for (const request of [
        { query: '' }, { query: '\ud800' }, { query: 'é'.repeat(4097) }, { query: 'ok', limit: 101 },
        { query: 'ok', prefix: 'relative' }, { query: 'ok', prefix: '/a/../' },
        { query: 'ok', filter: { field: 'metadata.unindexed', op: 'eq', value: 'ok' } },
        { query: 'ok', cursor: 'tampered' }, { at: { kind: 'fork' }, query: 'ok' }, { at: { kind: 'main', name: 'x' }, query: 'ok' },
    ]) await assert.rejects(drive.findText({ at, ...request }), { code: 'INVALID_INPUT' });
    const { next } = await drive.findText({ at, query: 'ok', limit: 1 });
    assert.deepEqual(next.at, at);
    const { cursor } = next;
    // A cursor is bound to its view; a mismatch neither falls back nor consumes it.
    await assert.rejects(drive.findText({ cursor }), { code: 'CURSOR_VIEW_MISMATCH' });
    await assert.rejects(drive.findText({ at: { kind: 'main' }, cursor }), { code: 'CURSOR_VIEW_MISMATCH' });
    await assert.rejects(drive.findText({ at, cursor: cursor + 'a' }), { code: 'FIND_TEXT_CURSOR_UNAVAILABLE' });
    assert.equal((await drive.findText(next)).hits[0].range.start, 3);
    await assert.rejects(drive.findText({ at, query: 'ok' }, { signal: AbortSignal.abort() }), { code: 'ABORTED' });
    // Stateless cursors do not expire in SDK memory.
    const now = Date.now;
    try {
        Date.now = () => now() + 60 * 60 * 1000;
        assert.equal((await drive.findText(next)).hits[0].range.start, 3);
    } finally {
        Date.now = now;
    }
    fixture.findTextQuery = request => request.fields.include.includes('body')
        ? { total: 1, isDocsInline: true, docs: [] } : undefined;
    await assert.rejects(drive.findText({ at, query: 'ok' }), { code: 'INVALID_RESULT' });
    fixture.findTextQuery = undefined;
    await drive.write({ at, op: 'delete', fileId: file.fileId });
    assert.deepEqual(await drive.findText({ at, query: 'ok' }), { hits: [], consistency: 'live' });
});

test('findText reads a maximum-sized original and escapes literal syntax', async () => {
    const { fixture, name, drive } = await setup();
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
    const result = await drive.findText({ at, query: literal.toLowerCase() });
    const start = original.body.length - tail.length + 81;
    assert.equal(result.hits.length, 1);
    assert.deepEqual(result.hits[0].range, { start, end: start + literal.length });
    assert.equal(result.hits[0].context.content, tail);
    assert.deepEqual(result.hits[0].context.range, { start: start - 81, end: original.body.length });
});

test('findText keeps a published continuation pinned across a later merge', async () => {
    const { drive } = await setup();
    const file = await drive.write({ at, op: 'create', path: '/note', content: 'Old old' });
    await drive.merge({ at, requestId: 'first', summary: 'Publish the first original' });
    const first = await drive.findText({ query: 'old', limit: 1 });
    assert.equal(first.consistency, 'snapshot');
    assert.equal(first.hits[0].content, 'Old');
    assert.deepEqual(first.next.at, { kind: 'main' });
    await drive.write({ at, op: 'update', fileId: file.fileId, content: 'New' });
    await drive.merge({ at, requestId: 'second', summary: 'Publish the second original' });
    assert.deepEqual((await drive.findText({ query: 'old' })).hits, []);
    // Omitted at is main, so the main cursor continues with or without explicit at.
    assert.equal((await drive.findText({ cursor: first.next.cursor })).hits[0].content, 'old');
    assert.equal((await drive.findText(first.next)).hits[0].content, 'old');
});

const token = value => `t1.${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
const decoded = cursor => JSON.parse(Buffer.from(cursor.slice(3), 'base64url').toString());

test('findText cursors are stateless: they continue on another client and never take authority from their contents', async () => {
    const { fixture, name, drive } = await setup();
    const first = await drive.write({ at, op: 'create', path: '/a', content: 'ok ok' });
    const page = await drive.findText({ at, query: 'ok', limit: 1 });
    // A fresh client instance resumes the same live fork scan.
    const other = await MemDrive.open({ client: { ...fixture.client }, name });
    assert.notEqual(other, drive);
    const resumed = await other.findText(page.next);
    assert.deepEqual(resumed.hits.map(hit => [hit.path, hit.range.start]), [['/a', 3]]);
    assert.deepEqual((await drive.findText(page.next)).hits, resumed.hits);
    const state = decoded(page.next.cursor);
    assert.equal(state.r.h.length, 64);
    for (const cursor of ['t1.', 't1.!!', 'x1.' + page.next.cursor.slice(3), token([]),
        token({ ...state, d: 'another-store-id' }), token({ ...state, q: '' }), token({ ...state, l: 101 }),
        token({ ...state, p: 'relative' }), token({ ...state, f: { field: 'metadata.unknown', op: 'eq', value: 1 } }),
        token({ ...state, af: 'file:not-an-id' }), token({ ...state, u: '*' }), token({ ...state, r: { ...state.r, o: -1 } }),
        token({ ...state, r: { ...state.r, h: undefined } }), token({ ...state, r: { ...state.r, i: 'file:x' } }),
        token({ ...state, v: 'v1' }), token({ ...state, a: { kind: 'fork' } }), token({ ...state, extra: true })])
        await assert.rejects(drive.findText({ at, cursor }), { code: 'FIND_TEXT_CURSOR_UNAVAILABLE' }, cursor);
    // A well-formed token for another view is a mismatch, and its at never selects the read ref.
    await assert.rejects(drive.findText({ at, cursor: token({ ...state, a: { kind: 'fork', name: 'other' } }) }),
        { code: 'CURSOR_VIEW_MISMATCH' });
    // A changed resumed file invalidates a live continuation on every client.
    await drive.write({ at, op: 'update', fileId: first.fileId, content: 'ok ok changed' });
    await assert.rejects(other.findText(page.next), { code: 'FIND_TEXT_CURSOR_UNAVAILABLE' });
});

test('main findText cursors verify their pinned publication on every page', async () => {
    const { fixture, name, drive } = await setup();
    await drive.write({ at, op: 'create', path: '/note', content: 'old old' });
    await drive.merge({ at, requestId: 'first', summary: 'Publish' });
    const page = await drive.findText({ query: 'old', limit: 1 });
    const state = decoded(page.next.cursor);
    assert.equal(state.v, 'v1');
    const other = await MemDrive.open({ client: { ...fixture.client }, name });
    assert.equal((await other.findText(page.next)).hits[0].content, 'old');
    // Unpublished, malformed or released versions are unavailable, never substituted.
    for (const v of ['v2', 'v01', 3])
        await assert.rejects(drive.findText({ cursor: token({ ...state, v }) }), { code: 'FIND_TEXT_CURSOR_UNAVAILABLE' });
    await assert.rejects(drive.findText({ cursor: token({ ...state, u: state.af ?? state.r.i }) }), { code: 'FIND_TEXT_CURSOR_UNAVAILABLE' });
    fixture.collections.get(name).tags.delete('md-main-v1');
    await assert.rejects(other.findText(page.next), { code: 'FIND_TEXT_CURSOR_UNAVAILABLE' });
});
