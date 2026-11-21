# LongMemEval-S with MemDrive

This benchmark uses the public `@functional-systems/memdrive` file SDK built
from this checkout. It creates one isolated file store per question and writes
archived turns as files on its `corpus` fork. Independent runs reuse that fork
until explicit corpus cleanup.

| Mode | Evidence collection |
| --- | --- |
| `single_pass` | One hybrid file search using the question and date, with reranking and a limit of 50 |
| `agentic` | A model uses read-only search and read tools and selects previously delivered file spans |

The benchmark owns the tool definitions, collection loop and model requests.
Both modes use the same answer context, packing rules and judge. Collector and
answer contexts are separate. Historical results from memory-based benchmarks
retain their original protocol and runtime.

## Ingest once

Use Node.js 20.12+ from the repository root. Build the SDK before running the benchmark.

```sh
npm ci
npm run build
node benchmark/longmemeval/run.mjs setup --root artifacts/lme-corpus
node benchmark/longmemeval/run.mjs ingest --root artifacts/lme-corpus --limit 10 --env-file /path/to/evaluation.env
```

`setup` downloads the pinned 277 MB LongMemEval-S cleaned dataset, checks size and
SHA-256, and writes a corpus manifest covering all 500 question IDs. It makes no
database calls. Use `setup --dataset /path/to/downloaded.json` for an existing
copy with the same checks. `ingest` materializes only the selected prefix of
sorted IDs (default 10), verifies original readback, then marks each entry ready.
A matching ready entry is skipped without create, upsert, embedding or any other
native request. To grow the same corpus, run `ingest --limit 500`; the first ten
ready collections are preserved and only missing entries are created.
Ingestion submits at most 20 originals per public batched `write()` call to bound
managed-embedding request size. A failed batch stops ingestion without retrying
or deleting the possibly accepted data; retain its receipts for inspection.

The immutable `corpus.json` binds the dataset, archived-original hashes, metadata
schema, managed embedding configuration, analyzers and per-question ownership.
Collector/answer models, prompts, query limits, judge settings and run-code hashes
are not corpus compatibility requirements. Changes that alter stored originals
or storage settings reject reuse and require a different corpus. The public
`open()` operation also validates MemDrive's stored format on every reuse.
Readiness state records the SDK-assigned file IDs in original order after
readback. Deletion state and ingestion HTTP receipts live alongside that
mapping. Cleanup leaves the immutable manifest intact.

## Repeat retrieval independently

```sh
node benchmark/longmemeval/run.mjs prepare --root artifacts/lme-single-1 --corpus artifacts/lme-corpus --mode single_pass --limit 10
node benchmark/longmemeval/run.mjs recall --root artifacts/lme-single-1 --env-file /path/to/evaluation.env
node benchmark/longmemeval/run.mjs verify --root artifacts/lme-single-1

node benchmark/longmemeval/run.mjs prepare --root artifacts/lme-agent-1 --corpus artifacts/lme-corpus --mode agentic --limit 10
node benchmark/longmemeval/run.mjs recall --root artifacts/lme-agent-1 --env-file /path/to/evaluation.env
node benchmark/longmemeval/run.mjs verify --root artifacts/lme-agent-1
```

`prepare` requires ready corpus entries. Defaults are `agentic` and the first ten
sorted IDs, a smoke cohort rather than a stratified or held-out sample. Both
modes with the same limit use the same IDs. Each run freezes its own settings,
prompts, judge rules, executable/runtime fingerprints and public tool definitions.
The collector receives the frozen tool definitions.
To change settings, edit `config.json` and prepare a new run directory against the
same corpus. Existing runs continue to use their frozen settings.

`recall` never creates, writes or deletes collections. It opens the existing
corpus fork, checks ownership/schema/embedding/analyzers, and reads all expected
originals by path in bounded batches, checking their file IDs before collecting evidence. Validation database operations and
elapsed time are reported separately from retrieval operations/time. Reuse
removes repeated ingestion and embedding, not these integrity reads. This proves
expected originals match; it does not prove absence of externally injected data
or every internal chunk invariant. The harness treats corpora as immutable,
exposes only read-only tools, and rejects returned spans that differ from source.
External corpus mutation is unsupported.

