# Benchmarks

Repository-owned evaluations consume MemDrive's public package APIs. They are
Node.js development tools, outside `src/` and the published npm archive.

- [LongMemEval](longmemeval/README.md): reusable per-question corpora, `single_pass` retrieval and `agentic` memory
  tools, followed by optional answer generation and judging stages.
- BEAM is planned as a separate suite; no BEAM runner is included yet.

Keep datasets, credentials, receipts and reports out of source control. Local
outputs belong under ignored `artifacts/`. Synthetic benchmark tests run with
`npm test`; ordinary CI makes no live database or model calls.
