# MemDrive

TypeScript file SDK backed by LambdaDB. MemDrive accepts an initialized LambdaDB client. The application owns connection credentials and transport.

The package is `@functional-systems/memdrive`, licensed under Apache-2.0. It supports ESM, CommonJS, TypeScript, Node.js 20.12+, and browser bundlers.

Install the matching LambdaDB client when your application constructs its own `LambdaDBClient`.

```sh
npm install @functional-systems/lambdadb@0.13.0
```

Checkpoint lookup and checkpoint-sourced forks require LambdaDB with the versioned reference API supported by client 0.13.0. An older self-hosted deployment can fail ref response validation if it omits fields required by this client.


## File stores

Use `@functional-systems/memdrive` to create a text file store and save exact originals on a working fork. These stores use a dedicated layout and require a fresh collection name.

```ts
import { MemDrive } from '@functional-systems/memdrive';

const main = await MemDrive.create({
    client, name: 'workspace', metadataSchema: { topic: { type: 'string' } },
});
const work = await main.fork({ name: 'research' });
const file = await work.write({
    op: 'create',
    path: '/notes/context.md',
    content: '# Task context\r\n',
    metadata: { topic: 'planning' },
});

const reopened = await MemDrive.open({ client, name: 'workspace', at: { fork: 'research' } });
const saved = await reopened.read({ fileId: file.fileId });
const { hits, reranked } = await reopened.search({ query: 'Task context', limit: 5 });
// The same file is available through { path: '/notes/context.md' }.
```

`read` returns the original file or `null` when absent. Content can be empty and the SDK preserves whitespace and line endings. Paths are case-sensitive, absolute and slash-separated. Pass an array of up to 100 operations to write files in batches. Pass up to 100 distinct paths in `read({ paths })` to read existing files in request order. An existing path in the same fork rejects creation with `PATH_EXISTS`. Main exposes the published file view and supplies the starting point for creating a fork. Working edits are scoped to that fork. A store can declare scalar metadata fields with `metadataSchema` and carry collection labels. File writes attach optional `metadata` and record the modification time.

Search ranks file chunks with Bayesian lexical and vector retrieval. The store defaults to LambdaDB's `standard` analyzer and OpenAI's managed `text-embedding-3-small` embeddings. Set `textSearch.analyzers` when creating a store to select other supported analyzers. Text is currently split at paragraph, sentence or whitespace boundaries using an 800-code-point cap. Each hit carries the stable file ID, path, metadata and a chunk preview. When the chunk's location is verified against the exact original, the hit also includes a UTF-16 `range` that can be passed to JavaScript's `slice`.

Search enables native reranking by default. Use `rerank: false` for fused order or `rerank: { onFailure: 'returnOriginal' }` to allow native provider fallback. The result's `reranked` flag reports whether reranking was applied. An optional `embeddingQuery` supplies separate semantic context while preserving `query` for lexical matching.

Use one writer per fork across runtimes and LambdaDB client instances. The SDK serializes writes to a fork within one client instance. It confirms the original and chunks with a consistent branch read before returning success. Batch writes can apply in parts. A file whose chunks require multiple requests becomes visible when its original is written after the earlier chunk requests are confirmed. If the request may have been accepted but the SDK cannot confirm it, the error code is `WRITE_UNCONFIRMED`. Its details identify the attempted files and any earlier confirmed files so the caller can inspect the fork. The handle blocks another create at that path until it observes an existing file there. This protection is local to the client instance. A replacement writer must confirm that the earlier request has settled before using that path.



## Filter search by metadata

Pass `filter` to either text or external-vector search. The filter limits retrieval candidates before ranking. Text search applies it to chunks in both lexical and vector retrieval. Vector search applies it to file records.

```ts
const { hits: planningHits } = await reopened.search({
    query: 'Task context',
    filter: { field: 'metadata.topic', op: 'eq', value: 'planning' },
});
```

Search filters use declared scalar metadata fields with `eq`, `neq`, `in`, and `exists`. Numeric and datetime fields support `gt`, `gte`, `lt`, and `lte`. Combine conditions with nonempty `and` or `or` arrays. Datetimes use the same UTC ISO format with milliseconds as stored metadata. The metadata field must be declared in the store's `metadataSchema`. Use `{ field, op: 'exists', value: false }` to match an omitted field.

## External-vector file stores

