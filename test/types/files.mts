import type { LambdaDBClient } from '@functional-systems/lambdadb';
import type { FileHistoryResult, FileStoreStatus } from '@functional-systems/memdrive';
import { create, open, type DriveFile, type CheckpointFileDrive, type FileChange, type FileFilter, type FindTextResult, type DeleteFileResult, type SearchFilesResult, type ListFilesResult, type FileDrive, type EmbeddingMode, type MergeResult, type OpenFileStoreOptions } from '@functional-systems/memdrive';

export async function fileConsumer(client: LambdaDBClient, options: OpenFileStoreOptions) {
    const main = await create({ client, name: 'workspace', metadataSchema: { topic: { type: 'string' } } });
    const fork = await main.fork({ name: 'research' });
    const created: DriveFile = await fork.write({ op: 'create', path: '/notes/context.md', content: '' });
    const reopened = await open({ client, name: 'workspace', at: { fork: 'research' } });
    const file: DriveFile | null = await reopened.read({ fileId: created.fileId });
    const batch: DriveFile[] = await reopened.write([{ op: 'create', path: '/batch.txt', content: 'Batch' }]);
    await reopened.read({ paths: batch.map(item => item.path) });
    const update: DriveFile = await reopened.write({ op: 'update', fileId: created.fileId, newPath: '/renamed.md',
        edits: [{ oldText: 'before', newText: 'after' }] });
    const deleted: DeleteFileResult = await reopened.write({ op: 'delete', fileId: update.fileId });
    await reopened.write([{ op: 'update', fileId: deleted.fileId, content: '' }, { op: 'delete', fileId: deleted.fileId }]);
    // @ts-expect-error Choose a full replacement or exact edits.
    await reopened.write({ op: 'update', fileId: update.fileId, content: '', edits: [] });
    const listed: ListFilesResult = await reopened.list({ prefix: '/notes/', delimiter: '/', limit: 2 });
    if (listed.cursor) await reopened.list({ cursor: listed.cursor });
    // @ts-expect-error A continuation inherits its original options.
    await reopened.list({ cursor: 'opaque', prefix: '/other/' });
    // @ts-expect-error Listing returns file metadata without original content.
    listed.files[0]?.content;
    const ranked: SearchFilesResult = await reopened.search({ query: 'Task context', filter: topicFilter, rerank: { onFailure: 'returnOriginal' } });
    ranked.hits[0]?.range?.start;
    const exact: FindTextResult = await reopened.findText({ query: 'Task context', prefix: '/notes/', filter: topicFilter });
    exact.hits[0]?.context.range.start;
    if (exact.cursor) await reopened.findText({ cursor: exact.cursor });
    // @ts-expect-error A continuation inherits its original options.
    await reopened.findText({ cursor: 'opaque', filter: topicFilter });
    const changes: FileChange[] = await reopened.diff({ signal: new AbortController().signal });
    for (const change of changes) if (change.op === 'update' || change.op === 'delete') change.previousPath;
    // @ts-expect-error Diff is available only on working forks.
    await main.diff();
    const merged: MergeResult = await reopened.merge({ requestId: 'batch-1', summary: 'Save the research' });
    const mainVersion: string = merged.version;
    void mainVersion;
    await open({ client, name: 'workspace', recover: true });
    // @ts-expect-error Publication is available only on working forks.
    await main.merge({ requestId: 'batch-1', summary: 'Save the research' });
    // @ts-expect-error Recovery is only available when opening main.
    await open({ client, name: 'workspace', at: { fork: 'research' }, recover: true });
    const checkpoint: CheckpointFileDrive = await reopened.checkpoint({ name: 'saved' });
    const pinned: CheckpointFileDrive = await open({ client, name: 'workspace', at: { checkpoint: 'saved' } });
    await pinned.read({ fileId: created.fileId });
    await pinned.findText({ query: 'saved' });
    await main.findText({ query: 'saved' });
    await checkpoint.fork({ name: 'from-saved' });
    await reopened.fork({ name: 'nested' });
    // @ts-expect-error Choose exactly one named view.
    await open({ client, name: 'workspace', at: { checkpoint: 'saved', fork: 'research' } });
    // @ts-expect-error Checkpoints do not mutate content.
    await pinned.write({ op: 'delete', fileId: created.fileId });
    // @ts-expect-error Diff is only available on mutable forks.
    await pinned.diff();
    // @ts-expect-error Checkpoint handles cannot publish.
    await pinned.merge({ requestId: 'batch-1', summary: 'Save the research' });
    const selected: FileDrive = await open(options);
    const state: FileStoreStatus = await selected.status();
    const history: FileHistoryResult = await selected.history({ sinceVersion: state.mainVersion, limit: 1 });
    if (history.cursor) await selected.history({ cursor: history.cursor });
    // @ts-expect-error Continuation is scoped to the original history request.
    await selected.history({ cursor: 'cursor', sinceVersion: 'v1' });
    if ('write' in selected) await selected.write({ op: 'create', path: '/another.md', content: '' });
    // @ts-expect-error Only a working fork has a write method.
    await main.write({ op: 'create', path: '/main.md', content: '' });
    // @ts-expect-error Path and ID selectors are mutually exclusive.
    await selected.read({ fileId: created.fileId, path: created.path });
    return file;
}

