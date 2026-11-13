# LongMemEval-S with MemDrive

This runner measures whether a model can use the public MemDrive tools to find
conversation evidence. It has two modes, using the same final answer and judge:

| Mode | Evidence collection |
| --- | --- |
| `single` | One question-only recall with limit 50 and SDK-default hybrid retrieval/reranking |
| `tools` | A model chooses among the five read-only `createTools()` operations, then selects previously delivered evidence |

Evidence collection and answer generation are separate model contexts. This
isolates retrieval and evidence selection; it is not a same-agent end-to-end
conversation evaluation. No live MemDrive benchmark result is included.
Historical SillyMemory scores belong to different source preparation, prompt
assembly and runtime configurations and must not be relabelled as these results.

## Setup and a small run

Use Node.js 20.12+ and run from the repository root. The live workflow has been
implemented but not qualified against a live database or model provider.

```sh
npm ci
npm run build
node benchmark/longmemeval/run.mjs setup --root artifacts/lme-tools
node benchmark/longmemeval/run.mjs prepare --root artifacts/lme-tools --mode tools --limit 10
node benchmark/longmemeval/run.mjs run --root artifacts/lme-tools --env-file /path/to/evaluation.env
node benchmark/longmemeval/run.mjs verify --root artifacts/lme-tools
```

`setup` downloads the pinned 277 MB public LongMemEval-S cleaned dataset and
checks its size and SHA-256. Use `setup --dataset /path/to/downloaded.json` to use
an existing copy with the same checks. `prepare` defaults to the first 10 sorted
question IDs; this is a smoke cohort, not a stratified or held-out sample. Both
modes with the same limit use the same IDs. Use a different root and `--mode
single` for the baseline. Use `--limit 500` only after validating the small run
and reviewing the model/database operation budget. These are separate paid runs;
no existing collections or old benchmark artifacts are adopted.

Environment variables (or an untracked env file):

- `LAMBDADB_BASE_URL`, `LAMBDADB_PROJECT_NAME`, `LAMBDADB_PROJECT_API_KEY`: a
  dedicated test project. The runner creates and deletes temporary collections.
- `LLM_API_KEY`: collector and answer model authentication.
- `TYPESAFE_API_KEY`: Jev judge authentication.

The endpoints, historical model IDs, prompts and limits are in `config.json`.
They are frozen by `prepare`; model availability is not established by offline
checks. The judge uses the retained task-specific Jev Noul rules and a 0.5
threshold. This is not a claim of equivalence with the upstream GPT-4o evaluator.
Changing configuration requires a new run root and preparation.

## Protocol

The frozen dataset is revision `98d7416c24c778c2fee6e6f3006e7a073259d48f` of
`xiaowu0162/longmemeval-cleaned`, SHA-256
`d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`.

Each case stores original message bodies, role, session ID/position and global
message position. Session clocks are calendar-validated and interpreted as UTC;
original date strings remain metadata. They are conversation times, not inferred
event times. The current question and recent window (at least five messages
including the question, aligned at an adjacent user/assistant pair) stay outside
the index. Recent context is supplied identically to both answer conditions.
Source bodies are preserved literally: no SillyTavern template escaping or
application prompt machinery is imported. Answers, `has_answer` and
`answer_session_ids` are available only to evaluation, never to indexing or the
collector/answer model.

The runner uses managed embeddings, English hybrid search and current SDK
reranking defaults. It serializes database operations with a single SDK request
slot; tool batches still accept up to five searches. Model-chosen query text,
filters, limits and reranking options are recorded without rewriting them.
The `single` baseline's limit 50 is not an equal-search-work constraint on the
model, whose default recall limit is 10.

The model sees the unchanged public tool results unless a result exceeds 16,000
`cl100k_base` tokens. In that case it receives an explicit size-limit error and
none of that result's text. The raw return is retained for diagnostics. Full
originals obtained via `read`/`list` and exact recall spans can be selected; the
model cannot introduce new source spans or arbitrary summaries. Selection is a
collector JSON response, not an added SDK tool. Tools that return no text, such
as value counts, can help query planning but do not themselves count as evidence.

Both modes admit evidence in selection order, merge overlapping/adjacent spans,
and present admitted evidence chronologically. The serialized evidence block
must fit 4,096 `cl100k_base` tokens. Whole candidates that do not fit are skipped;
the runner never silently clips a source span. This budget excludes system
instructions, recent dialogue and question, which are included in provider
answer usage. Large originals can be read by the collector but omitted from the
answer input; the separate stage metrics make that loss visible.