Create an external-vector store when your application produces embeddings and keeps the original text in its own storage. The store records the model identity, and the application supplies compatible vectors for writes and searches. External stores support cosine similarity and 64–4096 dimensions. Supply dense arrays of finite numbers with at least one nonzero component at float32 precision.

```ts
const main = await MemDrive.create({
    client,
    name: 'local-notes',
    embedding: { mode: 'external', dimensions: 768, similarity: 'cosine', identity: 'caller-model-v1' },
    metadataSchema: { sourceId: { type: 'string' }, workspace: { type: 'string' } },
});
const work = await main.fork({ name: 'notes-draft' });
const file = await work.write({
    op: 'create',
    path: '/notes/42',
    content: noteVector,
    metadata: { sourceId: '42', workspace: 'private' },
});

const reopened = await MemDrive.open({
    client, name: 'local-notes', mode: 'external', at: { fork: 'notes-draft' },
});
const { hits } = await reopened.search({
    query: questionVector,
    filter: { field: 'metadata.workspace', op: 'eq', value: 'private' },
    limit: 5,
});
// Resolve each hit's sourceId in the application's local store.
```

Pass `mode: 'external'` when reopening main, a fork, or a checkpoint from an external store. MemDrive checks the requested mode against the stored configuration. `describe()` returns the configured dimensions, similarity, and identity. External stores can carry up to three caller labels.

Each file record stores one supplied vector. The mode has no text index, text payloads, chunks, managed inference, or reranking. Write, read, list, and search return file references with `fileId`, `path`, `modifiedAt`, and optional metadata. Search counts files toward its result limit and returns `reranked: false`. Use paths and metadata that are suitable to store in LambdaDB.

Pass the replacement vector as `content` in `work.write({ op: 'update', fileId, content: replacementVector })`. A path or metadata update preserves the current vector. Vector files share the same fork, checkpoint, diff, merge, and deletion lifecycle as text files. A vector replacement alone counts as a file change.

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


## Save a checkpoint

```ts
const saved = await work.checkpoint({ name: 'before-cleanup' });
const pinned = await MemDrive.open({ client, name: 'workspace', at: { checkpoint: 'before-cleanup' } });
const original = await pinned.read({ fileId: file.fileId });
const child = await saved.fork({ name: 'recheck' });
```

A named checkpoint pins the selected view and serves read, search, and list from that pin. Forking any view makes a separate editable branch from that source. A fork and a checkpoint may share the same name, and `open` selects one with `at.fork` or `at.checkpoint`. Names are scoped to the store. Checkpoint names use 3–41 letters, digits, underscores, or hyphens.

Checkpoint and child fork creation from a working fork run in its local write queue. If a source write is still unconfirmed, resolve that outcome before capturing the fork. The SDK sends one creation request for each call. A rejected checkpoint request preserves the underlying LambdaDB error and HTTP status. If creation returns `REF_CREATION_UNCONFIRMED`, pause source mutations and open the named reference to check whether it exists. If the exact cutoff matters, compare the contents with your expected state before using the reference. The name alone cannot establish which request won or when it captured the source.

Checkpoint search and exact reads use LambdaDB's tag read semantics. Listing retains the eventual preview behavior described below, including on a recently created checkpoint. For live validation of a prepared working view and retained state after source deletion, set `MEMDRIVE_RUN_LIVE_CHECKPOINT_TESTS=1` when running the live suite against a dedicated test project.

## Review working changes

```ts
const changes = await work.diff();
for (const change of changes) {
    console.log(change.op, change.fileId, change.op === 'delete' ? change.previousPath : change.path);
}
```

`diff()` reports one net change per file on a working fork. A create uses the current path and a delete reports the original baseline path as `previousPath`. An update uses the current path and includes `previousPath` when the path changed. Files created and deleted in the fork, and files restored to their original state, are omitted.

Diff uses consistent reads and runs in the same queue as writes on the handle. Completed writes on that handle are visible to the scan, and later writes wait until the scan finishes. Use one active writer per fork. A previously unconfirmed request can still settle, and writes through another client or runtime can change the branch between pages. The result is an inspection of the working fork. It carries no durable snapshot or merge token.

## Publish a working fork

```ts
const result = await work.merge({
    requestId: 'research-2026-11-22',
    summary: 'Add the task context and supporting notes',
});

const published = await main.read({ path: '/notes/context.md' });
```

