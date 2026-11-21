# MemDrive

TypeScript file SDK backed by LambdaDB. MemDrive accepts an initialized LambdaDB client. The application owns connection credentials and transport.

The package is `@functional-systems/memdrive`, licensed under Apache-2.0. It supports ESM, CommonJS, TypeScript, Node.js 20.12+, and browser bundlers.

## File stores

Use `@functional-systems/memdrive` to create a text file store and save exact originals on a working fork. These stores use a dedicated layout and require a fresh collection name.

```ts
import { MemDrive } from '@functional-systems/memdrive';

const main = await MemDrive.create({ client, name: 'workspace' });
const work = await main.fork({ name: 'research' });
const file = await work.write({
    op: 'create',
    path: '/notes/context.md',
    content: '# Task context\r\n',
});

const reopened = await MemDrive.open({ client, name: 'workspace', at: { fork: 'research' } });
const saved = await reopened.read({ fileId: file.fileId });
const { hits, reranked } = await reopened.search({ query: 'Task context', limit: 5 });
// The same file is available through { path: '/notes/context.md' }.
```

`read` returns the original file or `null` when absent. Content can be empty and the SDK preserves whitespace and line endings. Paths are case-sensitive, absolute and slash-separated. Pass an array of up to 100 operations to write files in batches. Pass up to 100 distinct paths in `read({ paths })` to read existing files in request order. An existing path in the same fork rejects creation with `PATH_EXISTS`. Main is read-only and supplies the starting view for creating a fork. Working edits are scoped to that fork. A store can declare scalar metadata fields with `metadataSchema` and carry collection labels. File writes attach optional `metadata` and record the modification time.

Search ranks file chunks with Bayesian lexical and vector retrieval. The store defaults to LambdaDB's `standard` analyzer and OpenAI's managed `text-embedding-3-small` embeddings. Set `textSearch.analyzers` when creating a store to select other supported analyzers. Text is currently split at paragraph, sentence or whitespace boundaries using an 800-code-point cap. Each hit carries the stable file ID, path, metadata and a chunk preview. When the chunk's location is verified against the exact original, the hit also includes a UTF-16 `range` that can be passed to JavaScript's `slice`.

Search enables native reranking by default. Use `rerank: false` for fused order or `rerank: { onFailure: 'returnOriginal' }` to allow native provider fallback. The result's `reranked` flag reports whether reranking was applied. An optional `embeddingQuery` supplies separate semantic context while preserving `query` for lexical matching.

Use one writer per fork across runtimes and LambdaDB client instances. The SDK serializes writes to a fork within one client instance. It confirms the original and chunks with a consistent branch read before returning success. Batch writes can apply in parts. A file whose chunks require multiple requests becomes visible when its original is written after the earlier chunk requests are confirmed. If the request may have been accepted but the SDK cannot confirm it, the error code is `WRITE_UNCONFIRMED`. Its details identify the attempted files and any earlier confirmed files so the caller can inspect the fork. The handle blocks another create at that path until it observes an existing file there. This protection is local to the client instance. A replacement writer must confirm that the earlier request has settled before using that path.



## Edit files on a working fork

```ts
const updated = await work.write({
    op: 'update',
    fileId: file.fileId,
    newPath: '/archive/context.md',
    edits: [{ oldText: 'Task context', newText: 'Project context' }],
});
await work.write({ op: 'delete', fileId: updated.fileId });
```

A file keeps its ID across moves and replacements. Pass `content` to replace the entire original, including with an empty string. Exact edits each require a distinct nonempty `oldText` that occurs exactly once in the same original. Their spans must be disjoint and all are resolved before applying replacements. Passing `metadata` replaces the user metadata object, and `{}` clears it. Files without metadata omit the field. A move with only `newPath` preserves both content and metadata and updates the existing chunk metadata without submitting document text for re-embedding. A content or metadata replacement creates a new chunk generation and can re-embed unchanged text.

A batch can mix up to 100 `create`, `update`, and `delete` operations and returns results in input order. Duplicate file targets and destination paths fail before any write. Destinations must be free or already belong to the same file at preflight, so a batch cannot reuse a path vacated by another operation in that batch. Updates to missing files fail with `FILE_NOT_FOUND`. Repeating a delete by the same ID finishes cleanup or acknowledges absence.

The SDK confirms the original revision and chunk changes with consistent branch reads. A failed batch may already have applied some files. Error details identify the stage, affected IDs, and any confirmed original changes or completed operations. Check the original before repeating an exact edit after `WRITE_UNCONFIRMED`. The same handle fences another operation that could conflict with an unconfirmed write. Before retrying on a replacement handle, ensure the previous writer has stopped and its outstanding writes have settled. Reissuing an update with the current path and content can finish stale-chunk cleanup. Reissuing a delete can finish removing physically retained chunks and the deleted file's internal record.


## Review working changes

```ts
const changes = await work.diff();
for (const change of changes) {
    console.log(change.op, change.fileId, change.op === 'delete' ? change.previousPath : change.path);
}
```

`diff()` reports one net change per file on a working fork. A create uses the current path and a delete reports the original baseline path as `previousPath`. An update uses the current path and includes `previousPath` when the path changed. Files created and deleted in the fork, and files restored to their original state, are omitted.

Diff uses consistent reads and runs in the same queue as writes on the handle. Completed writes on that handle are visible to the scan, and later writes wait until the scan finishes. Use one active writer per fork. A previously unconfirmed request can still settle, and writes through another client or runtime can change the branch between pages. The result is an inspection of the working fork. It carries no durable snapshot or merge token.

## List files

```ts
const page = await reopened.list({ prefix: '/notes/', nameContains: 'draft', delimiter: '/', limit: 20 });
if (page.cursor) {
    const next = await reopened.list({ cursor: page.cursor });
}
```

`prefix` matches the beginning of the full path. `nameContains` checks a case-sensitive literal substring of the filename, including its extension. Omit `delimiter` for recursive results. The `'/'` delimiter groups deeper matches into common prefixes. The limit counts files and prefixes together, defaults to 100, and accepts 1–1000. Results carry file IDs, paths, modification times, and any declared metadata. Use `read` to retrieve the exact original. This preview does not expose datastore or file versions or file sizes.

List results report `consistency: 'eventual'`. The first call scans LambdaDB list pages and can omit recent writes or combine observations taken before and after a concurrent change. When the call succeeds, later pages reuse the collected metadata in path order, including when a cursor is retried. A continuation takes only `cursor` and belongs to the same drive handle. It expires after five minutes or when evicted from the handle's bounded cache. If the cursor is unavailable, start again without it. A continuation does not initiate a new database scan.

The first call can read several native pages even with a small `limit`. The preview stops with `LIST_SCAN_LIMIT` after reaching the scan budget of 100 native pages, 10,000 native rows, or 8 MiB of unique matching file metadata. Filters that need local checking can hit these limits even when few files match. Use a narrower complete directory prefix such as `/notes/projects/` to reduce the database scan. The pinned LambdaDB client does not expose consistent listing. Adopting future support requires an updated public client or adapter and verification against a live deployment.

For targeted live validation, set `MEMDRIVE_RUN_LIVE_LIST_TESTS=1` when running the existing live suite against a dedicated test project. The opt-in check polls for the expected synthetic files and then checks grouping and continuations. The regular release smoke accepts any valid eventual subset.
