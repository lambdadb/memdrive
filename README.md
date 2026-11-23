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

Search ranks file chunks with semantic retrieval by default. Choose `mode: 'keyword'` for analyzed terms or `mode: 'hybrid'` for Bayesian lexical and vector fusion. Retrieval never switches modes automatically. The store defaults to LambdaDB's `standard` analyzer and OpenAI's managed `text-embedding-3-small` embeddings. Set `textSearch.analyzers` when creating a store to select other supported analyzers. The default boundary splitter uses paragraph, sentence or whitespace boundaries with an 800-code-point cap; an optional local Docling adapter supports structured text as described below. Each hit carries the stable file ID, path, metadata and a chunk preview. When the chunk's location is verified against the exact original, the hit also includes a UTF-16 `range` that can be passed to JavaScript's `slice`.

Reranking defaults to `false`, independently of the search mode. Set `rerank: true` or an options object to add native model scoring of retrieved candidates, with additional inference cost and latency. It cannot recover evidence outside the retrieved candidate pool. Enabled reranking fails on provider errors unless you pass `rerank: { onFailure: 'returnOriginal' }`; that fallback returns the selected mode's original ranking. The result's `reranked` flag reports whether reranking was applied.

Use semantic search for natural-language meaning or paraphrases, keyword search for focused names, identifiers or terms, and hybrid only when both signals are intended. Do not pass a whole conversation as a keyword query. Keyword input is analyzed with query syntax disabled; use `findText` for verified literal occurrences.

```ts
await reopened.search({ query: 'How do we preserve work before editing?' }); // semantic, no reranking
await reopened.search({ query: 'checkpoint conflict', mode: 'keyword' });
await reopened.search({ query: 'How do we preserve work before editing?', rerank: true });
await reopened.search({ query: 'checkpoint conflict', mode: 'hybrid', rerank: true });
```

An optional `embeddingQuery` supplies separate embedding and enabled reranking input, while hybrid preserves `query` for keyword matching. In keyword mode it requires reranking and is used only for that scoring, without query embedding. Omitting it uses `query` for every active stage. External-vector stores keep their vector-only search contract and reject `mode`, `embeddingQuery` and `rerank`.

Earlier SDK versions defaulted to hybrid retrieval with reranking. Pass `mode: 'hybrid', rerank: true` to request that behavior explicitly. The LongMemEval and BEAM benchmarks explicitly select hybrid and retain their configured reranking policy; their historical scores do not measure the new defaults.

Use one writer per fork across runtimes and LambdaDB client instances. The SDK serializes writes to a fork within one client instance. It confirms the original and chunks with a consistent branch read before returning success. Batch writes can apply in parts. A file whose chunks require multiple requests becomes visible when its original is written after the earlier chunk requests are confirmed. If the request may have been accepted but the SDK cannot confirm it, the error code is `WRITE_UNCONFIRMED`. Its details identify the attempted files and any earlier confirmed files so the caller can inspect the fork. The handle blocks another create at that path until it observes an existing file there. This protection is local to the client instance. A replacement writer must confirm that the earlier request has settled before using that path.



## Configure retention

```ts
const main = await MemDrive.create({ client, name: 'workspace', retentionInDays: 7 });
await main.configure({ retentionInDays: 14 });
console.log((await main.describe()).retentionInDays);
```

`retentionInDays` accepts integers from 1 through 31 and maps to LambdaDB's
`snapshotRetentionInDays`. Omitting it on creation uses the native default.
The description reports the last observed setting when native metadata supplies
it. `configure` is available on main in both embedding modes. It verifies the
store generation and confirms the setting with a read; repeated confirmed values
do not send an update. Other clients should reopen to observe configuration
changes. Coordinate configuration through the same exclusive host ownership
used for lifecycle operations.

Configuration updates disable automatic retries. `CONFIGURATION_UNCONFIRMED`
blocks a different retention value and resource deletion on that client. After
the host fences outstanding requests, retry the same value to reconcile it.
The SDK also applies the observed setting to old published content and completed
merge captures automatically. User forks and named checkpoints never expire
automatically, and `history()` summaries and request identities remain available.

