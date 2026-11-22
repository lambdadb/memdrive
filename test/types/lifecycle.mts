import { create, destroy, MemDrive } from '@functional-systems/memdrive';
import type { ConnectionOptions, FileDrive, FileRefEntry } from '@functional-systems/memdrive';

export async function lifecycleConsumer(connection: ConnectionOptions, external: FileDrive<'external'>) {
    const main = await create(connection);
    const forks: FileRefEntry[] = await main.listForks();
    const checkpoints: FileRefEntry[] = await external.listCheckpoints({ signal: new AbortController().signal });
    const work = await main.fork({ name: 'draft' });
    const checkpoint = await work.checkpoint({ name: 'saved' });
    await checkpoint.delete();
    await work.delete();
    // @ts-expect-error Main cannot be deleted as a reference.
    await main.delete();
    await destroy(connection);
    await MemDrive.destroy(connection, { signal: new AbortController().signal });
    return { forks, checkpoints };
}
