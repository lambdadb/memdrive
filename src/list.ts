import { isObject, keysOnly } from './config.js';
import { checkAbort, databaseError, MemDriveError, nativeOptions, nativeRequest, operationOptions, requireInput } from './errors.js';
import { decodeFileEntry, originalId, resultDocs, validPath } from './records.js';
import { ancestorFilter, viewRead, type Handle, type ViewRef, type WithoutAt } from './storage-reads.js';
import { decodeToken, encodeToken } from './cursor-tokens.js';
import type { FileAt, ListFilesRequest, ListFilesResult, MetadataSchema, RequestOptions } from './types.js';

type Criteria = { prefix: string; nameContains: string; delimiter?: '/' | undefined; limit: number };
/** The last returned entry: a file's path and original ID, or a folder prefix without an ID. */
type Position = { key: string; id?: string | undefined };
const encoder = new TextEncoder();
const token = 'l2';
const fields = { include: ['id', 'kind', 'fileId', 'path', 'modifiedAt', 'metadata'] };
// Bound the optional cursor hint by LambdaDB's accepted page-token length.
const maximumAnchorLength = 144 * 1024;
const validNativeToken = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
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
function after(entry: Position, position: Position) {
    const order = codePointOrder(entry.key, position.key);
    if (order !== 0) return order > 0;
    return entry.id !== undefined && position.id !== undefined && entry.id > position.id;
}

/**
 * List one view in path order. The cursor carries the criteria and the last
 * returned position, so it continues on any drive object of the same store. A
 * native page token is an optional starting point that skips already read files.
 */
