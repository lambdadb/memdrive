import { create, open } from '@functional-systems/memdrive';
import { createDoclingChunker } from '@functional-systems/memdrive/docling';
import type { ChunkingOptions, ConnectionOptions, DoclingChunker, FileStoreDescription } from '@functional-systems/memdrive';
export async function chunkingConsumer(connection: ConnectionOptions) {
    const chunker: DoclingChunker = await createDoclingChunker({ tokenizer: '/local/tokenizer.json', maxTokens: 256 });
    const main = await create({ ...connection, chunking: { strategy: 'docling' }, chunker });
    await open({ ...connection, chunker });
    // Every managed store describes its persisted chunking configuration.
    const chunking: ChunkingOptions = (await main.describe()).chunking;
    // @ts-expect-error A managed description always includes chunking.
    const incomplete: FileStoreDescription = { ...await main.describe(), chunking: undefined };
    return { main, chunking, incomplete };
}
