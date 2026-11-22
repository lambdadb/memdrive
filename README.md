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



## Find literal text in originals

Use `findText` on managed stores to locate exact substrings in the original file text. It applies Unicode simple case folding and preserves the original spelling, punctuation, and whitespace in each hit. It matches overlapping occurrences and substrings that cross indexing chunk boundaries. Simple case folding does not normalize text or expand characters such as `ß` to `ss`. External-vector stores expose `findText` as `undefined`.

```ts
let page = await reopened.findText({
    query: 'task context',
    prefix: '/notes/',
    filter: { field: 'metadata.topic', op: 'eq', value: 'planning' },
    limit: 20,
});
for (;;) {
    for (const hit of page.hits) console.log(hit.path, hit.range, hit.context.content);
    if (!page.cursor) break;
    page = await reopened.findText({ cursor: page.cursor });
}
```

Each hit carries the file reference, the original matching text in `content`, and a half-open UTF-16 `range` for JavaScript's `slice`. Its `context` carries an excerpt and the excerpt's corresponding range. The excerpt includes up to 80 UTF-16 units of surrounding text on each side, extending by one unit if needed to avoid splitting a surrogate pair.

Use a nonempty literal of up to 8192 UTF-8 bytes, including whitespace if needed. The optional prefix is a case-sensitive absolute path prefix. Metadata filters use the same `FileFilter` as `search`. The page limit is 1–100 hits and defaults to 20. The SDK scans original file records in file ID order, checking up to 16 originals per page, and emits each file's matches in offset order. A page can contain fewer hits than requested, including zero. Follow the cursor until it is absent. Cursors are scoped to the same handle, expire after five minutes, and may be evicted as newer cursors are created. Restart a search if the SDK returns `FIND_TEXT_CURSOR_UNAVAILABLE`.

Main and checkpoint scans typically return `consistency: 'snapshot'` and keep reading the same published version across pages. Fork scans and scans of legacy main without a pinned published version return `consistency: 'live'`. Each fork page runs in the local writer queue, and the scan excludes file IDs above the initial upper bound. An edit or insertion ahead of the cursor can appear in later pages and a change behind it may be missed. A resumed file that changes or disappears invalidates the cursor.

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

## List and delete refs or destroy a store

```ts
const forks = await main.listForks();           // [{ name: 'research' }]
const checkpoints = await main.listCheckpoints(); // [{ name: 'before-edit' }]
await checkpoint.delete(); // Only this checkpoint.
await work.delete();       // Only this working fork.
await MemDrive.destroy({ client, name: 'workspace' }); // The entire store.
```

Both listing methods return all user refs in the store, sorted by name, from any
view. They follow all native reference pages and exclude internal publication
branches and tags. Results contain only `{ name }`; they are a live inventory,
not a snapshot spanning concurrent ref changes.

`delete()` is available only on fork and checkpoint handles. It preserves main,
other refs and retained publication history. A successfully deleted handle
rejects later operations with `REF_DELETED`. Repeating `delete()` on that handle
is a no-op, even if a new ref reuses its name. Open or create a new handle to use
the replacement. Main has no `delete()` method.

`MemDrive.destroy({ client, name })` (also exported as `destroy`) deletes the
content collection, all its refs and the owned publication journal. It verifies
journal ownership before changing anything. Destruction marks the content
collection as deleting, removes the journal, then removes the content collection.
The marker uses the existing format tag, preserving labels and the native tag
budget. Once marked, a fresh `open` fails with `STORE_DELETING`; destruction must
finish. A missing store is treated as already destroyed. Old handles sharing the
client reject operations with `STORE_DELETED`; create new handles after a
successful destroy.

The host must stop store operations across **all clients and processes**, fence
outstanding requests, and hold exclusive ownership through deletion and name
reuse. The SDK rejects deletion with `STORE_BUSY` while operations on the same
client are active, blocks new operations during deletion, and rejects observed
unfinished merges with `MERGE_BLOCKED`. Complete or recover those merges first.
Unconfirmed writes or ref creation must also settle first. These local checks
are not a distributed lock; discard handles held by other clients after deletion.

Native deletion and marker updates disable automatic retries. After
`REF_DELETION_UNCONFIRMED`, the affected handle and name stay fenced on that
client. After the host has settled outstanding requests, retry `delete()` on the
same handle before reusing the name. `STORE_DELETION_UNCONFIRMED` means the marker
or cleanup may have succeeded. After settling requests, retry `MemDrive.destroy`
with the same store name, using the original or a fresh client. The durable marker
allows a fresh process to finish cleanup after a crash; the content collection
remains the cleanup anchor until its journal is confirmed absent. Do not recreate
the store until cleanup and outstanding requests have finished.

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

## Inspect publication status and history

```ts
const status = await work.status();
const page = await work.history({ sinceVersion: 'v0', limit: 20 });
if (page.cursor) {
    const next = await work.history({ cursor: page.cursor });
}
```

`status()` returns the selected view in `at` and the store's current published main version in `mainVersion`. Before the first publication, main is `v0`. An observed unfinished merge includes its `requestId` and `phase`. The `publication` phase keeps main on its previous published version. The `bookkeeping` phase means main already exposes the new version and the source baselines still need to be confirmed. The writer may still be running in either phase. Use the exclusive writer rules above for recovery.

`history()` reports store-wide main publications from any main, fork, or checkpoint view in managed and external embedding modes. Entries are ordered by version, oldest first, and include the publication time, merge summary, and up to the first 100 affected file IDs in ID order. A deleted file still contributes its ID. `fileIdsTruncated` is true when a publication affected more than 100 files.

