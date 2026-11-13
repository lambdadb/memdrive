import { create, open, type Filter, type Match, type MemInput } from '@functional-systems/memdrive';
import type { MetadataSchema } from '@functional-systems/memdrive/types';
import { LambdaDBClient } from '@functional-systems/lambdadb';

const client = new LambdaDBClient({ baseUrl: 'https://example.invalid', projectName: 'sample', projectApiKey: 'synthetic' });
const metadataSchema: MetadataSchema = {
    tags: { type: 'string[]', description: 'Topics' },
    date: { type: 'datetime' },
};
const filter: Filter = { and: [
    { field: 'metadata.tags', op: 'in', value: ['music', 'sport'] },
    { field: 'timestamp', op: 'gte', value: '2026-01-01T00:00:00Z' },
    { field: 'timestamp', op: 'lte', value: '2026-12-31T23:59:59Z' },
] };
const signal = new AbortController().signal;
const drive = await create({ client, name: 'sample', metadataSchema,
    textSearch: { analyzers: ['english'] }, embedding: { mode: 'managed' }, labels: { app: 'sample' } });
await drive.remember({ mems: [{ content: 'Piano practice is on Friday.', metadata: { tags: ['music'] } }] }, { signal });
const one = await drive.recall({ query: 'When is practice?', filter, rerank: false }, { signal });
const matches: Match[] = one.matches;
for (const match of matches) {
    if (match.content !== undefined) {
        const text: string = match.content;
        const start: number = match.start;
        void [text, start];
    }
}
const batch = await drive.recall({ requests: [{ query: 'When?' }, { query: 'Which instrument?' }] });
for (const result of batch.results) {
    if ('error' in result) {
        const code: string = result.error.code;
        void code;
    } else {
        const memIds: string[] = result.matches.map(match => match.memId);
        await drive.read({ ids: memIds });
    }
}
await drive.configure({ description: 'Practice memories' });
await drive.configure({ metadataSchema });
await drive.forget({ filter });
await drive.branches.create({ name: 'draft', source: { branch: 'main' } });
const branch = drive.at({ branch: 'draft' });
await branch.recall({ query: 'When?' });
// @ts-expect-error A branch data handle cannot destroy the collection.
await branch.destroy();

const descriptor = await drive.describe();
const declaredFields: MetadataSchema = descriptor.metadataSchema;
const distribution = await branch.countValues({ fields: ['metadata.tags'], filter, excludeIds: ['excluded'], limit: 5 }, { signal });
const fetchedAt: string = distribution.asOf;
const more: boolean | null = distribution.values['metadata.tags'].hasMore;
const count: number = distribution.values['metadata.tags'].buckets[0].count;
void [declaredFields, fetchedAt, more, count];
// @ts-expect-error Retrieval mode is no longer part of recall.
await drive.recall({ query: 'text', mode: 'agentic' });
// @ts-expect-error Model adapters belong to the caller.
await open({ client, name: 'sample', agent: {} });
// @ts-expect-error Schema inspection uses describe, not a second API.
await drive.getSchema();
// @ts-expect-error Count requests require explicit fields.
await drive.countValues({});
// @ts-expect-error Counts accept a structured filter.
await drive.countValues({ fields: ['id'], filter: 'id:*' });
const external = await create({ client, name: 'vectors', metadataSchema: {},
    embedding: { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'test-v1' } });
await external.remember({ mems: [{ id: 'vector-1', embedding: Array(64).fill(1) }] });
await external.recall({ queryVector: Array(64).fill(1), rerank: false });

// @ts-expect-error A memory contains text or an embedding, never both.
const invalidMem: MemInput = { content: 'text', embedding: [1] };
// @ts-expect-error Filters use neq, not an arbitrary native query operator.
const invalidFilter: Filter = { field: 'id', op: 'ne', value: 'one' };
// @ts-expect-error Recall accepts one query representation at a time.
await drive.recall({ query: 'text', queryVector: [1] });
// @ts-expect-error Vector retrieval cannot enable text reranking.
await external.recall({ queryVector: [1], rerank: true });
// @ts-expect-error Reranking is a per-recall option.
await open({ client, name: 'sample', rerank: true });
// @ts-expect-error Creation requires an explicit metadata declaration.
await create({ client, name: 'sample' });
// @ts-expect-error Configure requires at least one changed setting.
await drive.configure({});
// @ts-expect-error Forget selects by IDs or filter, never both.
await drive.forget({ ids: ['one'], filter });
// @ts-expect-error Null is not a boolean rerank setting.
await drive.recall({ query: 'text', rerank: null });
void [invalidMem, invalidFilter];
