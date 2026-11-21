import { changedFiles, netChange } from './diff.js';
import { checkAbort, databaseError, MemDriveError, mutationOptions, nativeOptions, nativeRequest } from './errors.js';
import { decodeFile, fingerprintOf, originalId, resultDocs, validFileId } from './records.js';
import { createRef } from './refs.js';
import { fetchOriginals, pathQuery, viewRead, type Handle, type ViewRef } from './storage-reads.js';
import type { MetadataSchema } from './types.js';

type TagRef = Extract<ViewRef, { kind: 'tag' }>;
type BranchRef = Extract<ViewRef, { kind: 'branch' }>;
export type SourceQueue = <T>(operation: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
type Candidate = NonNullable<ReturnType<typeof netChange>>;
const confirmedCapture = Symbol('confirmed merge capture');
export type MergeSource = Readonly<TagRef & { [confirmedCapture]: string }>;

// A durable caller can reconstruct the capability only after verifying the
// operation's binding to a previously confirmed, retained capture.
export function confirmedMergeSource(handle: Handle, name: string): MergeSource {
    return Object.freeze({ kind: 'tag', name, [confirmedCapture]: handle.collectionName });
}

// Keep batches of full originals smaller than projected queries. The native
// client can hydrate larger responses from its download URL.
const originalBatchSize = 16;
const destinationBatchSize = 100;

/** Use the working writer's enqueueRef and an operation-owned, retained tag name. */
export function captureMergeSource(handle: Handle, source: BranchRef, tagName: string, enqueueRef: SourceQueue,
    pendingRefs: Set<string>, signal?: AbortSignal): Promise<MergeSource> {
    const branch: BranchRef = { kind: 'branch', name: source.name };
    return enqueueRef(async () => {
        await createRef(pendingRefs, { kind: 'merge source', name: tagName }, signal,
            () => handle.tags.create({ tagName, source: branch }, mutationOptions(signal)),
            response => response?.tag?.name === tagName);
        return confirmedMergeSource(handle, tagName);
    }, signal);
}

async function loadTargets(handle: Handle, name: string, source: TagRef, schema: MetadataSchema, signal?: AbortSignal) {
    const candidates: Candidate[] = [];
    for await (const candidate of changedFiles(handle, name, source, signal)) candidates.push(candidate);

    const targets = [];
    for (let start = 0; start < candidates.length; start += originalBatchSize) {
        const batch = candidates.slice(start, start + originalBatchSize);
        const originals = await fetchOriginals(handle, name, source, batch.map(({ change }) => change.fileId), signal);
        for (const candidate of batch) {
            const doc = originals.get(candidate.change.fileId);
            if (!doc || JSON.stringify(netChange(doc)) !== JSON.stringify(candidate))
                throw new MemDriveError('INVALID_RESULT', 'The pinned source original disagrees with its change summary.');
            const { revision, generation } = doc;
            if ((revision !== undefined && !validFileId(revision)) || (generation !== undefined && !validFileId(generation)))
                throw new MemDriveError('INVALID_RESULT', 'The pinned source original has invalid file tracking.');
            const file = candidate.change.op === 'delete' ? undefined : decodeFile(doc, schema);
            if (file && candidate.fingerprint !== undefined && await fingerprintOf(file) !== candidate.fingerprint)
                throw new MemDriveError('INVALID_RESULT', 'The pinned source original disagrees with its fingerprint.');
            targets.push({ ...candidate, file, revision, generation });
        }
    }
    return targets;
}

/**
 * Resolve publishedMain in the main publication queue and keep ownership
 * through application. For restart recovery, consume the
 * confirmed source returned by the durable capture journal.
 */
export async function prepareMerge(handle: Handle, name: string, capture: MergeSource, publishedMain: TagRef,
    schema: MetadataSchema, signal?: AbortSignal) {
    if (capture[confirmedCapture] !== name || handle.collectionName !== name || publishedMain.kind !== 'tag')
        throw new MemDriveError('INVALID_INPUT', 'Preparing a merge requires a confirmed source capture and the published main tag.');
    const source: TagRef = { kind: 'tag', name: capture.name };
    const main: TagRef = { kind: 'tag', name: publishedMain.name };
    const targets = await loadTargets(handle, name, source, schema, signal);
    const destinationClaims = new Map<string, string>();
    const byId = new Map(targets.map(target => [target.change.fileId, target]));
    for (const { file } of targets) {
        if (!file) continue;
        if (destinationClaims.has(file.path))
            throw new MemDriveError('INVALID_RESULT', 'Multiple source files claim the same merge destination.');
        destinationClaims.set(file.path, file.fileId);
    }

    const mainPaths = new Map<string, string>();
    const fileConflicts: string[] = [];
    for (let start = 0; start < targets.length; start += originalBatchSize) {
        const batch = targets.slice(start, start + originalBatchSize);
        const originals = await fetchOriginals(handle, name, main, batch.map(({ change }) => change.fileId), signal);
        for (const { baseline, change: { fileId } } of batch) {
            const doc = originals.get(fileId);
            const file = doc ? decodeFile(doc, schema) : undefined;
            if (file) {
                if (mainPaths.has(file.path))
                    throw new MemDriveError('INVALID_RESULT', 'Published main returned multiple files for one path.');
                mainPaths.set(file.path, fileId);
            }
            if (baseline === undefined ? file !== undefined
                : !file || file.path !== baseline.path || doc?.version !== baseline.version
                    || await fingerprintOf(file) !== baseline.fingerprint) {
                fileConflicts.push(fileId);
            }
        }
    }

    const paths = [...destinationClaims.keys()];
    const pathConflicts: string[] = [];
    for (let start = 0; start < paths.length; start += destinationBatchSize) {
        const batch = paths.slice(start, start + destinationBatchSize);
        const requested = new Set(batch);
        let response;
        try {
            response = await nativeRequest(() => handle.query({ ...viewRead(main), size: 2 * batch.length,
                query: pathQuery(batch, { literal: true }), fields: { include: ['id', 'kind', 'fileId', 'path'] },
            }, nativeOptions(signal)), signal);
        } catch (cause) {
            throw databaseError(cause, 'Could not check published main destinations.');
        }
        checkAbort(signal);
        const docs = resultDocs(response, name, batch.length);
        if (response.isDocsInline !== true || response.total !== docs.length)
            throw new MemDriveError('INVALID_RESULT', 'Published main returned an incomplete destination lookup.');
        const found = new Map<string, string>();
        for (const { id, kind, fileId, path } of docs) {
            if (kind !== 'file' || !validFileId(fileId) || id !== originalId(fileId)
                || typeof path !== 'string' || !requested.has(path) || found.has(path)
                || (mainPaths.get(path) !== fileId && (mainPaths.has(path) || byId.has(fileId))))
                throw new MemDriveError('INVALID_RESULT', 'Published main returned an unexpected or duplicate destination occupant.');
            found.set(path, fileId);
            const owner = byId.get(fileId);
            if (destinationClaims.get(path) !== fileId && !(owner?.baseline?.path === path && owner.file?.path !== path))
                pathConflicts.push(path);
        }
        for (const path of batch) {
            if (mainPaths.has(path) && !found.has(path))
                throw new MemDriveError('INVALID_RESULT', 'Published main omitted a known destination occupant.');
        }
    }

    checkAbort(signal);
    if (fileConflicts.length || pathConflicts.length)
        throw new MemDriveError('MERGE_CONFLICT', 'Published main changed a targeted file or occupies a requested destination.',
            { details: { fileIds: fileConflicts, paths: pathConflicts } });
    return { source, publishedMain: main, targets };
}
