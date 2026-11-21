import { MemDriveError, requireInput } from './errors.js';
import { isObject, keysOnly, metadataValues, validDate } from './config.js';
import { chunkSpans } from './chunking.js';
import type { CreateFileRequest, DriveFile, MetadataSchema } from './types.js';

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

export function decodeFile(doc: Record<string, unknown>, schema: MetadataSchema): DriveFile {
    if (doc.kind !== 'file' || !validFileId(doc.fileId) || doc.id !== originalId(doc.fileId)
        || !validPath(doc.path) || typeof doc.body !== 'string' || /\p{Surrogate}/u.test(doc.body) || !validDate(doc.modifiedAt))
        throw new MemDriveError('INVALID_RESULT', 'Read returned an invalid file original.');
    try {
        const metadata = metadataValues(doc.metadata, schema);
        return { fileId: doc.fileId, path: doc.path, modifiedAt: doc.modifiedAt, content: doc.body,
            ...(metadata === undefined ? {} : { metadata }) };
    } catch (cause) {
        throw new MemDriveError('INVALID_RESULT', 'Read returned invalid file metadata.', { cause });
    }
}

async function contentHash(content: string): Promise<string> {
    const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(content)));
    return [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function fileRecords(request: CreateFileRequest, schema: MetadataSchema) {
    requireInput(keysOnly(request, ['op', 'path', 'content', 'metadata']) && request.op === 'create',
        'Write requires a create operation with path and original text.');
    const { path, content } = request;
    requirePath(path);
    requireInput(typeof content === 'string' && !/\p{Surrogate}/u.test(content), 'File content must be UTF-8 text.');
    const metadata = metadataValues(request.metadata, schema);
    const fileId = globalThis.crypto.randomUUID();
    const modifiedAt = new Date().toISOString();
    const parts = path.slice(1).split('/');
    const fileName = parts.pop()!;
    const ancestorPaths = ['/'];
    let ancestor = '/';
    for (const part of parts) {
        ancestor += part + '/';
        ancestorPaths.push(ancestor);
    }
    const shared = { fileId, path, fileName, ancestorPaths, modifiedAt, ...(metadata === undefined ? {} : { metadata }) };
    const original = { id: originalId(fileId), kind: 'file', ...shared, body: content, changed: true };
    const originalBytes = bytes(original);
    requireInput(originalBytes <= 5 * 1024 * 1024, 'The file original exceeds the native 5 MiB document limit.');
    const spans = chunkSpans(content).filter(span => span.text.trim());
    const occurrences = new Map<string, number>();
    const hashes = await Promise.all(spans.map(span => contentHash(span.text)));
    const chunks = spans.map(({ text, start, end }, index) => {
        const hash = hashes[index]!;
        const occurrence = occurrences.get(hash) ?? 0;
        occurrences.set(hash, occurrence + 1);
        return { id: `chunk:${fileId}:${hash}:${occurrence}`, kind: 'chunk', ...shared, content: text, start, end };
    });
    const file: DriveFile = { fileId, path, modifiedAt, content, ...(metadata === undefined ? {} : { metadata }) };
    // Large files stage their chunks before making the original visible.
    const chunkRecords = chunks.map(doc => ({ doc, inputBytes: encoder.encode(doc.content).length, wireBytes: bytes(doc) + 1 }));
    requireInput(chunkRecords.every(record => record.wireBytes - 1 <= 5 * 1024 * 1024), 'A chunk exceeds the native 5 MiB document limit.');
    const docs = [...chunkRecords, { doc: original, inputBytes: 0, wireBytes: originalBytes + 1 }];
    return { file, docs };
}
