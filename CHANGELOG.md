# Changelog

## Unreleased

- Add one-based inclusive `startLine` and `endLine` to each findText hit `range`, numbered with the same CRLF, CR and LF line breaks as ranged `read`, so a hit's lines can be passed to `read` to retrieve the lines containing the match. UTF-16 offsets and `context` are unchanged.
- Scan findText originals in ID-ordered batches of up to 16 per page with one native query, plus an exact read when resuming inside a file and the first live page's upper bound, instead of one query per original. Pages, hits, cursors and their validation are unchanged; large batches rely on the native client's automatic `docsUrl` download, and a response it leaves offloaded or whose document count disagrees with its total is rejected rather than treated as complete. New managed stores no longer create a text index on original `body` fields, which no query used, so originals are not analyzed on write; opening a store requires `body` to be unindexed.

- Separate the SDK history window from native snapshot retention. `retentionInDays` on `create`, `configure` and `describe()` now sets the window for internal main version tags and completed merge captures: integers from 1 to 365, default 30. New stores keep LambdaDB `snapshotRetentionInDays` at its one-day minimum and persist the window in the SDK configuration description in both embedding modes; `configure` writes both in one confirmed native update.

- Replace per-view handles with one drive object per store. Every request selects its view with a serializable `at` (`{ kind: 'main' }`, `{ kind: 'fork', name }` or `{ kind: 'checkpoint', name }`); omission means main. `write`, `diff` and `merge` require an explicit fork `at` and never fall back to main or create a fork. `fork` and `checkpoint` take an optional source `at` (with `version` only from main) and return `{ at }`. Add `listForks`, `listCheckpoints`, `deleteFork` and `deleteCheckpoint` methods and tools; `merge` only publishes and never deletes its fork. List, findText, read-range and history continuations are returned as `next` and forwarded unchanged; a cursor used with another view fails with `CURSOR_VIEW_MISMATCH`. findText and history cursors are now stateless opaque tokens that continue on any client of the same store and no longer expire after five minutes in SDK memory; they become unavailable when their pinned version, fork or checkpoint incarnation, or resumed file is no longer available. List scan caches share one process-wide budget across stores and views, and keep their five-minute expiry. Shared tools are one-to-one with SDK methods and have one fixed schema set per embedding mode; the guide is version 7. Remove `MainFileDrive`, `WorkingFileDrive`, `CheckpointFileDrive`, `open({ at })`, `ForkSelection`, `CheckpointSelection`, `CreateMainFileRefRequest`, `FileRefEntry`, `FileToolRefResult`, handle `delete()`, view-bound tool schemas and the `REF_DELETED` error; a deleted fork or checkpoint reports `BRANCH_NOT_FOUND` or `CHECKPOINT_NOT_FOUND`.

- Default text search to semantic retrieval without reranking. Add explicit keyword and hybrid modes with independent reranking, preserve external-vector search, and explain mode selection in shared tools and guide version 5. LongMemEval and BEAM explicitly retain hybrid retrieval.

- Replace prerelease `asOf` ref selection with optional `version` on main fork/checkpoint creation. Select exact completed publications, reject version selectors on working forks/checkpoints and reject `asOf` everywhere. Preserve explicit checkpoint workflows and missing-history errors; update public types, bound tool schemas and guide version 4.

- Automatically enforce configured retention after terminal merges and completed recovery, preserving explicit forks/checkpoints, current main, bounded history summaries and request replay. Cleanup is bounded and best effort; remove the prerelease-only public pruning API.
- Configure retention at creation or through the drive, with generation checks, confirmed updates and fencing of unconfirmed configuration changes.
- Add persisted per-file chunking strategies and an optional local Docling Hybrid adapter, preserving exact originals, contextualized embeddings, verified ranges and parser-free publication recovery.
- Read bounded text ranges with exact line endings, Unicode-safe continuation and changed-original detection; expose the same contract through the shared read tool.
- List user forks and checkpoints, delete selected refs with stale-handle protection, and destroy stores with owned-journal cleanup and durable deletion recovery.
- Replace the memory SDK entry points with a file SDK for fresh stores, read-only main, and working forks.
- Create files in batches and read exact originals by path or stable file ID. Search indexed chunks with hybrid retrieval, optional reranking and verified source ranges.
- Find case-insensitive literal occurrences in original file text with verified UTF-16 ranges, excerpts, metadata filters and resumable pages.
- Read the published main version, unfinished merge phase and paginated main publication history from any file view.
- Bind a shared file-tool catalog to an authorized view with an explicit allowlist, mode-specific JSON Schemas, unchanged file/publication results, optional fork and checkpoint creation, portable error formatting and a versioned read-only guide.
- Run LongMemEval against the public file SDK. The file-based corpus and run formats bind each evidence span to its original file and keep prior benchmark results on their original protocol.

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
