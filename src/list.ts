import { isObject, keysOnly } from './config.js';
import { checkAbort, databaseError, MemDriveError, nativeOptions, nativeRequest, operationOptions, requireInput } from './errors.js';
import { decodeFileEntry, originalId, resultDocs, validPath } from './records.js';
import { ancestorFilter, viewRead, type Handle, type ViewRef, type WithoutAt } from './storage-reads.js';
import { decodeToken, encodeToken } from './cursor-tokens.js';
import type { FileAt, FileListEntry, ListFilesRequest, ListFilesResult, MetadataSchema, RequestOptions } from './types.js';

type Criteria = { prefix: string; nameContains: string; delimiter?: '/' | undefined; limit: number };
/** The last returned entry: a file's path and original ID, or a folder prefix without an ID. */
type Position = { key: string; id?: string | undefined };
type Entry = { key: string; id?: string; file?: FileListEntry };

/**
 * The most file records one listing can match. One native query returns every
 * match up to this size; more fail with LIST_TOO_MANY_FILES instead of a cut.
 */
export const listMaximum = 1000;
const encoder = new TextEncoder();
const token = 'l2';
const fields = { include: ['id', 'kind', 'fileId', 'path', 'modifiedAt', 'metadata'] };
const originalPattern = /^file:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const legalText = (value: unknown): value is string => typeof value === 'string'
    && !/[\p{Cc}\p{Surrogate}]/u.test(value) && encoder.encode(value).length <= 4096;
const cursorUnavailable = (cause?: unknown) => new MemDriveError('LIST_CURSOR_UNAVAILABLE',
    'Listing cursor is malformed or belongs to another store. Start again without a cursor.', { cause });

export const validPathPrefix = (value: unknown): value is string =>
    legalText(value) && (value === '' || value.startsWith('/')) && !value.includes('\\');
export const prefixAncestor = (prefix: string) => prefix.slice(0, prefix.lastIndexOf('/') + 1);
export const sameAt = (a: FileAt, b: FileAt) => a.kind === b.kind && (a.kind === 'main' || a.name === (b as { name: string }).name);
export const validAt = (value: unknown): value is FileAt => isObject(value) && (value.kind === 'main' ? keysOnly(value, ['kind'])
    : (value.kind === 'fork' || value.kind === 'checkpoint') && keysOnly(value, ['kind', 'name']) && typeof value.name === 'string');

// UTF-16 units in Unicode code point order: surrogates (code points above U+FFFF) sort after U+E000–U+FFFF.
const unit = (code: number) => code >= 0xd800 && code <= 0xdfff ? code + 0x2000 : code >= 0xe000 ? code - 0x800 : code;
/** Compare well-formed strings by Unicode code point, the order LambdaDB sorts keyword values in. */
export function codePointOrder(a: string, b: string) {
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index++) {
        const x = a.charCodeAt(index), y = b.charCodeAt(index);
        if (x !== y) return unit(x) - unit(y);
    }
    return a.length - b.length;
}

function validate({ prefix, nameContains, delimiter, limit }: Criteria) {
    requireInput(validPathPrefix(prefix), 'List prefix must be an absolute path prefix of at most 4096 UTF-8 bytes.');
    requireInput(legalText(nameContains), 'List filename substring must be text of at most 4096 UTF-8 bytes.');
    requireInput(delimiter === undefined || delimiter === '/', 'List delimiter must be "/".');
    requireInput(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000, 'List limit must be 1–1000.');
    const ancestor = prefixAncestor(prefix);
    requireInput(ancestor.length <= 1 || validPath(ancestor.slice(0, -1)), 'List prefix contains an invalid directory component.');
}

/** Whether an entry comes after the position. Equal keys are the same folder, or files that share a path. */
function after(entry: Entry, position: Position) {
    const order = codePointOrder(entry.key, position.key);
    if (order !== 0) return order > 0;
    return entry.id !== undefined && position.id !== undefined && entry.id > position.id;
}

/** The number of file records the query matched, from its `kind` facet. */
function matchedCount(response: unknown) {
    const buckets: unknown = isObject(response) && isObject(response.facets) && isObject(response.facets.kind)
        ? response.facets.kind.buckets : undefined;
    if (!Array.isArray(buckets) || buckets.length > 1) return undefined;
    if (!buckets.length) return 0;
    const [bucket] = buckets as unknown[];
    return isObject(bucket) && bucket.value === 'file' && Number.isSafeInteger(bucket.count) && (bucket.count as number) > 0
        ? bucket.count as number : undefined;
}

/**
 * List one view in path order. Each call is one native query that returns every
 * matching file record, up to `listMaximum`, with consistent reads on branches.
 * The cursor carries the criteria and the last returned position, so it continues
 * on any drive object of the same store and the SDK keeps nothing between calls.
 */
