import { create } from '@functional-systems/memdrive';
import type { ConnectionOptions, HistoryPruneResult } from '@functional-systems/memdrive';
export async function pruneConsumer(connection: ConnectionOptions) {
    const main = await create({ ...connection, retentionInDays: 7 });
    const preview: HistoryPruneResult = await main.pruneHistory();
    await main.pruneHistory({ dryRun: false, limit: 100 }, { signal: AbortSignal.timeout(1000) });
    const fork = await main.fork({ name: 'draft' });
    // @ts-expect-error Internal history maintenance belongs to main.
    await fork.pruneHistory();
    const external = await create({ ...connection, embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'fixture' } });
    await external.pruneHistory();
    return preview.tags;
}
