import { create } from '@functional-systems/memdrive';
import type { ConnectionOptions, CreateFileRefRequest, CreateMainFileRefRequest, WorkingFileDrive, CheckpointFileDrive } from '@functional-systems/memdrive';
export async function historicalConsumer(connection: ConnectionOptions) {
    const main = await create(connection);
    const request: CreateMainFileRefRequest = { name: 'earlier', version: 'v1' };
    const work: WorkingFileDrive = await main.fork(request);
    const saved: CheckpointFileDrive = await main.checkpoint(request);
    const current: CreateFileRefRequest = { name: 'current' };
    await work.checkpoint(current);
    await saved.fork(current);
    // @ts-expect-error Time selection is removed from main.
    await main.fork({ name: 'invalid', asOf: new Date().toISOString() });
    // @ts-expect-error Version selection is only supported on main.
    await work.fork({ name: 'invalid', version: 'v1' });
    // @ts-expect-error Checkpoints already identify a fixed state.
    await saved.checkpoint({ name: 'invalid', version: 'v1' });
    // @ts-expect-error Working snapshot time selection is removed.
    await work.checkpoint({ name: 'invalid', asOf: new Date().toISOString() });
    const external = await create({ ...connection, embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'fixture' } });
    const vector: WorkingFileDrive<'external'> = await external.fork(request);
    return { saved, vector };
}
