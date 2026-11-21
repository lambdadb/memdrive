import { keysOnly, metadataValues, vectorValues } from './config.js';
import { MemDriveError, requireInput } from './errors.js';
import { validFileId, validPath, validText, baselineOf, decodeStoredFile, fileOriginal, fileRecords, fingerprintOf, metadataKey, originalId, type StoredFile } from './records.js';
import type { DeleteFileRequest, MetadataSchema, TextEdit, UpdateExternalFileRequest, UpdateFileRequest } from './types.js';

type EditRequest = UpdateFileRequest | UpdateExternalFileRequest | DeleteFileRequest;

export function editRequest(request: unknown, schema: MetadataSchema, dimensions?: number): EditRequest {
    const fields = dimensions === undefined ? ['content', 'edits'] : ['embedding'];
    requireInput(keysOnly(request, ['op', 'fileId', 'newPath', 'metadata', ...fields]) && validFileId(request.fileId),
        'Update and delete require a fileId returned by MemDrive.');
    if (request.op === 'delete') {
        requireInput(Object.keys(request).length === 2, 'Delete accepts only a fileId.');
        return { op: 'delete', fileId: request.fileId };
    }
    requireInput(request.op === 'update' && (request.newPath === undefined || validPath(request.newPath)), 'Update requires a valid file path.');
    const base = { op: 'update' as const, fileId: request.fileId,
        ...(request.newPath === undefined ? {} : { newPath: request.newPath }) };
    if (dimensions !== undefined) {
        requireInput([request.newPath, request.embedding, request.metadata].some(value => value !== undefined),
            'Update requires a path, metadata or a replacement embedding.');
        const metadata = metadataValues(request.metadata, schema);
        return { ...base, ...(request.metadata === undefined ? {} : { metadata: metadata ?? {} }),
            ...(request.embedding === undefined ? {} : { embedding: vectorValues(request.embedding, dimensions) }) };
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

export async function planEdit(request: EditRequest, doc: Record<string, unknown> | undefined,
    schema: MetadataSchema, dimensions?: number) {
    const { fileId } = request;
    const current = doc?.kind === 'file' ? decodeStoredFile(doc, schema, dimensions) : undefined;
    const version = typeof doc?.version === 'string' && doc.version ? doc.version : undefined;
    let baseline = doc && baselineOf(doc);
    if (!baseline && (doc?.changed === false || doc?.changed === undefined) && current && version)
        baseline = { version, path: current.path, fingerprint: await fingerprintOf(current) };
    if (request.op === 'delete') {
        const path = current?.path ?? (validPath(doc?.path) ? doc.path : undefined);
        const tombstone = current ? {
            id: originalId(fileId), kind: 'tombstone' as const, fileId, path: current.path,
            modifiedAt: new Date().toISOString(), revision: globalThis.crypto.randomUUID(), changed: true,
            ...(baseline === undefined ? {} : { baseline }),
        } : undefined;
        return { op: 'delete' as const, fileId, path, removeOriginal: !!doc && !baseline, tombstone };
    }
    if (!current) throw new MemDriveError('FILE_NOT_FOUND', 'No current file with this ID exists on this fork.', { details: { fileId } });
    const path = request.newPath ?? current.path;
    const metadata = request.metadata === undefined ? current.metadata : metadataValues(request.metadata, schema);
    const fields = { fileId, path, modifiedAt: current.modifiedAt, ...(metadata === undefined ? {} : { metadata }) };
    const revision = globalThis.crypto.randomUUID();
    if ('embedding' in current) {
        const embedding = 'embedding' in request && request.embedding !== undefined ? [...request.embedding] : current.embedding;
        const file: StoredFile = { ...fields, embedding };
        const fingerprint = await fingerprintOf(file);
        if (fingerprint !== await fingerprintOf(current)) file.modifiedAt = new Date().toISOString();
        const records = await fileRecords(file, { revision, baseline, fingerprint, version });
        return { op: 'update' as const, file: records.file, generation: undefined, moveOnly: false as const, records };
    }
    const content = request.edits ? replaceExact(current.content, request.edits) : request.content ?? current.content;
    const generationValue = doc?.generation;
    if (generationValue !== undefined && !validFileId(generationValue))
        throw new MemDriveError('INVALID_RESULT', 'Read returned invalid file generation data.');
    const replace = content !== current.content || JSON.stringify(metadataKey(metadata)) !== JSON.stringify(metadataKey(current.metadata));
    const generation = replace ? revision : generationValue;
    const modifiedAt = !replace && path === current.path ? current.modifiedAt : new Date().toISOString();
    const file = { ...fields, modifiedAt, content };
    const tracking = { revision, generation, baseline, fingerprint: await fingerprintOf(file), version };
    const base = { op: 'update' as const, file, generation };
    return replace
        ? { ...base, moveOnly: false as const, records: await fileRecords(file, tracking) }
        : { ...base, moveOnly: true as const, original: fileOriginal(file, tracking) };
}