const topicFilter: FileFilter = { field: 'metadata.topic', op: 'eq', value: 'local' };

export async function externalFileConsumer(client: LambdaDBClient, options: OpenFileStoreOptions<EmbeddingMode>) {
    const embedding = { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'caller-model' } as const;
    const main = await create({ client, name: 'workspace', embedding, metadataSchema: { topic: { type: 'string' } } });
    const work = await main.fork({ name: 'semantic' });
    const vector: readonly number[] = Array(64).fill(0.25);
    const [file] = await work.write([{ op: 'create', path: '/note', content: vector }]);
    const reopened = await open({ client, name: 'workspace', mode: 'external', at: { fork: 'semantic' } });
    const reference = await reopened.read({ fileId: file!.fileId });
    await reopened.write({ op: 'update', fileId: file!.fileId, content: vector, newPath: '/updated' });
    await reopened.merge({ requestId: 'publish-1', summary: 'Save the vector files' });
    const hits = await main.search({ query: vector, filter: topicFilter });
    const results: false = hits.reranked;
    const saved = await reopened.checkpoint({ name: 'saved' });
    const pinned = await open({ client, name: 'workspace', mode: 'external', at: { checkpoint: 'saved' } });
    const state: FileStoreStatus = await pinned.status();
    const history: FileHistoryResult = await work.history({ sinceVersion: state.mainVersion });
    await saved.search({ query: vector });
    await pinned.search({ query: vector });
    const modelIdentity: string = (await main.describe()).embedding.identity;

    const mixed = await open(options);
    if (mixed.findText) await mixed.findText({ query: 'saved' });
    // @ts-expect-error Literal matching is available only for managed text stores.
    await main.findText({ query: 'text' });

    // @ts-expect-error External reads omit text.
    reference?.content;
    // @ts-expect-error External search hits omit stored vectors.
    hits.hits[0]?.embedding;
    // @ts-expect-error External file creates require a caller-provided embedding.
    await work.write({ op: 'create', path: '/text', content: 'text' });
    // @ts-expect-error External search accepts vectors only.
    await main.search({ query: 'text' });
    // @ts-expect-error External writes accept vectors through content.
    await work.write({ op: 'create', path: '/old-shape', embedding: vector });
    // @ts-expect-error External updates accept vectors through content.
    await work.write({ op: 'update', fileId: file!.fileId, embedding: vector });
    // @ts-expect-error External searches accept vectors through query.
    await main.search({ queryVector: vector });
    // @ts-expect-error External search cannot request a text reranker.
    await main.search({ query: vector, rerank: true });
    // @ts-expect-error Checkpoints do not mutate content.
    await pinned.write({ op: 'delete', fileId: file!.fileId });
    // @ts-expect-error External stores do not configure text indexes.
    await create({ client, name: 'workspace', embedding, textSearch: { analyzers: ['standard'] } });
    return { results, modelIdentity, reference, history };
}
