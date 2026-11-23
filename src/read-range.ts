import { MemDriveError, requireInput } from './errors.js';
import { fingerprintOf } from './records.js';
import type { DriveFile, FileAt, FileReadPage, ReadFileRangeOptions } from './types.js';

export const rangeKeys = ['startLine', 'endLine', 'maxChars', 'offset', 'revision'];

export function validateReadRange(request: ReadFileRangeOptions) {
    const { startLine = 1, endLine, maxChars = 16000, offset, revision } = request;
    requireInput(Number.isSafeInteger(startLine) && startLine >= 1
        && (endLine === undefined || Number.isSafeInteger(endLine) && endLine >= startLine),
    'Line bounds must be positive integers, with endLine at or after startLine.');
    requireInput(Number.isSafeInteger(maxChars) && maxChars >= 2 && maxChars <= 64000,
        'maxChars must be 2–64000 UTF-16 code units.');
    requireInput(revision === undefined || typeof revision === 'string' && /^[0-9a-f]{64}$/.test(revision),
        'revision must be returned by a previous ranged read.');
    requireInput(offset === undefined || Number.isSafeInteger(offset) && offset >= 0 && revision !== undefined,
        'Continuation offset requires a nonnegative integer and the returned revision.');
}

export async function readRange(file: DriveFile, request: ReadFileRangeOptions, at: FileAt, version?: string): Promise<FileReadPage> {
    const revision = await fingerprintOf(file);
    if (request.revision !== undefined && request.revision !== revision)
        throw new MemDriveError('READ_VERSION_CHANGED', 'The file changed between reads. Restart without offset and revision.');
    const text = file.content;
    const starts = [0, ...Array.from(text.matchAll(/\r\n|\r|\n/g), match => match.index + match[0].length)];
    const totalLines = starts.length;
    const { startLine = 1, endLine = totalLines, maxChars = 16000 } = request;
    requireInput(startLine <= totalLines, 'startLine is beyond the end of the file.');
    const lower = starts[startLine - 1]!;
    const upper = starts[Math.min(endLine, totalLines)] ?? text.length;
    const start = request.offset ?? lower;
    const splitPair = (offset: number) => offset > 0 && offset < text.length
        && (/[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset]!)
            || text[offset - 1] === '\r' && text[offset] === '\n');
    requireInput(start >= lower && start <= upper && !splitPair(start), 'Continuation offset is outside the selected range or splits a character/line ending.');
    let end = Math.min(upper, start + maxChars);
    if (splitPair(end)) end--;
    const lineAt = (offset: number) => {
        let low = 0, high = starts.length;
        while (low < high) { const middle = (low + high) >>> 1; if (starts[middle]! <= offset) low = middle + 1; else high = middle; }
        return low;
    };
    return { ...file, content: text.slice(start, end), at: { ...at }, revision, ...(version === undefined ? {} : { version }), totalLines,
        range: { startLine: lineAt(start), endLine: lineAt(Math.max(start, end - 1)), start, end },
        ...(end < upper ? { next: { at: { ...at }, fileId: file.fileId, startLine, endLine: Math.min(endLine, totalLines), maxChars, offset: end, revision } } : {}) };
}
