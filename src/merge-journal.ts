import { keysOnly } from './config.js';
import { checkAbort, databaseError, MemDriveError, mutationOptions, nativeOptions, nativeRequest, requireInput } from './errors.js';
import { captureMergeSource, confirmedMergeSource, type MergeSource } from './merge-preflight.js';
import { contentHash, resultDocs, validFileId, validText } from './records.js';
import { branchRead, type Handle } from './storage-reads.js';
import type { workingWriter } from './writes.js';

type CaptureRequest = { requestId: string; branch: string; summary: string };
type Binding = CaptureRequest & { id: string; driveId: string; kind: 'merge-capture-v1'; fingerprint: string; tag: string };

const capturePrefix = 'merge-capture-';
const captureKind = 'merge-capture-v1';
const validRequestId = (id: unknown): id is string => validText(id) && id.length > 0 && id.length <= 128;
const validBranch = (branch: unknown): branch is string => typeof branch === 'string' && /^fork-[A-Za-z0-9_-]{3,47}$/.test(branch);
const validSummary = (summary: unknown): summary is string => validText(summary) && summary.trim().length > 0 && summary.length <= 1024;
const fingerprintOf = (branch: string, summary: string) => contentHash(JSON.stringify([branch, summary]));

function sameBinding(found: Binding | undefined, expected: Binding): boolean {
    return found?.tag === expected.tag && found.requestId === expected.requestId
        && found.branch === expected.branch && found.summary === expected.summary && found.fingerprint === expected.fingerprint;
}

async function readBinding(handle: Handle, collection: string, driveId: string, id: string, signal?: AbortSignal): Promise<Binding | undefined> {
    let response;
    try {
        response = await nativeRequest(() => handle.docs.fetch({ ids: [id], ...branchRead('main') }, nativeOptions(signal)), signal);
    } catch (cause) {
        throw databaseError(cause, 'Could not read the merge capture binding.');
    }
    checkAbort(signal);
    const docs = resultDocs(response, collection, 1);
    if (response.isDocsInline !== true || response.total !== docs.length)
        throw new MemDriveError('INVALID_RESULT', 'Read did not confirm the merge capture binding count.');
    const doc = docs[0];
    if (!doc) return undefined;
    const { kind, requestId, branch, summary, fingerprint, tag } = doc;
    if (doc.id !== id || kind !== captureKind || doc.driveId !== driveId || !validRequestId(requestId)
        || !validBranch(branch) || !validSummary(summary) || fingerprint !== await fingerprintOf(branch, summary)
        || typeof tag !== 'string' || !tag.startsWith(capturePrefix) || !validFileId(tag.slice(capturePrefix.length)))
        throw new MemDriveError('INVALID_RESULT', 'Read returned an invalid merge capture binding.');
    return { id, kind, driveId, requestId, branch, summary, fingerprint, tag };
}

/**
 * Create one journal per drive under the host's exclusive writer ownership.
 * Supply its dedicated internal collection and the source fork's writer queue.
 * Takeover must fence and drain previous owners' writes to both collections.
 * The drive ID identifies this content generation across restarts. The owner
 * must reserve the capture namespace, retain bound tags and avoid reusing
 * source branch names while their requests are retained.
 */
export function mergeCaptureJournal(content: Handle, internal: Handle, collection: { name: string; driveId: string }) {
    const { name, driveId } = collection;
    requireInput(internal.collectionName === name && content.collectionName !== name
        && /^[A-Za-z0-9_-]{3,52}$/.test(name) && validRequestId(driveId),
        'Provide a dedicated internal collection and a stable drive ID.');
    const pending = new Map<string, Binding>();
    let tail = Promise.resolve();

    return function capture(request: CaptureRequest, enqueueSource: ReturnType<typeof workingWriter>['enqueueCapture'], signal?: AbortSignal): Promise<MergeSource> {
        checkAbort(signal);
        requireInput(keysOnly(request, ['requestId', 'branch', 'summary']) && validRequestId(request.requestId)
            && validBranch(request.branch) && validSummary(request.summary), 'Provide a merge request ID, working branch and summary.');
        const { requestId, branch, summary } = request;
        return enqueueSource((sourceBranch, confirmSource) => {
            requireInput(sourceBranch === branch, 'Provide the writer queue for the requested branch.');
            // The source queue orders capture against writes to its fork. This
            // queue serializes equal IDs across all forks of the drive.
            const result = tail.then(async () => {
                const id = `${captureKind}:${await contentHash(requestId)}`;
                const unconfirmed = (cause?: unknown) => new MemDriveError('MERGE_CAPTURE_UNCONFIRMED',
                    'Could not confirm the merge capture record. Retry the same request.', { cause, details: { requestId } });
                const uncertain = pending.get(id);
                const existing = await readBinding(internal, name, driveId, id, signal);
                if (existing && uncertain && !sameBinding(existing, uncertain)) throw unconfirmed();
                const bound = existing ?? uncertain;
                if (bound && (bound.requestId !== requestId || bound.branch !== branch || bound.summary !== summary))
                    throw new MemDriveError('MERGE_REQUEST_CONFLICT', 'The merge request ID is already bound to different input.', { details: { requestId } });
                if (existing) {
                    pending.delete(id);
                    return confirmedMergeSource(content, existing.tag);
                }

                let binding = uncertain;
                if (!binding) {
                    await confirmSource();
                    const tag = capturePrefix + globalThis.crypto.randomUUID();
                    const fingerprint = await fingerprintOf(branch, summary);
                    await captureMergeSource(content, { kind: 'branch', name: branch }, tag,
                        operation => operation(), new Set(), signal);
                    binding = { id, kind: captureKind, driveId, requestId, branch, summary, fingerprint, tag };
                }
                checkAbort(signal);
                // A previous submission can arrive after a missing read. Only
                // re-submit the same record under the same ID in that case.
                pending.set(id, binding);
                let cause: unknown;
                try {
                    await internal.docs.upsert({ branch: 'main', docs: [binding] }, mutationOptions(signal));
                } catch (error) {
                    cause = error;
                }
                let confirmed;
                try {
                    confirmed = await readBinding(internal, name, driveId, id, signal);
                } catch (error) {
                    throw unconfirmed(cause ?? error);
                }
                if (!sameBinding(confirmed, binding)) throw unconfirmed(cause);
                pending.delete(id);
                return confirmedMergeSource(content, binding.tag);
            });
            tail = result.then(() => undefined, () => undefined);
            return result;
        }, signal);
    };
}
