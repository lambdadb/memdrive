# LongMemEval-S with MemDrive

Ingest a reusable corpus once, then run independent retrieval experiments against
it. Each LongMemEval question retains its own isolated history collection; no
question can search another question's memories. Successful, failed and aborted
evaluation runs retain these collections. Only explicit corpus cleanup deletes
them.

| Mode | Evidence collection |
| --- | --- |
| `single_pass` | One question-only recall with limit 50 and SDK-default hybrid retrieval/reranking |
| `agentic` | A model chooses among the five read-only `createTools()` operations, then selects previously delivered evidence |

These are benchmark modes, not SDK options. Evidence collection and optional
answer generation use separate model contexts. The same answer packing and judge
apply to both modes; this is not a same-agent end-to-end conversation evaluation.
No live benchmark score is included, and historical SillyMemory scores must not
be relabelled as MemDrive results.

## Ingest once

Use Node.js 20.12+ from the repository root. Live three-question smoke checks
exercise ingestion and single-pass retrieval; they do not establish full-cohort
quality or model-provider compatibility for every configuration.

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
Ingestion submits at most 20 originals per public `remember()` call to bound
managed-embedding request size. A failed batch stops ingestion without retrying
or deleting the possibly accepted data; retain its receipts for inspection.

The immutable `corpus.json` binds the dataset, archived-original hashes, metadata
schema, managed embedding configuration, analyzers and per-question ownership.
Collector/answer models, prompts, query limits, judge settings and run-code hashes
are not corpus compatibility requirements. Changes that alter stored originals
or storage settings reject reuse and require a different corpus. The public
`open()` operation also validates MemDrive's stored format on every reuse.
Mutable readiness/deletion state and ingestion HTTP receipts live separately;
cleanup never rewrites the immutable manifest.

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
Only JSON Schema enum ordering is canonicalized, because native metadata field
order can vary. Actual enum values and other array ordering must still match;
collector requests use the frozen definitions and execute the public tools.
To change settings, edit `config.json` and prepare a new run directory against the
same corpus. Existing runs continue to use their frozen settings.

`recall` never creates, writes or deletes collections. It opens the existing
collection, checks ownership/schema/embedding/analyzers, and reads all expected
originals back before collecting evidence. Validation database operations and
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

Stored Mems preserve literal message bodies, roles, session identifiers and global
message positions. Calendar-validated session clocks are interpreted as UTC;
original date strings remain metadata. These are conversation times, not inferred
event dates. At least five recent messages including the question remain outside
the index, aligned at an adjacent user/assistant pair. Both answer conditions get
the same recent context. Answers, `has_answer` and `answer_session_ids` are
available only to evaluation, never to storage, the collector or answer model.
No SillyTavern escaping or application prompt machinery is imported.

Managed embeddings, English hybrid search and SDK-default reranking are used.
Database operations are serialized with one SDK request slot. Tool batches still
accept up to five searches; model-chosen queries, filters, limits and reranking
options are recorded without rewriting. Baseline limit 50 is not a constraint on
the agent's search work; the tool recall default is 10.

The collector sees unchanged public tool results unless a result exceeds 16,000
`cl100k_base` tokens. Then it receives a size-limit error and none of that result's
text; the raw return remains in diagnostics. Selection is a JSON response naming
exact previously delivered recall spans or complete read/list originals, not an
extra SDK tool. The final 4,096-token serialized evidence block admits candidates
in selected order, merges overlapping/adjacent spans, and presents them
chronologically. Whole candidates that do not fit are skipped, never silently
clipped. Instructions, recent dialogue and the question are outside this evidence
allocation and included in provider answer-input usage.

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
judge inputs, usage and summaries. Cache time is replayed from saved timestamps;
the serial verifier restores its clock on failure. Runtime elapsed values and
count fetch timestamps are excluded from semantic tool-output comparison.

Frozen configuration and judge-rule snapshots remain authoritative even after
current settings change. Executable SDK/runner/dependency code must still match
the run's fingerprints; use the recorded checkout/runtime if that code changes.
Receipts provide local audit consistency, not provider attestation or a frozen
server implementation. Legacy v1 one-shot artifacts are not adopted as reusable
corpora; retain their original checkout for verification.

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

### External and SDK collector boundaries

`collectorImplementation: "benchmark"` is the default external collector. It
consumes canonical IDs and exact spans from public `createTools` and selects
`{"evidence":[{"memId":"...","start":0,"end":123}]}`. Public tools expose no
alias settings or resolvers. The removed `shortIds`/`evidenceIds` run keys are
rejected even when false; historical runs require their retained runtime snapshot.
Dataset/corpus identity is unchanged and existing ready collections are reusable.

Set frozen `collectorImplementation: "sdk"` for agentic runs to use the public
retriever. Its model adapter receives internal m/e reference tools and selects
`{"evidence":["e1"]}`. Public selected evidence remains canonical. Preparation
freezes those internal model definitions using a local empty-selection adapter
probe through the public API; it performs no data or provider request. Live
collection and offline replay compare the actual supplied model definitions with
that frozen contract. `single_pass` always freezes canonical public tools,
regardless of the collector implementation setting.

`sdk-agent.mjs` owns Responses transport, application context and raw receipts.
Canonical source auditing uses host record events from the public retriever;
benchmark code imports no SDK internal modules. `orchestration.json` records
completion/accounting, while native Journal counts remain authoritative for HTTP
operations. Evidence packing, answering and judging stay separate. Oversized
undelivered references are not eligible for selection.

The external collector and SDK collector now differ in ID representation and
selection protocol as well as loop ownership. A comparison does not isolate
orchestration overhead. Earlier fixed-trace alias experiments and live results
remain historical evidence, replayable with their exact source snapshots; this
boundary cleanup does not establish a new performance or quality result.
