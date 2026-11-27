import type { CheckpointedWriteResult, LambdaDBClient, RollbackResult, WritableAt } from '@functional-systems/memdrive';
import { create, open, type DriveFile, type FileAt, type ForkAt, type CheckpointAt, type FileFilter, type FindTextResult, type DeleteFileResult,
    type SearchFilesResult, type ListFilesResult, type TreeFolder, type TreeRequest, type TreeResult, type FileDrive, type EmbeddingMode, type OpenFileStoreOptions, type FileRef } from '@functional-systems/memdrive';

export async function nativeRollbackConsumer(client: LambdaDBClient) {
    const { headSnapshot } = await client.collection('workspace').branches.rollback('main', { tag: 'checkpoint-saved' });
    // @ts-expect-error A rollback to an unpublished tag can return a null snapshot head.
    void headSnapshot.snapshotId;
    const snapshotId: string | undefined = headSnapshot?.snapshotId;
    return snapshotId;
}

export async function fileConsumer(client: LambdaDBClient, options: OpenFileStoreOptions) {
    const drive: FileDrive = await create({ client, name: 'workspace', metadataSchema: { topic: { type: 'string' } } });
    const { at }: FileRef<ForkAt> = await drive.fork({ name: 'research' });
    const created: DriveFile = await drive.write({ at, op: 'create', path: '/notes/context.md', content: '' });
    const reopened: FileDrive = await open({ client, name: 'workspace' });
    const file: DriveFile | null = await reopened.read({ at, fileId: created.fileId });
    const published: DriveFile | null = await reopened.read({ fileId: created.fileId });
    const batch: DriveFile[] = await reopened.write({ at, operations: [{ op: 'create', path: '/batch.txt', content: 'Batch' }] });
    await reopened.read({ at, paths: batch.map(item => item.path) });
    const update: DriveFile = await reopened.write({ at, op: 'update', fileId: created.fileId, newPath: '/renamed.md',
        edits: [{ oldText: 'before', newText: 'after' }] });
    const deleted: DeleteFileResult = await reopened.write({ at, op: 'delete', fileId: update.fileId });
    await reopened.write({ at, operations: [{ op: 'update', fileId: deleted.fileId, content: '' }, { op: 'delete', fileId: deleted.fileId }] });
    // @ts-expect-error Choose a full replacement or exact edits.
    await reopened.write({ at, op: 'update', fileId: update.fileId, content: '', edits: [] });
    // Omitted at writes to main.
    const onMain: DriveFile = await reopened.write({ op: 'create', path: '/main.md', content: '' });
    await reopened.write({ at: { kind: 'main' }, operations: [{ op: 'delete', fileId: onMain.fileId }] });
    // @ts-expect-error Checkpoints are read-only.
    await reopened.write({ at: { kind: 'checkpoint', name: 'saved' }, op: 'delete', fileId: created.fileId });
    // A checkpointed write returns the ordinary result and its checkpoint.
    const saved: CheckpointedWriteResult<DriveFile> = await reopened.write({ op: 'create', path: '/turn.md', content: '', checkpoint: { name: 'turn-1' } });
    const savedAt: CheckpointAt = saved.checkpoint.at;
    const savedBatch: CheckpointedWriteResult<(DriveFile | DeleteFileResult)[]> = await reopened.write({ at,
        operations: [{ op: 'delete', fileId: saved.result.fileId }], checkpoint: { name: 'turn-2' } });
    void savedAt; void savedBatch;
    // @ts-expect-error A checkpoint is named by an object.
    await reopened.write({ op: 'create', path: '/turn.md', content: '', checkpoint: 'turn-3' });
    // @ts-expect-error Batches are an operations array with at, not a bare array.
    await reopened.write([{ op: 'create', path: '/batch.txt', content: 'Batch' }]);
    const listed: ListFilesResult = await reopened.list({ at, prefix: '/notes/', delimiter: '/', limit: 2 });
    if (listed.next) {
        const nextAt: FileAt = listed.next.at;
        await reopened.list(listed.next);
        void nextAt;
    }
    await reopened.list({ cursor: 'opaque' });
    // @ts-expect-error A continuation inherits its original options.
    await reopened.list({ at, cursor: 'opaque', prefix: '/other/' });
    // @ts-expect-error Listing returns file metadata without original content.
    listed.files[0]?.content;
    // @ts-expect-error Continuations are returned as next, not a bare cursor.
    listed.cursor;
    // @ts-expect-error Listings are path-ordered and consistent on branches; there is no consistency marker.
    listed.consistency;
    const treeRequest: TreeRequest = { at, prefix: '/notes/' };
    const tree: TreeResult = await reopened.tree(treeRequest);
    const folder: TreeFolder | undefined = tree.folders[0];
    const counted: number = tree.fileCount + (folder?.fileCount ?? 0);
    const truncated: boolean = tree.truncated;
    void counted; void truncated;
    await reopened.tree();
    await reopened.tree({ at: { kind: 'checkpoint', name: 'saved' } });
    // @ts-expect-error A tree is one call; it has no limit or cursor.
    await reopened.tree({ prefix: '/', limit: 10 });
    // @ts-expect-error A tree folder carries no files.
    folder?.files;
    const ranked: SearchFilesResult = await reopened.search({ at, query: 'Task context', filter: topicFilter, rerank: { onFailure: 'returnOriginal' } });
    ranked.hits[0]?.range?.start;
    for (const mode of ['semantic', 'keyword', 'hybrid'] as const) {
        await reopened.search({ query: 'checkpoint', mode });
        await reopened.search({ at, query: 'checkpoint', mode, rerank: true, embeddingQuery: 'preserve work' });
    }
    // @ts-expect-error Search modes are explicit; there is no automatic routing mode.
    await reopened.search({ query: 'checkpoint', mode: 'auto' });
    const exact: FindTextResult = await reopened.findText({ at, query: 'Task context', prefix: '/notes/', filter: topicFilter });
    exact.hits[0]?.context.range.start;
    const hit = exact.hits[0];
    if (hit) {
        // Hit lines feed a bounded read of the lines containing the match.
        const { startLine, endLine }: { startLine: number; endLine: number } = hit.range;
        await reopened.read({ at, fileId: hit.fileId, startLine, endLine });
        // @ts-expect-error Context excerpts keep offsets only.
        hit.context.range.startLine;
    }
    if (exact.next) await reopened.findText(exact.next);
    // @ts-expect-error A continuation inherits its original options.
    await reopened.findText({ cursor: 'opaque', filter: topicFilter });
    // @ts-expect-error Merge, diff, status, history and configure are removed.
    await reopened.merge({ at, summary: 'Save the research' });
    // @ts-expect-error Merge, diff, status, history and configure are removed.
    await reopened.diff({ at });
    // @ts-expect-error Merge, diff, status, history and configure are removed.
    await reopened.status();
    // @ts-expect-error Merge, diff, status, history and configure are removed.
    await reopened.history();
    // @ts-expect-error Merge, diff, status, history and configure are removed.
    await reopened.configure({ retentionInDays: 7 });
    // @ts-expect-error Retention is not an SDK option.
    await create({ client, name: 'workspace', retentionInDays: 7 });
    // @ts-expect-error Refs are created from the current state of a view; there is no version.
    await drive.fork({ name: 'past', version: 'v1' });
    // @ts-expect-error Views are selected per request, not when opening.
    await open({ client, name: 'workspace', at: { kind: 'fork', name: 'research' } });
    const checkpoint: FileRef<CheckpointAt> = await reopened.checkpoint({ at, name: 'saved' });
    await reopened.read({ at: checkpoint.at, fileId: created.fileId });
    await reopened.findText({ at: checkpoint.at, query: 'saved' });
    await drive.findText({ query: 'saved' });
    await drive.fork({ at: checkpoint.at, name: 'from-saved' });
    await drive.fork({ at, name: 'nested' });
    // @ts-expect-error A view is identified by one kind.
    await drive.read({ at: { kind: 'fork', fork: 'research' }, fileId: created.fileId });
    const restored: RollbackResult = await drive.rollback({ at, to: checkpoint.at }, { signal: new AbortController().signal });
    const restoredAt: WritableAt = restored.at;
    await drive.rollback({ at: { kind: 'main' }, to: checkpoint.at });
    // @ts-expect-error Rollback requires an explicit target.
    await drive.rollback({ to: checkpoint.at });
    // @ts-expect-error A checkpoint cannot be rolled back.
    await drive.rollback({ at: checkpoint.at, to: checkpoint.at });
    // @ts-expect-error Rollback restores from a checkpoint only.
    await drive.rollback({ at, to: { kind: 'main' } });
    const selected: FileDrive = await open(options);
    // @ts-expect-error Path and ID selectors are mutually exclusive.
    await selected.read({ fileId: created.fileId, path: created.path });
    // @ts-expect-error View handles are removed.
    selected.at;
    return { file, published, restoredAt };
}

