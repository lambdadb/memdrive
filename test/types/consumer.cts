import { LambdaDBClient, MemDrive, type FileDrive, type ForkAt } from '@functional-systems/memdrive';

export async function commonJsConsumer(client: LambdaDBClient) {
    const drive: FileDrive = await MemDrive.open({ client, name: 'workspace' });
    const at: ForkAt = (await drive.fork({ name: 'research' })).at;
    return drive.write({ at, op: 'create', path: '/note.md', content: '# Note' });
}