After a terminal merge result, including a completed-request replay or an
unchanged merge, the SDK checks retention inside the serialized merge queue.
It also checks after explicit recovery finishes outstanding work. A superseded
main version becomes eligible after the retention period measured from the next
publication; a merge capture ages from its terminal outcome. The current main,
initial view, fork baselines and unfinished recovery remain protected.

Cleanup is best effort: each pass selects at most 100 expired refs and has a
five-second abort budget within the caller's deadline. It confirms retained
summaries before removing any selected ref. Failure, cancellation, unavailable
retention metadata or a busy local client defers work to a later merge without
changing its durable result. There is no cleanup API, background timer or
scheduler to configure. No merge activity means cleanup can be delayed; the
retention setting is not an exact physical deletion deadline. Raising retention
does not restore already released versions.

The existing exclusive host-owned merge/recovery queue also owns cleanup.
Keep clocks accurate and fence former owners and their outstanding mutations
before takeover or lifecycle operations. Other clients can keep reading current
main or explicit refs; use a checkpoint for work that must retain a selected
version beyond its retention period. SDK cursors expire within five minutes,
well before the minimum retention window. Before adopting automatic cleanup,
upgrade all history readers to support retained summaries (`0.1.1-dev.21` or
later); earlier readers require the old captures.

Internally, only refs proven to belong to completed SDK requests are removed.
Bounded history archives retain the summary and up to 100 affected IDs, with no
bodies or vectors. LambdaDB handles snapshot GC after refs are removed, and
other refs may still retain the same content. Tag removal does not establish
immediate physical erasure.

## Structured text chunking

New managed stores persist `chunking: { strategy: 'auto' }` by default. Explicit
strategies are `boundary` (the 800-code-point splitter), `none` (one nonblank
chunk), and `docling` (requires the local adapter and a supported format).
External-vector stores do not accept chunking settings or adapters.

For structured text in Node.js, install the optional pinned adapter dependency
and provide a local Hugging Face `tokenizer.json` suitable for your embedding
model. The SDK does not download a tokenizer or invoke an LLM for chunking.

```sh
npm install docling.rs@2.85.0
```

```ts
import { createDoclingChunker } from '@functional-systems/memdrive/docling';

const chunker = await createDoclingChunker({
    tokenizer: './tokenizer.json', maxTokens: 256, mergePeers: true,
});
const main = await MemDrive.create({
    client, name: 'structured-workspace', chunking: { strategy: 'auto' }, chunker,
});
const work = await main.fork({ name: 'draft' });
await work.write({ op: 'create', path: '/notes/context.md', content: '# Context\n\nExact original text.' });
// Supply the same adapter when reopening for structured writes.
await MemDrive.open({ client, name: 'structured-workspace', at: { fork: 'draft' }, chunker });
```

`auto` uses Docling Hybrid for recognized Markdown, HTML, CSV, AsciiDoc, LaTeX
and XML paths when an adapter is supplied. HTML/XML signatures also identify
otherwise unnamed formats. Plain text and ambiguous inputs such as JSON and
YAML use boundary splitting. Without an adapter, `auto` uses boundary splitting.
An explicitly requested `docling` store cannot be created or written without
an adapter (`CHUNKER_UNAVAILABLE`); unsupported formats return
`UNSUPPORTED_FORMAT`. Parser failures are surfaced, not silently retried through
a different splitter. `maxTokens` accepts 16–8192 and defaults to 256;
`mergePeers` defaults to true.

The exact original input string, whitespace and line endings
remain unchanged. Chunk previews contain rendered body text, while managed
embeddings use Docling's contextualized text, including structural context.
A chunk has a source range only if its text occurs exactly once in the original.
Rendered tables and repeated passages can therefore have no range. Markdown YAML
front matter remains searchable as exact source chunks; heading-only documents
fall back to exact source chunks if Docling emits no body. This is text-file
chunking, not a binary PDF or image ingestion API.

Each original records the resolved strategy and adapter identity, including
tokenizer hash and options. Moving, publishing and recovering files reuse the
captured chunks and vectors without rerunning the parser. Replacing content or
updating metadata runs the configured splitter again. Reads, checkpoints and
publication recovery can reopen without a local adapter. A changed tokenizer
file requires explicitly creating a new adapter.
An already cached store keeps its adapter binding. Use a separate LambdaDB
client instance when opening that store with a different adapter; otherwise
`CHUNKER_MISMATCH` prevents changing active writers implicitly.

