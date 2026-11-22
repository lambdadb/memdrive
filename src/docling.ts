import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { checkAbort, MemDriveError, operationOptions, requireInput } from './errors.js';
import type { DoclingChunker } from './types.js';

/** Optional Node entry point. Install docling.rs@2.85.0 separately and provide a local tokenizer. */
export async function createDoclingChunker(options: { tokenizer: string; maxTokens?: number; mergePeers?: boolean }): Promise<DoclingChunker> {
    requireInput(options !== null && typeof options === 'object' && Object.keys(options).every(key => ['tokenizer', 'maxTokens', 'mergePeers'].includes(key))
        && typeof options.tokenizer === 'string' && options.tokenizer.length > 0,
    'Provide a local tokenizer.json path and optional maxTokens/mergePeers.');
    const { tokenizer, maxTokens = 256, mergePeers = true } = options;
    requireInput(Number.isSafeInteger(maxTokens) && maxTokens >= 16 && maxTokens <= 8192 && typeof mergePeers === 'boolean',
        'maxTokens must be 16–8192 and mergePeers must be boolean.');
    let binding: typeof import('docling.rs');
    let tokenizerHash: string;
    try {
        binding = await import('docling.rs');
        tokenizerHash = createHash('sha256').update(await readFile(tokenizer)).digest('hex');
    } catch (cause) {
        throw new MemDriveError('CHUNKER_UNAVAILABLE', 'Install docling.rs@2.85.0 and provide a readable local tokenizer.json.', { cause });
    }
    const id = `docling.rs/2.85.0:${tokenizerHash}:${maxTokens}:${mergePeers}`;
    return Object.freeze({ id, async chunk(file, requestOptions) {
        const { signal } = operationOptions(requestOptions);
        checkAbort(signal);
        // The tokenizer contributes to persisted chunk identity. Do not silently
        // change segmentation after an on-disk tokenizer replacement.
        let currentHash: string;
        try { currentHash = createHash('sha256').update(await readFile(tokenizer)).digest('hex'); }
        catch (cause) { throw new MemDriveError('CHUNKER_UNAVAILABLE', 'The configured tokenizer is no longer readable.', { cause }); }
        if (currentHash !== tokenizerHash)
            throw new MemDriveError('CHUNKER_CHANGED', 'The configured tokenizer changed. Create a new chunker explicitly.');
        let chunks;
        try {
            chunks = await binding.chunkAsync({ name: file.path, data: Buffer.from(file.content), format: file.format },
                { chunker: 'hybrid', tokenizer, maxTokens, mergePeers });
        } catch (cause) {
            throw new MemDriveError('CHUNKING_FAILED', 'Local Docling Hybrid chunking failed.', { cause });
        }
        checkAbort(signal);
        return chunks.map(({ text, contextualized }) => ({ text, contextualized }));
    } } satisfies DoclingChunker);
}