export function fileLister(handle: Handle, name: string, schema: MetadataSchema, store: string) {
    return async function list(at: FileAt, ref: ViewRef, request: WithoutAt<ListFilesRequest> = {}, options?: RequestOptions): Promise<ListFilesResult> {
        const { signal } = operationOptions(options);
        checkAbort(signal);
        requireInput(keysOnly(request, ['prefix', 'nameContains', 'delimiter', 'limit', 'cursor']), 'Invalid list options.');
        let criteria: Criteria;
        let position: Position | undefined;
        if ('cursor' in request) {
            requireInput(Object.keys(request).length === 1 && typeof request.cursor === 'string', 'Pass only cursor when continuing a listing.');
            const value = decodeToken(token, request.cursor);
            if (!value || !keysOnly(value, ['d', 'a', 'p', 'n', 'dl', 'l', 'k', 'i']) || value.d !== store || !validAt(value.a))
                throw cursorUnavailable();
            if (!sameAt(value.a, at))
                throw new MemDriveError('CURSOR_VIEW_MISMATCH', 'This cursor belongs to another view. Forward the returned next request unchanged, including its at.');
            criteria = { prefix: value.p as string, nameContains: value.n as string, limit: value.l as number,
                ...(value.dl === undefined ? {} : { delimiter: value.dl as '/' }) };
            try { validate(criteria); }
            catch (cause) { throw cursorUnavailable(cause); }
            // A file position has a path and an original ID; a folder position, only with a delimiter, ends in '/'.
            const { k: key, i: id } = value;
            if (id === undefined ? criteria.delimiter === undefined || typeof key !== 'string' || !key.endsWith('/') || !validPath(key.slice(0, -1))
                : typeof id !== 'string' || !originalPattern.test(id) || !validPath(key)) throw cursorUnavailable();
            position = { key: key as string, ...(id === undefined ? {} : { id: id as string }) };
        } else {
            const { prefix = '', nameContains = '', delimiter, limit = 100 } = request;
            criteria = { prefix, nameContains, limit, ...(delimiter === undefined ? {} : { delimiter }) };
            validate(criteria);
        }
        const { prefix, nameContains, delimiter, limit } = criteria;
        const clauses = [{ queryString: { query: '"file"', defaultField: 'kind' }, occur: 'filter' },
            ...ancestorFilter(prefixAncestor(prefix))];
        // Keep parser-sensitive text out of the native regex. The literal
        // comparison below applies to all inputs.
        if (/^[A-Za-z0-9 ]{1,128}$/.test(nameContains)) clauses.push({
            queryString: { query: `/.*${nameContains}.*/`, defaultField: 'fileName' }, occur: 'filter',
        });
        let response;
        try {
            // Every file record has kind "file", so the one kind bucket counts all matches exactly.
            response = await nativeRequest(() => handle.query({ ...viewRead(ref), size: listMaximum,
                sort: [{ path: 'asc' }, { id: 'asc' }], fields, query: { bool: clauses }, facets: { kind: { size: 1 } } },
            nativeOptions(signal)), signal);
        } catch (cause) {
            throw databaseError(cause, 'Could not list files.');
        }
        checkAbort(signal);
        const docs = resultDocs(response, name, listMaximum);
        const matched = matchedCount(response);
        if (response.isDocsInline !== true || response.total !== docs.length || matched === undefined)
            throw new MemDriveError('INVALID_RESULT', 'Listing returned an incomplete or uncounted result.');
        if (matched > listMaximum)
            throw new MemDriveError('LIST_TOO_MANY_FILES', `More than ${listMaximum} files match this listing. Narrow it with a longer prefix or nameContains, or use search to find content.`,
                { details: { maximum: listMaximum } });
        if (matched !== docs.length) throw new MemDriveError('INVALID_RESULT', 'Listing did not return every matching file.');

        const files: (FileListEntry & { id: string })[] = [];
        const seen = new Set<string>();
        for (const doc of docs) {
            const file = decodeFileEntry(doc, schema);
            if (seen.has(file.fileId)) throw new MemDriveError('INVALID_RESULT', 'Listing returned a duplicate file.');
            seen.add(file.fileId);
            if (file.path.startsWith(prefix) && file.path.slice(file.path.lastIndexOf('/') + 1).includes(nameContains))
                files.push({ ...file, id: originalId(file.fileId) });
        }
        // The query returned every match, so order them here with LambdaDB's keyword order.
        files.sort((a, b) => codePointOrder(a.path, b.path) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        // One path-ordered sequence. A folder takes the place of its first file: every
        // path between a folder prefix and its first file starts with that prefix.
        const entries: Entry[] = [];
        for (const { id, ...file } of files) {
            // All drive paths start with '/'. At the root the delimiter groups
            // by the first component, rather than grouping all files under '/'.
            const nextSlash = delimiter === '/' ? file.path.indexOf('/', Math.max(1, prefix.length)) : -1;
            if (nextSlash === -1) entries.push({ key: file.path, id, file });
            else {
                const folder = file.path.slice(0, nextSlash + 1);
                if (entries.at(-1)?.key !== folder) entries.push({ key: folder });
            }
        }
        const remaining = position === undefined ? entries : entries.filter(entry => after(entry, position));
        const page = remaining.slice(0, limit);
        const result: ListFilesResult = { files: page.flatMap(entry => entry.file ? [entry.file] : []),
            prefixes: page.flatMap(entry => entry.file ? [] : [entry.key]) };
        const last = page.at(-1);
        if (last && remaining.length > limit) {
            result.next = { at: { ...at }, cursor: encodeToken(token, { d: store, a: at, p: prefix, n: nameContains,
                ...(delimiter === undefined ? {} : { dl: delimiter }), l: limit, k: last.key, ...(last.id === undefined ? {} : { i: last.id }) }) };
        }
        return result;
    };
}
