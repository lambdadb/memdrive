# Changelog

## Unreleased

Replace the memory SDK with a file SDK: a thin file abstraction over LambdaDB
collections, branches and tags. The SDK exposes what LambdaDB supports and holds
no state between calls; ordering, concurrency and multi-process ownership belong
to the caller.

- Create, open and destroy file stores with `MemDrive.create`, `MemDrive.open` and `MemDrive.destroy`. A store is one LambdaDB collection with the format tag `files-v1`; creation sets native `snapshotRetentionInDays` to 1, with no retention option. `destroy` deletes that collection after checking that it is a file store, and treats a missing store as already destroyed. `describe()` returns the configuration read by `create` or `open`.
- Select a view on every request with a serializable `at`: `{ kind: 'main' }` (the `main` branch), `{ kind: 'fork', name }` (a branch) or `{ kind: 'checkpoint', name }` (a read-only tag). Omitting `at` selects main. Main and forks are read with consistent branch reads, checkpoints from their tag. A native 404 on a view request is reported as `STORE_NOT_FOUND`, `BRANCH_NOT_FOUND` or `CHECKPOINT_NOT_FOUND` with status 404.
- Write files to main or a fork with `write`, as one operation or a batch of up to 100 `create`, `update` (including moves and exact `oldText`/`newText` edits) and `delete` operations; checkpoints reject writes with `INVALID_INPUT`. A file is an original document plus chunk documents; chunks are written before the original that makes the file visible, and a delete removes the original and then its chunks. Each request is confirmed with a consistent read. Path uniqueness (`PATH_EXISTS`) is checked by a read before writing and is best effort under concurrent writers. A write whose outcome is unknown fails with `WRITE_UNCONFIRMED` and details of the attempted and completed files, without fencing later calls. Batches are not transactions. A file counts as completed once its original is written or deleted, so a failed chunk cleanup (stage `cleanup-chunks`) still lists it in `completedFileIds`. Cleanup rereads the original and keeps its current chunk generation, and an update that finds no chunks for a nonempty original chunks it again, so resending an update repairs a file whose chunks racing writers removed. Racing creates can leave two files at one path: updates and deletes by `fileId` keep working, only creates and moves are checked against other files, and reading such a path fails with the new `PATH_AMBIGUOUS` error listing the file IDs.
- Read exact originals by `fileId`, `path` or up to 100 `paths`, and read bounded line or character ranges with exact line endings, Unicode-safe continuation and `READ_VERSION_CHANGED` detection.
- Search indexed chunks with semantic retrieval by default, explicit keyword and hybrid modes, independent opt-in reranking, declared-metadata filters and verified source ranges. External-vector stores store caller-supplied vectors and search them with vector queries. LongMemEval and BEAM explicitly select hybrid retrieval.
- Find case-insensitive literal occurrences in original text with `findText`, with verified UTF-16 ranges, one-based `startLine`/`endLine` numbered like ranged `read`, excerpts, prefix and metadata filters, and stateless cursors. Checkpoint scans are snapshots; main and fork scans are live. Originals are scanned in ID-ordered batches of up to 16 per page.
- List files with `list`, one native `docs.list` page per call with server-side filters on the selected branch or tag. Results come in native order with `consistency: 'eventual'`; a page can be short or empty while `next` is present, common prefixes are computed per page and can repeat, and the listing is complete only when `next` is absent. The cursor is an opaque token carrying the criteria and the native page token and continues on any drive object of the same store. A malformed or foreign cursor fails with `LIST_CURSOR_UNAVAILABLE`; another view's cursor fails with `CURSOR_VIEW_MISMATCH`. A list cursor is not bound to its fork's or checkpoint's identity; restart a listing after recreating a ref.
- Create forks and checkpoints from any view with `fork({ at?, name })` and `checkpoint({ at?, name })`, list them with `listForks` and `listCheckpoints`, and delete them with `deleteFork({ at })` and `deleteCheckpoint({ at })`. Each sends one native request; name conflicts report `BRANCH_CONFLICT` or `CHECKPOINT_CONFLICT`.
- Add `rollback({ at, to })`, which replaces the contents of main or a fork with those of a checkpoint through one `branches.rollback` call that is never retried, and returns `{ at }`. Resending a rollback can undo writes made after the first one. LambdaDB can reject a just-created checkpoint with status 400 until its snapshot is published (LambdaDB PR #640); the error passes through.
- Persist per-file chunking strategies (`auto`, `boundary`, `none`, `docling`) and provide an optional Node-only Docling Hybrid adapter at `@functional-systems/memdrive/docling`, preserving exact originals, contextualized embeddings and verified ranges. Managed stores leave original `body` and chunk `embeddingText` without a text index and declare the embedding source with the native `sources` form.
- Provide a shared file-tool catalog one-to-one with the SDK methods: `guide`, `list`, `read`, `search`, `findText`, `fork`, `checkpoint`, `listForks`, `listCheckpoints`, `deleteFork`, `deleteCheckpoint`, `write` and `rollback`, with an explicit allowlist, one fixed schema set per embedding mode, unchanged SDK results, portable error formatting, `fileToolInstructions` and a versioned read-only guide (version 7, describing this contract).
- Re-export `LambdaDBClient` and `HTTPClient` from the pinned `@functional-systems/lambdadb` `0.14.0`, which requires a LambdaDB deployment that creates a tag on a branch before its first snapshot commits (LambdaDB PR #614) and supports branch rollback to a tag.
- Run LongMemEval and BEAM against the public file SDK, and evaluate model tool use with the shared catalog in a repository benchmark.

Removed relative to earlier unreleased development builds, without a compatibility path. Stores they created (format `files-v0`) fail to open or destroy with `INCOMPATIBLE_STORE`; delete those collections and their `md-journal-*` collections directly with LambdaDB.

- APIs: `merge`, `diff`, `status`, `history`, `configure`, `retentionInDays` on `create` and in `describe()`, and `version` on `fork` and `checkpoint`; the `merge`, `diff`, `status` and `history` tools and the `publication` guide topic; the `MergeRequest`, `MergeResult`, `FileChange`, `FileStoreStatus`, `FileHistoryRequest`, `FileHistoryEntry`, `FileHistoryResult` and `ForkRequest` types; `version` on ranged read pages.
- Storage: the publication journal collection, `md-main-v*` version tags and the `md-main-v0` initial view, and file tombstones, baselines, fingerprints and the `changed` field and index on originals. Main is read directly from the `main` branch.
- Process state: per-fork write queues, the store merge queue, the per-client store registry and lifecycle gate, write, reference and configuration uncertainty fences, the store deletion marker, and the list scan cache with its process-wide budget and timers.
- Error codes: `MERGE_CONFLICT`, `HISTORICAL_VIEW_UNAVAILABLE`, `HISTORY_CURSOR_UNAVAILABLE`, `VERSION_NOT_FOUND`, `REF_CREATION_UNCONFIRMED`, `REF_DELETION_UNCONFIRMED`, `CONFIGURATION_UNCONFIRMED`, `STORE_BUSY`, `STORE_DELETING`, `STORE_DELETED`, `STORE_DELETION_UNCONFIRMED`, `STORE_REPLACED`, `MAIN_BOOTSTRAP_UNCONFIRMED`, `CHUNKER_MISMATCH` and `LIST_SCAN_LIMIT`. Unknown fork, checkpoint, deletion and rollback outcomes surface as the underlying error.

## 0.1.0

First stable release of the standalone MemDrive SDK. The public API and storage
format are unchanged from 0.1.0-rc.1; the LambdaDB TypeScript client remains pinned
to 0.12.0.

- Provide memory storage, vector and hybrid retrieval, complete-original reads, metadata inspection, branches and portable agent tools.
- Wait for npm registry metadata to become visible after a successful publication, without retrying publication; verify archive identity and report channel state on reruns.
- Document stable installation and the `latest`, `rc` and `dev` channels.

## 0.1.0-rc.1

First release candidate of the standalone MemDrive SDK, backed by the pinned
LambdaDB TypeScript client 0.12.0.

- Store original memories with automatic text chunking, or store caller-provided embeddings and metadata.
- Retrieve evidence through vector or hybrid search with optional native reranking; support structured metadata filters, exclusions and ordered batch results.
- Read complete originals, inspect schema descriptions and keyword distributions, and manage memories and branches.
- Expose portable agent tools through `@functional-systems/memdrive/tools`, with JSON Schema contracts, branch binding and optional writes. Applications own search orchestration and answer generation.
- Support ESM, CommonJS and TypeScript consumers on Node.js 20.12+ and browser bundlers.
- Validate installed release archives with bounded live integration checks and publish immutable versions with source identity through npm Trusted Publishing.
- Supply the required Bayesian candidate budget when hybrid recall disables reranking.
