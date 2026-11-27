import { keysOnly } from './config.js';
import { checkAbort, databaseError, MemDriveError, nativeOptions, nativeRequest, operationOptions, requireInput } from './errors.js';
import { compileFilter } from './filter.js';
import { prefixAncestor, sameAt, validAt, validPathPrefix } from './list.js';
import { decodeFile, decodeFileEntry, fileEntryFields, fingerprintOf, originalId, resultDocs, validPath, validText } from './records.js';
import { afterId, ancestorFilter, viewRead, type Handle, type ViewRef, type WithoutAt } from './storage-reads.js';
import type { DriveFile, FileAt, FileFilter, FindTextRequest, FindTextResult, MetadataSchema, RequestOptions } from './types.js';
import { decodeToken, encodeToken } from './cursor-tokens.js';
import { lineCounter } from './read-range.js';

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

const kind = { queryString: { query: '"file"', defaultField: 'kind' }, occur: 'filter' };
const encoder = new TextEncoder();
const contextUnits = 80;
const filesPerPage = 16;
const token = 't1';
const fingerprintPattern = /^[0-9a-f]{64}$/;
const incarnationPattern = /^[0-9a-f]{32}$/;
const originalPattern = /^file:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const unavailable = (cause?: unknown) => new MemDriveError('FIND_TEXT_CURSOR_UNAVAILABLE',
    'Text match cursor is malformed, or its view or resumed file is no longer available. Start again without a cursor.', { cause });
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
 * Find text in a store's views. Cursors are stateless tokens carrying the scan
 * position; the view is re-resolved and verified from the request on every page.
 * A fork or checkpoint scan is bound to that ref's incarnation, so a recreated
 * ref with the same name is never continued. Main exists as long as its store.
 */
