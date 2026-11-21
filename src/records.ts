import { MemDriveError, requireInput } from './errors.js';
import { isObject, keysOnly, metadataValues, validDate, vectorValues } from './config.js';
import { chunkSpans } from './chunking.js';
import type { CreateExternalFileRequest, CreateFileRequest, DriveFile, FileListEntry, MetadataSchema } from './types.js';

const encoder = new TextEncoder();
export const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;
const fileIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const validFileId = (value: unknown): value is string => typeof value === 'string' && fileIdPattern.test(value);
export const validPath = (value: unknown): value is string => typeof value === 'string' && value.startsWith('/')
    && !/[\\\p{Cc}\p{Surrogate}]/u.test(value) && encoder.encode(value).length <= 4096
    && value.slice(1).split('/').every(part => part !== '' && part !== '.' && part !== '..');
export const originalId = (fileId: string) => `file:${fileId}`;

export function requirePath(path: unknown): asserts path is string {
    requireInput(validPath(path), 'File path must be absolute, at most 4096 UTF-8 bytes, and contain valid nonempty components.');
}

export function resultDocs(response: unknown, collection: string, maximum: number): Record<string, unknown>[] {
    if (!isObject(response) || response.isDocsInline === false || !Array.isArray(response.docs) || response.docs.length > maximum)
        throw new MemDriveError('INVALID_RESULT', 'Read returned an invalid or ambiguous document envelope.');
    return response.docs.map(hit => {
        if (!isObject(hit) || hit.collection !== collection || !isObject(hit.doc))
            throw new MemDriveError('INVALID_RESULT', 'Read returned an invalid document.');
        return hit.doc;
    });
}

export function decodeFileEntry(doc: Record<string, unknown>, schema: MetadataSchema): FileListEntry {
    if (doc.kind !== 'file' || !validFileId(doc.fileId) || doc.id !== originalId(doc.fileId)
        || !validPath(doc.path) || !validDate(doc.modifiedAt))
        throw new MemDriveError('INVALID_RESULT', 'Read returned an invalid file original.');
    try {
        const metadata = metadataValues(doc.metadata, schema);
        return { fileId: doc.fileId, path: doc.path, modifiedAt: doc.modifiedAt,
            ...(metadata === undefined ? {} : { metadata }) };
    } catch (cause) {
        throw new MemDriveError('INVALID_RESULT', 'Read returned invalid file metadata.', { cause });
    }
}

export function decodeFile(doc: Record<string, unknown>, schema: MetadataSchema): DriveFile {
    if (typeof doc.body !== 'string' || /\p{Surrogate}/u.test(doc.body))
        throw new MemDriveError('INVALID_RESULT', 'Read returned an invalid file original.');
    const { metadata, ...entry } = decodeFileEntry(doc, schema);
    return { ...entry, content: doc.body, ...(metadata === undefined ? {} : { metadata }) };
}