const topicFilter: FileFilter = { field: 'metadata.topic', op: 'eq', value: 'local' };

export async function externalFileConsumer(client: LambdaDBClient, options: OpenFileStoreOptions<EmbeddingMode>) {
    const embedding = { mode: 'external', dimensions: 64, similarity: 'cosine', identity: 'caller-model' } as const;
    const drive = await create({ client, name: 'workspace', embedding, metadataSchema: { topic: { type: 'string' } } });
    const { at } = await drive.fork({ name: 'semantic' });
    const vector: readonly number[] = Array(64).fill(0.25);
    const [file] = await drive.write({ at, operations: [{ op: 'create', path: '/note', content: vector }] });
    const reopened: FileDrive<'external'> = await open({ client, name: 'workspace', mode: 'external' });
    const reference = await reopened.read({ at, fileId: file!.fileId });
    const vectorTree: TreeResult = await reopened.tree({ at });
    void vectorTree;
    await reopened.write({ at, op: 'update', fileId: file!.fileId, content: vector, newPath: '/updated' });
    const hits = await drive.search({ query: vector, filter: topicFilter });
    const results: false = hits.reranked;
    const saved = await reopened.checkpoint({ at, name: 'saved' });
    await reopened.rollback({ at, to: saved.at });
    await drive.search({ at: saved.at, query: vector });
    const modelIdentity: string = (await drive.describe()).embedding.identity;

    const mixed = await open(options);
    if (mixed.findText) await mixed.findText({ query: 'saved' });
    // @ts-expect-error Literal matching is available only for managed text stores.
    await drive.findText({ query: 'text' });

    // @ts-expect-error External reads omit text.
    reference?.content;
    // @ts-expect-error External search hits omit stored vectors.
    hits.hits[0]?.embedding;
    // @ts-expect-error External file creates require a caller-provided embedding.
    await drive.write({ at, op: 'create', path: '/text', content: 'text' });
    // @ts-expect-error External search accepts vectors only.
    await drive.search({ query: 'text' });
    // @ts-expect-error External writes accept vectors through content.
    await drive.write({ at, op: 'create', path: '/old-shape', embedding: vector });
    // @ts-expect-error External updates accept vectors through content.
    await drive.write({ at, op: 'update', fileId: file!.fileId, embedding: vector });
    // @ts-expect-error External searches accept vectors through query.
    await drive.search({ queryVector: vector });
    // @ts-expect-error External search has no text retrieval modes.
    await drive.search({ query: vector, mode: 'semantic' });
    // @ts-expect-error External search cannot request a text reranker.
    await drive.search({ query: vector, rerank: true });
    // @ts-expect-error Checkpoints do not mutate content.
    await drive.write({ at: saved.at, op: 'delete', fileId: file!.fileId });
    // @ts-expect-error External stores do not configure text indexes.
    await create({ client, name: 'workspace', embedding, textSearch: { analyzers: ['standard'] } });
    return { results, modelIdentity, reference };
}
