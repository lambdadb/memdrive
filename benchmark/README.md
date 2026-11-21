# Benchmarks

Repository-owned evaluations are Node.js development tools outside the
published npm archive. LongMemEval consumes the public file SDK and owns its
tool definitions, model orchestration and evidence scoring.

- [LongMemEval](longmemeval/README.md) uses reusable per-question file corpora for
  `single_pass` and `agentic` retrieval with optional answering and judging.
- BEAM is planned as a separate suite.

Keep datasets, credentials, receipts and reports under ignored `artifacts/`.
Synthetic benchmark tests run with `npm test`; ordinary CI makes no live
database or model calls.
