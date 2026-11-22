import { create, open } from '@functional-systems/memdrive';
import { createDoclingChunker } from '@functional-systems/memdrive/docling';
import type { ConnectionOptions, DoclingChunker } from '@functional-systems/memdrive';
export async function chunkingConsumer(connection: ConnectionOptions) {
    const chunker: DoclingChunker = await createDoclingChunker({ tokenizer: '/local/tokenizer.json', maxTokens: 256 });
    const main = await create({ ...connection, chunking: { strategy: 'docling' }, chunker });
    await open({ ...connection, chunker });
    return main;
}