`merge` captures the fork's net changes and publishes them to main. It returns the request ID, status (`published` or `unchanged`), and main version (for example, `v2`). Versions increase when a new view is published and can have gaps. A request ID is scoped to the store. Pass the same fork, ID, and summary to resume or retrieve its original result. Use a new ID to submit a revised change set.

Merges queue against the latest published view. A conflicting file baseline or destination rejects the request with `MERGE_CONFLICT` and the affected file IDs and paths. Independent changes on main can coexist. Edits made on the source after capture stay on that fork. When multiple merges are queued on the same fork, the later capture waits for the earlier merge to advance its source baselines.

Main reads, searches, lists, forks, and checkpoints select one published version. A completed merge becomes visible to existing SDK handles and new SDK clients after the journal records publication. Working views and named checkpoints keep their own contents. Direct LambdaDB reads of the writable `main` branch and older SDK versions can observe writes during application. Upgrade main readers before enabling merges.

- `MERGE_RESUMABLE` identifies a paused request. Retry with its original ID and summary. If its main version is already published, the error includes `details.publishedVersion` and the retry completes the source bookkeeping.
- `MERGE_BLOCKED` identifies the active request that prevents other publications. If a mutable native write has an unknown outcome, the host must fence the old writer and settle its in-flight operations before a replacement owner resumes it.
- The SDK retries a definite rejection when pinning a merge's source or target tag for up to two minutes per stage. Cold collections can take longer to accept their first tag. A source deadline returns `MERGE_SOURCE_NOT_READY`; retry the request once the working snapshot is available. A target deadline is resumable. Pass a request `signal` to bound your wait.

Run main publication and recovery through one exclusive host-owned writer per store across runtimes and client instances. Continue to enforce one writer per working fork, including its post-merge bookkeeping. Once the previous owner and its in-flight mutations have settled, the replacement owner can call `MemDrive.open({ client, name: 'workspace', recover: true })`. A normal `open` never resumes the merge. A paused merge continues to serve the previous published version until publication, and recovery continues from the retained request. Recovery does not automatically roll back the writable branch.

MemDrive keeps its initial view, request captures, and published versions in reserved refs and creates an internal collection on the first merge. Give the writer permission to provision that collection and readers permission to inspect its records. Retain the SDK-owned refs and journal together while the store is in use. Earlier file stores are initialized on the first operation that needs a frozen main view. Native tag availability also applies to named checkpoints on an empty or cold view.

## List files

```ts
const page = await reopened.list({ prefix: '/notes/', nameContains: 'draft', delimiter: '/', limit: 20 });
if (page.cursor) {
    const next = await reopened.list({ cursor: page.cursor });
}
```

`prefix` matches the beginning of the full path. `nameContains` checks a case-sensitive literal substring of the filename, including its extension. Omit `delimiter` for recursive results. The `'/'` delimiter groups deeper matches into common prefixes. The limit counts files and prefixes together, defaults to 100, and accepts 1–1000. Results carry file IDs, paths, modification times, and any declared metadata. For text files, use `read` to retrieve the exact original. This preview does not expose datastore or file versions or file sizes.

List results report `consistency: 'eventual'`. The first call scans LambdaDB list pages and can omit recent writes or combine observations taken before and after a concurrent change. When the call succeeds, later pages reuse the collected metadata in path order, including when a cursor is retried. A continuation takes only `cursor` and belongs to the same drive handle. It expires after five minutes or when evicted from the handle's bounded cache. If the cursor is unavailable, start again without it. A continuation does not initiate a new database scan.

The first call can read several native pages even with a small `limit`. The preview stops with `LIST_SCAN_LIMIT` after reaching the scan budget of 100 native pages, 10,000 native rows, or 8 MiB of unique matching file metadata. Filters that need local checking can hit these limits even when few files match. Use a narrower complete directory prefix such as `/notes/projects/` to reduce the database scan. The pinned LambdaDB client does not expose consistent listing. Adopting future support requires an updated public client or adapter and verification against a live deployment.

For targeted live validation, set `MEMDRIVE_RUN_LIVE_LIST_TESTS=1` when running the existing live suite against a dedicated test project. The opt-in check polls for the expected synthetic files and then checks grouping and continuations. The regular release smoke accepts any valid eventual subset.
