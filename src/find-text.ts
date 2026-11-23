import { isObject, keysOnly } from './config.js';
import { checkAbort, databaseError, MemDriveError, nativeOptions, nativeRequest, operationOptions, requireInput } from './errors.js';
import { compileFilter } from './filter.js';
import { prefixAncestor, validPathPrefix } from './list.js';
import { initialMainRef } from './merge-preflight.js';
import { decodeFile, decodeFileEntry, fingerprintOf, originalId, resultDocs, validPath, validText } from './records.js';
import { afterId, ancestorFilter, branchRef, readRef, viewRead, type Handle, type RefSource, type ViewRef, type WithoutAt } from './storage-reads.js';
import type { FileAt, FileFilter, FindTextRequest, FindTextResult, MetadataSchema, RequestOptions } from './types.js';
import { decodeToken, encodeToken } from './cursor-tokens.js';
import { tagFor } from './publication-log.js';

type Clause = ReturnType<typeof compileFilter> | { queryString: { query: string; defaultField: string; skipSyntax?: boolean }; occur: string };
type Resume = { id: string; offset: number; fingerprint?: string };
type Criteria = { query: string; prefix: string; filter?: FileFilter | undefined; limit: number };
type Scan = Criteria & {
    ref: ViewRef;
    /** Fork or checkpoint incarnation the scan started on. */
    incarnation?: string | undefined;
    pattern: string;
    clauses: Clause[];
    upper?: string | undefined;
    after?: string | undefined;
    resume?: Resume | undefined;
};

type Page = { result: FindTextResult; next?: Scan };

const entryFields = ['id', 'kind', 'fileId', 'path', 'modifiedAt', 'metadata'];
const kind = { queryString: { query: '"file"', defaultField: 'kind' }, occur: 'filter' };
const encoder = new TextEncoder();
const contextUnits = 80;
const filesPerPage = 16;
const token = 't1';
const fingerprintPattern = /^[0-9a-f]{64}$/;
const incarnationPattern = /^[0-9a-f]{32}$/;
const originalPattern = /^file:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const unavailable = (cause?: unknown) => new MemDriveError('FIND_TEXT_CURSOR_UNAVAILABLE',
    'Text match cursor is malformed, or its pinned view or resumed file is no longer available. Start again without a cursor.', { cause });
const sameAt = (a: FileAt, b: FileAt) => a.kind === b.kind && (a.kind === 'main' || a.name === (b as { name: string }).name);
const validAt = (value: unknown): value is FileAt => isObject(value) && (value.kind === 'main' ? keysOnly(value, ['kind'])
    : (value.kind === 'fork' || value.kind === 'checkpoint') && keysOnly(value, ['kind', 'name']) && typeof value.name === 'string');
const insidePair = (text: string, offset: number) => text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff;

/** Validate search criteria for a new scan or a decoded continuation. */
function prepare(criteria: Criteria, schema: MetadataSchema) {
    const { query, prefix, limit, filter } = criteria;
    requireInput(validText(query) && query.length > 0 && query.length <= 8192 && encoder.encode(query).length <= 8192,
        'Text matching requires a nonempty literal of at most 8192 UTF-8 bytes.');
    requireInput(validPathPrefix(prefix), 'Text match prefix must be an absolute path prefix of at most 4096 UTF-8 bytes.');
    const ancestor = prefixAncestor(prefix);
    requireInput(ancestor.length <= 1 || validPath(ancestor.slice(0, -1)), 'Text match prefix contains an invalid directory component.');
    requireInput(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'Text match limit must be 1–100.');
    const pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const clauses: Clause[] = [kind, ...ancestorFilter(ancestor),
        ...(filter === undefined ? [] : [{ ...compileFilter(filter, schema), occur: 'filter' as const }])];
    return { ...criteria, pattern, clauses };
}

/**
 * Find text in one view. Cursors are stateless tokens carrying the scan
 * position; the view and any pinned main publication are re-resolved and
 * verified from the request on every page.
 */
