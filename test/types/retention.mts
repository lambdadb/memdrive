import { create } from '@functional-systems/memdrive';
import type { ConnectionOptions } from '@functional-systems/memdrive';
export async function retentionConsumer(connection: ConnectionOptions) {
    const drive = await create({ ...connection, retentionInDays: 7 });
    const result = await drive.configure({ retentionInDays: 14 });
    const days: number | undefined = result.retentionInDays;
    // @ts-expect-error Store configuration is store-wide and takes no view.
    await drive.configure({ at: { kind: 'fork', name: 'draft' }, retentionInDays: 7 });
    return days;
}
