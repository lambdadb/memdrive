import { checkAbort, databaseError, MemDriveError, nativeOptions, nativeRequest } from './errors.js';
import { baselineOf, originalId, resultDocs, validFileId, validPath } from './records.js';
import { afterId, branchRead, type Handle } from './storage-reads.js';
import type { FileChange } from './types.js';

const pageSize = 1000;
const fields = { include: ['id', 'kind', 'fileId', 'path', 'changed', 'baseline', 'fingerprint', 'version'] };
const changedOriginals = [
    { bool: ['file', 'tombstone'].map(kind => ({
        queryString: { query: JSON.stringify(kind), defaultField: 'kind' }, occur: 'should',
    })), occur: 'filter' },
    { queryString: { query: 'true', defaultField: 'changed' }, occur: 'filter' },
];

export async function diffFiles(handle: Handle, name: string, branch: string, signal?: AbortSignal): Promise<FileChange[]> {
    const changes: FileChange[] = [];
    let after: string | undefined;
    for (;;) {
        let response;
        try {
            response = await nativeRequest(() => handle.query({ ...branchRead(branch), fields, size: pageSize,
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
            const { id, fileId, path, kind, fingerprint } = doc;
            if (!validFileId(fileId) || id !== originalId(fileId) || !validPath(path) || doc.changed !== true
                || (kind !== 'file' && kind !== 'tombstone') || (after !== undefined && id <= after))
                throw new MemDriveError('INVALID_RESULT', 'Diff returned an unexpected or unordered file record.');
            after = id;
            const baseline = baselineOf(doc);
            if (doc.version !== undefined && (typeof doc.version !== 'string' || !doc.version || !baseline))
                throw new MemDriveError('INVALID_RESULT', 'Diff returned inconsistent file version tracking.');
            if (kind === 'tombstone') {
                if (baseline) changes.push({ op: 'delete', fileId, previousPath: baseline.path });
                continue;
            }
            // Files first created on a fork predate persisted fingerprints.
            if ((fingerprint !== undefined || baseline)
                && (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)))
                throw new MemDriveError('INVALID_RESULT', 'Diff returned invalid file fingerprint data.');
            if (!baseline) changes.push({ op: 'create', fileId, path });
            else if (fingerprint !== baseline.fingerprint) {
                changes.push({ op: 'update', fileId, path, ...(path === baseline.path ? {} : { previousPath: baseline.path }) });
            } else if (path !== baseline.path) {
                throw new MemDriveError('INVALID_RESULT', 'Diff returned a changed path with its unchanged baseline fingerprint.');
            }
        }
        if (docs.length < pageSize) return changes;
    }
}