Stores created before chunking configuration was introduced keep their existing
boundary layout and embedding source. They remain readable and writable; opening
them does not migrate or reindex them. Create a fresh store to adopt configured
chunking. The package root remains browser-compatible without `docling.rs`;
the `/docling` subpath is Node-only.

## Read a bounded text range

```ts
let page = await work.read({ path: '/notes/plan.md', startLine: 10, endLine: 30, maxChars: 4000 });
while (page) {
    console.log(page.content, page.range, page.totalLines);
    if (!page.next) break;
    page = await work.read(page.next);
}
```

Line numbers are one-based and inclusive. CRLF, LF and lone CR each end one line;
a trailing line ending starts an empty final line, and an empty file has one line.
The original text and line endings are preserved. An omitted end selects through
EOF; an end beyond EOF is clamped, while a start beyond EOF is invalid.

Adding `startLine`, `endLine` or `maxChars` selects a range response with the file
identity, bounded `content`, `at`, `totalLines`, `revision` and `range`. The range
contains inclusive line numbers and half-open UTF-16 `start`/`end` offsets into
the original. `version`, when present, identifies the main publication last
assigned to that original; it does not claim unpublished fork edits are published.
`maxChars` bounds content to 2–64000 UTF-16 code units (default 16000 for range
requests). Pages never split a surrogate pair or CRLF and can continue within a
long line. The bound applies to content, not serialized metadata or JSON overhead.

Pass the returned `next` request unchanged to continue on the same view. It binds
the file ID, bounds, offset and fingerprint of the original path, content and
metadata. A changed original returns `READ_VERSION_CHANGED`; restart without
offset/revision. This detects changes rather than retaining a working snapshot.
Missing files return `null`. External-vector files and `paths` batches do not
support ranges. Requests without range fields still return full originals with
the existing shape. Range reads fetch the full original from LambdaDB, so they
bound application/model output rather than database transfer size.

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

## Create a ref from a published version

```ts
const { entries } = await main.history();
const version = entries[0].version; // For example, 'v1'.
const past = await main.fork({ name: 'past-work', version });
const savedPast = await main.checkpoint({ name: 'past-save', version });
```

On main, both methods accept optional `version` to select that exact completed
publication. Omit it for current main. `v0` selects the retained initial view;
older stores without that pin cannot reconstruct it. An unfinished merge's
version cannot be selected even if its target tag already exists.

An unknown, unpublished or expired version fails with
`HISTORICAL_VIEW_UNAVAILABLE`, with the requested `version` in error details.
The SDK does not substitute another version. History summaries may outlive their
content, so a history entry does not guarantee that version is still retained.
Creation retains the name-conflict and uncertain-outcome behavior described above.

Working forks and checkpoints accept only `{ name }` and copy their bound state.
To preserve a working intermediate state, explicitly create a checkpoint, then
open or fork that checkpoint when needed. `asOf` is no longer accepted on any
view; MemDrive does not expose native snapshot time selection. `publishedAt`
remains descriptive history metadata, not a ref selector.

Once created, explicit forks and checkpoints do not automatically expire.
A fork from an old main version preserves its merge baseline, so publishing edits
from it can conflict with later main changes. Ref creation does not roll back
main or change the original view.

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

MemDrive keeps its initial view, request captures, and published versions in reserved refs and creates an internal collection on the first merge. Give the writer permission to provision that collection and readers permission to inspect its records. Keep the journal while the store is in use; completed merges automatically attempt retention cleanup. Earlier file stores are initialized on the first operation that needs a frozen main view. Native tag availability also applies to named checkpoints on an empty or cold view.

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

These methods read the publication journal without initializing main, advancing a merge, or reading file bodies or vectors. A cold client may need to read the retained journal before returning the first result. History uses the bounded archive saved by automatic retention cleanup, or reads affected IDs from the retained capture before archival. If both are missing, `history()` returns `HISTORY_UNAVAILABLE` for that entry's version. Read the selected view to retrieve its current files.

## Bind shared file tools

