# Original BEAM with MemDrive

This benchmark uses the public MemDrive file SDK for single-pass retrieval.
Each question follows its complete original conversation, including questions
about an earlier event or a knowledge update. One collection and one working
fork hold the same archive for every question in a conversation. The last four
messages stay in recent dialogue, with the preceding user input included if the
boundary lands on its first reply. The probing question is the fifth recent
item. Earlier messages are UTF-8 text files and the supplied user profile is a
JSON file. Evaluation annotations are prepared separately and are never read by
the runner.

## Prepare pinned source data

Install Node.js 20.12 or later and Python 3.11 or later with `pyarrow`. From the
repository root:

```sh
npm ci
npm run build
python3 -m venv artifacts/beam-venv
artifacts/beam-venv/bin/python -m pip install pyarrow==26.0.0
```

Download the shards listed in [original-config.json](original-config.json) for
your split and save them with the specified filenames. For example, download
the pinned [500K shard](https://huggingface.co/datasets/Mohammadta/BEAM/resolve/3205395e897e7318c7b094ef4e6047b9b82dbb03/data/500K-00000-of-00001.parquet)
as `500k.parquet` in `artifacts/beam-parquet`. Preparation verifies the exact byte
count and SHA-256 of each shard before reading any rows.

```sh
artifacts/beam-venv/bin/python benchmark/beam/original.py \
  --split 500k --data-dir artifacts/beam-parquet --output artifacts/beam-original-500k
```

The 500K split contains 35 conversations and 700 questions. The script also
accepts `100k`, `1m` and `10m`. Its manifest binds the prepared conversation
files, isolated evaluation files and upstream revision. Original message
order, content, source IDs and turn IDs are preserved. A batch date becomes
noon UTC and is stored as conversation metadata. It does not establish the
time of a specific event or impose a time cutoff on retrieval.

## Ingest, retrieve and clean up

Use a dedicated LambdaDB test project. The commands below make database
requests and can incur managed embedding and reranking charges. The environment
or an untracked `--env-file` must supply `LAMBDADB_BASE_URL`,
`LAMBDADB_PROJECT_NAME` and `LAMBDADB_PROJECT_API_KEY`. Select one numeric
conversation ID from the manifest and use question IDs from its runtime file.

```sh
node benchmark/beam/run.mjs ingest \
  --manifest artifacts/beam-original-500k/manifest.json --conversation 1 \
  --name beam_file_trial --ledger artifacts/beam-file-ledger.json \
  --env-file /path/to/evaluation.env

node benchmark/beam/run.mjs recall \
  --ledger artifacts/beam-file-ledger.json --questions 1_multi_session_reasoning_0 \
  --output artifacts/beam-file-question --env-file /path/to/evaluation.env

node benchmark/beam/run.mjs cleanup \
  --ledger artifacts/beam-file-ledger.json --env-file /path/to/evaluation.env
```

Ingestion writes an ownership ledger before creating the store. It batches
file creates and verifies path, file ID, original content and metadata before
marking the ledger ready. An interrupted or uncertain create keeps the ledger
pending. Retain it for explicit cleanup. Recall reuses the same fork, checks
its settings and verifies the archived originals before search. It makes no
writes to LambdaDB. Use a new output directory per run. Cleanup requires the
same endpoint and project, matches the collection name and ownership labels,
and confirms absence before marking the ledger cleaned. It can run after
local source files are removed. Commands sharing a ledger are serialized by
an exclusive `.active` directory. After a hard kill, confirm the process has
exited before removing a stale guard.

## Retrieval and answer input

- Question-only search is the default. Requests explicitly select `mode: 'hybrid'`
  to preserve this benchmark profile independently of SDK defaults. It uses the literal question for
  lexical, semantic and reranking queries. Managed embeddings are
  `text-embedding-3-small` with English lexical analysis. The default is
  `--limit 100` with native Jev reranking. Use `--rerank false` to opt out.
- `--retrieval-input contextual` keeps the lexical query literal and adds
  recent dialogue and the serialized profile to the semantic and reranking
  query. Input exceeding the SDK's 8,192-byte query bound fails before any
  database request. In offline preparation of the pinned 500K split, the
  complete contextual input exceeded the bound for 600 of 700 questions.
  Use question-only search for those questions. Both modes retain the full
  recent dialogue and profile in the answer input.
- Evidence must match a frozen file ID, path and metadata. Ranged hits must
  match the exact original UTF-16 span. When a hit omits its range, its text
  must occur exactly once in the original to qualify. Packing retains
  complete passages in search order within the default `--evidence-budget
  8000` source-only units, estimated as `ceil(codepoints / 4)` per passage.
  The run records attribution, duplicate and budget omissions. Serialized
  context size is an estimate and excludes the answer template.
- The runner saves the fully substituted original RAG answer request locally.
  The CLI sends no answer or judge requests. Evidence includes original
  source IDs, turn IDs, roles and ranges. Quoted source text containing
  placeholder markers remains literal.

`run.json` freezes the source fingerprints, chosen questions, retrieval
settings and validation time. `results.jsonl` records each search request,
returned hits, retrieval time, delivered and omitted evidence, and answer
request. `summary.json` indicates that all selected questions completed.
This file benchmark uses protocol `beam-original-file-sdk-v1`. Historical
Past results and answer quality require their own evaluation protocol. These
steps do not reproduce the BEAM paper's scores.

Each database HTTP request has a 30-second deadline and transport-level
retries are disabled. The runner accepts inline responses only. Large native
responses can fail if LambdaDB requires a separate download. Offline checks
cover the pinned 500K transformation and synthetic public SDK round trips
through recorded-shape responses. Live retrieval, ranking quality, latency
and cost require measurement on a test project.

The original RAG prompt comes from BEAM revision
`b2da22eac88bb0874c64665f13457eb99835774a`. The upstream file hashes are pinned in
[original-config.json](original-config.json), and [original-LICENSE](original-LICENSE)
preserves the upstream notice.

## Session replay: how a model uses the file tools

`replay.mjs` is a separate runner. It replays one prepared conversation session
by session and reports how a model used the MemDrive file tools while it
talked to the user. The replay makes no retrieval, answer or judge request,
and it never reads the evaluation annotations. The separate
[question stage](#questions-is-what-was-saved-enough-to-answer) asks and judges
BEAM's probing questions afterwards; it is the only part of the session replay
that reads them.

A session is one original BEAM batch: the messages that share a batch in the
source, identified by the `s###` part of each prepared source ID. Only the
list layout carries that batch; other layouts are rejected. The pinned 100K
split has 20 conversations, 90 sessions and 2,866 user utterances.

Each session is a fresh model conversation. The runner sends the user
utterances in their original order, one at a time, and lets the model reply
and call tools until it returns a final message. The model answers every
utterance itself; the dataset's assistant messages are not replayed, so a
later utterance can refer to a reply the model never gave. All user utterances
are replayed, without the last-four-message hold-out of the retrieval runner.
One conversation uses one new store, and the drive is the only state carried
from one session to the next.

The model receives only what an MCP deployment and an agent application
could deliver:

- the user utterances with nothing appended. They are verbatim except for the
  dataset's trailing generation marker (`->-> 1,11`, `->-> 5,14)`,
  `->-> 2,N/A`), which 2,155 of the 2,866 utterances in the 100K split end
  with and which no user said; the plan records how many each session lost;
- the fixed SDK catalog from `getFileToolDefinitions`: `guide`, `status`,
  `history`, `list`, `read`, `search`, `findText`, `fork`, `checkpoint`,
  `listForks`, `listCheckpoints`, `deleteFork`, `deleteCheckpoint`, `diff`,
  `write` and `merge`, unchanged for the whole run;
- each tool result as the SDK returned it, the SDK's normalized error, or an
  explicit delivery-limit error when a result exceeds 64,000 bytes;
- optionally one developer message standing in for server instructions;
- one developer message with the session's date, `Current date: 2024-03-15`,
  from the batch date in the dataset. Agent applications tell their model the
  date, and without it a model notices that the dates in the conversation lie
  in the past and records them as doubtful.

`--instructions sdk` (default) supplies the exported `fileToolInstructions`
verbatim; `--instructions none` supplies nothing. `--policy-file FILE` appends
that file's text to the same message after a blank line, or makes it the whole
message with `none`. The manifest records the exact text and its SHA-256. No
task, starting view or reminder is added, and nothing is injected during a
conversation. The date message is separate from the instructions and is sent
with either setting. Every view of the store is authorized, as for a personal drive.
The runner never writes, merges or deletes for the model. After each session
it only reads `status`, `history`, `listForks` and each fork's `diff`, and
after each successful model `list` call it reads the paths described under
the `list` check below.

```sh
npm ci
npm run build

# No model request: validates the transport, recording and metrics.
node benchmark/beam/replay.mjs --manifest artifacts/beam-original-100k/manifest.json \
  --conversation 1 --mode scripted --output artifacts/beam-replay/smoke-1

# Paid model requests. A small first pilot: two sessions, five utterances each.
node benchmark/beam/replay.mjs --manifest artifacts/beam-original-100k/manifest.json \
  --conversation 1 --sessions 2 --turns 5 --env-file /path/to/model.env \
  --output artifacts/beam-replay/pilot-1
```

Model mode uses OpenAI Responses with the explicit model ID (`gpt-6.1-sol` by
default, or `--model`), low reasoning, `store: false`, sequential tool calls
and non-strict function schemas. It needs `LLM_API_KEY` in the environment or
`--env-file`, and fails before creating a run when it is missing. The runner
validates the returned model identity and usage. It does not retry a model
request, switch models or repair invalid model output; invalid tool JSON is
returned to the model as a recorded tool error. `--sessions` and `--turns`
limit the sessions and the utterances per session. Each output directory must
be new.

Host budgets per session: 16 model rounds and 40 tool calls per utterance, a
120,000-token request reservation (`--context-tokens N`), 4,000,000 reported
total tokens (`--session-tokens N`), 8,192 output tokens per request, a
three-minute request timeout and one hour (`--session-seconds N`). The
manifest records the budgets used. The estimator is `cl100k_base` over the
serialized request, not the model's tokenizer: it counts opaque reasoning
items as text and can exceed the provider's reported input by a wide margin.
One session stopped at this reservation while its largest reported request
was 85,000 tokens. The conversation is never shortened, so every tool result
stays in each later request of the session. These are untuned defaults. A session that fails or exceeds a budget is recorded as
failed and ends the run on either backend. There is no resume: later sessions
depend on that drive.

### Backends

`--backend fixture` (default) runs the real public SDK on the in-memory
native-client fixture used by the unit tests and destroys the store at the
end. For this runner it differs from LambdaDB in three ways: ranked search
ignores the query and returns the same candidates with a fixed score for every
query, `list` is always current, and there is no latency or cost. Reads,
searches and diffs of a fork use consistent reads on both backends, and main
and checkpoints read a pinned published version, so the visibility of fresh
writes to those operations is the same.

`--backend lambdadb` creates the store in a LambdaDB project. Use a dedicated
test project: the run makes paid requests (managed embeddings on every write,
searches) on top of any model requests. The LambdaDB deployment must be able
to create a tag on a branch before its first snapshot commits, as required by
LambdaDB client `0.14.0` (see the changelog). The environment or an untracked
`--env-file` must supply `LAMBDADB_BASE_URL` (an HTTPS origin),
`LAMBDADB_PROJECT_NAME` and `LAMBDADB_PROJECT_API_KEY`; missing or malformed
settings fail before the run directory exists. Requests are confined to that
project, have a 30-second deadline and are not retried, and responses that
need an external download are rejected. The store is created with the same
settings as on the fixture (default managed embeddings, the default text
analyzer and chunking), named `beam-replay-<32 hex>`, and labeled with
`beam.application` and a random `beam.owner`.

Before the create request the runner writes `store.json` in the run
directory with the store name, endpoint origin, project name, labels and
status `pending`, and sets `ready` once the store exists. It holds no
credentials. The store is kept after the run, whether it completed or failed,
for inspection and later evaluation; `summary.json` reports `cleanup:
"retained"`. Delete it explicitly:

```sh
node benchmark/beam/replay.mjs --cleanup --output artifacts/beam-replay/live-1 \
  --env-file /path/to/evaluation.env
```

Cleanup requires the same endpoint and project as the ledger, checks the
store's name and ownership labels, destroys it with its publication journal
through `MemDrive.destroy`, confirms that it is gone and marks the ledger
`cleaned`. It deletes nothing else, can be repeated, and also handles a
`pending` ledger whose create outcome is unknown.

### Metrics

`summary.json` is rewritten after every session with per-session metrics and
conversation totals:

- utterances sent, model requests, reported tokens, tool calls by name and
  tool errors by code;
- forks created, fork-name conflicts (`BRANCH_CONFLICT`) and forks deleted;
- merges that published, replayed, returned unchanged or failed. A merge
  repeated with a completed request ID returns its original `published`
  result without publishing again; it counts as replayed, not as a publication;
- publication lag: for each successful `write` call, the number of utterances
  until the next `merge` of the same fork that published a new version in
  that session, or null when there was none. An `unchanged` or replayed
  merge publishes nothing. A batch write is one call;
- utterance-to-publication lag: for each utterance, the number of utterances
  until the next turn in which a merge published, or null when none followed
  in that session. A model can postpone the write itself instead of holding
  edits on a fork, which the publication lag above cannot show. `afterLast`
  counts the utterances after the session's last publication, or all of them
  in a session without one. Their content cannot have been published in that
  session. An earlier utterance may have been saved, but nothing here checks
  what a publication contained;
- turns with a successful write and turns with a publication;
- published and republished files: distinct file IDs in the session's
  publications, and those in two or more of them, from `history()`. An
  addition to a file counts like a correction of it. A truncated history
  entry makes both lower bounds;
- after the last utterance: forks remaining, forks with unpublished changes,
  the number of those changes, and fully published forks left behind;
- sessions without a successful write;
- the `list` check (`listCheck`): successful model `list` calls, those
  checked, unchecked ones by reason, checked calls that missed at least one
  existing file and the number of missed files.

The SDK documents `list` as eventually consistent, while `read`, `search` and
`diff` see a fork's writes immediately. After each successful model `list`
call, before the model's next call, the runner reads every path it has seen in
a successful `write` result in the run, with the same `at`, in batches of 100
paths. A paths read omits missing files, and every file in the store was
written by the model, so the result is what existed in that view. A file that
read returns and the listing lacks is a miss. `prefix` and `nameContains` are
applied to the expected paths exactly as the SDK applies them: the path starts
with `prefix` and its last component contains `nameContains`. A call is
recorded as unchecked when it continues with `cursor`, groups with
`delimiter`, returns `next` (a partial page) or when the harness read fails
(`cursor`, `delimiter`, `next`, `read_failed`). The check only observes: the
model receives the `list` result unchanged and the harness reads are not
model tool calls. It does not detect a listed file that no longer exists. On
the fixture `list` is always current, so a miss is expected only on LambdaDB.

Totals of the end-of-session fork states count a fork once for every session
it was still present in; the `final*` fields give the last observation.
Republication is a per-session count: a file revised in a later session is the
drive growing, not a publication being redone. The conversation total,
`republishedWithinSessions`, is the sum of the per-session counts, so a file
republished within two sessions counts in both and one published once in each
counts in neither.

`manifest.json` freezes the source hashes, runner and SDK build hashes, source
commit, backend, model, budgets, instruction text, tool definitions and
planned sessions. Each session directory holds `transcript.jsonl` (every input
item in order), `requests.jsonl` (a pending and an outcome receipt per
request, with the number of transcript items it sent), `events.jsonl` (the
model's tool calls and results), `list-checks.jsonl` (the runner's `list`
checks), `observation.json` (the runner's reads) and `result.json`. Receipts
can contain provider response IDs and opaque reasoning. Keep runs under
ignored `artifacts/`.

Durations are kept out of the metrics. Each outcome receipt and each tool
event carries `elapsedMs`, and `result.json` and each session in
`summary.json` carry `timing`: the session's wall time (model requests, tool
calls, the runner's `list` checks, token estimation and local recording), the
total model request time, the total model tool-call time and that time by
tool name, in milliseconds. Fixture timings show only local overhead.

### Limits of this measurement

- These are process counts from recorded tool calls. The replay itself
  generates no answer to a probing question and scores nothing; the question
  stage below does, against a retained LambdaDB store.
- A direct model request is not an agent application. Real agents add their
  own system prompt and memory features and decide whether server instructions
  reach the model. Results describe the model with this catalog only.
- On the fixture, search ignores the query, `list` is always current and
  there is no latency or cost, so fixture runs do not show whether a model
  finds the right file among several, how long a save takes or how listings
  lag. A LambdaDB run is one measurement on one store; its timings include
  network and service variance.
- Scripted mode and injected test transports report their totals under
  `smoke`, and `modelBehavior` stays null. The maintained tests use synthetic
  conversations and establish the harness, not model behavior.

### Questions: is what was saved enough to answer?

`--questions` asks one finished LambdaDB run's probing questions against the
store it kept and judges the answers. It is the only reader of
`evaluation/<id>.json`:

```sh
node benchmark/beam/replay.mjs --questions --run artifacts/beam-replay/live-1 \
  --manifest artifacts/beam-original-100k/manifest.json \
  --output artifacts/beam-replay/live-1-questions --env-file /path/to/evaluation.env
```

The run must use `--backend lambdadb`, have finished (`summary.json` reports
`cleanup: "retained"`) and still hold its store (`store.json` status `ready`).
A fixture run is rejected because its store is gone. The run does not record
where its prepared data lives, so `--manifest` names it; the stage checks the
SHA-256 of that manifest and of the runtime file against the run's manifest,
and the evaluation file against the prepared manifest. It needs `LLM_API_KEY`
and the same LambdaDB settings as the run. Missing settings, a ledger from
another endpoint or project, a store whose ownership labels differ from the
ledger and an existing `--output` all fail before any model request and
before anything is written; the last two are checked after the store is read.
The stage makes paid model requests (answers and judge) and paid database
requests (reads and searches).

Every question of the conversation is classified by the messages its
annotation cites (`source_chat_ids`, matched to runtime turn IDs):

- `user_replayed`: every cited message is a user utterance the run sent;
- `no_sources`: it cites none, as for every abstention question;
- `needs_assistant`: it cites a dataset assistant message. The replay never
  sends those, because the model writes its own replies;
- `not_replayed`: it cites only user utterances, but at least one was not
  sent: outside the planned sessions, beyond `--turns`, or in a session that
  failed;
- `unresolved`: it cites an ID that matches no message, or more than one.
  These are recorded and never asked.

`--scope replayed` (default) asks `user_replayed` and `no_sources` questions.
The other two classes depend on content the drive cannot hold, so their scores
measure the replay's coverage rather than the model's saving. `--scope all`
asks every class except `unresolved`. `--limit N` asks only the first N
selected questions, in dataset order. The manifest records every question's
class and cited messages, and the selected IDs.

Each question is a fresh model conversation in dataset order with no memory of
other questions: the run's exact instruction text as the developer message
(none when the run had none), the date of the run's last completed session as
`Current date: …` when the run told its sessions their date, then the question
text verbatim. `--answer-policy-file FILE` replaces the run's policy text for
the answers, after the SDK instructions when the run had them, so a rule about
answering can be tried on a finished drive without replaying the
conversation. The manifest records that text and that it differs from the
run's; a deployment has one text for saving and answering. There is no
"answer only from the drive" instruction, so the model can also answer from
its general knowledge. The tool catalog is read-only: `guide`, `status`,
`history`, `list`, `read`, `search`, `findText`, `listForks` and
`listCheckpoints`, from `getFileToolDefinitions` and executed through
`createFileTools` with the same allowlist, so any other call returns
`TOOL_NOT_ALLOWED`. The answer model defaults to the run's model (`--model`
overrides it). Requests, budgets and failure handling are those of a replay
session with one utterance; a failed question keeps its failure code, is not
judged, and the stage continues. The answer is the final response's assistant
text. The harness opens the store without recovery and only reads it: it
compares the main version, forks and checkpoints before and after and reports
them in `summary.json`.

Judging follows upstream BEAM's `evaluate_*` functions: one Chat Completions
request per rubric item with `unified_llm_judge_base_prompt`, replacing
`<rubric_item>` and then `<llm_response>`. Upstream never substitutes the
QUESTION the prompt mentions, and neither does this stage. The prompt is
stored in [original-judge-prompt.json](original-judge-prompt.json) with the
upstream revision and the pinned `src/prompts.py` hash, and its text hash is
pinned in the runner. The judge is `gpt-4.1-mini-2025-04-14` at temperature 0
(`--judge-model` overrides it), without retries. Its returned model and usage
are validated. Reasoning models reject temperature 0: `--judge-effort
low|medium|high` sends `reasoning_effort` instead of a temperature, which is
no longer upstream's request. The reply is parsed as upstream's `parse_json_response` does
(optional code fence, the whole text, then the first embedded JSON object),
but upstream's `json_repair` fallback is not applied: anything that does not
yield a score of exactly 1, 0.5 or 0 is a judge failure. A question's score is
the mean over its rubric items, or null when any item failed. For
`event_ordering`, upstream's headline metric is Kendall tau-b times F1 after
an LLM alignment of events; it is not computed here, and only the rubric judge
score is reported. This is not a reproduction of the BEAM paper's scores.

`NEW_DIR/manifest.json` records the run directory and manifest hash, store
name, source hashes, scope, limit, models, budgets, the instruction hash, the
read-only tool definitions and their hash, the judge prompt hash and upstream
revision, and the classification. Each asked question has a directory with
`transcript.jsonl`, `requests.jsonl`, `events.jsonl` (with `elapsedMs`),
`judge.jsonl` (one record per rubric item: score, reason, judge text, usage,
`elapsedMs` or a failure code) and `result.json` (answer, tool calls by name,
whether `search`, `read` or `findText` was called, tokens and timing).
`summary.json` is rewritten after every question. It counts every question by
class and by category, and reports judge scores for the asked questions
overall, per class and per category. Each mean is over judged questions only
and comes with its counts: asked, answered, failed (not answered), judged and
unjudged (failed or with a failed judge request). Compare classes separately.
Injected test transports report `measured: false`.

### Judging stored answers again

`--rejudge --answers QUESTIONS_DIR --manifest FILE --output NEW_DIR
[--judge-model ID] [--judge-effort low|medium|high] [--repeats N]` judges the answers a question stage already
stored, without asking anything and without a store. It needs only
`LLM_API_KEY`. Each rubric item of each answered question is judged
`--repeats` times (1 to 10, default 1) with the same upstream prompt and
request as the stage, and any judge model. Use it to see whether the judge
repeats its own scores and whether another judge model agrees.

`summary.json` reports, per rubric item, how many were scored in every repeat,
how many of those got the same score in every repeat (`stable`), and how many
stable items equal the original judgment (`sameAsOriginal`); the mean question
score of the original stage and of each repeat with the number of questions
behind it; and every item whose scores differ, with its rubric text. Judge
reasons are in each question's `judge.jsonl`. A different model changes the
judge, so its scores are not comparable with upstream BEAM's `gpt-4.1-mini`.
