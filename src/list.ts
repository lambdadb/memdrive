import { keysOnly } from './config.js';
import { checkAbort, databaseError, MemDriveError, nativeOptions, nativeRequest, operationOptions, requireInput } from './errors.js';
import { bytes, decodeFileEntry, resultDocs, validPath } from './records.js';
import { afterId, ancestorFilter, readRef, viewRead, type RefSource, type WithoutAt } from './storage-reads.js';
import type { ConnectionOptions, FileAt, FileListEntry, ListFilesRequest, ListFilesResult, MetadataSchema, RequestOptions } from './types.js';

type Handle = ReturnType<ConnectionOptions['client']['collection']>;
type Entry = FileListEntry | string;
type Scan = {
    owner: object;
    entries: Entry[];
    limit: number;
    bytes: number;
    expiresAt: number;
    lastIssuedOffset: number;
    /** Tells the owning store that this scan no longer needs it. */
    released: () => void;
};

const pageSize = 500;
const maxScanPages = 100;
const maxScanRows = 10_000;
const maxBytes = 8 * 1024 * 1024;
const ttlMs = 5 * 60 * 1000;
// One process-wide budget shared by every store and view. Insertion order is
// recency order: continuations move a scan to the end; the oldest is evicted.
const maxCachedBytes = 64 * 1024 * 1024;
const maxCachedScans = 128;
const scans = new Map<string, Scan>();
let cachedBytes = 0;
// One timer, armed for the earliest expiry, removes expired scans even when
// no later listing runs. A cached scan reaches its store through `released`,
// so nothing here may outlive its expiry.
let expiry: { at: number; timer: unknown } | undefined;

/** The only way a scan leaves the cache: expiry, eviction and release all end here. */
function drop(id: string) {
    const scan = scans.get(id);
    if (!scan) return;
    cachedBytes -= scan.bytes;
    scans.delete(id);
    scan.released();
}

/** Arm the timer for the earliest remaining expiry, or stop it when the cache is empty. */
function schedule() {
    let earliest = Infinity;
    for (const scan of scans.values()) if (scan.expiresAt < earliest) earliest = scan.expiresAt;
    if (expiry?.at === earliest) return;
    if (expiry) clearTimeout(expiry.timer as ReturnType<typeof setTimeout>);
    expiry = undefined;
    if (earliest === Infinity) return;
    const timer: unknown = setTimeout(() => {
        expiry = undefined;
        sweep(Date.now());
    }, Math.max(1, earliest - Date.now()));
    // Never keep a Node process alive for the cache. Browsers return a number.
    if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') timer.unref();
    expiry = { at: earliest, timer };
}

function sweep(now: number) {
    for (const [id, scan] of scans) if (now >= scan.expiresAt) drop(id);
    schedule();
}
const encoder = new TextEncoder();
const cursorPattern = /^([0-9a-f-]{36})\.([1-9][0-9]{0,4})$/;
const fields = { include: ['id', 'kind', 'fileId', 'path', 'modifiedAt', 'metadata'] };
const legalText = (value: unknown): value is string => typeof value === 'string'
    && !/[\p{Cc}\p{Surrogate}]/u.test(value) && encoder.encode(value).length <= 4096;
const exceeded = () => new MemDriveError('LIST_SCAN_LIMIT', 'Listing exceeded the preview scan budget. Narrow the directory prefix and start again.');
const cursorUnavailable = () => new MemDriveError('LIST_CURSOR_UNAVAILABLE', 'Listing cursor is unavailable. Start again without a cursor.');

export const validPathPrefix = (value: unknown): value is string =>
    legalText(value) && (value === '' || value.startsWith('/')) && !value.includes('\\');
export const prefixAncestor = (prefix: string) => prefix.slice(0, prefix.lastIndexOf('/') + 1);

/**
 * List one view. Its cursors live in the shared process-wide scan cache;
 * `released` runs whenever one of them leaves that cache.
 */
