import { create } from '@functional-systems/memdrive';
import type { ConnectionOptions } from '@functional-systems/memdrive';
export async function retentionConsumer(connection: ConnectionOptions) {
    const drive = await create({ ...connection, retentionInDays: 7 });
    const result = await drive.configure({ retentionInDays: 14 });
    const days: number = result.retentionInDays;
    // @ts-expect-error Store configuration is store-wide and takes no view.
    await drive.configure({ at: { kind: 'fork', name: 'draft' }, retentionInDays: 7 });
    // @ts-expect-error The SDK manages native snapshot retention.
    await drive.configure({ retentionInDays: 30, snapshotRetentionInDays: 1 });
    // @ts-expect-error Native snapshot retention is not a store option.
    await create({ ...connection, snapshotRetentionInDays: 1 });
    // Omitting the window selects the 30-day default.
    const defaulted = await create({ ...connection, embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'fixture' } });
    const window: number = (await defaulted.configure({ retentionInDays: 365 })).retentionInDays;
    return [days, window];
}
