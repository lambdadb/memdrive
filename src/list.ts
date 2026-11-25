import { isObject, keysOnly } from './config.js';
import { checkAbort, databaseError, MemDriveError, nativeOptions, nativeRequest, operationOptions, requireInput } from './errors.js';
import { decodeFileEntry, resultDocs, validPath } from './records.js';
import { ancestorFilter, type Handle, type ViewRef, type WithoutAt } from './storage-reads.js';
import { decodeToken, encodeToken } from './cursor-tokens.js';
import type { FileAt, FileListEntry, ListFilesRequest, ListFilesResult, MetadataSchema, RequestOptions } from './types.js';

type Criteria = { prefix: string; nameContains: string; delimiter?: '/' | undefined; limit: number };

const encoder = new TextEncoder();
const token = 'l1';
const fields = { include: ['id', 'kind', 'fileId', 'path', 'modifiedAt', 'metadata'] };
const legalText = (value: unknown): value is string => typeof value === 'string'
    && !/[\p{Cc}\p{Surrogate}]/u.test(value) && encoder.encode(value).length <= 4096;
const validPageToken = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 16_384;
const cursorUnavailable = () => new MemDriveError('LIST_CURSOR_UNAVAILABLE',
    'Listing cursor is malformed or belongs to another store. Start again without a cursor.');

export const validPathPrefix = (value: unknown): value is string =>
    legalText(value) && (value === '' || value.startsWith('/')) && !value.includes('\\');
export const prefixAncestor = (prefix: string) => prefix.slice(0, prefix.lastIndexOf('/') + 1);
export const sameAt = (a: FileAt, b: FileAt) => a.kind === b.kind && (a.kind === 'main' || a.name === (b as { name: string }).name);
export const validAt = (value: unknown): value is FileAt => isObject(value) && (value.kind === 'main' ? keysOnly(value, ['kind'])
    : (value.kind === 'fork' || value.kind === 'checkpoint') && keysOnly(value, ['kind', 'name']) && typeof value.name === 'string');

function validate({ prefix, nameContains, delimiter, limit }: Criteria) {
    requireInput(validPathPrefix(prefix), 'List prefix must be an absolute path prefix of at most 4096 UTF-8 bytes.');
    requireInput(legalText(nameContains), 'List filename substring must be text of at most 4096 UTF-8 bytes.');
    requireInput(delimiter === undefined || delimiter === '/', 'List delimiter must be "/".');
    requireInput(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000, 'List limit must be 1–1000.');
    const ancestor = prefixAncestor(prefix);
    requireInput(ancestor.length <= 1 || validPath(ancestor.slice(0, -1)), 'List prefix contains an invalid directory component.');
}

/**
 * List one view, one native page per call. The cursor carries the criteria and
 * the native page token, so it continues on any drive object of the same store
 * and the SDK keeps nothing between calls.
 */
export function fileLister(handle: Handle, name: string, schema: MetadataSchema, store: string) {
    return async function list(at: FileAt, ref: ViewRef, request: WithoutAt<ListFilesRequest> = {}, options?: RequestOptions): Promise<ListFilesResult> {
        const { signal } = operationOptions(options);
        checkAbort(signal);
        requireInput(keysOnly(request, ['prefix', 'nameContains', 'delimiter', 'limit', 'cursor']), 'Invalid list options.');
        let criteria: Criteria;
        let pageToken: string | undefined;
        if ('cursor' in request) {
            requireInput(Object.keys(request).length === 1 && typeof request.cursor === 'string', 'Pass only cursor when continuing a listing.');
            const value = decodeToken(token, request.cursor);
            if (!value || !keysOnly(value, ['d', 'a', 'p', 'n', 'dl', 'l', 't']) || value.d !== store || !validAt(value.a)
                || !validPageToken(value.t)) throw cursorUnavailable();
            if (!sameAt(value.a, at))
                throw new MemDriveError('CURSOR_VIEW_MISMATCH', 'This cursor belongs to another view. Forward the returned next request unchanged, including its at.');
            criteria = { prefix: value.p as string, nameContains: value.n as string, limit: value.l as number,
                ...(value.dl === undefined ? {} : { delimiter: value.dl as '/' }) };
            try { validate(criteria); }
            catch (cause) { throw new MemDriveError('LIST_CURSOR_UNAVAILABLE', cursorUnavailable().message, { cause }); }
            pageToken = value.t;
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
            response = await nativeRequest(() => handle.docs.list({ size: limit, ...(pageToken === undefined ? {} : { pageToken }),
                fields, ref, includeVectors: false, filter: { bool: clauses } }, nativeOptions(signal)), signal);
        } catch (cause) {
            throw databaseError(cause, 'Could not list files.');
        }
        checkAbort(signal);
        const files: FileListEntry[] = [], prefixes: string[] = [];
        for (const doc of resultDocs(response, name, limit)) {
            const file = decodeFileEntry(doc, schema);
            if (!file.path.startsWith(prefix) || !file.path.slice(file.path.lastIndexOf('/') + 1).includes(nameContains)) continue;
            // All drive paths start with '/'. At the root the delimiter groups
            // by the first component, rather than grouping all files under '/'.
            const nextSlash = delimiter === '/' ? file.path.indexOf('/', Math.max(1, prefix.length)) : -1;
            if (nextSlash === -1) files.push(file);
            else {
                const group = file.path.slice(0, nextSlash + 1);
                if (!prefixes.includes(group)) prefixes.push(group);
            }
        }
        const result: ListFilesResult = { files, prefixes, consistency: 'eventual' };
        const next: unknown = 'nextPageToken' in response ? response.nextPageToken : undefined;
        if (next !== undefined) {
            if (!validPageToken(next) || next === pageToken)
                throw new MemDriveError('INVALID_RESULT', 'Native listing did not make progress.');
            result.next = { at: { ...at }, cursor: encodeToken(token, { d: store, a: at, p: prefix, n: nameContains,
                ...(delimiter === undefined ? {} : { dl: delimiter }), l: limit, t: next }) };
        }
        return result;
    };
}
