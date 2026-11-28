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
- the SDK's agent catalog from `getFileToolDefinitions`: the seven tools
  `guide`, `read`, `tree`, `list`, `search`, `findText` and `write`, all on
  main of one drive and unchanged for the whole run. `--guide off` leaves out
  `guide`;
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
task, reminder or benchmark annotation is added, and nothing is injected
during a conversation. The date message is separate from the instructions and
is sent with either setting.

`--guide on` (default) offers the `guide` tool; `--guide off` leaves it out of
the allowlist and the definitions, as the `none` guide channel of the
[tool-use benchmark](../tool-use/README.md) does. The instruction text stays
the same: `fileToolInstructions` names no tool, so it never tells the model to
call one it lacks. The manifest and summary record the setting.

The runner acts as the host. It connects the tools with `createFileTools` and a
`checkpoint` hook, so every `write` call is a
[checkpointed write](../../README.md#checkpointed-writes): applied whole and
recorded as main's latest checkpoint, or undone back to the previous one. The
hook names each checkpoint `turn-<base-36 milliseconds>-<8 hex>`, as the SDK
README advises, so names stay unique across sessions and across any later
run or restart on the same store. The model never sees a name; each `write`
event in `events.jsonl` records it. There is no switch for this. The runner
never writes or deletes for the model. Before each session it reads main's
latest checkpoint with `describe`, and after each session it reads as
described under the observation below.

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

Scripted mode follows a fixed script. Session 1 reads the guide index and the
`editing` topic, calls `tree` for the whole drive, searches, creates a note and
lists its folder with `prefix: '/notes/'` in its first turn; in its second it
reads the note, edits it with an exact edit and tries to create it again,
which fails with `PATH_EXISTS` and changes nothing. Session 2 calls `tree`
with `prefix: '/notes/'`, creates a file without a lookup (a `tree` call is
none), finds the note with `findText` and deletes it. Every other turn only
replies. With `--guide off` the guide calls are skipped.

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
The conversation is never shortened, so every tool result stays in each later
request of the session. These are untuned defaults. A session that fails or
exceeds a budget is recorded as failed and ends the run on either backend.
There is no resume: later sessions depend on that drive.

### Backends

`--backend fixture` (default) runs the real public SDK on the in-memory
native-client fixture used by the unit tests and destroys the store at the
end. For this runner it differs from LambdaDB in two ways: ranked search
ignores the query and returns the same candidates with a fixed score for every
query, and there is no latency or cost. `tree`, `list`, `read`, `search` and
`findText` on main use consistent reads on both backends.

`--backend lambdadb` creates the store in a LambdaDB project. Use a dedicated
test project: the run makes paid requests (managed embeddings on every write,
searches) on top of any model requests. The LambdaDB deployment must support
the versioned reference API of LambdaDB client `0.15.0`, including tags,
aliases and branch rollback before a tag's first snapshot is published. The
environment or an untracked `--env-file`
must supply `LAMBDADB_BASE_URL` (an HTTPS origin), `LAMBDADB_PROJECT_NAME` and
`LAMBDADB_PROJECT_API_KEY`; missing or malformed settings fail before the run
directory exists. Requests are confined to that project, have a 30-second
deadline and are not retried, and responses that need an external download
are rejected. The store is created with the same settings as on the fixture
(default managed embeddings, the default text analyzer and chunking), named
`beam-replay-<32 hex>`, and labeled with `beam.application` and a random
`beam.owner`. It is one collection; each checkpointed write adds a tag and
moves main's `latest-main` alias. A failed checkpointed write can restore the
previous checkpoint immediately. See the [SDK restore behavior](../../README.md#checkpointed-writes).

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
store's name and ownership labels, deletes its collection through
`MemDrive.destroy`, confirms that it is gone and marks the ledger `cleaned`.
It deletes nothing else, can be repeated, and also handles a `pending` ledger
whose create outcome is unknown. Ledgers record the protocol
`memdrive-beam-session-replay-store-v3`, whose stores use the SDK's `files-v2`
layout. A ledger from an earlier protocol names a store in an earlier SDK layout
that this SDK cannot open or destroy: `-v2` a `files-v1` store, `-v1` a
`files-v0` store with an `md-journal-*` collection. Cleanup refuses such a
ledger before any request, and its collections have to be deleted with LambdaDB
directly.

### Observation after each session

After each session the runner reads main's latest checkpoint with `describe`,
calls `tree()` for the whole drive and lists main to the end (every `next`).
`list` is path-ordered and sees every write that succeeded before it, and only
the model writes, so the listing is all of main. It then reads each listed
file once by file ID, only for its length, which no listing reports. The
inventory has each file's `fileId`, `path`, `modifiedAt` and `chars` (UTF-16
length of the original; null if that read finds no file), in path order.
`observation.json` records `latestCheckpointBefore`, `latestCheckpointAfter`,
`tree` (the SDK result: `fileCount`, `folders` with their file counts, and
`truncated`), the `inventory` and `errors`. A failed step is recorded by step
and code (`describe`, `tree`, `list`, `read`) and leaves its value null.

### Metrics

`summary.json` is rewritten after every session with per-session metrics and
conversation totals. Unless stated otherwise, a total is the sum of the
per-session values. A turn is one user utterance.

- `userTurns`, `modelRequests`, `inputTokens`, `outputTokens`,
  `unknownUsageRequests`: utterances sent, model requests, reported tokens and
  requests without valid usage;
- `toolCalls`, `toolCallsByName`, `toolErrorsByCode`: every model tool call,
  including rejected ones, by name and by error code;
- `toolCallsPerTurn`: mean and maximum number of tool calls per turn, over
  every turn sent, including turns without a call. The conversation mean is
  over all its turns; the maximum is the largest of any session;
- `toolRounds`, `toolRoundsPerTurn`: model responses that called at least one
  tool, in total and per turn (mean and maximum, as above);
- `guideCalls`: `guide` calls without a topic (`index`) and with a topic
  (`byTopic`, by the topic requested, including invalid ones);
- `writeCalls`: every `write` call, including rejected ones;
  `failedWritesByCode`: failed `write` calls by error code;
- `turnsWithWrite`: turns with at least one successful `write` call;
  `turnsWithMultipleWriteCalls`: turns with more than one `write` call,
  successful or not. The SDK instructions ask for one per turn;
- `operations`: operations in successful `write` calls by kind: `create`,
  `updateEdits` (exact `edits`), `updateContent` (replaced `content`),
  `updateOther` (only a new path or metadata) and `delete`. A batch counts each
  of its operations;
- `filesCreated`, `filesUpdated`: distinct file IDs created, and distinct file
  IDs updated, by successful `write` calls in the session;
  `filesWrittenInSeveralTurns`: distinct file IDs that successful operations
  (create, update or delete) touched in more than one turn of the session;
- `createsAfterLookup`, `createsWithoutLookup`: create operations in
  successful `write` calls that came after, or before, the session's first
  successful `search`, `findText`, `list` or `read` call. The SDK
  instructions ask to search and read before writing;
- `noSuccessfulWrite` (per session) and `sessionsWithoutWrite` (total);
- `filesAfter`: files in the inventory after the session, null when the
  observation failed; `finalFiles` is the last session's value;
- `latestCheckpointAsExpected`: whether main's latest checkpoint after the
  session is the checkpoint of the session's last successful `write` call, or
  the one before the session when no write succeeded. A failed checkpointed
  write must leave it unchanged. Null when `describe` failed;
  `sessionsWithUnexpectedLatestCheckpoint` counts sessions where it is false;
- `toolUse`: how the model explored and read the drive, below.

`toolUse` describes one model conversation: here a session, and in the
question stage one question. It is computed from the recorded tool events in
call order. Every call counts whatever its outcome, except that a call whose
arguments are not a JSON object (invalid JSON, `null`, an array or a scalar,
which the host or SDK rejects) is left out of every split by argument (it
still counts in `toolCallsByName` and in the failure tallies).
`tree` and `list` treat `/` as the whole drive, and `list` also `''`, so a
prefix like that does not count as narrowing. Per conversation:

- `firstTool`: the name of the first tool called, or `none`;
  `firstNonGuideTool`: the first tool other than `guide`, or `none`;
- `tree.withPrefix`, `tree.withoutPrefix`: `tree` calls with a `prefix` other
  than `/`, and calls without one or with `/`;
- `list.listings`: `list` calls without `cursor` (new listings);
  `list.continuations`: calls with `cursor`. Of the new listings:
  `list.afterTree` came after a `tree` call of the same conversation (any
  outcome), `list.withPrefix` gave a `prefix` other than `''` or `/`,
  `list.withNameContains` a nonempty `nameContains`, and `list.withDelimiter`
  a `delimiter`;
- `list.stoppedBeforeEnd`: successful `list` pages that reached the model with
  a `next` whose cursor no later `list` call of the conversation forwarded:
  the model saw only part of that listing;
- `search`, `findText`: calls of each;
- `read.whole`: `read` calls by `fileId`, `path` or `paths` without range
  options; `read.ranged`: calls with any of `startLine`, `endLine`, `maxChars`,
  `offset` or `revision` (a range page or its continuation);
- `read.wholeChars`, `read.rangedChars`: UTF-16 units of `content` in the
  successful read results of each kind that reached the model (every file of
  a `paths` batch; a missing file adds nothing). Results withheld for the
  delivery limit are not counted;
- `failedTreesByCode`, `failedListsByCode`: failed `tree` and `list` calls by
  error code. These codes are also in `toolErrorsByCode`.

Over several conversations (the replay's conversation totals and the question
stage's summary), `toolUse` has `conversations`; `firstTool` and
`firstNonGuideTool` tallied by name; the `tree`, `list` and `read` counts and
the failure tallies summed; `search` and `findText` as `calls` with their
`mean` and `max` per conversation (null without conversations); and
`withoutSearchOrFindText`, the conversations that called neither.

`tree` is not a lookup for `createsAfterLookup`: it returns folders and counts
but no files.

Earlier protocols also checked each model `list` traversal against the
runner's reads by file ID, because `list` was eventual and could miss recent
writes or return stale entries. `list` now uses consistent reads, and only the
model writes, so such a check could not find a miss; it was removed. The one
partial view it could still see, a listing the model stopped following, is
`list.stoppedBeforeEnd`, computed from the events alone.

`manifest.json` freezes the source hashes, runner and SDK build hashes, source
commit, backend, model, budgets, instruction text, guide setting, tool names
and definitions, the checkpoint naming and planned sessions. Each session
directory holds `transcript.jsonl` (every input item in order),
`requests.jsonl` (a pending and an outcome receipt per request, with the
number of transcript items it sent), `events.jsonl` (the model's tool calls
and results, with each write's checkpoint name), `observation.json` and
`result.json`. Receipts can
contain provider response IDs and opaque reasoning. Keep runs under ignored
`artifacts/`.

Durations are kept out of the metrics. Each outcome receipt and each tool
event carries `elapsedMs`, and `result.json` and each session in
`summary.json` carry `timing`: the session's wall time (model requests, tool
calls, token estimation and local recording), the
total model request time, the total model tool-call time and that time by
tool name, and `perTurn`, the model request time and tool-call time of each
turn, in milliseconds. Wall time per turn is not recorded. Fixture timings
show only local overhead.

This is protocol `memdrive-beam-session-replay-v3`. Runs of
`memdrive-beam-session-replay-v2` offered six tools without `tree`, with a
`list` that was unordered, paginated per storage page and eventual; runs of
`memdrive-beam-session-replay-v1` used 16 tools with an `at` view selector and
published forks with `merge`. Their metrics are not comparable with these,
and the question stage refuses those runs.

### Limits of this measurement

- These are process counts from recorded tool calls. The replay itself
  generates no answer to a probing question and scores nothing; the question
  stage below does, against a retained LambdaDB store.
- A direct model request is not an agent application. Real agents add their
  own system prompt and memory features and decide whether server instructions
  reach the model. Results describe the model with this catalog only.
- On the fixture, search ignores the query and there is no latency or cost,
  so fixture runs do not show whether a model finds the right file among
  several or how long a save takes. A LambdaDB run is one measurement on one
  store; its timings include network and service variance.
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

The run must use the current replay protocol and `--backend lambdadb`, have
finished (`summary.json` reports `cleanup: "retained"`) and still hold its
store (`store.json` status `ready`). A run of an earlier protocol is rejected
with its protocol named, and a fixture run because its store is gone. The run does not record
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
its general knowledge. The tool catalog is read-only: `guide`, `read`,
`tree`, `list`, `search` and `findText` on main, from `getFileToolDefinitions` and
executed through `createFileTools` with the same allowlist, so any other call,
`write` included, returns `TOOL_NOT_ALLOWED`. `--guide off` leaves out
`guide`, with the instruction text unchanged as in the replay. It defaults to
`on` whatever the run used; the manifest records both settings and the summary
notes when they differ. The answer model defaults to the run's model (`--model`
overrides it). Requests, budgets and failure handling are those of a replay
session with one utterance; a failed question keeps its failure code, is not
judged, and the stage continues. The answer is the final response's assistant
text. The harness only reads the store: before and after the questions it
observes main as the replay does after a session (`latestCheckpoint`, `tree`,
the listed `files` and `errors`), and reports both and whether they are equal
in `summary.json` (`store.unchanged`). If a step failed in either observation,
`unchanged` is null.

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
guide setting, the read-only tool definitions and their hash, the judge prompt hash and upstream
revision, and the classification. Each asked question has a directory with
`transcript.jsonl`, `requests.jsonl`, `events.jsonl` (with `elapsedMs`),
`judge.jsonl` (one record per rubric item: score, reason, judge text, usage,
`elapsedMs` or a failure code) and `result.json` (answer, tool calls by name,
whether `search`, `read` or `findText` was called, the question's `toolUse`,
tokens and timing). `summary.json` is rewritten after every question. Its
`retrieval` holds the questions with such a call, the tool calls by name and
`toolUse` totals over the asked questions, with the definitions of the
[replay metrics](#metrics). It counts every question by
class and by category, and reports judge scores for the asked questions
overall, per class and per category. Each mean is over judged questions only
and comes with its counts: asked, answered, failed (not answered), judged and
unjudged (failed or with a failed judge request). Compare classes separately.
Injected test transports report `measured: false`. With `--amendments on`
(default) the stage also judges amended rubric items and reports
`amendedScores` beside `scores`; see [amendments](#amendments). The stage
protocol is `memdrive-beam-replay-questions-v4`; `-v3` was the same stage
without amendments.

### Judging stored answers again

`--rejudge --answers QUESTIONS_DIR --manifest FILE --output NEW_DIR
[--judge-model ID] [--judge-effort low|medium|high] [--repeats N] [--amendments on|off]`
judges the answers a question stage already
stored, without asking anything and without a store. It needs only
`LLM_API_KEY`. It reads only stored answers and original judgments, so it also
accepts the output of the earlier question protocols
(`memdrive-beam-replay-questions-v1` to `-v3`), whose files have the same
format. Its own protocol is `memdrive-beam-replay-rejudge-v2`; `-v1` had no
amendments. Each rubric item of each answered question is judged
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
With `--amendments on` (default) it also judges amended items; see
[re-scoring stored answers under amendments](#re-scoring-stored-answers-under-amendments).

### Amendments

Some BEAM questions are defective: a rubric item is malformed or contradicts
the question's own answer key, or the question's premise does not hold in its
conversation. One item, `LLM response should mention: which statement is
correct?`, is in every contradiction question and judges read it in opposite
ways: the dataset means that the answer asks the user which statement is
correct, and judges often reward an answer that picks one itself.
[amendments.json](amendments.json) records corrections for such cases next to
the dataset.

Amendments never change the prepared dataset, the original judge requests or
the original scores. With `--amendments on` (the default for `--questions`
and `--rejudge`) a stage judges every rubric item as before and reports
`scores` exactly as without amendments. It then judges each amended item once
more with its replacement text, with the same judge model, prompt and
settings, and reports `amendedScores` as well. Both are always reported;
neither replaces the other. `--amendments off` judges and reports the original
rubric only, without reading the file.

An amendment is added only when an audit that does not look at any system's
answers finds the defect, or uniformly by a rule over all items with the same
text. It keeps the dataset's intent, as shown by the question, its answer key
and its other annotations, and never adds a requirement. A question that
cannot be repaired without writing a new one is excluded instead. Each entry
states its reason.

The file has five keys, all required, and no others:

```json
{
  "protocol": "memdrive-beam-amendments-v1",
  "split": "100k",
  "datasetRevision": "3205395e897e7318c7b094ef4e6047b9b82dbb03",
  "rules": [
    { "id": "contradiction-ask", "category": "contradiction_resolution",
      "original": "LLM response should mention: which statement is correct?",
      "replacement": "LLM response should ask the user which statement is correct",
      "reason": "..." }
  ],
  "questions": {
    "<question ID>": { "exclude": "<reason>" },
    "<another question ID>": { "rubric": [
      { "index": 2, "original": "<the item's exact dataset text>", "replacement": "<text>", "reason": "<reason>" }
    ] }
  }
}
```

Question IDs are the dataset's, such as `7_contradiction_resolution_0`. `split` and
`datasetRevision` must equal the prepared manifest's. A rule replaces the text
of every rubric item, in questions of its `category`, whose text equals
`original` exactly. A question entry either excludes the question or amends
items by zero-based `index`, quoting each item's dataset text exactly in
`original`. An excluded question is still asked and judged on its original
rubric, so `scores` stay complete, and is left out of `amendedScores`.

The file is checked against the conversation's evaluation before any model
request, and the stage fails with the reason when it finds unknown keys, a
missing field, another split or revision, a question ID with this
conversation's prefix (`<conversation>_`) that its evaluation lacks, an index
out of range, an `original` that is not the item's exact text (which also
catches a changed dataset), an empty replacement or one equal to `original`,
an entry with both `exclude` and `rubric`, or an item amended twice, by two
rules, two entries or a rule and an entry. Entries for other conversations do
not apply and are not checked. Whether a rule matches anything in the whole
dataset is not checked, because a stage loads one conversation, in which a
rule can legitimately match nothing; the manifest lists what applied.

The stage manifest records the setting, the file's SHA-256 and, for each
question of the conversation with an amendment, its exclusion or its amended
items with their replacement text and rule ID or reason. A question with
amended items gets `amended-judge.jsonl`, one record per amended item like
`judge.jsonl` plus `amendment` (`{ "rule": ID }` or `{ "reason": TEXT }`),
and in `result.json` `amendedJudge` (`status`, and per item `index`,
`rubricItem`, `amendment`, `status`, `score` or `code`, `usage`) and
`amendedScore`: the mean over all its items, with the amended judgment where
an item is amended and the original one elsewhere, or null unless every one of
them scored. An excluded question's `result.json` has `excluded` with the
reason. The summary adds `amendments` (`setting`, `sha256`, and over the asked
questions `amendedQuestions`, `amendedItems` and `excludedQuestions`),
`amendedScores` (the score summary of the asked questions that are not
excluded, with `amendedScore` where a question has one and `score`
otherwise), `tokens.amendedJudge`, and `excluded`, `amendedScore` and
`amendedJudge` in `questionResults`. The stage succeeds only when the amended
judgments are complete too. With `--amendments off` the summary has only
`amendments: { "setting": "off", "sha256": null }` in addition to the fields
without amendments.

#### Re-scoring stored answers under amendments

`--rejudge` applies the current file to any stored answers, including stage
directories written before amendments existed, without answering again:

```sh
node benchmark/beam/replay.mjs --rejudge --answers artifacts/beam-replay/live-1-questions \
  --manifest artifacts/beam-original-100k/manifest.json \
  --output artifacts/beam-replay/live-1-amended --env-file /path/to/model.env
```

It judges the original rubric `--repeats` times as before and each amended
item of a question that is not excluded as many times. Each question's
`result.json` adds `amendedScores` (per repeat), `amendedItems` (per item the
replacement text, `amendment`, `original` and `scores`) and `amendedOutcomes`,
and `excluded` where it applies; amended judgments go to
`amended-judge.jsonl`. The summary keeps `agreement`, `scores` and `tokens`
for the original rubric and adds `amendments`, `amendedAgreement` (the
original of an amended item is the stage's own amended judgment when it judged
the same replacement text, otherwise none, so earlier stages have no
`comparable` items), `amendedScores.repeats` (the mean per repeat over the
questions that are not excluded) and `amendedTokens`. The summary's
`questionResults` add `excluded` and `amendedScores`.
