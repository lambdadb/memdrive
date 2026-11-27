import { resolvedChunking, type TextChunker } from './text-chunks.js';
import { keysOnly, metadataValues, vectorValues } from './config.js';
import { MemDriveError, requireInput } from './errors.js';
import { validFileId, validPath, validText, decodeStoredFile, fileOriginal, fileRecords, metadataKey, fingerprintOf, updatedFields,
    type StoredFile, type WriteChange } from './records.js';
import type { DeleteFileRequest, MetadataSchema, TextEdit, UpdateExternalFileRequest, UpdateFileRequest } from './types.js';

type EditRequest = UpdateFileRequest | UpdateExternalFileRequest | DeleteFileRequest;

export function editRequest(request: unknown, schema: MetadataSchema, dimensions?: number): EditRequest {
    const fields = dimensions === undefined ? ['op', 'fileId', 'newPath', 'metadata', 'content', 'edits']
        : ['op', 'fileId', 'newPath', 'metadata', 'content'];
    requireInput(keysOnly(request, fields) && validFileId(request.fileId),
        'Update and delete require a fileId returned by MemDrive.');
    if (request.op === 'delete') {
        requireInput(Object.keys(request).length === 2, 'Delete accepts only a fileId.');
        return { op: 'delete', fileId: request.fileId };
    }
    requireInput(request.op === 'update' && (request.newPath === undefined || validPath(request.newPath)), 'Update requires a valid file path.');
    const base = { op: 'update' as const, fileId: request.fileId,
        ...(request.newPath === undefined ? {} : { newPath: request.newPath }) };
    if (dimensions !== undefined) {
        requireInput([request.newPath, request.content, request.metadata].some(value => value !== undefined),
            'Update requires a path, metadata or replacement vector content.');
        const metadata = metadataValues(request.metadata, schema);
        return { ...base, ...(request.metadata === undefined ? {} : { metadata: metadata ?? {} }),
            ...(request.content === undefined ? {} : { content: vectorValues(request.content, dimensions) }) };
    }
    requireInput((request.content === undefined || validText(request.content))
        && !(request.edits !== undefined && request.content !== undefined)
        && [request.newPath, request.content, request.edits, request.metadata].some(value => value !== undefined),
    'Update requires a valid path, metadata or exactly one content replacement or edits array.');
    const metadata = metadataValues(request.metadata, schema);
    const textBase = { ...base, ...(request.metadata === undefined ? {} : { metadata: metadata ?? {} }) };
    if (request.edits === undefined) return { ...textBase, ...(request.content === undefined ? {} : { content: request.content }) };
    requireInput(Array.isArray(request.edits) && request.edits.length > 0, 'Edits require a nonempty array.');
    const edits: TextEdit[] = [...request.edits].map(edit => {
        requireInput(keysOnly(edit, ['oldText', 'newText']) && validText(edit.oldText) && edit.oldText.length > 0 && validText(edit.newText),
            'An edit requires nonempty oldText and UTF-8 newText.');
        return { oldText: edit.oldText, newText: edit.newText };
    });
    requireInput(new Set(edits.map(edit => edit.oldText)).size === edits.length, 'Edits must specify distinct oldText values.');
    return { ...textBase, edits };
}

function replaceExact(source: string, edits: TextEdit[]): string {
    const spans = edits.map(({ oldText, newText }, index) => {
        const start = source.indexOf(oldText);
        if (start < 0 || source.indexOf(oldText, start + 1) >= 0)
            throw new MemDriveError('EDIT_CONFLICT', 'Each oldText must match exactly once in the original file.', { details: { editIndex: index } });
        return { start, end: start + oldText.length, newText };
    }).sort((a, b) => a.start - b.start);
    const text: string[] = [];
    let from = 0;
    for (const span of spans) {
        if (span.start < from) throw new MemDriveError('EDIT_CONFLICT', 'Exact edits overlap in the original file.');
        text.push(source.slice(from, span.start), span.newText);
        from = span.end;
    }
    text.push(source.slice(from));
    return text.join('');
}

export async function planEdit(request: EditRequest, doc: Record<string, unknown> | undefined, change: WriteChange,
    schema: MetadataSchema, dimensions?: number, chunker?: TextChunker, options?: { signal?: AbortSignal | undefined }) {
    const { fileId } = request;
    const current = doc?.kind === 'file' ? decodeStoredFile(doc, schema, dimensions) : undefined;
    // Deleting an absent file still removes any chunks left by an interrupted write or delete.
    if (request.op === 'delete') return { op: 'delete' as const, fileId, path: current?.path, removeOriginal: !!current };
    if (!current) throw new MemDriveError('FILE_NOT_FOUND', 'No current file with this ID exists in this view.', { details: { fileId } });
    const path = request.newPath ?? current.path;
    const metadata = request.metadata === undefined ? current.metadata : metadataValues(request.metadata, schema);
    const settings = { path, ...(metadata === undefined ? {} : { metadata }) };
    const revision = globalThis.crypto.randomUUID();
    if ('embedding' in current) {
        const embedding = request.content !== undefined && typeof request.content !== 'string' ? [...request.content] : current.embedding;
        const changed = await fingerprintOf({ ...settings, embedding }) !== await fingerprintOf(current);
        const file: StoredFile = { ...updatedFields(current, change, changed).fields, ...settings, embedding };
        const records = await fileRecords(file, { revision });
        return { op: 'update' as const, file: records.file, generation: undefined, moveOnly: false as const, records };
    }
    const content = request.edits ? replaceExact(current.content, request.edits)
        : typeof request.content === 'string' ? request.content : current.content;
    const generationValue = doc?.generation;
    if (generationValue !== undefined && !validFileId(generationValue))
        throw new MemDriveError('INVALID_RESULT', 'Read returned invalid file generation data.');
    const replace = content !== current.content || JSON.stringify(metadataKey(metadata)) !== JSON.stringify(metadataKey(current.metadata));
    const generation = replace ? revision : generationValue;
    const { fields, newModifier } = updatedFields(current, change, replace || path !== current.path);
    const file = { ...fields, ...settings, content };
    const tracking = { revision, generation, chunking: resolvedChunking(doc?.chunking) };
    const base = { op: 'update' as const, file, generation };
    return replace
        ? { ...base, moveOnly: false as const, records: await fileRecords(file, tracking, chunker, options) }
        : { ...base, moveOnly: true as const, newModifier, original: fileOriginal(file, tracking) };
}