## Limits, receipts and cleanup

Per question: 8 collector rounds, 24 tool calls, 48,000 estimated request tokens
including completion reservation, 160,000 reported collector/answer tokens,
1,000 database operations, and 15 minutes. Each HTTP call has a 180-second bound;
the whole run has an eight-hour bound. Preflight reserves serialized-request
`cl100k_base` tokens plus the configured completion maximum. This is a conservative
application estimate, not the provider's exact tokenizer accounting; reported
usage is checked again afterwards. No automatic HTTP/model retries occur.
Cleanup has a separate 30-operation allowance and remains possible after a
question or run timeout. Failed and uncertain requests have receipts; their
unavailable billable usage is explicitly unknown.

A pending ownership record is persisted before collection creation. Successful
writes are read back before collection tools are exposed. Cleanup verifies the
exact random collection name and run/scope labels, deletes only that collection,
and confirms HTTP 404. Answer generation starts after cleanup. Cleanup failure
stops further allocation and leaves the run incomplete.

`lock.json` freezes the cohort, source hashes, configuration, prompts, actual
installed dependency code, package metadata and tool definitions. Question
folders hold raw database/model HTTP receipts without authentication headers,
raw versus delivered tool results, selected/final spans and annotation metrics.
Hashes and receipts provide local audit consistency, not cryptographic provider
attestation. Server-managed search/reranker behavior and model nondeterminism are
not frozen by the dependency lock.

`verify` is offline. It replays ingestion and public SDK tool calls against the
recorded native responses, checks source equality and metadata/offsets, rebuilds
collector requests, evidence selection, answer requests and judge inputs, then
checks counts, verdicts and cleanup. It excludes runtime elapsed time and count
fetch timestamps from semantic tool-output comparisons. Cache time is replayed
from recorded request/tool timestamps; verification runs serially with its clock
restored even on failure. It does not contact providers or declare unrecorded
requests successful.

```sh
node benchmark/longmemeval/run.mjs cleanup --root artifacts/lme-tools --env-file /path/to/evaluation.env
```

Explicit cleanup can run after code changes or dataset removal and receives a
fresh bounded cleanup allowance while retaining cumulative accounting. A
`.running` directory prevents concurrent CLI operations. After a hard kill,
confirm the old process is gone before removing that directory and running
cleanup. The runner does not resume paid evaluation automatically: uncertain
request outcomes require inspection, and a new evaluation uses a new root.

## Reading results

`summary.json` retains the frozen cohort denominator. A completed run counts
operational failures as incorrect and reports scored/failed counts, per-type
outcomes and per-model-stage calls, input/output tokens and elapsed HTTP time.
For incomplete runs, headline `accuracy` is null; provisional correctness over
the frozen cohort is explicitly named. Token totals are known reported usage,
with unknown-usage request counts alongside them. Billed cost stays null.

Each `evidence.json` reports raw retrieved, model-delivered and final-packed
coverage. Any overlap with an annotated turn and full-turn coverage are distinct;
archived annotations and annotations in recent context are separated. Session
coverage includes recent dialogue. Missing turn annotations yield null rather
than zero; abstention cases are not scored for evidence coverage. These are
annotation-coverage proxies, not measurements of all necessary facts or proof
that the model understood the evidence. Source offsets use UTF-16 code units.

Inspect traces to distinguish failed retrieval, oversized delivery, poor evidence
selection, packing loss and wrong answers despite delivered annotations. Tool
frequency alone is not a success metric. The test dataset was used during prior
SillyMemory development, so results would not establish held-out generalization.

## Provenance and local validation

The existing SillyMemory `feat/memdrive-integration` workflow informed the
protocol and lifecycle requirements. This is an independent Node.js runner; no
SillyMemory runtime, Python bridge, private MemDrive prototype or application
source assembly is imported. The retained `judge-rules.json` contains the
upstream LongMemEval evaluation instructions adapted for the existing Jev
protocol; its SHA-256 is pinned in configuration. `LICENSE.upstream` retains the
LongMemEval MIT notice (Di Wu, 2024).

Sources: [LongMemEval](https://github.com/xiaowu0162/LongMemEval),
[pinned dataset](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/tree/98d7416c24c778c2fee6e6f3006e7a073259d48f).

`npm test` includes small synthetic tests for source isolation, public-tool
execution, budget enforcement, native receipt replay, cleanup and forged-evidence
rejection. Unit tests and installed-package checks are offline; they establish
neither live compatibility nor an answer-quality score. Benchmark code, rules,
datasets and outputs are excluded from the published package.