A `single_pass` recall requires only database credentials and makes no model or
judge call. An `agentic` recall additionally makes paid collector-model calls,
but still makes no answer or judge call. A completed retrieval-only run can pass
`verify`; its answer accuracy remains null.

## Optional answering and judging

```sh
node benchmark/longmemeval/run.mjs score --root artifacts/lme-single-1 --env-file /path/to/model.env
node benchmark/longmemeval/run.mjs verify --root artifacts/lme-single-1
```

`score` validates saved evidence offline, then calls the answer model and judge.
It needs no database credentials, no live corpus and no corpus lease. It can run
after explicit remote corpus cleanup. Collector usage is retained separately
when answer/judge usage is added. Scoring is not automatically retried after an
interrupted or failed paid attempt.

Environment variables (or an untracked env file):

- `LAMBDADB_BASE_URL`, `LAMBDADB_PROJECT_NAME`, `LAMBDADB_PROJECT_API_KEY`: required
  for ingest, recall and cleanup; use a dedicated test project.
- `LLM_API_KEY`: required for agentic recall and scoring.
- `TYPESAFE_API_KEY`: required only for scoring.

Endpoints, historical model IDs, prompts and limits are configured in
`config.json`; offline checks do not establish provider/model availability.
The collector uses the OpenAI Responses API with the configured reasoning effort,
`store: false`, explicit non-strict function schemas, and unchanged opaque reasoning
items carried into the next request. Answer generation uses Chat Completions
without tools. This separation preserves `gpt-6.1-sol` with low reasoning: live
Chat Completions rejected that combination when function tools were included.
Incomplete collector responses remain failed attempts with recorded usage; no
automatic fallback to another model, reasoning effort or API is performed.
See the [official Responses migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses)
and [reasoning-item guidance](https://developers.openai.com/api/docs/guides/reasoning).
Judging uses the retained Jev Noul task-specific rules and a 0.5 threshold, not a
claim of equivalence with the upstream GPT-4o evaluator.

## Source and evidence protocol

Dataset revision: `98d7416c24c778c2fee6e6f3006e7a073259d48f` of
`xiaowu0162/longmemeval-cleaned`; SHA-256:
`d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`.

Each nonblank archived turn is stored as a text file at
`/sessions/<session>/messages/<message>.txt`. The filename uses the zero-based
position across the conversation. Files preserve literal message bodies and
include role, session ID, positions and calendar-validated session timestamps
interpreted as UTC in metadata. Recent dialogue remains outside the index. The
boundary includes at least five messages counting the question and keeps a
preceding user/assistant pair together. Answers and evidence annotations enter
only scoring and coverage calculations.

Both modes use managed embeddings, English text analysis and reranked hybrid
search. The agent may reduce the search limit from the configured ceiling.
Read returns a full original by file ID. Search evidence uses the SDK's UTF-16
ranges when present. The benchmark checks the file ID, path, metadata, text and
range against the frozen source before delivery. If the SDK omits a range, the
benchmark attributes text only when it occurs exactly once in the original.
Unattributed snippets remain in raw receipts and are omitted from the model's
evidence. The collector can read their originals by file ID.

If a tool result exceeds 16,000 `cl100k_base` tokens, the collector receives a size
error and none of that result's evidence. The collector returns
`{"evidence":[{"fileId":"...","start":0,"end":123}]}`, copying exact references
to delivered spans. Full-file reads use the same reference format. The final
4,096-token serialized evidence block admits whole candidates in selected
order, merges overlapping or adjacent spans and presents them chronologically.
The question and recent dialogue sit outside the evidence budget.

## Limits, failures and explicit cleanup

Per question: eight collector rounds, 24 tool calls, 48,000 estimated request
tokens including completion reservation, 160,000 reported collector/answer
tokens, 1,000 database operations and 15 minutes per live phase. Validation reads
count toward the retrieval phase's database limit. Ingest, recall and score each
have an eight-hour phase deadline. The collector/answer token limit is cumulative
across recall and score. Each HTTP call has a 180-second bound. Preflight reserves
serialized-request `cl100k_base` tokens plus maximum completion; provider usage
is checked again afterwards. This estimate is not exact provider tokenization.

Pending ownership is recorded before create. Incomplete/uncertain ingestion is
never retried automatically, and ready entries are never overwritten. A failed
partial ingestion requires inspection and explicit cleanup; this initial runner
retires the whole corpus on cleanup rather than repairing individual entries.
Create another corpus to reingest after retirement. Existing ready entries remain
usable until retirement, subject to the selected run prefix being ready.

```sh
node benchmark/longmemeval/run.mjs cleanup --root artifacts/lme-corpus --env-file /path/to/evaluation.env
```

Cleanup verifies exact collection names and owner/scope labels, deletes only
materialized entries and confirms HTTP 404. It works after dataset removal or
run-setting/code fingerprint changes, has a fresh bounded 30-operation allowance
per entry/invocation, and retains cumulative receipts/accounting. It leaves local
manifests, dataset and run evidence intact. Evaluation failures never trigger it.

One exclusive `.corpus-active` lease serializes ingestion, preparation, recall
and cleanup on a corpus, preventing deletion during retrieval. Separate corpora
can be evaluated independently. Scoring and offline verification do not hold this
lease. `.running` prevents concurrent CLI operations on the same run/root. Leases
are released on handled failures. After a hard kill, confirm the old process has
exited before manually removing its stale guard and inspecting pending receipts.

## Verification and results

Each run snapshots the immutable corpus manifest and selected readiness proof,
and retains the pinned dataset through a hard link (copy fallback across devices).
Removing the corpus's original local files does not remove these run inputs.
`verify` replays public `open`, descriptor/read validation and tools against run
HTTP receipts; it does not replay ingestion or require any live collection. It
checks source equality, reconstructs collector and answer requests, packing,
judge inputs, usage and summaries. The same file operations and arguments
are replayed against recorded native HTTP responses.

Frozen configuration and judge-rule snapshots remain authoritative even after
current settings change. The built file SDK, runner and dependencies must match the run fingerprints.
The file corpus format is `longmemeval-file-corpus-v1`; the run and file evidence
format is `memdrive-longmemeval-files-v1`. Use the matching historical checkout
to verify or clean up earlier memory corpora and runs. Receipts verify local
audit consistency and do not attest provider behavior.

`summary.json` separates retrieval completion from scoring completion. A completed
scored run includes operational failures in the frozen question denominator;
retrieval-only and incomplete scored runs have null answer accuracy. It reports
validation versus retrieval resources and per-model-stage calls, input/output
usage, unknown usage and HTTP time. Ingestion resources remain in the corpus
state/receipts, outside repeated-run totals. Billed cost remains null.

Per-question `evidence.json` separates raw retrieved, model-delivered and
final-packed annotation coverage. Any turn overlap and full-turn coverage are
distinct, archived and recent-context annotations are separated, missing turn
annotations yield null, and abstention coverage is not applicable. These are
coverage proxies, not necessary-fact recall or proof of comprehension. Offsets
are UTF-16 code units. Previously used development data does not establish
held-out generalization.

## Provenance and validation

SillyMemory's `feat/memdrive-integration` informed protocol/lifecycle requirements.
This independently implemented Node.js runner imports no SillyMemory runtime,
Python bridge or private MemDrive SDK. `judge-rules.json` retains upstream
LongMemEval evaluation instructions adapted for Jev; its hash is configured and
frozen per run. `LICENSE.upstream` preserves the MIT notice (Di Wu, 2024).
Sources: [LongMemEval](https://github.com/xiaowu0162/LongMemEval),
[pinned dataset](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/tree/98d7416c24c778c2fee6e6f3006e7a073259d48f).

`npm test` uses synthetic histories and native HTTP responses to verify source
isolation, corpus growth/reuse, both modes, retrieval-only execution, explicit
cleanup, failure accounting and offline replay after deletion. Installed-package
consumer checks remain offline. Benchmark code, datasets and receipts stay
outside the published npm package; no live answer-quality claim follows from
unit or package tests.
