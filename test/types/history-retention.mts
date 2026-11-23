import { create } from '@functional-systems/memdrive';
import type { ConnectionOptions } from '@functional-systems/memdrive';
export async function retentionConsumer(connection: ConnectionOptions) {
    const drive = await create({ ...connection, retentionInDays: 7 });
    await drive.configure({ retentionInDays: 14 });
    // @ts-expect-error Retention is automatic; no public cleanup API.
    await drive.pruneHistory();
    const { at } = await drive.fork({ name: 'draft' });
    await drive.merge({ at, requestId: 'publish', summary: 'Publish draft' });
    const external = await create({ ...connection, retentionInDays: 7,
        embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'fixture' } });
    // @ts-expect-error Retention is automatic in both embedding modes.
    await external.pruneHistory();
}
