# Benchmarks

Repository-owned evaluations are Node.js development tools outside the
published npm archive. They consume the public file SDK and own their
source preparation, model requests and evaluation logic.

- [LongMemEval](longmemeval/README.md) uses reusable per-question file corpora for
  `single_pass` and `agentic` retrieval with optional answering and judging.
- [Original BEAM](beam/README.md) uses a reusable file corpus per conversation
  for single-pass retrieval and offline answer preparation.

Keep datasets, credentials, receipts and reports under ignored `artifacts/`.
Synthetic benchmark tests run with `npm test`; ordinary CI makes no live
database or model calls.
