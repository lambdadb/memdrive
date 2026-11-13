import { create, open, list, MemDriveError } from '@functional-systems/memdrive';
import { LambdaDBClient } from '@functional-systems/lambdadb';

async function consume() {
    const client = new LambdaDBClient({ baseUrl: 'https://example.invalid', projectName: 'sample', projectApiKey: 'synthetic' });
    const drive = await create({ client, name: 'sample', mode: 'single_pass', metadataSchema: {} });
    await drive.recall({ query: 'What changed?' });
    await open({ client, name: 'sample', mode: 'single_pass' });
    await list({ client });
    return new MemDriveError('INVALID_INPUT', 'Example');
}
void consume;
