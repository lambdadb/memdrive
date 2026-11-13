// Exact source partitions: UTF-16 offsets for slice(), a Unicode-code-point cap.
// English sentence detection is deliberate; other languages are not optimized.
export const CHUNKING_POLICY = 'boundary-v1';
export function chunkSpans(text: string, limit = 800): Array<{start: number; end: number; text: string}> {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Chunk limit must be a positive integer.');
    const offsets = [0];
    for (const char of text) offsets.push(offsets.at(-1)! + char.length);
    const paragraphs = [...text.matchAll(/\r?\n[\t ]*\r?\n(?:\s*\r?\n)*/gu)].map(m => m.index + m[0].length);
    const sentences = typeof Intl.Segmenter === 'function'
        ? [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)].map(s => s.index + s.segment.length)
        : [...text.matchAll(/[.!?]["'”’)\]]*(?:\s+|$)/gu)].map(m => m.index + m[0].length);
    const words = [...text.matchAll(/\s+/gu)].map(m => m.index + m[0].length);
    const lastBoundary = (boundaries: number[], floor: number, ceiling: number) => {
        let low = 0, high = boundaries.length;
        while (low < high) { const mid = (low + high) >>> 1; if (boundaries[mid]! <= ceiling) low = mid + 1; else high = mid; }
        return boundaries[low - 1]! >= floor ? boundaries[low - 1] : undefined;
    };
    const spans: Array<{start: number; end: number; text: string}> = [];
    for (let point = 0; point < offsets.length - 1;) {
        const last = Math.min(point + limit, offsets.length - 1), start = offsets[point]!;
        let end = offsets[last]!;
        if (last < offsets.length - 1) {
            // Avoid tiny fragments caused by an early heading/short sentence.
            const floor = offsets[point + Math.max(1, Math.floor(limit / 2))]!;
            end = lastBoundary(paragraphs, floor, end) ?? lastBoundary(sentences, floor, end)
                ?? lastBoundary(words, floor, end) ?? end;
        }
        spans.push({ start, end, text: text.slice(start, end) });
        while (offsets[point]! < end) point++;
    }
    return spans;
}
