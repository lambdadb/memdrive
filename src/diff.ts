import { checkAbort, databaseError, MemDriveError, nativeOptions, nativeRequest } from './errors.js';
import { baselineOf, originalId, resultDocs, validFileId, validPath, type FileBaseline } from './records.js';
import { afterId, branchRef, viewRead, type Handle, type ViewRef } from './storage-reads.js';
import type { FileChange } from './types.js';

const pageSize = 1000;
const fields = { include: ['id', 'kind', 'fileId', 'path', 'changed', 'baseline', 'fingerprint', 'version'] };
const changedOriginals = [
    { bool: ['file', 'tombstone'].map(kind => ({
        queryString: { query: JSON.stringify(kind), defaultField: 'kind' }, occur: 'should',
    })), occur: 'filter' },
    { queryString: { query: 'true', defaultField: 'changed' }, occur: 'filter' },
];

type NetChange =
    | { change: Extract<FileChange, { op: 'create' }>; baseline?: undefined; fingerprint: string }
    | { change: Extract<FileChange, { op: 'update' }>; baseline: FileBaseline; fingerprint: string }
    | { change: Extract<FileChange, { op: 'delete' }>; baseline: FileBaseline; fingerprint?: undefined };

export function netChange(doc: Record<string, unknown>): NetChange | undefined {
    const { id, fileId, path, kind, fingerprint } = doc;
    if (!validFileId(fileId) || id !== originalId(fileId) || !validPath(path) || doc.changed !== true
        || (kind !== 'file' && kind !== 'tombstone'))
        throw new MemDriveError('INVALID_RESULT', 'Diff returned an unexpected file record.');
    const baseline = baselineOf(doc);
    if (doc.version !== undefined && (typeof doc.version !== 'string' || !doc.version || !baseline))
        throw new MemDriveError('INVALID_RESULT', 'Diff returned inconsistent file version tracking.');
    if (kind === 'tombstone')
        return baseline && { change: { op: 'delete', fileId, previousPath: baseline.path }, baseline };
    // Every write of a changed live original persists its fingerprint.
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint))
        throw new MemDriveError('INVALID_RESULT', 'Diff returned invalid file fingerprint data.');
    if (!baseline) return { change: { op: 'create', fileId, path }, fingerprint };
    if (fingerprint !== baseline.fingerprint)
        return { change: { op: 'update', fileId, path, ...(path === baseline.path ? {} : { previousPath: baseline.path }) }, baseline, fingerprint };
    if (path !== baseline.path)
        throw new MemDriveError('INVALID_RESULT', 'Diff returned a changed path with its unchanged baseline fingerprint.');
    return undefined;
}

export async function* changedFiles(handle: Handle, name: string, ref: ViewRef, signal?: AbortSignal) {
    let after: string | undefined;
    for (;;) {
        let response;
        try {
            response = await nativeRequest(() => handle.query({ ...viewRead(ref), fields, size: pageSize,
                sort: [{ id: 'asc' }], query: { bool: [...changedOriginals, ...afterId(after)] },
            }, nativeOptions(signal)), signal);
        } catch (cause) {
            throw databaseError(cause, 'Could not read changed file records.');
        }
        checkAbort(signal);
        const docs = resultDocs(response, name, pageSize);
        if (response.isDocsInline !== true || response.total !== docs.length)
            throw new MemDriveError('INVALID_RESULT', 'Diff returned an incomplete document page.');
        for (const doc of docs) {
            const { id } = doc;
            if (typeof id !== 'string' || (after !== undefined && id <= after))
                throw new MemDriveError('INVALID_RESULT', 'Diff returned an unordered file record.');
            const change = netChange(doc);
            after = id;
            if (change) yield change;
        }
        if (docs.length < pageSize) return;
    }
}

export async function diffFiles(handle: Handle, name: string, branch: string, signal?: AbortSignal): Promise<FileChange[]> {
    const changes: FileChange[] = [];
    for await (const { change } of changedFiles(handle, name, branchRef(branch), signal)) changes.push(change);
    return changes;
}