export function fileTextFinder(handle: Handle, name: string, schema: MetadataSchema, store: string,
    incarnation: (at: Exclude<FileAt, { kind: 'main' }>, signal?: AbortSignal) => Promise<string>) {
    async function current(at: Exclude<FileAt, { kind: 'main' }>, signal?: AbortSignal) {
        try { return await incarnation(at, signal); }
        catch (cause) {
            if (cause instanceof MemDriveError && (cause.code === 'BRANCH_NOT_FOUND' || cause.code === 'CHECKPOINT_NOT_FOUND')) throw unavailable(cause);
            throw cause;
        }
    }
    const isSnapshot = (ref: ViewRef) => ref.kind === 'tag';

    async function encode(at: FileAt, scan: Scan) {
        const { query, prefix, filter, limit, upper, after, resume } = scan;
        return encodeToken(token, { d: store, a: at,
            ...(scan.incarnation === undefined ? {} : { i: scan.incarnation }),
            q: query, p: prefix, ...(filter === undefined ? {} : { f: filter }), l: limit,
            ...(upper === undefined ? {} : { u: upper }), ...(after === undefined ? {} : { af: after }),
            ...(resume === undefined ? {} : { r: { i: resume.id, o: resume.offset, ...(resume.fingerprint === undefined ? {} : { h: resume.fingerprint }) } }) });
    }

    /** Rebuild a scan from an untrusted token without granting it any authority. */
    async function decode(at: FileAt, ref: ViewRef, cursor: string, signal?: AbortSignal): Promise<Scan> {
        const value = decodeToken(token, cursor);
        if (!value || !keysOnly(value, ['d', 'a', 'i', 'q', 'p', 'f', 'l', 'u', 'af', 'r']) || value.d !== store || !validAt(value.a))
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
        // The read ref comes from the request's view, never from the token.
        if (at.kind === 'main') {
            if (Object.hasOwn(value, 'i')) throw unavailable();
        } else {
            if (typeof value.i !== 'string' || !incarnationPattern.test(value.i)) throw unavailable();
            // Reject a fork or checkpoint deleted or recreated under the same name since the scan began.
            if (value.i !== await current(at, signal)) throw unavailable();
        }
        // Snapshots have no upper bound or fingerprints; live scans require both.
        const snapshot = isSnapshot(ref);
        if (snapshot ? upper !== undefined || resume?.fingerprint !== undefined
            : upper === undefined || (resume !== undefined && resume.fingerprint === undefined)) throw unavailable();
        return { ...criteria, ref, ...(at.kind === 'main' ? {} : { incarnation: value.i as string }), ...(upper === undefined ? {} : { upper: upper as string }),
            ...(after === undefined ? {} : { after: after as string }), ...(resume === undefined ? {} : { resume }) };
    }

    /**
     * Read up to `size` originals in ID order, or the last one for a live upper bound.
     * The native client downloads offloaded (`docsUrl`) results; a response that is
     * still not inline or disagrees with its total is never treated as complete.
     */
    async function originals(ref: ViewRef, clauses: Clause[], size: number, signal?: AbortSignal, upperBound = false) {
        let response;
        try {
            response = await nativeRequest(() => handle.query({
                ...viewRead(ref), size, sort: [{ id: upperBound ? 'desc' : 'asc' }],
                fields: { include: upperBound ? fileEntryFields : [...fileEntryFields, 'body'] },
                query: { bool: clauses },
            }, nativeOptions(signal)), signal);
        } catch (cause) {
            throw databaseError(cause, 'Could not read file originals for text matching.');
        }
        checkAbort(signal);
        const docs = resultDocs(response, name, size);
        if (response.isDocsInline !== true || response.total !== docs.length)
            throw new MemDriveError('INVALID_RESULT', 'Text matching returned an incomplete document page.');
        return docs;
    }

    async function page(scan: Scan, signal?: AbortSignal): Promise<Page> {
        const { ref, clauses, limit, prefix, pattern, upper, resume } = scan;
        const result: FindTextResult = { hits: [], consistency: isSnapshot(ref) ? 'snapshot' : 'live' };
        const find = new RegExp(pattern, 'giu');
        /** The last fully examined original. */
        let after = scan.after;
        /** Collect one file's matches from offset, returning the page if the hit limit stops inside or after it. */
        async function examine(file: DriveFile, id: string, offset: number): Promise<Page | undefined> {
            checkAbort(signal);
            const { content, ...entry } = file;
            if (!file.path.startsWith(prefix)) return undefined;
            find.lastIndex = offset;
            let match = find.exec(content);
            // Match starts increase, so one counter numbers them in a single pass.
            let lines: ((offset: number) => number) | undefined;
            while (match) {
                const start = match.index;
                const end = start + match[0].length;
                // Lines follow ranged reads: a match ends on the line holding its last unit,
                // so a trailing line break stays on the line it terminates.
                const startLine = (lines ??= lineCounter(content))(start);
                const endLine = lineCounter(content.slice(start, end), startLine)(end - 1 - start);
                let contextStart = Math.max(0, start - contextUnits);
                let contextEnd = Math.min(end + contextUnits, content.length);
                if (insidePair(content, contextStart)) contextStart--;
                if (insidePair(content, contextEnd)) contextEnd++;
                result.hits.push({ ...entry, content: match[0], range: { startLine, endLine, start, end },
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
            return undefined;
        }

        let examined = 0;
        if (resume) {
            // Continue inside exactly the file the previous page stopped in. Its own
            // query keeps originals inserted before it out of this page.
            const exact = { queryString: { query: resume.id, defaultField: 'id', skipSyntax: true }, occur: 'filter' };
            const [doc] = await originals(ref, [...clauses, exact], 1, signal);
            if (!doc) throw unavailable();
            const file = decodeFile(doc, schema);
            if (originalId(file.fileId) !== resume.id)
                throw new MemDriveError('INVALID_RESULT', 'Text matching returned an unexpected file original.');
            if (resume.fingerprint !== undefined && resume.fingerprint !== await fingerprintOf(file))
                throw unavailable();
            if (resume.offset > file.content.length || insidePair(file.content, resume.offset))
                throw unavailable();
            const stopped = await examine(file, resume.id, resume.offset);
            if (stopped) return stopped;
            if (resume.id === upper) return { result };
            after = resume.id;
            examined = 1;
        }
        // One batch fills the rest of the page. Originals fetched after a stop are
        // refetched by the next page, so none is skipped.
        const size = filesPerPage - examined;
        const docs = await originals(ref, [...clauses, ...afterId(after)], size, signal);
        for (const doc of docs) {
            const file = decodeFile(doc, schema);
            const id = originalId(file.fileId);
            // Strictly ascending IDs after the cursor also exclude duplicates.
            if (after !== undefined && id <= after)
                throw new MemDriveError('INVALID_RESULT', 'Text matching returned an unexpected file original.');
            if (upper !== undefined && id > upper) return { result };
            const stopped = await examine(file, id, 0);
            if (stopped) return stopped;
            after = id;
            if (id === upper) return { result };
        }
        // Native queries return every requested match or fail; they never cut a page by
        // bytes, so a short batch ends the scan.
        if (docs.length < size) return { result };
        return { result, next: { ...scan, after, resume: undefined } };
    }

    return async function findText(at: FileAt, ref: ViewRef, request: WithoutAt<FindTextRequest>, options?: RequestOptions): Promise<FindTextResult> {
        const { signal } = operationOptions(options);
        checkAbort(signal);
        requireInput(keysOnly(request, ['query', 'prefix', 'filter', 'limit', 'cursor']), 'Invalid text match options.');

        let run: () => Promise<Page>;
        if ('cursor' in request) {
            const cursor = request.cursor;
            requireInput(Object.keys(request).length === 1 && typeof cursor === 'string', 'Pass only cursor when continuing text matching.');
            run = async () => page(await decode(at, ref, cursor, signal), signal);
        } else {
            const { query, prefix = '', limit = 20, filter } = request;
            const criteria = prepare({ query, prefix, limit, ...(filter === undefined ? {} : { filter }) }, schema);
            run = async () => {
                const scan = { ...criteria, ref, ...(at.kind === 'main' ? {} : { incarnation: await incarnation(at, signal) }) };
                if (isSnapshot(ref)) return page(scan, signal);
                const [last] = await originals(ref, criteria.clauses, 1, signal, true);
                if (!last) return { result: { hits: [], consistency: 'live' } };
                const upper = originalId(decodeFileEntry(last, schema).fileId);
                return page({ ...scan, upper }, signal);
            };
        }

        const { result, next } = await run();
        checkAbort(signal);
        if (next) result.next = { at: { ...at }, cursor: await encode(at, next) };
        return result;
    };
}
