import type { LambdaDBClient } from '@functional-systems/lambdadb';
import { create, open, type DriveFile, type FileDrive, type OpenFileStoreOptions } from '@functional-systems/memdrive';

export async function fileConsumer(client: LambdaDBClient, options: OpenFileStoreOptions) {
    const main = await create({ client, name: 'workspace' });
    const fork = await main.fork({ name: 'research' });
    const created: DriveFile = await fork.write({ op: 'create', path: '/notes/context.md', content: '' });
    const reopened = await open({ client, name: 'workspace', at: { fork: 'research' } });
    const file: DriveFile | null = await reopened.read({ fileId: created.fileId });
    const selected: FileDrive = await open(options);
    if ('write' in selected) await selected.write({ op: 'create', path: '/another.md', content: '' });
    // @ts-expect-error Only a working fork has a write method.
    await main.write({ op: 'create', path: '/main.md', content: '' });
    // @ts-expect-error Path and ID selectors are mutually exclusive.
    await selected.read({ fileId: created.fileId, path: created.path });
    return file;
}