The starting `sinceVersion` is exclusive and defaults to `v0`. Unchanged and conflicting requests create version gaps. A gap or future version returns `VERSION_NOT_FOUND`, and an invalid version format returns `INVALID_INPUT`. The page size defaults to 20 and accepts 1–100. The first page captures the latest publication as `throughVersion`. Pass only the cursor to continue through that same version while main advances. Cursors expire after five minutes or may be evicted sooner. They work across views of the same store opened through the same client instance. If a cursor is unavailable, start again with the last version you processed.

These methods read the publication journal without initializing main, advancing a merge, or reading file bodies or vectors. A cold client may need to read the retained journal before returning the first result. If a required capture has been removed, `history()` returns `HISTORY_UNAVAILABLE` for that entry's version. Read the selected view to retrieve its current files.

## Bind shared file tools

MCP hosts and applications can share the same names, JSON Schemas and descriptions
without importing a model-provider adapter. Bind an already authorized SDK handle
and explicitly select the permitted tools:

```ts
import { createFileTools, fileToolError, fileToolGuide } from '@functional-systems/memdrive';

const tools = createFileTools({
    drive: work,
    tools: ['guide', 'status', 'history', 'list', 'read', 'search', 'findText', 'fork', 'checkpoint', 'diff', 'write', 'merge'],
});

// Register definitions with the host's model or MCP transport.
const definitions = tools.definitions;
const state = await tools.execute('status', {});
const guide = await tools.execute('guide', {}); // { version, content }, no storage calls

// A host can expose precisely the same text as a resource.
const guideResource = fileToolGuide;

const controller = new AbortController();
try {
    await tools.execute('write', {
        op: 'update', fileId: file.fileId,
        edits: [{ oldText: 'Earlier decision', newText: 'Current decision and reason' }],
    }, { signal: controller.signal });
} catch (error) {
    // { ok: false, error: { code, message, status?, details? } }
    const toolFailure = fileToolError(error);
    // Encode toolFailure using the host's transport and error indicator.
}
```

Available names are `guide`, `status`, `history`, `list`, `read`, `search`,
`findText`, `fork`, `checkpoint`, `diff`, `write` and `merge`. `diff`, `write` and
`merge` require a working fork; `findText` requires text mode. Selecting an unavailable tool fails at binding
with `TOOL_UNAVAILABLE`. External-vector bindings advertise vector inputs for
`search` and `write` and return the SDK's file references. No embeddings or local
content hydration are supplied by the tool layer.

`execute(name, input, options?)` returns the underlying SDK result unchanged for
file and publication operations and rejects with SDK errors. In particular,
`status` and `history` keep their SDK names, arguments and results.
Zero-argument tools accept `{}`. `write` accepts a
single SDK operation object, or `{ operations: [...] }` for the SDK's array form;
the result is respectively one file/deletion result or an array. A batch is not a
transaction. `guide` returns the exported versioned text without provisioning or
reading drive files. `fileToolError` preserves SDK error codes, messages, status
and details, excludes causes and stacks, and masks unexpected errors. It does not
retry calls or authorize recovery.

`fork` and `checkpoint` accept the SDK's `{ name }` argument on main, working forks
and checkpoints in both embedding modes. They create a ref from the bound view
and return a serializable `FileToolRefResult`, `{ name: storeName, at: { kind,
name: refName } }`, instead of an SDK handle. Neither operation publishes edits
or changes the tool binding. For example:

```ts
const created = await tools.execute('fork', { name: 'research-copy' });
// { name: 'workspace', at: { kind: 'fork', name: 'research-copy' } }
const saved = await tools.execute('checkpoint', { name: 'before-edit' });
// Both refs come from work; tools is still bound to work.
```

The host can authorize and open the returned ref using `MemDrive.open`, then
create another tool binding with its own allowlist. Ref creation is marked
`readOnly: false`. Duplicate names and uncertain creation retain the SDK's
`BRANCH_CONFLICT`, `CHECKPOINT_CONFLICT` and `REF_CREATION_UNCONFIRMED` errors.

The `guide` tool is optional, just like the other tools. Its name is the catalog's
implementation choice for delivering the read-only usage guide. Hosts can omit
it and use the exported `fileToolGuide` as an MCP resource or other instruction
channel instead; no guide tool call is required by the executor.

For a read-only connection, select only the needed query tools, for example
`['guide', 'status', 'history', 'list', 'read', 'search']`. The executor copies the
allowlist and rejects every other name with `TOOL_NOT_ALLOWED`, even if the
underlying handle supports writes. Definitions are deeply frozen. Input Schemas
describe JSON structure; the public SDK validates semantic constraints such as
UTF-8 limits, paths, declared metadata and embedding dimensions. The `readOnly`
flag classifies content and ref mutations, not backend credentials: inherited SDK
snapshot initialization can still require provisioning a retained ref on an
older uninitialized store. `guide`, `status` and `history` do not initialize it.

The host must authenticate and authorize every invocation, bind the permitted
drive/ref and establish the exclusive writer rules for merge. Arguments cannot
select another drive or ref. The host chooses whether to enable fork/checkpoint
creation. Opening and binding another view, recovery and store lifecycle remain
host operations outside this catalog.
Keep the SDK client and view handles alive for cursor continuations; creating a
new client for each request loses those cursors. Transport formatting, hosted
Markdown/capacity/reranker policies, instruction delivery and telemetry remain
host responsibilities. Tool availability and fetching the guide do not establish
which instructions a model followed.

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