export async function contentHash(content: string): Promise<string> {
    const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(content)));
    return [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export const validText = (value: unknown): value is string => typeof value === 'string' && !/\p{Surrogate}/u.test(value);

export type StoredFile = DriveFile | (FileListEntry & { embedding: number[] });

export function decodeStoredFile(doc: Record<string, unknown>, schema: MetadataSchema, dimensions?: number): StoredFile {
    if (dimensions === undefined) return decodeFile(doc, schema);
    const file = decodeFileEntry(doc, schema);
    if (doc.body !== undefined || doc.content !== undefined)
        throw new MemDriveError('INVALID_RESULT', 'Read returned text on an external-vector file original.');
    try {
        return { ...file, embedding: vectorValues(doc.embedding, dimensions) };
    } catch (cause) {
        throw new MemDriveError('INVALID_RESULT', 'Read returned an invalid external file embedding.', { cause });
    }
}

export async function createRecords(request: CreateFileRequest | CreateExternalFileRequest, schema: MetadataSchema, dimensions?: number) {
    const field = dimensions === undefined ? 'content' : 'embedding';
    requireInput(keysOnly(request, ['op', 'path', field, 'metadata']) && request.op === 'create',
        dimensions === undefined ? 'Create requires a path and original text.' : 'Create requires a path and external embedding.');
    const { path } = request;
    requirePath(path);
    let payload: { content: string } | { embedding: number[] };
    if (dimensions === undefined) {
        requireInput(validText(request.content), 'File content must be UTF-8 text.');
        payload = { content: request.content };
    } else {
        payload = { embedding: vectorValues(request.embedding, dimensions) };
    }
    const metadata = metadataValues(request.metadata, schema);
    const file: StoredFile = { fileId: globalThis.crypto.randomUUID(), path, modifiedAt: new Date().toISOString(), ...payload,
        ...(metadata === undefined ? {} : { metadata }) };
    if ('embedding' in file)
        return fileRecords(file, { revision: globalThis.crypto.randomUUID(), fingerprint: await fingerprintOf(file) });
    return fileRecords(file);
}

export type FileBaseline = { version: string; path: string; fingerprint: string };

export function baselineOf(doc: Record<string, unknown>): FileBaseline | undefined {
    if (doc.baseline === undefined) return undefined;
    if (!isObject(doc.baseline) || typeof doc.baseline.version !== 'string' || !doc.baseline.version
        || !validPath(doc.baseline.path) || typeof doc.baseline.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(doc.baseline.fingerprint))
        throw new MemDriveError('INVALID_RESULT', 'Read returned invalid file baseline data.');
    return { version: doc.baseline.version, path: doc.baseline.path, fingerprint: doc.baseline.fingerprint };
}

export const metadataKey = (metadata: DriveFile['metadata']) => metadata === undefined ? null : Object.entries(metadata).sort();
export const fingerprintOf = (file: StoredFile) =>
    contentHash(JSON.stringify([file.path, metadataKey(file.metadata), 'embedding' in file ? file.embedding : file.content]));

type FileTracking = {
    revision: string;
    generation?: string | undefined;
    baseline?: FileBaseline | undefined;
    fingerprint: string;
    version?: string | undefined;
};

export function fileOriginal(file: StoredFile, tracking?: FileTracking) {
    const { fileId, path, modifiedAt, metadata } = file;
    const parts = path.slice(1).split('/');
    const fileName = parts.pop()!;
    const ancestorPaths = ['/'];
    let ancestor = '/';
    for (const part of parts) {
        ancestor += part + '/';
        ancestorPaths.push(ancestor);
    }
    const { revision } = tracking ?? {};
    const shared = { fileId, path, fileName, ancestorPaths, modifiedAt, ...(metadata === undefined ? {} : { metadata }),
        ...(revision === undefined ? {} : { revision }) };
    const payload = 'embedding' in file ? { embedding: file.embedding } : { body: file.content };
    return { id: originalId(fileId), kind: 'file' as const, ...shared, ...payload,
        changed: !tracking?.baseline || tracking.fingerprint !== tracking.baseline.fingerprint, ...tracking };
}

export async function fileRecords(file: StoredFile, tracking?: FileTracking) {
    const { fileId } = file;
    const original = fileOriginal(file, tracking);
    const { path, fileName, ancestorPaths, modifiedAt, metadata, revision } = original;
    const generation = tracking?.generation;
    const shared = { fileId, path, fileName, ancestorPaths, modifiedAt,
        ...(metadata === undefined ? {} : { metadata }), ...(revision === undefined ? {} : { revision }) };
    const originalBytes = bytes(original);
    requireInput(originalBytes <= 5 * 1024 * 1024, 'The file original exceeds the native 5 MiB document limit.');
    const originalRecord = { doc: original, inputBytes: 0, wireBytes: originalBytes + 1 };
    if ('embedding' in file) {
        const { embedding: _embedding, ...reference } = file;
        return { file: reference, docs: [originalRecord] };
    }
    const spans = chunkSpans(file.content).filter(span => span.text.trim());
    const occurrences = new Map<string, number>();
    const hashes = await Promise.all(spans.map(span => contentHash(span.text)));
    const chunks = spans.map(({ text, start, end }, index) => {
        const hash = hashes[index]!;
        const occurrence = occurrences.get(hash) ?? 0;
        occurrences.set(hash, occurrence + 1);
        // Legacy and new creates keep their established IDs. Each replacement
        // gets a new suffix so delayed cleanup cannot delete a later generation.
        const suffix = generation === undefined ? '' : `:${generation}`;
        return { id: `chunk:${fileId}:${hash}:${occurrence}${suffix}`, kind: 'chunk' as const, ...shared, content: text, start, end };
    });
    // Large files stage their chunks before making the original visible.
    const chunkRecords = chunks.map(doc => ({ doc, inputBytes: encoder.encode(doc.content).length, wireBytes: bytes(doc) + 1 }));
    requireInput(chunkRecords.every(record => record.wireBytes - 1 <= 5 * 1024 * 1024), 'A chunk exceeds the native 5 MiB document limit.');
    const docs = [...chunkRecords, originalRecord];
    return { file, docs };
}
