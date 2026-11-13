# Changelog

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