MCP hosts and applications can share the same names, JSON Schemas and descriptions
without importing a model-provider adapter. Bind an already authorized SDK handle
and explicitly select the permitted tools:

```ts
import { createFileTools, fileToolError, fileToolGuide, fileToolGuideTopics } from '@functional-systems/memdrive';

const tools = createFileTools({
    drive: work,
    tools: ['guide', 'status', 'history', 'list', 'read', 'search', 'findText', 'fork', 'checkpoint', 'diff', 'write', 'merge'],
});

// Register definitions with the host's model or MCP transport.
const definitions = tools.definitions;
const state = await tools.execute('status', {});
const guide = await tools.execute('guide', {}); // { version, content, topics }, no storage calls
const editingGuide = await tools.execute('guide', { topic: 'editing' }); // { version, topic, title, description, content }

// A host can expose precisely the same text as a resource.
const guideResource = fileToolGuide;
const editingResource = fileToolGuideTopics.editing; // Identical to editingGuide

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

`fork` and `checkpoint` accept the SDK's `{ name, version? }` argument on main in
both embedding modes. Working-fork and checkpoint bindings accept only `{ name }`
and omit `version` from their schemas. No binding exposes `asOf`. They create a ref from the bound view
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
it and expose the exported `fileToolGuide` index and `fileToolGuideTopics` documents
as resources or another instruction channel instead; no guide tool call is required
by the executor. The frozen index lists `retrieval`, `references`, `editing`,
`publication` and `maintenance`, with descriptions of when to read each.
`guide({ topic })` returns that topic from the same immutable catalog and version.
Unknown topics return `INVALID_INPUT` with the valid names. Resource URI mapping
belongs to the host; clients without resource support can use the guide tool.

Guide version 6 preserves selected conversational wording, examples, qualifications
and corrections instead of aggressively summarizing stored originals. It does not
require new metadata or capturing every utterance. Long originals can be delivered
through ranged reads without reducing their stored detail.

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

Repository development includes a [model tool-use evaluation harness](https://github.com/lambdadb/memdrive/tree/main/benchmark/tool-use) for SDK-backed synthetic workflows and guide delivery. It is outside the published package and separate from LongMemEval/BEAM retrieval evaluation.

### Publish a fixed tool catalog

For hosts that cache tool definitions, use `getFileToolDefinitions` to obtain
names, descriptions and schemas without opening a drive or accessing storage.
Select an explicit embedding mode and tool list. The returned array is deeply
frozen and independent of the current main, fork or checkpoint binding.

```ts
import { createFileTools, getFileToolDefinitions } from '@functional-systems/memdrive';

// Publish this catalog once; keep it unchanged when the authorized view changes.
const advertised = getFileToolDefinitions({
    embeddingMode: 'managed',
    tools: ['guide', 'read', 'fork', 'checkpoint', 'diff', 'write', 'merge'],
});

// Execution bindings contain only tools authorized and supported in that view.
const mainTools = createFileTools({ drive: main, tools: ['guide', 'read', 'fork', 'checkpoint'] });
// The advertised write tool remains visible, but mainTools.execute('write', ...)
// rejects with TOOL_NOT_ALLOWED. Adding write to this binding fails with TOOL_UNAVAILABLE.

// After the host authorizes a working view and its operations:
const workTools = createFileTools({ drive: work, tools: ['guide', 'read', 'fork', 'checkpoint', 'diff', 'write', 'merge'] });
// Recheck caller permissions before each call; do not register workTools.definitions
// in place of advertised. View binding and authentication remain host responsibilities.
```

The catalog's `fork` and `checkpoint` schemas always include optional `version`.
Their descriptions restrict it to main, and SDK execution rejects it on working
forks and checkpoints even when the input satisfies the advertised schema.
`createFileTools` keeps its existing view-specific definitions and rejects
unsupported tools at binding time. A fixed catalog does not change those checks
or grant permissions; the host must enforce current authorization on every call
and route execution only to the corresponding authorized binding.

Keep the catalog's embedding mode fixed for that exposed contract. Managed text
and external-vector tools have different input and result semantics; external
mode rejects `findText`. Transport registration, catalog caching and changing a
published contract belong to the host. This API does not implement MCP transport
or establish compatibility with a particular client or marketplace.

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
