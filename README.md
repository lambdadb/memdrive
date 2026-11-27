# MemDrive

TypeScript file SDK backed by LambdaDB. MemDrive accepts an initialized LambdaDB client. The application owns connection credentials and transport.

The package is `@functional-systems/memdrive`, licensed under Apache-2.0. It supports ESM, CommonJS, TypeScript, Node.js 20.12+, and browser bundlers.

MemDrive pins `@functional-systems/lambdadb` `0.15.0` and re-exports its `LambdaDBClient` and `HTTPClient`. Import them from `@functional-systems/memdrive` so the client always matches the SDK; do not install a separate copy of the LambdaDB client for MemDrive.

```ts
import { LambdaDBClient } from '@functional-systems/memdrive';

const client = new LambdaDBClient({ baseUrl, projectName, projectApiKey });
```

MemDrive is a thin file abstraction over LambdaDB primitives. A store is one
LambdaDB collection; main and forks are its branches, and checkpoints are its
tags. It requires LambdaDB with the features supported by client 0.15.0,
including tag creation and branch rollback before a tag's first snapshot is
published, and ordered document listing with consistent branch reads. An older
self-hosted deployment can reject these requests or fail response validation
when it omits required fields.
[LambdaDB rollback support](https://github.com/lambdadb/lambdadb/pull/640),
[LambdaDB document listing](https://docs.lambdadb.ai/guides/documents/list-data#sort-and-read-pending-writes)


## File stores

Use `@functional-systems/memdrive` to create a text file store and save exact originals. These stores use a dedicated layout and require a fresh collection name.

```ts
import { MemDrive } from '@functional-systems/memdrive';

const drive = await MemDrive.create({
    client, name: 'workspace', metadataSchema: { topic: { type: 'string' } },
});
const file = await drive.write({ // omitted at writes to main
    op: 'create',
    path: '/notes/context.md',
    content: '# Task context\r\n',
    metadata: { topic: 'planning' },
});

const { at: work } = await drive.fork({ name: 'research' }); // { kind: 'fork', name: 'research' }
await drive.write({ at: work, op: 'create', path: '/notes/idea.md', content: 'Only on the fork.' });

const reopened = await MemDrive.open({ client, name: 'workspace' });
const saved = await reopened.read({ fileId: file.fileId }); // main
const onFork = await reopened.read({ at: work, path: '/notes/idea.md' });
await reopened.read({ path: '/notes/idea.md' }); // null: main does not see the fork's write
const { hits, reranked } = await reopened.search({ at: work, query: 'Task context', limit: 5 });
```

`MemDrive.create` and `MemDrive.open` return a drive object for the store. Each
request selects its view with `at`: `{ kind: 'main' }`, `{ kind: 'fork', name }`
or `{ kind: 'checkpoint', name }`. Omitting `at` selects main. Main and forks are
writable LambdaDB branches; a checkpoint is a read-only LambdaDB tag. `tree`,
`list`, `read`, `search` and `findText` on main and forks use consistent branch
reads, so they see a write as soon as it succeeds. Results that identify a view, such as range pages, created forks and
checkpoints and continuations, always carry an explicit `at`, including
`{ kind: 'main' }`.

The drive object keeps only the store's configuration, read once by `create` or
`open` and returned by `describe()` together with the latest checkpoint of main
or a fork (see [Checkpointed writes](#checkpointed-writes)). Every call resolves its `at` and goes to
LambdaDB, so any number of drive objects, clients and processes can use the same
store, and a continuation from one works on another. Apart from the per-branch
queues that order state-changing calls within one process (see
[Concurrent calls](#concurrent-calls)), the SDK keeps no state between calls: no
caches, locks or registries. When a request on a view
fails with a native 404, the SDK checks what is missing and reports
`STORE_NOT_FOUND`, `BRANCH_NOT_FOUND` or `CHECKPOINT_NOT_FOUND` (status 404).

`read` returns the original file or `null` when absent. Content can be empty and the SDK preserves whitespace and line endings. Paths are case-sensitive, absolute and slash-separated. Pass `{ at, operations: [...] }` with up to 100 operations to write files in batches. Pass up to 100 distinct paths in `read({ paths })` to read existing files in request order. A store can declare scalar metadata fields with `metadataSchema` and carry collection labels. File writes attach optional `metadata` and record when and by whom each file was created and last modified (see [File attribution](#file-attribution)).

`MemDrive.create` sets LambdaDB's native `snapshotRetentionInDays` to its
one-day minimum; there is no retention option. Forks and checkpoints never
expire; they stay until you delete them. Untagged snapshots are not a history
the SDK exposes: keep a version by creating a checkpoint.

Search ranks file chunks with semantic retrieval by default. Choose `mode: 'keyword'` for analyzed terms or `mode: 'hybrid'` for Bayesian lexical and vector fusion. Retrieval never switches modes automatically. The store defaults to LambdaDB's `standard` analyzer and OpenAI's managed `text-embedding-3-small` embeddings. Set `textSearch.analyzers` when creating a store to select other supported analyzers. The default boundary splitter uses paragraph, sentence or whitespace boundaries with an 800-code-point cap; an optional local Docling adapter supports structured text as described below. Each hit carries the stable file ID, path, metadata and a chunk preview. When the chunk's location is verified against the exact original, the hit also includes a UTF-16 `range` that can be passed to JavaScript's `slice`.

Reranking defaults to `false`, independently of the search mode. Set `rerank: true` or an options object to add native model scoring of retrieved candidates, with additional inference cost and latency. It cannot recover evidence outside the retrieved candidate pool. Enabled reranking fails on provider errors unless you pass `rerank: { onFailure: 'returnOriginal' }`; that fallback returns the selected mode's original ranking. The result's `reranked` flag reports whether reranking was applied.

Use semantic search for natural-language meaning or paraphrases, keyword search for focused names, identifiers or terms, and hybrid only when both signals are intended. Do not pass a whole conversation as a keyword query. Keyword input is analyzed with query syntax disabled; use `findText` for verified literal occurrences.

```ts
await reopened.search({ query: 'How do we preserve work before editing?' }); // main, semantic, no reranking
await reopened.search({ at: work, query: 'checkpoint conflict', mode: 'keyword' });
await reopened.search({ query: 'How do we preserve work before editing?', rerank: true });
await reopened.search({ at: work, query: 'checkpoint conflict', mode: 'hybrid', rerank: true });
```

An optional `embeddingQuery` supplies separate embedding and enabled reranking input, while hybrid preserves `query` for keyword matching. In keyword mode it requires reranking and is used only for that scoring, without query embedding. Omitting it uses `query` for every active stage. External-vector stores keep their vector-only search contract and reject `mode`, `embeddingQuery` and `rerank`.

Earlier SDK versions defaulted to hybrid retrieval with reranking. Pass `mode: 'hybrid', rerank: true` to request that behavior explicitly. The LongMemEval and BEAM benchmarks explicitly select hybrid and retain their configured reranking policy; their historical scores do not measure the new defaults.


## Concurrent calls

A file is several LambdaDB documents, an original and its chunks, and LambdaDB
has no multi-document transaction or conditional write. Within one process the
SDK therefore runs state-changing calls on one branch one at a time, in call
order:

- `write`, as one operation or a batch, on main or that fork; a checkpointed
  write also creates its checkpoint, moves the branch's latest checkpoint and, on
  failure, restores the branch in the same turn;
- `rollback` of that branch;
- `fork` and `checkpoint` whose source is that branch, so a new fork or
  checkpoint never captures a half-applied write; a checkpoint also becomes the
  branch's latest checkpoint in the same turn;
- `deleteFork` of that fork.

The queues are shared by every drive object of the same store in the process; a
store recreated under the same name gets new ones. A queue exists only while it
has pending calls. Calls on different branches run concurrently. Reads (`read`,
`tree`, `list`, `search`, `findText`, `listForks`, `listCheckpoints`, `describe`),
`deleteCheckpoint` and forks or checkpoints taken from a checkpoint never wait. A
call that fails or is aborted does not hold up the next one; aborting a waiting
call rejects it with `ABORTED` before it sends anything. `MemDrive.destroy` waits
for the store's pending state-changing calls in the process before deleting the
collection. It first reads the collection to identify the store; calls made after
that read run after the deletion and fail with `STORE_NOT_FOUND`, while a call made
during the read can still run, succeed and then be deleted with the store.

Separate processes, and separate copies of the SDK in one process (for example
its ESM and CommonJS builds loaded side by side), are not coordinated. Ordering
their writers is the caller's job until LambdaDB offers conditional writes; the
repair paths in [Edit files](#edit-files) cover what racing writers leave behind.

## What the SDK does not do

MemDrive exposes what LambdaDB supports, as files. It does not add features
LambdaDB lacks; callers build them when they need them.

- **No merge, diff or history.** There is no publication step, journal or
  version log. A fork's changes reach main only when you write them to main, or
  when you roll main back to a checkpoint of the fork. Keep versions you need as
  checkpoints, and build diffs, merges or change logs in the application.
- **No coordination across processes or locks.** Only state-changing calls
  in one process are ordered (see [Concurrent calls](#concurrent-calls)).
  Writes from separate processes or SDK copies to the same view interleave. The
  original written last decides a file's path, content and metadata, and exact
  `edits` apply to the original read at the start of that write call, so a
  concurrent replacement in between is overwritten. Racing writers to one file
  can remove each other's chunks: the file stays readable but search may miss it
  until another update of that file (even with unchanged content or only a new
  path) chunks it again. Racing creates can leave two files at one path; see
  below.
- **No other cross-call state.** The SDK keeps no caches, fences or
  registries. Retries and the ordering and ownership of a store or view across
  processes are the caller's responsibility.
- **Path uniqueness within one process.** `create` and path changes check the
  destination with a read before writing (`PATH_EXISTS`). Writes on one branch
  in one process run one at a time, so the check holds there, except right after
  a write that was aborted or failed with an unknown outcome: a request it already
  sent can still be applied after the next write's check. Writers in separate
  processes can both pass it and create two files at the same path.
- **No hidden retries of unknown outcomes.** A write whose outcome is unknown
  fails with `WRITE_UNCONFIRMED`; it may or may not have been applied, and the
  caller inspects the files before retrying. Fork, checkpoint, deletion and
  rollback requests are sent once; an error without an HTTP status may have
  taken effect.
- **Tree folder buckets.** `tree` returns at most 100 folder buckets per call,
  including the prefix and its ancestors.

When LambdaDB adds merge, conditional writes (`if-match`/`if-none-match`), more
facet buckets, substring filters or point-in-time reads (`asOf`), the SDK can
expose or use them.

## Structured text chunking

Managed stores persist `chunking: { strategy: 'auto' }` by default. Explicit
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
const drive = await MemDrive.create({
    client, name: 'structured-workspace', chunking: { strategy: 'auto' }, chunker,
});
await drive.write({ op: 'create', path: '/notes/context.md', content: '# Context\n\nExact original text.' });
// Supply the same adapter when reopening for structured writes.
await MemDrive.open({ client, name: 'structured-workspace', chunker });
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
tokenizer hash and options. Moving a file reuses its stored chunks and vectors
without rerunning the parser; forks, checkpoints and rollback copy them natively.
Replacing content or updating metadata runs the configured splitter again.
Reads, searches, forks, checkpoints and rollback work on a drive opened without
a local adapter. A changed tokenizer file requires explicitly creating a new
adapter. Each drive object uses the adapter passed to the `create` or `open`
call that returned it.

The package root remains browser-compatible without `docling.rs`;
the `/docling` subpath is Node-only.

## Read a bounded text range

```ts
let page = await drive.read({ at: work, path: '/notes/plan.md', startLine: 10, endLine: 30, maxChars: 4000 });
while (page) {
    console.log(page.content, page.range, page.totalLines);
    if (!page.next) break;
    page = await drive.read(page.next); // next includes at
}
```

Line numbers are one-based and inclusive. CRLF, LF and lone CR each end one line;
a trailing line ending starts an empty final line, and an empty file has one line.
The original text and line endings are preserved. An omitted end selects through
EOF; an end beyond EOF is clamped, while a start beyond EOF is invalid.

Adding `startLine`, `endLine` or `maxChars` selects a range response with the file
identity, bounded `content`, `at`, `totalLines`, `revision` and `range`. The range
contains inclusive line numbers and half-open UTF-16 `start`/`end` offsets into
the original. `maxChars` bounds content to 2–64000 UTF-16 code units (default 16000 for range
requests). Pages never split a surrogate pair or CRLF and can continue within a
long line. The bound applies to content, not serialized metadata or JSON overhead.

Pass the returned `next` request unchanged to continue on the same view. It contains
that view's `at`, the file ID, bounds, offset and fingerprint of the original path, content and
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
    at: work,
    query: 'task context',
    prefix: '/notes/',
    filter: { field: 'metadata.topic', op: 'eq', value: 'planning' },
    limit: 20,
});
for (;;) {
    for (const hit of page.hits) console.log(hit.path, hit.range, hit.context.content);
    if (!page.next) break;
    page = await reopened.findText(page.next); // { at, cursor }
}
```

Each hit carries the file reference, the original matching text in `content`, and a `range` with half-open UTF-16 `start` and `end` offsets for JavaScript's `slice` plus one-based inclusive `startLine` and `endLine`. Lines are numbered exactly as in ranged `read`, where CRLF, a lone CR and LF each end a line. `endLine` is the line holding the match's last unit, so a match ending with a line break ends on the line that break terminates. Pass `startLine` and `endLine` with the hit's `fileId` to `read` to retrieve the lines containing the match. Its `context` carries an excerpt and the excerpt's corresponding range. The excerpt includes up to 80 UTF-16 units of surrounding text on each side, extending by one unit if needed to avoid splitting a surrogate pair.

Use a nonempty literal of up to 8192 UTF-8 bytes, including whitespace if needed. The optional prefix is a case-sensitive absolute path prefix. Metadata filters use the same `FileFilter` as `search`. The page limit is 1–100 hits and defaults to 20. The SDK scans the original file records in the selected view in file ID order, reading up to 16 originals per page in batches, and emits each file's matches in offset order. Original text has no text index, so the cost scales with the number of originals in scope rather than with the number of matches; `prefix` and metadata `filter` narrow the originals the scan reads. A page can contain fewer hits than requested, including zero. Forward `next` unchanged until it is absent. It contains the scan's `at` and cursor. Passing a cursor with another `at` (omitted means main) fails with `CURSOR_VIEW_MISMATCH` and leaves the cursor usable. The cursor is a self-contained opaque token: it holds no SDK memory, does not expire by time, and continues on any client of the same store. The SDK revalidates every field and derives the read from the request's `at`. The cursor is bound to the store's generation, and for a fork or checkpoint to that ref's identity, which it rereads on each page. It becomes unavailable when the store is replaced, the fork or checkpoint was deleted or recreated under the same name, or a resumed live file changed or disappeared. Restart a search if the SDK returns `FIND_TEXT_CURSOR_UNAVAILABLE`.

Checkpoint scans return `consistency: 'snapshot'` and read the same tag on every page. Main and fork scans return `consistency: 'live'`: they read the branch directly, and the scan excludes file IDs above the upper bound observed on its first page. An edit or insertion ahead of the cursor can appear in later pages and a change behind it may be missed. A resumed file that changes or disappears invalidates the cursor. Pages are not serialized with writes.

## Filter search by metadata

Pass `filter` to either text or external-vector search. The filter limits retrieval candidates before ranking. Text search applies it to chunks in both lexical and vector retrieval. Vector search applies it to file records.

```ts
const { hits: planningHits } = await reopened.search({
    at: work,
    query: 'Task context',
    filter: { field: 'metadata.topic', op: 'eq', value: 'planning' },
});
```

Search filters use declared scalar metadata fields with `eq`, `neq`, `in`, and `exists`. Numeric and datetime fields support `gt`, `gte`, `lt`, and `lte`. Combine conditions with nonempty `and` or `or` arrays. Datetimes use the same UTC ISO format with milliseconds as stored metadata. The metadata field must be declared in the store's `metadataSchema`. Use `{ field, op: 'exists', value: false }` to match an omitted field.

## External-vector file stores

Create an external-vector store when your application produces embeddings and keeps the original text in its own storage. The store records the model identity, and the application supplies compatible vectors for writes and searches. External stores support cosine similarity and 64–4096 dimensions. Supply dense arrays of finite numbers with at least one nonzero component at float32 precision.

```ts
const notes = await MemDrive.create({
    client,
    name: 'local-notes',
    embedding: { mode: 'external', dimensions: 768, similarity: 'cosine', identity: 'caller-model-v1' },
    metadataSchema: { sourceId: { type: 'string' }, workspace: { type: 'string' } },
});
const { at: draft } = await notes.fork({ name: 'notes-draft' });
const note = await notes.write({
    at: draft,
    op: 'create',
    path: '/notes/42',
    content: noteVector,
    metadata: { sourceId: '42', workspace: 'private' },
});

const reopenedNotes = await MemDrive.open({ client, name: 'local-notes', mode: 'external' });
const { hits: noteHits } = await reopenedNotes.search({
    at: draft,
    query: questionVector,
    filter: { field: 'metadata.workspace', op: 'eq', value: 'private' },
    limit: 5,
});
// Resolve each hit's sourceId in the application's local store.
```

Pass `mode: 'external'` when opening an external store. MemDrive checks the requested mode against the stored configuration. `describe()` returns the configured dimensions, similarity, and identity. External stores can carry up to three caller labels.

Each file record stores one supplied vector. The mode has no text index, text payloads, chunks, managed inference, or reranking. Write, read, list, and search return file references with `fileId`, `path`, `createdAt`, `modifiedAt`, the recorded `createdBy` and `modifiedBy`, and optional metadata. Search counts files toward its result limit and returns `reranked: false`. Use paths and metadata that are suitable to store in LambdaDB.

Pass the replacement vector as `content` in `notes.write({ at: draft, op: 'update', fileId, content: replacementVector })`. A path or metadata update preserves the current vector. Vector files share the same main, fork, checkpoint, rollback and deletion behavior as text files.

## Edit files

```ts
const updated = await drive.write({
    at: work,
    op: 'update',
    fileId: file.fileId,
    newPath: '/archive/context.md',
    edits: [{ oldText: 'Task context', newText: 'Project context' }],
});
await drive.write({ at: work, op: 'delete', fileId: updated.fileId });
```

`write` targets main (when `at` is omitted or `{ kind: 'main' }`) or a fork. A
checkpoint `at` fails with `INVALID_INPUT` before any storage request. A write to
main changes main directly; use a fork when changes should stay separate.

A file keeps its ID across moves and replacements. Pass `content` to replace the entire original, including with an empty string. Exact edits each require a distinct nonempty `oldText` that occurs exactly once in the current original. Their spans must be disjoint and all are resolved before applying replacements; a mismatch fails with `EDIT_CONFLICT`. Passing `metadata` replaces the user metadata object, and `{}` clears it. Files without metadata omit the field. A move with only `newPath` preserves both content and metadata and updates the existing chunk metadata without submitting document text for re-embedding. A content or metadata replacement creates a new chunk generation and can re-embed unchanged text.

A batch can mix up to 100 `create`, `update`, and `delete` operations and returns results in input order. Duplicate file targets and destination paths fail before any write. Destinations must be free or already belong to the same file when checked, so a batch cannot reuse a path vacated by another operation in that batch. Updates to missing files fail with `FILE_NOT_FOUND`. A delete removes the original, which makes the file disappear, and then its chunks; deleting an absent file ID succeeds and removes any chunks an interrupted write left behind.

Within one call, a file becomes visible only after its chunks are written: chunks
go first and the original last, and each request is confirmed with a consistent
branch read before the next. Search ignores chunks whose original is missing or
has another revision. A batch is not a transaction and can apply in parts; error
details identify the stage, the attempted files, the completed file IDs and any
files whose chunks were written without their original. If a request may have
been accepted but the SDK cannot confirm it, the error code is
`WRITE_UNCONFIRMED`. Read the affected files before retrying.

A file counts as completed as soon as its original is written or deleted. After
that, the SDK reads the original back and removes chunks of other generations; if
that cleanup fails, the error has stage `cleanup-chunks` and lists the file in
`completedFileIds`: the change is applied, and only leftover chunks remain, which
search ignores. Repeating a delete, or any update of the file, removes them
again. An update that finds no chunks for a nonempty original, for example after
racing writers in separate processes removed each other's chunks, chunks the
file again instead of failing, so resending an update repairs search for it.

Racing creates from separate processes can leave several files at one path. Updates and deletes by
`fileId` keep working for each of them, and an update that keeps its path is not
checked against other files. Reading that path fails with `PATH_AMBIGUOUS`,
whose details list `{ path, fileIds }`; move or delete the extra files by
`fileId`. A create or move to a path that another file holds fails with
`PATH_EXISTS`.

## File attribution

```ts
const plan = await drive.write({
    op: 'create', path: '/notes/plan.md', content: 'Ship on Friday.',
    by: { user: 'user-42', agent: 'planner' },
}); // createdAt === modifiedAt; createdBy and modifiedBy are the actor
await drive.write({ op: 'update', fileId: plan.fileId, by: { agent: 'reviewer' },
    edits: [{ oldText: 'Friday', newText: 'Monday' }] }); // createdBy stays; modifiedBy is the reviewer
// Imported or replayed content keeps its original date.
await drive.write({ time: new Date('2024-05-01T09:00:00.000Z'), operations: [
    { op: 'create', path: '/imports/2024-05-01.md', content: 'Earlier notes.' },
] });
```

Every file records `createdAt`, `modifiedAt` and, when the writes named an
actor, `createdBy` and `modifiedBy`. Write results, `read`, `list`, `search` and
`findText` return them in both embedding modes.

- `createdAt` and `createdBy` are set when the file is created and never change.
- `modifiedAt` changes, as before, when a write changes the file's path, content
  or metadata (path, vector or metadata in external-vector stores). `modifiedBy`
  is the actor of the write that set `modifiedAt`, and is removed when that
  write named none, so an earlier modifier is never credited with a later
  change. A write that changes nothing keeps both.
- `by` and `time` are optional fields of the whole `write` request, in every
  form: one operation or `operations`, with or without `checkpoint`, on main or a
  fork. They apply to every operation of the call; an operation inside
  `operations` accepts neither.
- `by` is `{ user?, agent? }` with at least one nonblank string of at most 256
  UTF-8 bytes without control characters or lone surrogates; keys holding
  `undefined` count as absent. The SDK stores the strings as given and does not
  authenticate or interpret them: naming the caller is the host's job.
- `time` is a valid `Date` in the years 0000–9999. It replaces the current time
  for the call's `createdAt` and `modifiedAt` values. Without it each value is
  the current time, as before.

Invalid `by` or `time` fails with `INVALID_INPUT` before any storage request.
`createdAt` has a `datetime` index like `modifiedAt`; the actors have no index
and cannot be filtered on. Chunks carry none of these fields. In a text store,
a move whose `modifiedBy` differs from the stored one sends one more request
than other moves: a LambdaDB patch merges into the stored original and cannot
remove a field, so the SDK patches the chunks and then writes the whole original.

## Checkpointed writes

A checkpointed write applies a write and records the result as the branch's
latest checkpoint, or leaves the branch at its previous latest checkpoint. It is
meant for a host that saves an agent's work once per turn: every such write goes
through it, so the latest checkpoint is always the last good state.

```ts
const { result, checkpoint } = await drive.write({
    operations: [
        { op: 'create', path: '/notes/handoff.md', content: 'On-call handoff happens at 09:30 KST every Monday.' },
        { op: 'update', fileId: file.fileId, edits: [{ oldText: 'Tuesday', newText: 'Monday' }] },
    ],
    // Host-chosen and unique for the store's lifetime, also across restarts.
    checkpoint: { name: `turn-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}` },
});
// result: the ordinary write result; checkpoint: { at: { kind: 'checkpoint', name: 'turn-…' } }
const { latestCheckpoint } = await drive.describe(); // the same { at }
```

Add `checkpoint: { name }` to any single-operation or batch `write` on main or a
fork. The result is `{ result, checkpoint: { at } }`, where `result` is what the
same write without `checkpoint` returns. Checkpoint names follow the rules in
[Save a checkpoint](#save-a-checkpoint) and must be unique for the store's
lifetime, including across host restarts: a counter that restarts at 1 reuses
names, every such write then fails tag creation with `CHECKPOINT_CONFLICT` and is
rolled back. Use a timestamp or random suffix within the 41-character limit.

Each branch has one SDK-reserved LambdaDB alias naming its latest checkpoint:
`latest-main` for main and `latest-fork-<name>` for a fork. It names the base
checkpoint of the branch's current state: the most recent checkpoint taken of the
branch, whether by a checkpointed write or by `checkpoint({ at, name })` with
that branch as source, or the checkpoint the branch was last rolled back to. The SDK has no alias API, so callers cannot
create, move or delete it through the SDK, and `listCheckpoints` never lists it.
`describe({ at? })` reports it as `latestCheckpoint: { at } | null` for main
(default) or a fork with one alias read; a checkpoint `at` fails with
`INVALID_INPUT`. `describe` does not check that the fork exists: a missing fork,
like a fork without checkpoints, reports `null`. `deleteCheckpoint` refuses a
checkpoint that is some branch's latest with `CHECKPOINT_IN_USE`, whose details
list `latestOf` (the branches), so retention can never leave the alias dangling;
delete older checkpoints instead; a 409 from LambdaDB for an alias target is
reported the same way. `deleteFork` deletes the fork's alias before the branch;
if the branch deletion then fails, the error keeps its code and status and adds
`latestCheckpointCleared: true`. `fork` deletes any alias left under the new
fork's name (for example by a branch deleted outside the SDK) in the new fork's
queue turn, so a new fork always starts without a latest checkpoint; if that
fails, it throws `LATEST_CHECKPOINT_NOT_MOVED` with `forkCreated: true`.

One turn of the branch's queue (see [Concurrent calls](#concurrent-calls)) runs
the whole sequence:

1. Apply the write exactly as `write` without `checkpoint` does.
2. Create the tag `checkpoint-<name>` from the branch (`tags.create`).
3. Move the alias to it (`aliases.retarget`). The branch's first checkpoint gets
   a 404 there and creates the alias instead (`aliases.create`).
4. Return the write result and the checkpoint.

On success this adds exactly two requests to the write's own requests: one tag
creation and one alias retarget (plus one alias creation the first time). The
alias is not read beforehand. A plain `write` sends no tag, alias or rollback
requests.

Errors raised before the write sends its first mutation, such as
`INVALID_INPUT`, `PATH_EXISTS`, `EDIT_CONFLICT`, `FILE_NOT_FOUND` or an abort, are
thrown unchanged and the branch is untouched. Any later failure (a rejected or partial write,
`WRITE_UNCONFIRMED`, a failed tag creation including `CHECKPOINT_CONFLICT`, or a
failed alias move) restores the branch, then throws:

- The SDK reads the alias. If the alias move's response was lost but the alias
  now names the new checkpoint, the call succeeded and returns normally.
- Otherwise it rolls the branch back to the checkpoint the alias names with one
  `branches.rollback`, never retried, and deletes the new tag if the call
  created it. When the tag creation's outcome is unknown, it reads the tag and
  deletes it only when its creation time is no more than 2 seconds before the
  client clock reading taken just before the request; otherwise, for example
  after a lost 409 for an existing checkpoint, the tag stays and the details say
  `checkpointCreated: 'unknown'`. The tolerance covers clock skew between client
  and server; a larger skew only leaves a checkpoint behind.
- Without an alias, on the branch's first checkpointed write, there is nothing to
  roll back to: the SDK deletes the files this call created, with their chunks.
  Updates and deletions of files that existed before cannot be undone this way.

The restore runs even when the caller's signal aborted the call. The error is one
of:

| Code | Meaning | Details |
| --- | --- | --- |
| `CHECKPOINT_WRITE_FAILED` | Nothing from the call remains. `stage: 'write'`: the write failed; `'checkpoint'` or `'alias'`: the write was applied but its checkpoint could not be recorded. | `stage`, `restored: true`, `restoredTo` (the checkpoint `at`, or `null` when created files were deleted), `cause` (code, message, status, details of the original error), `checkpointCreated` and `checkpointRemoved` when the call created or may have created its tag |
| `CHECKPOINT_RESTORE_FAILED` | The restore failed or could not undo everything; the branch may hold part of the write. Read the affected files. | `stage`, `restored: false`, `cause`, `restoreCause` when a restore request failed, `previousCheckpoint` or `restoredTo: null`, `checkpointCreated` (`true`, `false` or `'unknown'`), `unrestoredFileIds` for existing files a first checkpointed write changed, `createdFileIds` when their deletion failed |

A rollback restores the whole branch to the latest checkpoint, so it is safe only
when every write to that branch goes through checkpointed writes from one
process: the queue keeps write, tag and alias move together within the process.
A plain `write` made after the latest checkpoint is undone too when a later
checkpointed write fails. Writers in other processes are the host's job, and a
request whose response was lost can still be applied after the rollback.

There is no option to change this behavior. A checkpointed write is all or
nothing, restored to the latest checkpoint. To write without a restore, call
`write` without `checkpoint` and then `checkpoint({ at, name })`. To restore
another checkpoint, call `rollback({ at, to })`. Checkpoint retention, for
example deleting checkpoints older than a plan's 7 or 30 days, belongs to the
host.

## Save a checkpoint

```ts
const { at: pinned } = await drive.checkpoint({ at: work, name: 'before-cleanup' });
// { kind: 'checkpoint', name: 'before-cleanup' }
const original = await drive.read({ at: pinned, fileId: file.fileId });
const { at: child } = await drive.fork({ at: pinned, name: 'recheck' });
```

`fork` and `checkpoint` take an optional source `at` (main, a fork or a
checkpoint); omitting it copies main. `name` names only the new fork or
checkpoint, and the result is `{ at }` for that new view. A checkpoint is a
LambdaDB tag of the source as it is when created; reads, searches, lists and
findText on it see that fixed state. Forking any view makes a separate writable
branch from that source. A fork and a checkpoint may share the same name;
`at.kind` distinguishes them. Names are scoped to the store. Fork names use 3–40
and checkpoint names 3–41 letters, digits, underscores, or hyphens; fork names
cannot be `main`. A fork's name leaves room for its reserved alias
`latest-fork-<name>` within LambdaDB's 52-character reference names.

A checkpoint whose source is main or a fork becomes that branch's latest
checkpoint (see [Checkpointed writes](#checkpointed-writes)): in the same queue
turn the SDK moves the branch's alias to it, creating the alias the first time.
A later failing checkpointed write rolls the branch back to it. A checkpoint of a
checkpoint, and a fork of any view, leave every alias alone. If the tag is
created but the alias move fails, the SDK reads the alias back; unless the move
did happen, it throws `LATEST_CHECKPOINT_NOT_MOVED` with details `at` (the
branch), `checkpoint`, `checkpointCreated: true`, `latestCheckpoint` (what the
alias names, `null` or `'unknown'`) and `cause`. The checkpoint exists and no
files changed; take another checkpoint to retry the move.

Creating a fork also deletes any alias left under the new fork's name, one more
request; see [Checkpointed writes](#checkpointed-writes).

Each call sends one native creation request, plus the alias move for a
checkpoint of a branch. A name already in use fails with
`BRANCH_CONFLICT` or `CHECKPOINT_CONFLICT`, and a missing source with
`BRANCH_NOT_FOUND` or `CHECKPOINT_NOT_FOUND`. Other rejections preserve the
LambdaDB error and HTTP status. If the outcome is unknown, check with
`listForks`/`listCheckpoints` before retrying. A checkpoint captures whatever its
source holds when LambdaDB creates it. A fork or checkpoint of
main or a fork waits for that branch's pending writes in this process; with
writers in other processes, compare its contents with the state you expect.

## Roll back to a checkpoint

```ts
const { at: before } = await drive.checkpoint({ at: work, name: 'before-import' });
// ... writes to the fork ...
await drive.rollback({ at: work, to: before }); // { at: work }
```

`rollback({ at, to })` replaces the contents of main or a fork with those of a
checkpoint: the view's files become exactly the checkpoint's files, so files
created, changed or deleted in that view since then revert. `at` is required and
must be main or a fork; `to` must be a checkpoint. The checkpoint can come from
any view of the store, so rolling main back to a checkpoint taken from a fork
replaces main with that fork's state at the time. A checkpoint can be restored
as soon as it is created. The result is `{ at }`, including when the native
client returns `headSnapshot: null` before the checkpoint's first snapshot is
published. MemDrive's consistent branch reads see the restored files immediately.

Rollback is one native `branches.rollback` call and is never retried, by the SDK
or the LambdaDB client. Resending a rollback also undoes writes made after the
first one, so after an error without a status, or a lost result, read the view
before deciding to send it again. A missing view or checkpoint fails with
`BRANCH_NOT_FOUND` or `CHECKPOINT_NOT_FOUND`; other errors pass through with
their HTTP status.

When the branch has a latest checkpoint, the rollback also moves it to `to`, so
a later failing checkpointed write restores the state the branch was rolled back
to. A branch without one keeps none. If that alias move fails after the rollback
succeeded, including a 404 because `to` was deleted meanwhile while the alias
still names another checkpoint, the SDK throws `LATEST_CHECKPOINT_NOT_MOVED`
with `rolledBack: true`; the files are rolled back.

## List and delete refs or destroy a store

```ts
const { forks } = await drive.listForks();
// [{ at: { kind: 'fork', name: 'research' }, createdAt: '2026-11-26T01:02:03.004Z' }]
let page = await drive.listCheckpoints({ limit: 50 });
for (;;) {
    // page.checkpoints: [{ at: { kind: 'checkpoint', name }, createdAt }]
    if (!page.next) break;
    page = await drive.listCheckpoints(page.next); // { cursor }
}
await drive.deleteCheckpoint({ at: older });  // { at: older }; only this checkpoint.
await drive.deleteFork({ at: work });         // { at: work }; only this fork.
await MemDrive.destroy({ client, name: 'workspace' }); // The entire store.
```

`listForks` and `listCheckpoints` return one native page per call (`limit`
1–100, default 100) as `{ at, createdAt }` entries, where `createdAt` is the
native creation time as an ISO 8601 string. Pass the returned `next`
(`{ cursor }`) unchanged to continue; the cursor wraps LambdaDB's page token, is
bound to the store and the listing kind (`LIST_CURSOR_UNAVAILABLE` otherwise)
and works on any drive object of that store. Entries come in LambdaDB's name
order. LambdaDB has no time-ordered or reverse listing yet; the latest
checkpoint of a branch is available from `describe({ at })`. A fork page can
hold fewer entries than `limit`, even none, while `next` is present, because
main and other branches are not forks. The listing is complete when a page has
no `next`, and is a live inventory, not a snapshot spanning concurrent changes.

`deleteFork` and `deleteCheckpoint` require the `at` of an existing fork or
checkpoint. They return `{ at }`. `deleteFork` deletes the fork's reserved alias
(absent is fine) and then the branch. `deleteCheckpoint` first lists the store's
aliases and refuses a checkpoint that is a branch's latest checkpoint with
`CHECKPOINT_IN_USE`, then sends one native deletion. Deleting a fork
discards edits that no other view holds; main, other forks and checkpoints remain.
Main cannot be deleted. After deletion, using that `at` reports
`BRANCH_NOT_FOUND` or `CHECKPOINT_NOT_FOUND`, and its findText cursors can no
longer be continued. A new fork or checkpoint with the same name is a separate
view.

`MemDrive.destroy({ client, name })` (also exported as `destroy`) deletes the
store's collection, which removes all its forks and checkpoints. A store has no
other collections. It inspects the collection first: a missing store is treated
as already destroyed, and a collection that is not a compatible file store fails
with `INCOMPATIBLE_STORE` without deletion. View requests through drive objects
of a destroyed store then fail with `STORE_NOT_FOUND`. In one process, `destroy`
first waits for the store's pending state-changing calls (see
[Concurrent calls](#concurrent-calls)). The host must stop users of the store in
other processes before destroying it or reusing its name; the SDK does not
coordinate them.

Stores created by earlier development builds (formats `files-v0` and
`files-v1`) cannot be opened or destroyed by this SDK and fail with
`INCOMPATIBLE_STORE`. Delete such a collection directly with LambdaDB, together
with the `md-journal-*` collection that `files-v0` builds created for it.

## Shared file tools

MCP hosts and applications can share the same names, JSON Schemas and
descriptions without importing a model-provider adapter. The catalog is
deliberately small: an agent works on main of one drive, records what is worth
keeping each turn with one `write`, and gets no fork, checkpoint or rollback
tools. Hosts use the SDK directly for refs, rollback and retention.

```ts
import { createFileTools, fileToolError, fileToolGuide, fileToolGuideTopics } from '@functional-systems/memdrive';

const tools = createFileTools({
    drive,
    tools: ['guide', 'read', 'tree', 'list', 'search', 'findText', 'write'],
    // Optional: every write tool call becomes a checkpointed write with this name,
    // unique across host restarts.
    checkpoint: () => ({ name: `turn-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}` }),
});

// Register definitions with the host's model or MCP transport.
const definitions = tools.definitions;
const folders = await tools.execute('tree', {}); // { fileCount, folders, truncated } of main
const page = await tools.execute('list', { prefix: '/notes/' }); // main; next is { cursor }
const guide = await tools.execute('guide', {}); // { version, content, topics }, no storage calls
const editingGuide = await tools.execute('guide', { topic: 'editing' }); // { version, topic, title, description, content }

// A host can expose precisely the same text as a resource.
const guideResource = fileToolGuide;
const editingResource = fileToolGuideTopics.editing; // Identical to editingGuide

const controller = new AbortController();
try {
    await tools.execute('write', {
        operations: [{ op: 'update', fileId: file.fileId,
            edits: [{ oldText: 'Earlier decision', newText: 'Current decision and reason' }] }],
    }, { signal: controller.signal }); // the plain write result
} catch (error) {
    // { ok: false, error: { code, message, status?, details? } }
    const toolFailure = fileToolError(error);
    // Encode toolFailure using the host's transport and error indicator.
}
```

The catalog has exactly seven tools: `guide`, `read`, `tree`, `list`, `search`,
`findText` and `write`. Each tool except `guide` calls the public SDK method of the same
name on main: `execute(name, input, options?)` passes the input object to the
drive method and rejects with SDK errors. No schema has an `at`, and an input
with `at` fails with `INVALID_INPUT` before any storage request. Results carry no
view selector either: `read` range pages and their `next`, and the `next` of
`list` and `findText`, omit `at`, so a model forwards `next` unchanged. Other
results are the SDK's. `write` accepts one SDK operation or
`{ operations: [...] }` and returns one file/deletion result or an array.
`findText` requires text mode; selecting it for an external-vector drive fails
with `TOOL_UNAVAILABLE`. External-vector definitions advertise vector inputs for
`search` and `write` and return the SDK's file references. No embeddings or local
content hydration are supplied by the tool layer.

`createFileTools({ drive, tools, checkpoint? })` takes an optional host hook,
`checkpoint: () => ({ name })`, synchronous or asynchronous. With it, every
`write` tool call becomes a [checkpointed write](#checkpointed-writes) named by
the hook, and the tool still returns the plain write result; checkpoints stay
with the host. The `write` schema has no checkpoint option, and an input with
`checkpoint` fails with `INVALID_INPUT`, so the agent can neither choose nor skip
a checkpoint. A failed write then reports `CHECKPOINT_WRITE_FAILED` (nothing
kept) or `CHECKPOINT_RESTORE_FAILED` through `fileToolError`, with a fixed
message and only `stage`, `restored`, the original and restore causes' code and
status (plus the writer's file details for stage `write`) and
`unrestoredFileIds`/`createdFileIds`; checkpoint names are removed. The hook runs
once per `write` call, before validation. Its names must be unique for the
store's lifetime, including across host restarts, so do not use a counter that
restarts. Without the hook, `write` is a plain write.

`createFileTools({ drive, tools, checkpoint?, actor?, now? })` also attributes
the agent's writes (see [File attribution](#file-attribution)): `actor` is passed
as `by` on every `write` call, and the result of `now()`, called once per `write`
call, as `time`. `actor` and `now` are validated when the tools are created and
`now()`'s result on each call. The `write` schema has neither field, and an input
with `by` or `time` fails with `INVALID_INPUT` before any storage request, so the
agent cannot name itself or date its writes. Results carry the attribution fields
unchanged.

Tool names, descriptions and schemas are the only text every client delivers to
a model, so the descriptions carry everything ordinary use needs, including when
to use each tool: `write`, for example, says what to save and not to wait to be
asked. `fileToolInstructions` is an optional, short, transport-neutral supplement
for server instructions, which clients may drop or shorten. It says what the
drive is and how the tools relate (search and read before writing, update rather
than duplicate). It mentions only searching and reading before writing and names
no tool that only some hosts offer, such as `tree`, `findText` or `guide`, so a
host can send it with any subset that can search and read. A host that writes or
extends its own instructions should name only the tools it offers. `guide()` returns the
index of topics, and `guide({ topic })` returns the selected topic. Both return
the exported versioned text without reading drive files.

`fileToolError` preserves SDK error codes, messages, status and details, excludes
causes and stacks, and masks unexpected errors. It does not retry calls.

Only `write` is marked `readOnly: false`. Tool calls go through the SDK, so
writes run one at a time within the host process; the host coordinates writers
in other processes.

The `guide` tool is optional, just like the other tools. The guide is reference
for unusual cases, and ordinary searching, reading and saving do not need it.
Hosts can omit the tool and expose the exported `fileToolGuide` index and
`fileToolGuideTopics` documents as resources, skills or another instruction
channel instead; no guide tool call is required by the executor. The frozen
index lists `retrieval` and `editing`, each described by the situations in which
to read it, which also suit a skill description. The `guide` tool description
repeats those conditions, so a model can choose a topic without reading the
index first. `guide({ topic })` returns that topic from the same immutable
catalog and version. Unknown topics return `INVALID_INPUT` with the valid names.
Resource URI mapping belongs to the host; clients without resource support can
use the guide tool.

The guide describes one drive and main only. Its topics hold procedures and
explanations the tool descriptions leave out: choosing a search mode, what to do
when results are missing or too many, tree limits, listing pagination, ranged-read
pages and cursors (`retrieval`); what counts as a duplicate, keeping both
statements when new information conflicts with what is saved (the later one is
current when it updates the earlier one), preserving selected conversational
wording, examples, qualifications and corrections instead of aggressively
summarizing them, what each write error means, moves and deletion caveats
(`editing`). It does not require new metadata or capturing every utterance. Long
originals can be delivered through ranged reads without reducing their stored
detail. The guide `version` changes only in release pull requests.

For a read-only connection, select only the needed query tools, for example
`['guide', 'tree', 'list', 'read', 'search']`. The executor copies the allowlist and
rejects every other name with `TOOL_NOT_ALLOWED`, even though the drive supports
writes. Descriptions keep their references to related tools in any subset; for
example, `search` mentions `findText`, `tree` and `list`. Definitions are deeply frozen. Input Schemas describe JSON structure; the
public SDK owns semantic validation such as UTF-8 limits, paths, declared
metadata and embedding dimensions. The `readOnly` flag classifies content
mutations, not backend credentials.

The host owns authentication, authorization and the selection of the authorized
drive, and must authorize every invocation and coordinate writers in other
processes. Arguments cannot select another drive or branch. Refs, rollback,
checkpoint retention and store lifecycle remain host operations outside this
catalog. List and findText cursors are self-contained and continue on a new
client of the same store. Transport formatting, hosted Markdown/capacity/reranker
policies, instruction delivery and telemetry remain host responsibilities;
instructions a host sends should name only the tools it offers. Tool
availability and fetching the guide do not establish which instructions a model
followed.

Repository development includes a [model tool-use evaluation harness](https://github.com/lambdadb/memdrive/tree/main/benchmark/tool-use) for SDK-backed synthetic workflows and guide delivery. It is outside the published package and separate from LongMemEval/BEAM retrieval evaluation.

### Publish a fixed tool catalog

For hosts that cache tool definitions, use `getFileToolDefinitions` to obtain
names, descriptions and schemas without opening a drive or accessing storage.
Select an explicit embedding mode and tool list. The returned array is deeply
frozen and identical to `createFileTools({ drive, tools }).definitions` for a
drive of that embedding mode and the same tool list. There are no view-specific
schema variants.

```ts
import { createFileTools, getFileToolDefinitions } from '@functional-systems/memdrive';

const advertised = getFileToolDefinitions({
    embeddingMode: 'managed',
    tools: ['guide', 'read', 'tree', 'list', 'search', 'findText', 'write'],
});
const readOnly = createFileTools({ drive, tools: ['guide', 'read'] });
// readOnly.execute('write', ...) rejects with TOOL_NOT_ALLOWED; recheck caller
// permissions before routing each call.
```

Keep the catalog's embedding mode fixed for that exposed contract. Managed text
and external-vector tools have different input and result semantics; external
mode rejects `findText`. Transport registration, catalog caching and changing a
published contract belong to the host. This API does not implement MCP transport
or establish compatibility with a particular client or marketplace.

## Explore folders with tree

```ts
const tree = await reopened.tree(); // main, the whole drive
// { fileCount: 5, truncated: false, folders: [{ path: '/projects/', fileCount: 4 },
//   { path: '/projects/alpha/', fileCount: 1 }] }
await reopened.tree({ at: work, prefix: '/projects/' }); // one folder of a fork
```

`tree` is like the shell's `tree -d`: it returns folders only, each with its file
count, and no files. A folder's `fileCount` includes the files in its subfolders,
and the top-level `fileCount` counts every file under `prefix`. `prefix` is an
absolute folder path ending in `/` and defaults to `/`; anything else fails with
`INVALID_INPUT`. `folders` holds the folders below `prefix` at any depth, in path
order, without `prefix` itself or its ancestors.

Each call is one LambdaDB query with facets on the `ancestorPaths` and `kind`
fields of file records (`size: 0`, so no file record or content is read), with a
consistent read on main and forks. It works in managed and external embedding
modes. The `kind` facet counts the files under `prefix` exactly. LambdaDB returns
at most 100 `ancestorPaths` buckets, the most populated first, and the prefix and
its ancestors use buckets too. `truncated` is `true` when all 100 were used, so
less populated folders may be missing; call `tree` with a subfolder as prefix to
see them. Below a prefix about 100 folders deep the ancestors use every bucket,
so `folders` is empty with `truncated: true` while `fileCount` stays exact. The
counts in `folders` are exact. A prefix, including one with double quotes, is
matched exactly.

LambdaDB rejects an aggregation over more than 10,000 distinct folders or 256 KiB
of folder paths with HTTP 400. `tree` reports any HTTP 400 as `DATABASE_ERROR`
with status 400 and a message suggesting a narrower prefix; LambdaDB's response
does not identify the budget case reliably, so it has no code of its own. Use
`list` with a delimiter or the paths of `search` hits to find candidate folders,
then call `tree` with one as prefix.

## List files

```ts
const files = [];
let page = await reopened.list({ at: work, prefix: '/notes/', limit: 100 });
for (;;) {
    files.push(...page.files); // in path order
    if (!page.next) break;
    page = await reopened.list(page.next); // { at, cursor }
}
```

`prefix` matches the beginning of the full path. `nameContains` checks a case-sensitive literal substring of the filename, including its extension. Omit `delimiter` for recursive results; the `'/'` delimiter shows each immediate subfolder once in `prefixes` instead of its files. Results carry file IDs, paths, creation and modification times with their recorded actors, and any declared metadata. For text files, use `read` to retrieve the exact original. Listing does not expose datastore or file versions or file sizes. Use `tree` for folder structure and file counts; `list` has no total count.

`list` reads the projected file fields through ordered LambdaDB document pages.
It reads main and forks consistently, including files written just before the
call, and reads checkpoints through their tags. The SDK applies the exact path
prefix and filename substring and gathers enough matches to fill the requested
page and discover whether another entry follows. A delimiter or a filter with
few matches can require reading several document pages.

- Files and folder prefixes form one sequence in Unicode code point order of their
  paths, the order LambdaDB sorts keywords in. A folder takes the place of its
  first file. Files that share a path, which racing creates in separate
  processes can leave, follow in `fileId` order.
- `limit` (default 100, 1–1000) counts files and prefixes together. Every page
  but the last is full, and `next` is present exactly when more entries follow.

Forward the returned `next` (`{ at, cursor }`) unchanged. The cursor is an opaque
token carrying the listing criteria and the last returned path (with its file ID,
or as a folder prefix), so it continues on any drive object or client of the
same store and does not expire. Existing position-based `l2` cursors continue
across this change. Each page returns entries after the saved position. A live
listing can observe writes during or between page calls. An entry already
returned is not repeated, except that a file moved past the position can appear
again at its new path. On a checkpoint the view is immutable. Passing a cursor
with another `at` (omitted means main) fails with `CURSOR_VIEW_MISMATCH`. A
malformed cursor, one from another store or an obsolete cursor format fails
with `LIST_CURSOR_UNAVAILABLE`. After a fork or checkpoint is deleted and
recreated under the same name, a continuation lists the new ref from the same
position.
