import { create } from '@functional-systems/memdrive';
import type { CheckpointAt, ConnectionOptions, CreateFileRefRequest, FileRef, ForkAt } from '@functional-systems/memdrive';
export async function historicalConsumer(connection: ConnectionOptions) {
    const drive = await create(connection);
    const request: CreateFileRefRequest = { name: 'earlier', version: 'v1' };
    const work: FileRef<ForkAt> = await drive.fork(request);
    const saved: FileRef<CheckpointAt> = await drive.checkpoint(request);
    await drive.fork({ at: { kind: 'main' }, name: 'explicit-main', version: 'v0' });
    const current: CreateFileRefRequest = { at: work.at, name: 'current' };
    await drive.checkpoint(current);
    await drive.fork({ at: saved.at, name: 'current' });
    // @ts-expect-error Time selection is removed.
    await drive.fork({ name: 'invalid', asOf: new Date().toISOString() });
    // @ts-expect-error Version selection is only supported from a main source.
    await drive.fork({ at: work.at, name: 'invalid', version: 'v1' });
    // @ts-expect-error Checkpoints already identify a fixed state.
    await drive.checkpoint({ at: saved.at, name: 'invalid', version: 'v1' });
    // @ts-expect-error Working snapshot time selection is removed.
    await drive.checkpoint({ at: work.at, name: 'invalid', asOf: new Date().toISOString() });
    const external = await create({ ...connection, embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'fixture' } });
    const vector: FileRef<ForkAt> = await external.fork(request);
    return { saved, vector };
}
