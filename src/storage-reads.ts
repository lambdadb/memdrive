import { checkAbort, databaseError, MemDriveError, nativeOptions, nativeRequest } from './errors.js';
import { originalId, resultDocs, validFileId, validPath } from './records.js';
import type { ConnectionOptions } from './types.js';

export type Handle = ReturnType<ConnectionOptions['client']['collection']>;

export type ViewRef = { kind: 'branch'; name: string } | { kind: 'tag'; name: string };
export const branchRef = (name: string) => ({ kind: 'branch' as const, name });

export function viewRead(ref: ViewRef) {
    return ref.kind === 'branch'
        ? { ref, consistentRead: true as const, includeVectors: false }
        : { ref, consistentRead: false as const, includeVectors: false };
}
export const branchRead = (branch: string) => viewRead(branchRef(branch));

const kindClause = { queryString: { query: '"file"', defaultField: 'kind' }, occur: 'filter' };
export function pathQuery(paths: string[], { literal = false } = {}) {
    const pathClause = (path: string) => ({ queryString: { defaultField: 'path',
        ...(literal ? { query: path, skipSyntax: true } : { query: JSON.stringify(path) }),
    } });
    return { bool: [
        kindClause,
        paths.length === 1 ? { ...pathClause(paths[0]!), occur: 'filter' }
            : { bool: paths.map(path => ({ ...pathClause(path), occur: 'should' })), occur: 'filter' },
    ] };
}

// Use only IDs already validated against the SDK's generated ASCII format.
export const afterId = (id: string | undefined) => id === undefined ? [] : [
    { queryString: { query: `{${id} TO *}`, defaultField: 'id' }, occur: 'filter' },
];

export async function fetchOriginals(handle: Handle, name: string, ref: ViewRef, fileIds: string[], signal?: AbortSignal) {
    if (!fileIds.length) return new Map<string, Record<string, unknown>>();
    let response;
    try {
        response = await nativeRequest(() => handle.docs.fetch({ ids: fileIds.map(originalId), ...viewRead(ref) }, nativeOptions(signal)), signal);
    } catch (cause) {
        throw databaseError(cause, 'Could not read file originals.');
    }
    checkAbort(signal);
    const originals = new Map<string, Record<string, unknown>>();
    const expected = new Set(fileIds);
    const docs = resultDocs(response, name, fileIds.length);
    if (response.isDocsInline !== true || response.total !== docs.length)
        throw new MemDriveError('INVALID_RESULT', 'Read did not confirm the original document count.');
    for (const doc of docs) {
        if (!validFileId(doc.fileId) || doc.id !== originalId(doc.fileId) || (doc.kind !== 'file' && doc.kind !== 'tombstone')
            || !validPath(doc.path) || !expected.has(doc.fileId) || originals.has(doc.fileId)
            || (doc.kind === 'tombstone' && (doc.changed !== true || !validFileId(doc.revision))))
            throw new MemDriveError('INVALID_RESULT', 'Read returned unexpected or duplicate file originals.');
        originals.set(doc.fileId, doc);
    }
    return originals;
}
