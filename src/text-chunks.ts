import { keysOnly } from './config.js';
import { chunkSpans } from './chunking.js';
import { checkAbort, MemDriveError, requireInput } from './errors.js';
import type { ChunkingOptions, DoclingChunker, RequestOptions } from './types.js';

export type TextChunk = { text: string; contextualized: string; start?: number | undefined; end?: number | undefined };
export type ResolvedChunking = { strategy: 'boundary' | 'none' | 'docling'; version: string };
export type TextChunker = (file: { path: string; content: string }, options?: RequestOptions) => Promise<{ chunks: TextChunk[]; resolved: ResolvedChunking }>;

export function resolvedChunking(value: unknown): ResolvedChunking | undefined {
    if (value === undefined) return undefined;
    if (!keysOnly(value, ['strategy', 'version']) || typeof value.strategy !== 'string' || !['boundary', 'none', 'docling'].includes(value.strategy)
        || typeof value.version !== 'string' || !value.version || value.version.length > 200)
        throw new MemDriveError('INVALID_RESULT', 'The original has invalid chunking provenance.');
    return { strategy: value.strategy as ResolvedChunking['strategy'], version: value.version };
}

export function chunkingOptions(value: unknown): ChunkingOptions {
    requireInput(keysOnly(value, ['strategy']) && typeof value.strategy === 'string' && ['auto', 'boundary', 'none', 'docling'].includes(value.strategy),
        'Chunking strategy must be auto, boundary, none or docling.');
    return { strategy: value.strategy as ChunkingOptions['strategy'] };
}

export function structuredFormat(path: string, content: string): string | undefined {
    const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    const formats: Record<string, string> = { md: 'md', markdown: 'md', html: 'html', htm: 'html', csv: 'csv',
        adoc: 'asciidoc', asciidoc: 'asciidoc', tex: 'latex', xml: 'xml' };
    if (formats[extension]) return formats[extension];
    if (/^\s*(?:<!doctype html\b|<html\b)/i.test(content)) return 'html';
    if (/^\s*<\?xml\s/.test(content)) return 'xml';
    return undefined;
}

export function textChunker(configuration: ChunkingOptions, backend?: DoclingChunker, requireBackend = false): TextChunker {
    const { strategy } = chunkingOptions(configuration);
    requireInput(backend === undefined || typeof backend === 'object' && backend !== null
        && typeof backend.id === 'string' && backend.id.length > 0 && backend.id.length <= 200
        && typeof backend.chunk === 'function', 'Provide a Docling chunker created by the optional Node adapter.');
    if (requireBackend && strategy === 'docling' && !backend)
        throw new MemDriveError('CHUNKER_UNAVAILABLE', 'The configured Docling strategy requires a local Docling chunker.');
    return async ({ path, content }, options) => {
        checkAbort(options?.signal);
        if (strategy === 'docling' && !backend)
            throw new MemDriveError('CHUNKER_UNAVAILABLE', 'Writing this store requires its configured local Docling backend.');
        const format = structuredFormat(path, content);
        if (strategy === 'docling' || strategy === 'auto' && format && backend) {
            if (!format) throw new MemDriveError('UNSUPPORTED_FORMAT', 'Docling chunking requires a supported structured text format.');
            const results = await backend!.chunk({ path, content, format }, options);
            checkAbort(options?.signal);
            if (!Array.isArray(results) || !results.every(chunk => typeof chunk?.text === 'string' && chunk.text.trim()
                && typeof chunk.contextualized === 'string' && chunk.contextualized.trim()
                && !/\p{Surrogate}/u.test(chunk.text + chunk.contextualized)))
                throw new MemDriveError('INVALID_CHUNKS', 'Docling did not return valid nonempty text chunks.');
            const chunks: TextChunk[] = results.map(({ text, contextualized }) => {
                const start = content.indexOf(text);
                const unique = start >= 0 && content.indexOf(text, start + 1) < 0;
                return { text, contextualized, ...(unique ? { start, end: start + text.length } : {}) };
            });
            // The parser omits YAML front matter. Keep it searchable as exact
            // source text; semantic front-matter policy remains with the host.
            const front = format === 'md' ? /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(content)?.[0] : undefined;
            if (front && results.length) chunks.unshift(...chunkSpans(front).filter(chunk => chunk.text.trim())
                .map(chunk => ({ ...chunk, contextualized: chunk.text })));
            // Heading-only documents can produce no body chunks. Preserve an
            // exact searchable representation instead of silently dropping them.
            if (!chunks.length && content.trim()) chunks.push(...chunkSpans(content).filter(chunk => chunk.text.trim())
                .map(chunk => ({ ...chunk, contextualized: chunk.text })));
            return { chunks, resolved: { strategy: 'docling', version: backend!.id } };
        }
        const chunks = (strategy === 'none' ? [{ text: content, start: 0, end: content.length }] : chunkSpans(content))
            .filter(chunk => chunk.text.trim()).map(chunk => ({ ...chunk, contextualized: chunk.text }));
        return { chunks, resolved: { strategy: strategy === 'none' ? 'none' : 'boundary', version: '1' } };
    };
}
