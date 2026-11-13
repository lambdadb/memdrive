# Changelog

## 0.1.0 — Unreleased

- Extract the MemDrive prototype into a standalone TypeScript SDK backed by LambdaDB 0.12.0.
- Preserve memory storage, retrieval, source reading, filtering, schema inspection, batch operations and branches.
- Add ESM, CommonJS and TypeScript distribution checks with a browser-compatible runtime boundary.
- Establish main-branch development and release conventions. Development publication uses an explicitly dispatched, validated npm `dev` workflow.
- Remove internal agent orchestration and retrieval modes; callers own repeated searches and evidence selection.
- Expose branch-aware keyword distributions through `countValues`; retain `describe` as the sole schema inspection API.
- Add portable memory tools with JSON Schema contracts, effect annotations, branch binding and optional writes under the `tools` export.
- Add bounded live integration checks, exact-tarball validation and source-linked immutable development versions.
- Supply the required Bayesian candidate budget when hybrid recall disables reranking.
