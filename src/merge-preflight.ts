import { changedFiles, netChange } from './diff.js';
import { resolvedChunking } from './text-chunks.js';
import { checkAbort, databaseError, MemDriveError, nativeOptions, nativeRequest } from './errors.js';
import { decodeStoredFile, fingerprintOf, originalId, resultDocs, validFileId } from './records.js';
import { fetchOriginals, pathQuery, viewRead, type Handle, type ViewRef } from './storage-reads.js';
import type { MetadataSchema } from './types.js';

type TagRef = Extract<ViewRef, { kind: 'tag' }>;
type BranchRef = Extract<ViewRef, { kind: 'branch' }>;
export const initialMainRef = { kind: 'branch', name: 'md-main-v0' } as const;
type PublishedMain = TagRef | typeof initialMainRef;
type Candidate = NonNullable<ReturnType<typeof netChange>>;

// Keep batches of full originals smaller than projected queries. The native
// client can hydrate larger responses from its download URL.
export const originalBatchSize = 16;
const destinationBatchSize = 100;

async function loadTargets(handle: Handle, name: string, source: BranchRef, schema: MetadataSchema, dimensions: number | undefined, signal?: AbortSignal) {
    const candidates: Candidate[] = [];
    for await (const candidate of changedFiles(handle, name, source, signal)) candidates.push(candidate);

    const targets = [];
    for (let start = 0; start < candidates.length; start += originalBatchSize) {
        const batch = candidates.slice(start, start + originalBatchSize);
        const originals = await fetchOriginals(handle, name, source, batch.map(({ change }) => change.fileId), signal, dimensions !== undefined);
        for (const candidate of batch) {
            const doc = originals.get(candidate.change.fileId);
            if (!doc || JSON.stringify(netChange(doc)) !== JSON.stringify(candidate))
                throw new MemDriveError('INVALID_RESULT', 'The source original disagrees with its change summary.');
            const { revision, generation } = doc;
            if ((revision !== undefined && !validFileId(revision)) || (generation !== undefined && !validFileId(generation)))
                throw new MemDriveError('INVALID_RESULT', 'The source original has invalid file tracking.');
            // Only a deletion has no fingerprint; every live target carries one.
            if (candidate.fingerprint === undefined) {
                targets.push({ ...candidate, file: undefined, revision, generation, chunking: undefined });
                continue;
            }
            const file = decodeStoredFile(doc, schema, dimensions);
            if (await fingerprintOf(file) !== candidate.fingerprint)
                throw new MemDriveError('INVALID_RESULT', 'The source original disagrees with its fingerprint.');
            const chunking = 'content' in file ? resolvedChunking(doc.chunking) : undefined;
            targets.push({ ...candidate, file, revision, generation, chunking });
        }
    }
    return targets;
}

/**
 * Plan a merge of the `working` fork against the published main version. Call
 * it in the main publication queue while the merge owns the fork's queue.
 * A changed file whose state published main already holds, such as one an
 * earlier merge published before its source bookkeeping, is `settled`: it is
 * neither applied nor a conflict, and its baseline can advance to the version
 * that holds it.
 */
export async function prepareMerge(handle: Handle, name: string, working: BranchRef, publishedMain: PublishedMain,
    schema: MetadataSchema, signal?: AbortSignal, dimensions?: number) {
    if (working.kind !== 'branch' || handle.collectionName !== name || publishedMain.kind !== 'tag' && publishedMain.name !== initialMainRef.name)
        throw new MemDriveError('INVALID_INPUT', 'Preparing a merge requires the working fork and the published main version.');
    const source: BranchRef = { kind: 'branch', name: working.name };
    const main: PublishedMain = { ...publishedMain };
    const targets = await loadTargets(handle, name, source, schema, dimensions, signal);
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
    const settled = new Map<string, string | undefined>();
    for (let start = 0; start < targets.length; start += originalBatchSize) {
        const batch = targets.slice(start, start + originalBatchSize);
        const originals = await fetchOriginals(handle, name, main, batch.map(({ change }) => change.fileId), signal, dimensions !== undefined);
        for (const { baseline, fingerprint, change: { fileId } } of batch) {
            const doc = originals.get(fileId);
            const file = doc ? decodeStoredFile(doc, schema, dimensions) : undefined;
            if (file) {
                if (mainPaths.has(file.path))
                    throw new MemDriveError('INVALID_RESULT', 'Published main returned multiple files for one path.');
                mainPaths.set(file.path, fileId);
            }
            const held = file && await fingerprintOf(file);
            // The fingerprint covers path, metadata and content or vector; a deletion has none.
            if (held === fingerprint) {
                const version = doc?.version;
                if (file && typeof version !== 'string') throw new MemDriveError('INVALID_RESULT', 'Published main returned a file without its version.');
                settled.set(fileId, version as string | undefined);
            } else if (baseline === undefined ? file !== undefined
                : !file || file.path !== baseline.path || doc?.version !== baseline.version || held !== baseline.fingerprint) {
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
    return { source, publishedMain: main, targets: targets.filter(({ change }) => !settled.has(change.fileId)),
        settled: targets.flatMap(({ change: { fileId }, fingerprint }) => settled.has(fileId) ? [{ fileId, fingerprint, version: settled.get(fileId) }] : []),
        dimensions };
}