export function fileTextFinder(handle: Handle, name: string, source: RefSource, schema: MetadataSchema, at: FileAt,
    { enqueue, pinVersion, store, incarnation }: {
        enqueue?: (<T>(operation: () => Promise<T>, signal?: AbortSignal) => Promise<T>) | undefined;
        pinVersion: (version: string, signal?: AbortSignal) => Promise<ViewRef>;
        store: Promise<string>;
        /** A fresh identity of a fork or checkpoint, so a recreated ref with the same name is never continued. */
        incarnation?: ((signal?: AbortSignal) => Promise<string>) | undefined;
    }) {
    const published = 'read' in source;
    async function current(signal?: AbortSignal) {
        try { return await incarnation!(signal); }
        catch (cause) {
            if (cause instanceof MemDriveError && (cause.code === 'BRANCH_NOT_FOUND' || cause.code === 'CHECKPOINT_NOT_FOUND')) throw unavailable(cause);
            throw cause;
        }
    }
    /** The main publication a ref pins, or null for a legacy live main. */
    const mainVersion = (ref: ViewRef) => ref.kind === 'tag' && ref.name.startsWith(tagFor('')) ? ref.name.slice(tagFor('').length)
        : ref.name === initialMainRef.name ? 'v0' : null;

    async function encode(scan: Scan) {
        const { query, prefix, filter, limit, upper, after, resume } = scan;
        return encodeToken(token, { d: await store, a: at, ...(published ? { v: mainVersion(scan.ref) } : {}),
            ...(scan.incarnation === undefined ? {} : { i: scan.incarnation }),
            q: query, p: prefix, ...(filter === undefined ? {} : { f: filter }), l: limit,
            ...(upper === undefined ? {} : { u: upper }), ...(after === undefined ? {} : { af: after }),
            ...(resume === undefined ? {} : { r: { i: resume.id, o: resume.offset, ...(resume.fingerprint === undefined ? {} : { h: resume.fingerprint }) } }) });
    }

    /** Rebuild a scan from an untrusted token without granting it any authority. */
    async function decode(cursor: string, signal?: AbortSignal): Promise<Scan> {
        const value = decodeToken(token, cursor);
        if (!value || !keysOnly(value, ['d', 'a', 'v', 'i', 'q', 'p', 'f', 'l', 'u', 'af', 'r']) || value.d !== await store || !validAt(value.a))
            throw unavailable();
        if (!sameAt(value.a, at))
            throw new MemDriveError('CURSOR_VIEW_MISMATCH', 'This cursor belongs to another view. Forward the returned next request unchanged, including its at.');
        let criteria;
        try {
            criteria = prepare({ query: value.q as string, prefix: value.p as string, limit: value.l as number,
                ...(Object.hasOwn(value, 'f') ? { filter: value.f as FileFilter } : {}) }, schema);
        } catch (cause) { throw unavailable(cause); }
        const { u: upper, af: after, r } = value;
        let resume: Resume | undefined;
        if (r !== undefined) {
            if (!keysOnly(r, ['i', 'o', 'h']) || typeof r.i !== 'string' || !originalPattern.test(r.i)
                || !Number.isSafeInteger(r.o) || (r.o as number) < 0
                || (r.h !== undefined && (typeof r.h !== 'string' || !fingerprintPattern.test(r.h)))) throw unavailable();
            resume = { id: r.i, offset: r.o as number, ...(r.h === undefined ? {} : { fingerprint: r.h as string }) };
        }
        if ((upper !== undefined && (typeof upper !== 'string' || !originalPattern.test(upper)))
            || (after !== undefined && (typeof after !== 'string' || !originalPattern.test(after)))
            || (after !== undefined && upper !== undefined && after >= upper)
            || (resume && ((after !== undefined && resume.id <= after) || (upper !== undefined && resume.id > upper))))
            throw unavailable();
        // Derive the read ref from the request's view, never from the token.
        let ref: ViewRef;
        if (!published) {
            if (Object.hasOwn(value, 'v') || typeof value.i !== 'string' || !incarnationPattern.test(value.i)) throw unavailable();
            // Reject a fork or checkpoint deleted or recreated under the same name since the scan began.
            if (value.i !== await current(signal)) throw unavailable();
            ref = source;
        }
        else if (Object.hasOwn(value, 'i')) throw unavailable();
        else if (value.v === null) ref = branchRef('main');
        else if (typeof value.v === 'string' && /^v(?:0|[1-9][0-9]*)$/.test(value.v) && value.v.length <= 44) {
            try { ref = await pinVersion(value.v, signal); }
            catch (cause) {
                if (cause instanceof MemDriveError && cause.code === 'HISTORICAL_VIEW_UNAVAILABLE') throw unavailable(cause);
                throw cause;
            }
        } else throw unavailable();
        // Snapshots have no upper bound or fingerprints; live scans require both.
        const snapshot = isSnapshot(ref);
        if (snapshot ? upper !== undefined || resume?.fingerprint !== undefined
            : upper === undefined || (resume !== undefined && resume.fingerprint === undefined)) throw unavailable();
        return { ...criteria, ref, ...(published ? {} : { incarnation: value.i as string }), ...(upper === undefined ? {} : { upper: upper as string }),
            ...(after === undefined ? {} : { after: after as string }), ...(resume === undefined ? {} : { resume }) };
    }
    const isSnapshot = (ref: ViewRef) => ref.kind === 'tag' || ('read' in source && ref.name === initialMainRef.name);

    async function original(ref: ViewRef, clauses: Clause[], signal?: AbortSignal, upperBound = false) {
        let response;
        try {
            response = await nativeRequest(() => handle.query({
                ...viewRead(ref), size: 1, sort: [{ id: upperBound ? 'desc' : 'asc' }],
                fields: { include: upperBound ? entryFields : [...entryFields, 'body'] },
                query: { bool: clauses },
            }, nativeOptions(signal)), signal);
        } catch (cause) {
            throw databaseError(cause, 'Could not read file originals for text matching.');
        }
        checkAbort(signal);
        const docs = resultDocs(response, name, 1);
        if (response.isDocsInline !== true || response.total !== docs.length)
            throw new MemDriveError('INVALID_RESULT', 'Text matching returned an incomplete document page.');
        return docs[0];
    }

    async function page(scan: Scan, signal?: AbortSignal): Promise<Page> {
        const { ref, clauses, limit, prefix, pattern, upper } = scan;
        const result: FindTextResult = { hits: [], consistency: isSnapshot(ref) ? 'snapshot' : 'live' };
        const find = new RegExp(pattern, 'giu');
        let { after, resume } = scan;
        for (let examined = 0; examined < filesPerPage; examined++) {
            const exact = resume && { queryString: { query: resume.id, defaultField: 'id', skipSyntax: true }, occur: 'filter' };
            const doc = await original(ref, [...clauses, ...(exact ? [exact] : afterId(after))], signal);
            if (!doc) {
                if (resume) throw unavailable();
                return { result };
            }
            const file = decodeFile(doc, schema);
            const id = originalId(file.fileId);
            if ((after !== undefined && id <= after) || (resume && id !== resume.id))
                throw new MemDriveError('INVALID_RESULT', 'Text matching returned an unexpected file original.');
            if (upper !== undefined && id > upper) return { result };
            if (resume?.fingerprint !== undefined && resume.fingerprint !== await fingerprintOf(file))
                throw unavailable();
            if (resume && (resume.offset > file.content.length || insidePair(file.content, resume.offset)))
                throw unavailable();
            checkAbort(signal);
            const { content, ...entry } = file;
            if (file.path.startsWith(prefix)) {
                find.lastIndex = resume?.offset ?? 0;
                let match = find.exec(content);
                while (match) {
                    const start = match.index;
                    const end = start + match[0].length;
                    let contextStart = Math.max(0, start - contextUnits);
                    let contextEnd = Math.min(end + contextUnits, content.length);
                    if (insidePair(content, contextStart)) contextStart--;
                    if (insidePair(content, contextEnd)) contextEnd++;
                    result.hits.push({ ...entry, content: match[0], range: { start, end },
                        context: { content: content.slice(contextStart, contextEnd),
                            range: { start: contextStart, end: contextEnd } } });
                    // Advance one code point from the start to include overlapping occurrences.
                    find.lastIndex = start + (insidePair(content, start + 1) ? 2 : 1);
                    match = find.exec(content);
                    if (result.hits.length === limit) {
                        if (match) return { result, next: { ...scan, after, resume: { id, offset: match.index,
                            ...(isSnapshot(ref) ? {} : { fingerprint: await fingerprintOf(file) }) } } };
                        if (id === upper) return { result };
                        return { result, next: { ...scan, after: id, resume: undefined } };
                    }
                }
            }
            after = id;
            resume = undefined;
            if (id === upper) return { result };
        }
        return { result, next: { ...scan, after, resume: undefined } };
    }

    async function findText(request: WithoutAt<FindTextRequest>, options?: RequestOptions): Promise<FindTextResult> {
        const { signal } = operationOptions(options);
        checkAbort(signal);
        requireInput(keysOnly(request, ['query', 'prefix', 'filter', 'limit', 'cursor']), 'Invalid text match options.');

        let run: () => Promise<Page>;
        if ('cursor' in request) {
            const cursor = request.cursor;
            requireInput(Object.keys(request).length === 1 && typeof cursor === 'string', 'Pass only cursor when continuing text matching.');
            run = async () => {
                const scan = await decode(cursor, signal);
                if (!isSnapshot(scan.ref) && published) {
                    // A legacy main may gain a published tag between pages.
                    return readRef(source, ref => {
                        if (ref.kind !== scan.ref.kind || ref.name !== scan.ref.name) throw unavailable();
                        return page(scan, signal);
                    }, signal);
                }
                return page(scan, signal);
            };
        } else {
            const { query, prefix = '', limit = 20, filter } = request;
            const criteria = prepare({ query, prefix, limit, ...(filter === undefined ? {} : { filter }) }, schema);
            run = () => readRef(source, async ref => {
                const scan = { ...criteria, ref, ...(published ? {} : { incarnation: await incarnation!(signal) }) };
                if (isSnapshot(ref)) return page(scan, signal);
                const last = await original(ref, criteria.clauses, signal, true);
                if (!last) return { result: { hits: [], consistency: 'live' } };
                const upper = originalId(decodeFileEntry(last, schema).fileId);
                return page({ ...scan, upper }, signal);
            }, signal);
        }

        const { result, next } = await (enqueue ? enqueue(run, signal) : run());
        checkAbort(signal);
        if (next) result.next = { at: { ...at }, cursor: await encode(next) };
        return result;
    }
    return findText;
}
