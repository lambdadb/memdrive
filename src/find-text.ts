import { keysOnly } from './config.js';
import { checkAbort, databaseError, MemDriveError, nativeOptions, nativeRequest, operationOptions, requireInput } from './errors.js';
import { compileFilter } from './filter.js';
import { prefixAncestor, validPathPrefix } from './list.js';
import { initialMainRef } from './merge-preflight.js';
import { decodeFile, decodeFileEntry, fingerprintOf, originalId, resultDocs, validPath, validText } from './records.js';
import { afterId, ancestorFilter, readRef, viewRead, type Handle, type RefSource, type ViewRef } from './storage-reads.js';
import type { FindTextRequest, FindTextResult, MetadataSchema, RequestOptions } from './types.js';

type Clause = ReturnType<typeof compileFilter> | { queryString: { query: string; defaultField: string; skipSyntax?: boolean }; occur: string };
type Resume = { id: string; offset: number; fingerprint?: string };
type Scan = {
    ref: ViewRef;
    prefix: string;
    pattern: string;
    limit: number;
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
const maxCursors = 64;
const cursorTtlMs = 5 * 60 * 1000;
const unavailable = () => new MemDriveError('FIND_TEXT_CURSOR_UNAVAILABLE', 'Text match cursor is unavailable. Start again without a cursor.');
const insidePair = (text: string, offset: number) => text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff;

export function fileTextFinder(handle: Handle, name: string, source: RefSource, schema: MetadataSchema,
    enqueue?: <T>(operation: () => Promise<T>, signal?: AbortSignal) => Promise<T>) {
    const cursors = new Map<string, { scan: Scan; expiresAt: number }>();
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

    return async function findText(request: FindTextRequest, options?: RequestOptions): Promise<FindTextResult> {
        const { signal } = operationOptions(options);
        checkAbort(signal);
        requireInput(keysOnly(request, ['query', 'prefix', 'filter', 'limit', 'cursor']), 'Invalid text match options.');

        let run: () => Promise<Page>;
        if ('cursor' in request) {
            const cursor = request.cursor;
            requireInput(Object.keys(request).length === 1 && typeof cursor === 'string', 'Pass only cursor when continuing text matching.');
            run = () => {
                const entry = cursors.get(cursor);
                if (!entry || Date.now() >= entry.expiresAt) throw unavailable();
                const { scan } = entry;
                if (!isSnapshot(scan.ref) && 'read' in source) {
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
            requireInput(validText(query) && query.length > 0 && query.length <= 8192 && encoder.encode(query).length <= 8192,
                'Text matching requires a nonempty literal of at most 8192 UTF-8 bytes.');
            requireInput(validPathPrefix(prefix), 'Text match prefix must be an absolute path prefix of at most 4096 UTF-8 bytes.');
            const ancestor = prefixAncestor(prefix);
            requireInput(ancestor.length <= 1 || validPath(ancestor.slice(0, -1)), 'Text match prefix contains an invalid directory component.');
            requireInput(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'Text match limit must be 1–100.');
            const pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const clauses: Clause[] = [kind, ...ancestorFilter(ancestor),
                ...(filter === undefined ? [] : [{ ...compileFilter(filter, schema), occur: 'filter' as const }])];
            run = () => readRef(source, async ref => {
                const scan = { ref, prefix, pattern, limit, clauses };
                if (isSnapshot(ref)) return page(scan, signal);
                const last = await original(ref, clauses, signal, true);
                if (!last) return { result: { hits: [], consistency: 'live' } };
                const upper = originalId(decodeFileEntry(last, schema).fileId);
                return page({ ...scan, upper }, signal);
            }, signal);
        }

        const { result, next } = await (enqueue ? enqueue(run, signal) : run());
        checkAbort(signal);
        if (next) {
            const now = Date.now();
            for (const [id, entry] of cursors) if (now >= entry.expiresAt) cursors.delete(id);
            if (cursors.size >= maxCursors) cursors.delete(cursors.keys().next().value!);
            const cursor = globalThis.crypto.randomUUID();
            cursors.set(cursor, { scan: next, expiresAt: now + cursorTtlMs });
            result.cursor = cursor;
        }
        return result;
    };
}
