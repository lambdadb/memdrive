import { create } from '@functional-systems/memdrive';
import type { ConnectionOptions } from '@functional-systems/memdrive';
export async function retentionConsumer(connection: ConnectionOptions) {
    const main = await create({ ...connection, retentionInDays: 7 });
    const result = await main.configure({ retentionInDays: 14 });
    const days: number | undefined = result.retentionInDays;
    const fork = await main.fork({ name: 'draft' });
    // @ts-expect-error Store configuration belongs to main.
    await fork.configure({ retentionInDays: 7 });
    return days;
}
