import { MemDriveError, requireInput } from './errors.js';
import { isObject, keysOnly, metadataValues, validDate, vectorValues } from './config.js';
import type { TextChunker, ResolvedChunking } from './text-chunks.js';
import type { CreateExternalFileRequest, CreateFileRequest, DriveFile, FileActor, FileListEntry, MetadataSchema } from './types.js';

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

const actorName = (value: unknown) => typeof value === 'string' && value.trim() !== ''
    && !/[\p{Cc}\p{Surrogate}]/u.test(value) && encoder.encode(value).length <= 256;
/** A new actor of the string names among `user` and `agent`, or undefined when there are none. */
const actorOf = (user: unknown, agent: unknown): FileActor | undefined => typeof user === 'string'
    ? { user, ...(typeof agent === 'string' ? { agent } : {}) } : typeof agent === 'string' ? { agent } : undefined;
const sameActor = (a?: FileActor, b?: FileActor) => a?.user === b?.user && a?.agent === b?.agent;

/** Validate an actor; keys holding `undefined` count as absent. */
export function requireActor(value: unknown, name: string): FileActor {
    // Read each name once, so a getter cannot change what was validated.
    const names = keysOnly(value, ['user', 'agent']) ? [value.user, value.agent] : [];
    const actor = actorOf(names[0], names[1]);
    requireInput(actor !== undefined && names.every(item => item === undefined || actorName(item)),
        `${name} must be { user?, agent? } with at least one nonblank string of at most 256 UTF-8 bytes without control characters or lone surrogates.`);
    return actor;
}

/** A stored actor. A move's patch stores `null` for a name it removes, and an actor without names is none. */
function storedActor(value: unknown): FileActor | undefined {
    if (value === undefined) return undefined;
    if (!keysOnly(value, ['user', 'agent']) || !Object.values(value).every(item => item === null || actorName(item)))
        throw new MemDriveError('INVALID_RESULT', 'Read returned an invalid file actor.');
    return actorOf(value.user, value.agent);
}

/** The actor and time of one write call; an omitted time means the clock at each use. */
export type WriteChange = { by?: FileActor | undefined; time?: Date | undefined };

export function requireTime(value: unknown): Date {
    // The internal time value, not overridable methods, is what a copy stores.
    let time = Number.NaN;
    try { time = Date.prototype.getTime.call(value); }
    catch { /* not a Date */ }
    const copy = new Date(time);
    requireInput(!Number.isNaN(time) && validDate(copy.toISOString()), 'time must be a valid Date between the years 0000 and 9999.');
    return copy;
}

/** The `modifiedAt` and `modifiedBy` a change records: this call's time and actor, never an earlier modifier. */
export const modification = ({ by, time }: WriteChange) =>
    ({ modifiedAt: (time ?? new Date()).toISOString(), ...(by === undefined ? {} : { modifiedBy: { ...by } }) });

/**
 * The identity and attribution of an updated file: its creation fields, and this
 * call's modification when the file changed or else its stored one.
 * `newModifier` reports a `modifiedBy` that differs from the stored one.
 */
