import type { LambdaDBClient } from '@functional-systems/lambdadb';
import { MemDrive, type MainFileDrive, type WorkingFileDrive } from '@functional-systems/memdrive';

export async function commonJsConsumer(client: LambdaDBClient) {
    const main: MainFileDrive = await MemDrive.open({ client, name: 'workspace' });
    const fork: WorkingFileDrive = await main.fork({ name: 'research' });
    return fork.write({ op: 'create', path: '/note.md', content: '# Note' });
}
