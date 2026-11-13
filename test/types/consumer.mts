import { create, open, list, MemDriveError } from '@functional-systems/memdrive';
import { LambdaDBClient } from '@functional-systems/lambdadb';

const client = new LambdaDBClient({ baseUrl: 'https://example.invalid', projectName: 'sample', projectApiKey: 'synthetic' });
const drive = await create({ client, name: 'sample', mode: 'single_pass', metadataSchema: {} });
await drive.remember({ mems: [{ content: 'The meeting is on Friday.' }] });
await drive.recall({ query: 'When is the meeting?', rerank: false });
await open({ client, name: 'sample', mode: 'single_pass' });
await list({ client });
const error: Error = new MemDriveError('INVALID_INPUT', 'Example');
void error;
// @ts-expect-error Unknown modes must not type-check.
await create({ client, name: 'sample', mode: 'invalid', metadataSchema: {} });