export function updatedFields(current: FileListEntry, change: WriteChange, changed: boolean) {
    const { fileId, createdAt, createdBy, modifiedAt, modifiedBy } = current;
    const modified = changed ? modification(change) : { modifiedAt, ...(modifiedBy === undefined ? {} : { modifiedBy }) };
    return { fields: { fileId, createdAt, ...(createdBy === undefined ? {} : { createdBy }), ...modified },
        newModifier: !sameActor(modified.modifiedBy, modifiedBy) };
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

/** The original fields that `decodeFileEntry` reads, for queries that project fields. */
export const fileEntryFields = ['id', 'kind', 'fileId', 'path', 'createdAt', 'createdBy', 'modifiedAt', 'modifiedBy', 'metadata'];

export function decodeFileEntry(doc: Record<string, unknown>, schema: MetadataSchema): FileListEntry {
    if (doc.kind !== 'file' || !validFileId(doc.fileId) || doc.id !== originalId(doc.fileId)
        || !validPath(doc.path) || !validDate(doc.createdAt) || !validDate(doc.modifiedAt))
        throw new MemDriveError('INVALID_RESULT', 'Read returned an invalid file original.');
    const createdBy = storedActor(doc.createdBy), modifiedBy = storedActor(doc.modifiedBy);
    try {
        const metadata = metadataValues(doc.metadata, schema);
        return { fileId: doc.fileId, path: doc.path, createdAt: doc.createdAt, ...(createdBy === undefined ? {} : { createdBy }),
            modifiedAt: doc.modifiedAt, ...(modifiedBy === undefined ? {} : { modifiedBy }), ...(metadata === undefined ? {} : { metadata }) };
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

export async function createRecords(request: CreateFileRequest | CreateExternalFileRequest, change: WriteChange, schema: MetadataSchema, dimensions?: number, chunker?: TextChunker, options?: { signal?: AbortSignal | undefined }) {
    requireInput(keysOnly(request, ['op', 'path', 'content', 'metadata']) && request.op === 'create',
        dimensions === undefined ? 'Create requires a path and original text.' : 'Create requires a path and vector content.');
    const { path } = request;
    requirePath(path);
    let payload: { content: string } | { embedding: number[] };
    if (dimensions === undefined) {
        requireInput(validText(request.content), 'File content must be UTF-8 text.');
        payload = { content: request.content };
    } else {
        payload = { embedding: vectorValues(request.content, dimensions) };
    }
    const metadata = metadataValues(request.metadata, schema);
    const created = modification(change);
    const file: StoredFile = { fileId: globalThis.crypto.randomUUID(), path, createdAt: created.modifiedAt,
        ...(change.by === undefined ? {} : { createdBy: { ...change.by } }), ...created, ...payload, ...(metadata === undefined ? {} : { metadata }) };
    return fileRecords(file, undefined, chunker, options);
}

export const metadataKey = (metadata: DriveFile['metadata']) => metadata === undefined ? null : Object.entries(metadata).sort();
export const fingerprintOf = (file: Pick<StoredFile, 'path' | 'metadata'> & ({ content: string } | { embedding: number[] })) =>
    contentHash(JSON.stringify([file.path, metadataKey(file.metadata), 'embedding' in file ? file.embedding : file.content]));

/**
 * Stored with each original. `revision` is new for every write of the original
 * and copied to its chunks, so search drops chunks of another revision.
 * `generation` suffixes the chunk IDs of a replaced text, so cleanup of one
 * generation never deletes a later one.
 */
type FileTracking = {
    chunking?: ResolvedChunking | undefined;
    revision: string;
    generation?: string | undefined;
};

export function fileOriginal(file: StoredFile, tracking?: FileTracking) {
    const { fileId, path, createdAt, createdBy, modifiedAt, modifiedBy, metadata } = file;
    const parts = path.slice(1).split('/');
    const fileName = parts.pop()!;
    const ancestorPaths = ['/'];
    let ancestor = '/';
    for (const part of parts) {
        ancestor += part + '/';
        ancestorPaths.push(ancestor);
    }
    const { revision } = tracking ?? {};
    const shared = { fileId, path, fileName, ancestorPaths, createdAt, ...(createdBy === undefined ? {} : { createdBy }),
        modifiedAt, ...(modifiedBy === undefined ? {} : { modifiedBy }), ...(metadata === undefined ? {} : { metadata }),
        ...(revision === undefined ? {} : { revision }) };
    const payload = 'embedding' in file ? { embedding: file.embedding } : { body: file.content };
    return { id: originalId(fileId), kind: 'file' as const, ...shared, ...payload, ...tracking };
}

export async function fileRecords(file: StoredFile, tracking?: FileTracking, chunker?: TextChunker, options?: { signal?: AbortSignal | undefined }) {
    const { fileId } = file;
    const toRecord = (original: ReturnType<typeof fileOriginal>) => {
        const originalBytes = bytes(original);
        requireInput(originalBytes <= 5 * 1024 * 1024, 'The file original exceeds the native 5 MiB document limit.');
        return { doc: original, inputBytes: 0, wireBytes: originalBytes + 1 };
    };
    if ('embedding' in file) {
        const { embedding: _embedding, ...reference } = file;
        return { file: reference, docs: [toRecord(fileOriginal(file, tracking ?? { revision: globalThis.crypto.randomUUID() }))] };
    }
    // Reject an oversized original before running the chunker.
    toRecord(fileOriginal(file, tracking));
    requireInput(chunker !== undefined, 'Text files require the store chunker.');
    const rendered = await chunker(file, options);
    const originalRecord = toRecord(fileOriginal(file, { revision: globalThis.crypto.randomUUID(), ...tracking, chunking: rendered.resolved }));
    const { path, fileName, ancestorPaths, modifiedAt, metadata, revision } = originalRecord.doc;
    const generation = tracking?.generation;
    const shared = { fileId, path, fileName, ancestorPaths, modifiedAt, ...(metadata === undefined ? {} : { metadata }), revision };
    const occurrences = new Map<string, number>();
    const hashes = await Promise.all(rendered.chunks.map(span => contentHash(JSON.stringify([span.text, span.contextualized]))));
    const chunks = rendered.chunks.map(({ text, contextualized, start, end }, index) => {
        const hash = hashes[index]!;
        const occurrence = occurrences.get(hash) ?? 0;
        occurrences.set(hash, occurrence + 1);
        // A created file's chunks have no suffix. Each replacement gets a new
        // suffix so delayed cleanup cannot delete a later generation.
        const suffix = generation === undefined ? '' : `:${generation}`;
        return { id: `chunk:${fileId}:${hash}:${occurrence}${suffix}`, kind: 'chunk' as const, ...shared, content: text, embeddingText: contextualized,
            ...(start === undefined || end === undefined ? {} : { start, end }) };
    });
    // Large files stage their chunks before making the original visible.
    const chunkRecords = chunks.map(doc => ({ doc, inputBytes: encoder.encode(doc.embeddingText).length, wireBytes: bytes(doc) + 1 }));
    requireInput(chunkRecords.every(record => record.wireBytes - 1 <= 5 * 1024 * 1024), 'A chunk exceeds the native 5 MiB document limit.');
    const docs = [...chunkRecords, originalRecord];
    return { file, docs };
}