export function fileLister(handle: Handle, name: string, source: RefSource, schema: MetadataSchema, at: FileAt, released: () => void = () => {}) {
    const owner = {};
    const next = (cursor: string) => ({ at: { ...at }, cursor });
    const live = (id: string | undefined) => {
        const scan = id === undefined ? undefined : scans.get(id);
        return scan?.owner === owner && Date.now() < scan.expiresAt;
    };

    function page(entries: Entry[], offset: number, limit: number): ListFilesResult {
        const files: FileListEntry[] = [], prefixes: string[] = [];
        for (const entry of entries.slice(offset, offset + limit)) {
            if (typeof entry === 'string') prefixes.push(entry);
            else files.push(structuredClone(entry));
        }
        return { files, prefixes, consistency: 'eventual' };
    }

    /** Whether an unexpired cursor was issued by this view; never consumes it. */
    function owns(cursor: string) {
        return live(cursorPattern.exec(cursor)?.[1]);
    }

    /** Whether an unexpired cursor of this view is cached. */
    function holds() {
        const now = Date.now();
        for (const scan of scans.values()) if (scan.owner === owner && now < scan.expiresAt) return true;
        return false;
    }

    /** Drop this view's scans, for example after its ref is deleted. */
    function release() {
        for (const [id, scan] of scans) if (scan.owner === owner) drop(id);
        schedule();
    }

    async function list(request: WithoutAt<ListFilesRequest> = {}, options?: RequestOptions): Promise<ListFilesResult> {
        const { signal } = operationOptions(options);
        checkAbort(signal);
        requireInput(keysOnly(request, ['prefix', 'nameContains', 'delimiter', 'limit', 'cursor']), 'Invalid list options.');
        sweep(Date.now());
        if ('cursor' in request) {
            const cursor = request.cursor;
            requireInput(Object.keys(request).length === 1 && typeof cursor === 'string', 'Pass only cursor when continuing a listing.');
            const match = cursorPattern.exec(cursor);
            if (!match) throw cursorUnavailable();
            const id = match[1]!, offset = Number(match[2]);
            const scan = scans.get(id);
            if (!scan || scan.owner !== owner || offset >= scan.entries.length || offset % scan.limit !== 0 || offset > scan.lastIssuedOffset)
                throw cursorUnavailable();
            scans.delete(id);
            scans.set(id, scan);
            const result = page(scan.entries, offset, scan.limit);
            if (offset + scan.limit < scan.entries.length) {
                scan.lastIssuedOffset = Math.max(scan.lastIssuedOffset, offset + scan.limit);
                result.next = next(`${id}.${offset + scan.limit}`);
            }
            return result;
        }

        const { prefix = '', nameContains = '', delimiter, limit = 100 } = request;
        requireInput(validPathPrefix(prefix),
            'List prefix must be an absolute path prefix of at most 4096 UTF-8 bytes.');
        requireInput(legalText(nameContains), 'List filename substring must be text of at most 4096 UTF-8 bytes.');
        requireInput(delimiter === undefined || delimiter === '/', 'List delimiter must be "/".');
        requireInput(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1000, 'List limit must be 1–1000.');
        const ancestor = prefixAncestor(prefix);
        requireInput(ancestor.length <= 1 || validPath(ancestor.slice(0, -1)), 'List prefix contains an invalid directory component.');
        const clauses = [{ queryString: { query: '"file"', defaultField: 'kind' }, occur: 'filter' }];
        clauses.push(...ancestorFilter(ancestor));
        // Keep parser-sensitive text out of the native regex. The literal
        // comparison below applies to all inputs.
        if (/^[A-Za-z0-9 ]{1,128}$/.test(nameContains)) clauses.push({
            queryString: { query: `/.*${nameContains}.*/`, defaultField: 'fileName' }, occur: 'filter',
        });

        const entries = await readRef(source, async ref => {
            const published = 'read' in source;
            const result: Entry[] = [];
            let lastId: string | undefined;
            const ids = new Set<string>(), paths = new Set<string>(), groups = new Set<string>(), tokens = new Set<string>();
            let pageToken: string | undefined;
            let scannedRows = 0, projectedBytes = 0;
            for (let pageIndex = 0; ; pageIndex++) {
                if (pageIndex === maxScanPages) throw exceeded();
                let response;
                try {
                    response = await nativeRequest(async () => published
                        ? handle.query({ size: pageSize, fields, ...viewRead(ref), sort: [{ id: 'asc' }],
                            query: { bool: [...clauses, ...afterId(lastId)] } }, nativeOptions(signal))
                        : handle.docs.list({ size: pageSize, pageToken, fields, ref, includeVectors: false,
                            filter: { bool: clauses } }, nativeOptions(signal)), signal);
                } catch (error) {
                    throw databaseError(error, 'Could not list files.');
                }
                checkAbort(signal);
                const docs = resultDocs(response, name, pageSize);
                scannedRows += docs.length;
                if (scannedRows > maxScanRows) throw exceeded();
                for (const doc of docs) {
                    const file = decodeFileEntry(doc, schema);
                    if (published) {
                        const id = doc.id as string;
                        if (lastId !== undefined && id <= lastId)
                            throw new MemDriveError('INVALID_RESULT', 'Published listing returned an unordered file record.');
                        lastId = id;
                    }
                    if (!file.path.startsWith(prefix) || !file.path.slice(file.path.lastIndexOf('/') + 1).includes(nameContains)
                        || ids.has(file.fileId) || paths.has(file.path)) continue;
                    projectedBytes += bytes(file);
                    if (projectedBytes > maxBytes) throw exceeded();
                    ids.add(file.fileId);
                    paths.add(file.path);
                    // All drive paths start with '/'. At the root the delimiter
                    // groups by the first component, rather than grouping all files under '/'.
                    const nextSlash = delimiter === '/' ? file.path.indexOf('/', Math.max(1, prefix.length)) : -1;
                    const entry = nextSlash === -1 ? file : file.path.slice(0, nextSlash + 1);
                    if (typeof entry === 'string') {
                        if (groups.has(entry)) continue;
                        groups.add(entry);
                    }
                    result.push(entry);
                }

                if (published) {
                    if (response.isDocsInline !== true || response.total !== docs.length)
                        throw new MemDriveError('INVALID_RESULT', 'Published listing returned an incomplete file page.');
                    if (docs.length < pageSize) break;
                    continue;
                }
                const next: unknown = 'nextPageToken' in response ? response.nextPageToken : undefined;
                if (next === undefined) break;
                if (typeof next !== 'string' || !next.length || next.length > 16_384 || tokens.has(next))
                    throw new MemDriveError('INVALID_RESULT', 'Native listing did not make progress.');
                tokens.add(next);
                pageToken = next;
            }

            return result;
        }, signal);
        entries.sort((a, b) => {
            const x = typeof a === 'string' ? a : a.path, y = typeof b === 'string' ? b : b.path;
            return x < y ? -1 : x > y ? 1 : 0;
        });
        checkAbort(signal);
        const result = page(entries, 0, limit);
        if (entries.length > limit) {
            const id = globalThis.crypto.randomUUID();
            const retainedBytes = entries.reduce((total, entry) => total + bytes(entry), 0);
            sweep(Date.now());
            while (scans.size && (scans.size >= maxCachedScans || cachedBytes + retainedBytes > maxCachedBytes))
                drop(scans.keys().next().value!);
            scans.set(id, { owner, entries, limit, bytes: retainedBytes, expiresAt: Date.now() + ttlMs, lastIssuedOffset: limit, released });
            cachedBytes += retainedBytes;
            schedule();
            result.next = next(`${id}.${limit}`);
        }
        return result;
    }
    return { list, owns, holds, release };
}
