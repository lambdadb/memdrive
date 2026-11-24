import assert from 'node:assert/strict';
import test from 'node:test';
import { MemDrive } from '@functional-systems/memdrive';
import { fileClient } from './helpers/file-client.mjs';

const at = { kind: 'fork', name: 'draft' };
const token = value => `t1.${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
const decoded = cursor => JSON.parse(Buffer.from(cursor.slice(3), 'base64url').toString());
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
        content: '🙂A.*\r\n', range: { startLine: 1, endLine: 1, start: 797, end: 804 },
        context: { content: content.slice(717), range: { start: 717, end: content.length } },
    }]);
    // Both candidates under the quoted prefix's native ancestor come from one batch.
    const candidates = fixture.calls.filter(call => call.kind === 'query' && call.request.fields?.include?.includes('body'));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].request.size, 16);
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
        originals.set(id, { id, kind: 'file', fileId, path: `/file-${index}`, modifiedAt, body: index === 18 ? 'Match Match' : '.',
            chunking: { strategy: 'boundary', version: '1' } });
    }
    const queries = async request => {
        const before = fixture.calls.length;
        const result = await drive.findText(request);
        return { result, queries: fixture.calls.slice(before).filter(call => call.kind === 'query').map(({ request }) =>
            [request.sort[0].id, request.size, request.fields.include.includes('body'), request.query.bool.at(-1).queryString.query]) };
    };
    const id = index => `file:11111111-1111-4111-8111-${String(index).padStart(12, '0')}`;
    // One upper-bound query and one batch of 16 originals, instead of one query per original.
    const { result: first, queries: firstQueries } = await queries({ at, query: 'match', limit: 1 });
    assert.deepEqual(first.hits, []);
    assert.deepEqual(first.next.at, at);
    assert.deepEqual(firstQueries, [['desc', 1, false, '"file"'], ['asc', 16, true, '"file"']]);
    const addedId = '11111111-1111-4111-8111-999999999999';
    originals.set(`file:${addedId}`, { id: `file:${addedId}`, kind: 'file', fileId: addedId, path: '/late', modifiedAt, body: 'Match' });

    // The batch also returns the concurrent insert above the live upper bound, which ends the scan.
    const { result: second, queries: secondQueries } = await queries(first.next);
    assert.deepEqual(second.hits.map(hit => [hit.path, hit.range]), [['/file-18', { startLine: 1, endLine: 1, start: 0, end: 5 }]]);
    assert.deepEqual(secondQueries, [['asc', 16, true, `{${id(16)} TO *}`]]);
    assert(second.next);
    // Resuming inside the upper-bound file needs only its exact read.
    const { result: last, queries: lastQueries } = await queries(second.next);
    assert.deepEqual(last.hits.map(hit => [hit.path, hit.range]), [['/file-18', { startLine: 1, endLine: 1, start: 6, end: 11 }]]);
    assert.deepEqual(lastQueries, [['asc', 1, true, id(18)]]);
    assert.equal(last.next, undefined);

    await drive.write({ at, op: 'update', fileId: last.hits[0].fileId, content: 'Match skipped Match' });
    await assert.rejects(drive.findText(second.next), { code: 'FIND_TEXT_CURSOR_UNAVAILABLE' });
});

/**
 * Reference pages of the original scan, which examined one original per native
 * query and at most 16 per page. Live scans end at their upper bound without next;
 * snapshot scans end with an empty page.
 */
function referencePages(files, matchesOf, limit, live) {
    const pages = [];
    let hits = [], examined = 0;
    const flush = () => { pages.push(hits); hits = []; examined = 0; };
    files.forEach((file, index) => {
        if (examined === 16) flush();
        examined++;
        const matches = matchesOf(file);
        matches.forEach((match, position) => {
            hits.push(match);
            if (hits.length !== limit) return;
            if (position < matches.length - 1) {
                flush();
                // The next page resumes inside this file and counts it.
                examined = 1;
            } else if (!live || index < files.length - 1) flush();
        });
    });
    const full = examined === 16;
    pages.push(hits);
    if (!live && full) pages.push([]);
    return pages;
}

test('batched findText pages equal the one-original-per-query reference and bound native queries per page', async () => {
    const { fixture, name, drive } = await setup();
    const modifiedAt = '2026-01-01T00:00:00.000Z';
    const files = [];
    for (let index = 1; index <= 41; index++) {
        const fileId = `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`;
        const path = `${index % 4 === 0 ? '/out' : '/in'}/${index}.md`;
        // Zero to four occurrences, with mixed case, per original.
        const body = Array.from({ length: index % 5 }, (_, n) => `${'x'.repeat(n)}${n % 2 ? 'AB' : 'ab'}`).join(' ');
        files.push({ id: `file:${fileId}`, kind: 'file', fileId, path, ancestorPaths: ['/', path.slice(0, path.lastIndexOf('/') + 1)], modifiedAt,
            metadata: { topic: index % 3 === 0 ? 'drop' : 'keep' }, body });
    }
    const branch = fixture.collections.get(name).branches.get('fork-draft').docs;
    for (const file of files) branch.set(file.id, file);
    const { at: checkpoint } = await drive.checkpoint({ at, name: 'scan' });
    const matchesOf = prefix => file => {
        const found = [];
        if (!file.path.startsWith(prefix)) return found;
        for (let start = file.body.toLowerCase().indexOf('ab'); start !== -1; start = file.body.toLowerCase().indexOf('ab', start + 1))
            found.push([file.path, start]);
        return found;
    };
    const filtered = files.filter(file => file.path.startsWith('/in/') && file.metadata.topic === 'keep');
    for (const [view, live] of [[at, true], [checkpoint, false]]) {
        for (const { scope, request, prefix } of [
            { scope: files, request: {}, prefix: '' },
            { scope: filtered, request: { prefix: '/in/', filter: { field: 'metadata.topic', op: 'eq', value: 'keep' } }, prefix: '/in/' },
        ]) {
            for (const limit of [1, 3, 7, 100]) {
                const pages = [];
                let request_ = { at: view, query: 'aB', limit, ...request };
                for (;;) {
                    const before = fixture.calls.length;
                    const resumed = request_.cursor !== undefined && decoded(request_.cursor).r !== undefined;
                    const page = await drive.findText(request_);
                    const reads = fixture.calls.slice(before).filter(call => call.kind === 'query');
                    // One batch per page, plus the exact resumed original and the first live page's upper bound.
                    assert(reads.length <= 1 + (resumed ? 1 : 0) + (live && pages.length === 0 ? 1 : 0), `${reads.length} queries`);
                    assert(reads.filter(read => read.request.size > 1).length <= 1);
                    pages.push(page.hits.map(hit => [hit.path, hit.range.start]));
                    if (!page.next) break;
                    request_ = page.next;
                }
                assert.deepEqual(pages, referencePages(scope, matchesOf(prefix), limit, live), `${view.kind} ${prefix} ${limit}`);
            }
        }
    }
    // The 41-original unfiltered scan reads 3 batches where the original scan issued one query per original.
    const before = fixture.calls.length;
    let page = await drive.findText({ at: checkpoint, query: 'ab', limit: 100 });
    while (page.next) page = await drive.findText(page.next);
    assert.equal(fixture.calls.slice(before).filter(call => call.kind === 'query').length, 3);
});

test('a batched findText page validates its native batch and never resumes a deleted file', async () => {
    const { fixture, name, drive } = await setup();
    const branch = fixture.collections.get(name).branches.get('fork-draft').docs;
    const modifiedAt = '2026-01-01T00:00:00.000Z';
    const files = [1, 2, 3].map(index => {
        const fileId = `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`;
        return { id: `file:${fileId}`, kind: 'file', fileId, path: `/${index}`, modifiedAt, body: 'hit hit' };
    });
    for (const file of files) branch.set(file.id, file);
    const envelope = (docs, extra = {}) => ({ isDocsInline: true, total: docs.length,
        docs: docs.map(doc => ({ collection: name, doc: structuredClone(doc) })), ...extra });
    const [a, b, c] = files;
    for (const [label, response] of [
        ['descending', envelope([b, a])], ['duplicate', envelope([a, a])], ['tombstone', envelope([a, { ...b, kind: 'tombstone' }])],
        ['oversized', envelope(Array.from({ length: 17 }, () => a))], ['short total', envelope([a, b], { total: 3 })],
        ['offloaded', { isDocsInline: false, docsUrl: 'https://example.invalid/docs', total: 3, docs: [] }],
        ['offloaded without docs', { isDocsInline: false, total: 3 }],
    ]) {
        fixture.findTextQuery = request => request.size > 1 ? response : undefined;
        await assert.rejects(drive.findText({ at, query: 'hit' }), { code: 'INVALID_RESULT' }, label);
    }
    // A batch must start after the cursor's last examined original.
    fixture.findTextQuery = undefined;
    const first = await drive.findText({ at, query: 'hit', limit: 2 });
    fixture.findTextQuery = request => request.size > 1 ? envelope([a, b, c]) : undefined;
    await assert.rejects(drive.findText(first.next), { code: 'INVALID_RESULT' });

    // An abort after the batch arrives stops before examining it.
    const stop = new AbortController();
    fixture.findTextQuery = request => { if (request.size > 1) stop.abort(); };
    await assert.rejects(drive.findText({ at, query: 'hit' }, { signal: stop.signal }), { code: 'ABORTED' });
    fixture.findTextQuery = undefined;

    // A live continuation inside a deleted file is unavailable, never moved to the next original.
    const resumed = await drive.findText({ at, query: 'hit', limit: 3 });
    assert.equal(decoded(resumed.next.cursor).r.i, b.id);
    branch.delete(b.id);
    await assert.rejects(drive.findText(resumed.next), { code: 'FIND_TEXT_CURSOR_UNAVAILABLE' });
    // A resumed original that no longer matches the scan's filters is equally unavailable.
    branch.set(b.id, b);
    const scoped = await drive.findText({ at, query: 'hit', prefix: '/', limit: 1 });
    branch.set(a.id, { ...a, kind: 'tombstone' });
    await assert.rejects(drive.findText(scoped.next), { code: 'FIND_TEXT_CURSOR_UNAVAILABLE' });
});

test('findText line numbers select ranged reads containing each match across LF, CRLF, lone CR and surrogate pairs', async () => {
    const { drive } = await setup();
    // Lines: 1 'alpha 🙂Needle\n', 2 'beta\r\n', 3 'needle gamma\r', 4 'delta NEEDLE\r\n', 5 'multi\n', 6 'line 🙂needle\n', 7 'end'.
    const content = 'alpha 🙂Needle\nbeta\r\nneedle gamma\rdelta NEEDLE\r\nmulti\nline 🙂needle\nend';
    const file = await drive.write({ at, op: 'create', path: '/lines.txt', content });
    const lines = async query => (await drive.findText({ at, query, prefix: '/lines.txt', limit: 100 })).hits
        .map(({ content: text, range }) => [text, range.startLine, range.endLine]);
    assert.deepEqual(await lines('needle'), [['Needle', 1, 1], ['needle', 3, 3], ['NEEDLE', 4, 4], ['needle', 6, 6]]);
    assert.deepEqual(await lines('🙂needle'), [['🙂Needle', 1, 1], ['🙂needle', 6, 6]]);
    // Multi-line literals cross LF, CRLF and a lone CR.
    assert.deepEqual(await lines('needle\nbeta\r\nneedle'), [['Needle\nbeta\r\nneedle', 1, 3]]);
    assert.deepEqual(await lines('gamma\rdelta'), [['gamma\rdelta', 3, 4]]);
    assert.deepEqual(await lines('multi\nline'), [['multi\nline', 5, 6]]);
    // A match ends on the line holding its last unit, so a trailing break stays on the
    // line it terminates, and a leading break starts on that line, exactly as in read.
    assert.deepEqual(await lines('beta\r\n'), [['beta\r\n', 2, 2]]);
    assert.deepEqual(await lines('gamma\r'), [['gamma\r', 3, 3]]);
    assert.deepEqual(await lines('\nend'), [['\nend', 6, 7]]);
    // Either half of a CRLF belongs to the line the pair terminates.
    assert.deepEqual(await lines('\r'), [['\r', 2, 2], ['\r', 3, 3], ['\r', 4, 4]]);
    assert.deepEqual(await lines('\n'), [['\n', 1, 1], ['\n', 2, 2], ['\n', 4, 4], ['\n', 5, 5], ['\n', 6, 6]]);

    for (const query of ['needle', '🙂needle', 'needle\nbeta\r\nneedle', 'gamma\rdelta', 'multi\nline', 'beta\r\n', 'gamma\r', '\nend', '\r', '\n', 'end']) {
        for (const hit of (await drive.findText({ at, query, prefix: '/lines.txt', limit: 100 })).hits) {
            const { startLine, endLine, start, end } = hit.range;
            const page = await drive.read({ at, fileId: file.fileId, startLine, endLine });
            assert.deepEqual([page.range.startLine, page.range.endLine], [startLine, endLine], JSON.stringify(query));
            assert(page.range.start <= start && end <= page.range.end, JSON.stringify(query));
            assert.equal(page.content.slice(start - page.range.start, end - page.range.start), hit.content);
        }
    }
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
    assert.deepEqual(result.hits[0].range, { startLine: 1, endLine: 1, start, end: start + literal.length });
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
    // Unpublished, malformed or released versions and a main without a pinned version
    // are unavailable, never substituted.
    for (const v of ['v2', 'v01', 3, null])
        await assert.rejects(drive.findText({ cursor: token({ ...state, v }) }), { code: 'FIND_TEXT_CURSOR_UNAVAILABLE' });
    await assert.rejects(drive.findText({ cursor: token({ ...state, u: state.af ?? state.r.i }) }), { code: 'FIND_TEXT_CURSOR_UNAVAILABLE' });
    fixture.collections.get(name).tags.delete('md-main-v1');
    await assert.rejects(other.findText(page.next), { code: 'FIND_TEXT_CURSOR_UNAVAILABLE' });
});

test('a checkpoint findText cursor survives the first publication of its tag snapshot', async () => {
    const { fixture, drive } = await setup();
    await drive.write({ at, op: 'create', path: '/note', content: 'saved saved' });
    // A tag created before its source's first snapshot reports a null snapshot
    // until that snapshot is published (LambdaDB PR #614).
    fixture.afterTagCreate = tag => { tag.snapshotId = null; tag.snapshotCommittedAt = null; };
    const { at: saved } = await drive.checkpoint({ at, name: 'saved' });
    const page = await drive.findText({ at: saved, query: 'saved', limit: 1 });
    assert(page.next);
    const tag = fixture.collections.get('literal-scan').tags.get('checkpoint-saved')?.tag;
    assert.equal(tag?.snapshotId, null);
    tag.snapshotId = 'published-later';
    tag.snapshotCommittedAt = new Date();
    assert.equal((await drive.findText(page.next)).hits[0].range.start, 6);
});

test('findText cursors never continue on a fork or checkpoint recreated under the same name', async () => {
    const { fixture, name, drive } = await setup();
    const file = await drive.write({ at, op: 'create', path: '/note', content: 'saved saved' });
    const { at: saved } = await drive.checkpoint({ at, name: 'saved' });
    const page = await drive.findText({ at: saved, query: 'saved', limit: 1 });
    assert.equal(page.consistency, 'snapshot');
    assert.equal(decoded(page.next.cursor).i.length, 32);
    // The original incarnation still continues, including on another client.
    const other = await MemDrive.open({ client: { ...fixture.client }, name });
    assert.equal((await other.findText(page.next)).hits[0].range.start, 6);
    await drive.deleteCheckpoint({ at: saved });
    await assert.rejects(other.findText(page.next), { code: 'FIND_TEXT_CURSOR_UNAVAILABLE' });
    await drive.write({ at, op: 'update', fileId: file.fileId, content: 'saved but replaced' });
    await drive.checkpoint({ at, name: 'saved' });
    await assert.rejects(drive.findText(page.next), { code: 'FIND_TEXT_CURSOR_UNAVAILABLE' });
    await assert.rejects(other.findText(page.next), { code: 'FIND_TEXT_CURSOR_UNAVAILABLE' });
    assert.equal((await drive.findText({ at: saved, query: 'saved' })).hits.length, 1);

    // A recreated fork is likewise a different view, even with unchanged files.
    await drive.write({ at, op: 'create', path: '/second', content: 'saved' });
    const { at: copy } = await drive.fork({ at, name: 'copy' });
    const copied = await drive.findText({ at: copy, query: 'saved', limit: 1 });
    await drive.deleteFork({ at: copy });
    await drive.fork({ at, name: 'copy' });
    assert(copied.next);
    await assert.rejects(drive.findText(copied.next), { code: 'FIND_TEXT_CURSOR_UNAVAILABLE' });
});
