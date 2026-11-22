# Changelog

## Unreleased

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
