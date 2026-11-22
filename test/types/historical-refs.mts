import { create } from '@functional-systems/memdrive';
import type { ConnectionOptions, CreateFileRefRequest, WorkingFileDrive, CheckpointFileDrive } from '@functional-systems/memdrive';
export async function historicalConsumer(connection: ConnectionOptions) {
    const main = await create(connection);
    const request: CreateFileRefRequest = { name: 'earlier', asOf: new Date().toISOString() };
    const work: WorkingFileDrive = await main.fork(request);
    const saved: CheckpointFileDrive = await work.checkpoint(request);
    // @ts-expect-error asOf is a JSON-compatible ISO timestamp, not Unix milliseconds.
    await main.fork({ name: 'invalid', asOf: Date.now() });
    const external = await create({ ...connection, embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'fixture' } });
    const vector: WorkingFileDrive<'external'> = await external.fork(request);
    return { saved, vector };
}