export function fileLister(handle: Handle, name: string, schema: MetadataSchema, store: string) {
    return async function list(at: FileAt, ref: ViewRef, request: WithoutAt<ListFilesRequest> = {}, options?: RequestOptions): Promise<ListFilesResult> {
        const { signal } = operationOptions(options);
        checkAbort(signal);
        requireInput(keysOnly(request, ['prefix', 'nameContains', 'delimiter', 'limit', 'cursor']), 'Invalid list options.');
        let criteria: Criteria;
        let position: Position | undefined;
        let pageToken: string | undefined;
        if ('cursor' in request) {
            requireInput(Object.keys(request).length === 1 && typeof request.cursor === 'string', 'Pass only cursor when continuing a listing.');
            const value = decodeToken(token, request.cursor);
            if (!value || !keysOnly(value, ['d', 'a', 'p', 'n', 'dl', 'l', 'k', 'i', 't']) || value.d !== store || !validAt(value.a))
                throw cursorUnavailable();
            if (!sameAt(value.a, at))
                throw new MemDriveError('CURSOR_VIEW_MISMATCH', 'This cursor belongs to another view. Forward the returned next request unchanged, including its at.');
            criteria = { prefix: value.p as string, nameContains: value.n as string, limit: value.l as number,
                ...(value.dl === undefined ? {} : { delimiter: value.dl as '/' }) };
            try { validate(criteria); }
            catch (cause) { throw cursorUnavailable(cause); }
            // A file position has a path and an original ID; a folder position, only with a delimiter, ends in '/'.
            const { k: key, i: id, t: anchor } = value;
            if (anchor !== undefined && (!validNativeToken(anchor) || anchor.length > maximumAnchorLength)) throw cursorUnavailable();
            pageToken = anchor;
            if (id === undefined ? criteria.delimiter === undefined || typeof key !== 'string' || !key.endsWith('/') || !validPath(key.slice(0, -1))
                : typeof id !== 'string' || !originalPattern.test(id) || !validPath(key)) throw cursorUnavailable();
            position = { key: key as string, ...(id === undefined ? {} : { id: id as string }) };
        } else {
            const { prefix = '', nameContains = '', delimiter, limit = 100 } = request;
            criteria = { prefix, nameContains, limit, ...(delimiter === undefined ? {} : { delimiter }) };
            validate(criteria);
        }
        const { prefix, nameContains, delimiter, limit } = criteria;
        const ancestor = prefixAncestor(prefix);
        const clauses = [{ queryString: { query: '"file"', defaultField: 'kind' }, occur: 'filter' }, ...ancestorFilter(ancestor)];
        // The longest run of letters, digits and spaces narrows the native match;
        // parser-sensitive text stays out of the regex, and the literal comparison
        // below applies the whole substring.
        const run = (nameContains.match(/[A-Za-z0-9 ]+/g) ?? []).reduce((longest, part) => part.length > longest.length ? part : longest, '').slice(0, 128);
        if (run) clauses.push({ queryString: { query: `/.*${run}.*/`, defaultField: 'fileName' }, occur: 'filter' });
        // The delimiter and local filters can consume several originals per entry.
        const minimumSize = delimiter || nameContains || prefix !== ancestor ? 100 : 1;
        const scope = { ...viewRead(ref), size: Math.min(1000, Math.max(limit + 1, minimumSize)),
            sort: [{ path: 'asc' as const }], fields, filter: { bool: clauses } };
        const result: ListFilesResult = { files: [], prefixes: [] };
        const emittedFiles = new Set<string>();
        let previous: Position | undefined;
        let last: Position | undefined;
        let anchor: string | undefined;
        // An anchor on an incoming cursor is advisory. A rejected token can be
        // bypassed from the same exact public position, including after upgrades.
        let resume = pageToken !== undefined;
        for (;;) {
            let response;
            try {
                response = await nativeRequest(() => handle.docs.list({ ...scope, ...(pageToken === undefined ? {} : { pageToken }) },
                    nativeOptions(signal)), signal);
            } catch (cause) {
                const error = databaseError(cause, 'Could not list files.');
                if (!resume || error.status !== 400) throw error;
                resume = false;
                pageToken = undefined;
                continue;
            }
            resume = false;
            checkAbort(signal);
            const docs = resultDocs(response, name, scope.size);
            const next: unknown = response.nextPageToken;
            if (response.isDocsInline !== true || response.total !== docs.length)
                throw new MemDriveError('INVALID_RESULT', 'Listing returned an incomplete document page.');
            if (next !== undefined && (!validNativeToken(next) || next === pageToken || !docs.length))
                throw new MemDriveError('INVALID_RESULT', 'Native file listing did not make progress.');

            const seen = new Set<string>();
            const files = docs.map(doc => {
                const file = decodeFileEntry(doc, schema);
                const rank = { key: file.path, id: originalId(file.fileId) };
                if (seen.has(rank.id) || (previous && !after(rank, previous)))
                    throw new MemDriveError('INVALID_RESULT', 'Listing returned duplicate or unordered files.');
                seen.add(rank.id);
                previous = rank;
                return file;
            });
            for (const file of files) {
                if (!file.path.startsWith(prefix)) {
                    // Once past the exact prefix, no later sorted path can match.
                    if (codePointOrder(file.path, prefix) > 0) return result;
                    continue;
                }
                if (!file.path.slice(file.path.lastIndexOf('/') + 1).includes(nameContains)) continue;
                // All paths start with '/'; at the root group by the first component.
                const slash = delimiter === '/' ? file.path.indexOf('/', Math.max(1, prefix.length)) : -1;
                const entry: Position = slash === -1 ? { key: file.path, id: originalId(file.fileId) }
                    : { key: file.path.slice(0, slash + 1) };
                if ((position && !after(entry, position)) || (entry.id === undefined ? entry.key === last?.key : emittedFiles.has(entry.id))) continue;
                if (last && result.files.length + result.prefixes.length === limit) {
                    // A token after the lookahead could hide insertions between the
                    // last returned entry and the lookahead. Resume before the lookahead.
                    result.next = { at: { ...at }, cursor: encodeToken(token, { d: store, a: at, p: prefix, n: nameContains,
                        ...(delimiter === undefined ? {} : { dl: delimiter }), l: limit, k: last.key,
                        ...(last.id === undefined ? {} : { i: last.id }),
                        ...(anchor === undefined || anchor.length > maximumAnchorLength ? {} : { t: anchor }) }) };
                    return result;
                }
                if (entry.id === undefined) result.prefixes.push(entry.key);
                else {
                    // A move between native reads can expose one file at both paths.
                    emittedFiles.add(entry.id);
                    result.files.push(file);
                }
                last = entry;
                anchor = pageToken;
            }
            if (next === undefined) return result;
            // Advance the anchor when this native page ends at the last visible
            // file or inside its folder. No new visible entries can fall in between.
            if (last && previous && (last.id === undefined ? previous.key.startsWith(last.key)
                : previous.key === last.key && previous.id === last.id)) anchor = next;
            pageToken = next;
        }
    };
}
