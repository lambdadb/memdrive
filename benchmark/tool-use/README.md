# Model tool-use evaluation

This benchmark gives a model the public SDK's `createFileTools` definitions and
executes its calls through that executor. It evaluates tool selection and final
SDK state before building a separate MCP server. LongMemEval and BEAM remain
separate SDK retrieval benchmarks.

The first backend is the existing native-client fixture, with the **real public
SDK** above it. Its immediate visibility and deterministic candidate search do
not model LambdaDB ranking, latency, snapshot readiness or consistency. No live
LambdaDB credentials or collections are used. `toolsList`, `toolsCall`,
`resourcesList` and `resourcesRead` model the host boundary in process; there is
no MCP transport, server deployment or client compatibility claim.

## Run

Use Node 20.12+ and run `npm ci` first. Outputs must use a new directory. Runs
and synthetic request/tool traces belong under ignored `artifacts/`.

```sh
# No model calls: validate the host, SDK workflows and scoring machinery.
# Nine tasks and three guide channels: 27 scripted cases per instruction profile.
npm run benchmark:tools -- --mode scripted --output artifacts/tool-use/smoke

# Provide LLM_API_KEY through the environment or ignored .env.local.
# A small first model pilot compares all three guide channels for one task.
npm run benchmark:tools -- --mode model --scenario recall --guide all \
  --model gpt-6.1-sol --output artifacts/tool-use/model-recall

# Only the three read-only retrieval tasks: 9 conversations per repetition.
npm run benchmark:tools -- --mode model --scenario retrieval --guide all \
  --repeats 2 --output artifacts/tool-use/model-retrieval

# Nine tasks, three guide channels, two repetitions: 54 separate conversations.
npm run benchmark:tools -- --mode model --guide all --repeats 2 \
  --instruction server --output artifacts/tool-use/model-server

# Separate profiles for workflow guidance and an explicit user reminder.
npm run benchmark:tools -- --mode model --instruction workflow \
  --output artifacts/tool-use/model-workflow
npm run benchmark:tools -- --mode model --instruction user \
  --output artifacts/tool-use/model-user
```

`--scenario` takes `all` (default, every scenario), `retrieval` (`paraphrase`,
`cross-language` and `enumerate`) or one scenario ID such as the `recall` pilot.
With all three guide channels a repetition plans 3 conversations for `recall`,
9 for `retrieval` and 27 for `all`. Scripted mode passes all 81 combinations of
nine scenarios, three guide channels and three instruction profiles; run it once
per `--instruction` value to cover them.

Model mode uses OpenAI Responses with the explicit model ID, low reasoning,
`store: false` and sequential tool calls. The default model follows the existing
LongMemEval configuration. Availability and access still depend on the supplied
key. The runner validates returned model identity and usage. It does not silently
switch models, repair invalid model JSON or retry model requests. Invalid tool
JSON is returned as a recorded tool error so the model can correct its next call.
Missing credentials fail before creating a run. Never put keys in command
arguments or checked-in files.

Each conversation is bounded by 16 model rounds, 40 tool calls, a conservative
32,000-token request reservation, 160,000 reported total tokens, 4,096 output
tokens per request, 64,000 bytes per delivered tool result and a 15-minute model
phase. Model requests have a three-minute timeout. The token estimator is
`cl100k_base`; it is a host budget estimate, not a model tokenizer equivalence.
Oversized results are not silently cut into misleading JSON; the model receives
an explicit delivery-limit error explaining that the operation already ran.
Unknown request usage stays unknown in the summary. Charges are not estimated.

## Run in GitHub Actions

Set the `LLM_API_KEY` repository secret under **Settings → Secrets and variables
→ Actions**. Dispatch **Model tool-use evaluation** from `main` in the Actions
tab, or use the GitHub CLI:

```sh
# First pilot: recall, one conversation per guide condition, server profile.
gh workflow run tool-evaluation.yaml --ref main

# Only the read-only retrieval tasks: 18 conversations with two repeats.
gh workflow run tool-evaluation.yaml --ref main -f scenario=retrieval -f repeats=2

# After reviewing the pilot: nine tasks, all three guide conditions, two repeats.
gh workflow run tool-evaluation.yaml --ref main -f scenario=all -f repeats=2
```

The workflow always compares `none`, `tool` and `resource`. It defaults to
`gpt-6.1-sol`, the `server` profile and one repetition. The dispatch form also
accepts an explicit model ID, `workflow` or `user` instructions, and up to five
repetitions. Each dispatch can incur model charges. Runs execute one at a time,
with a 60-minute model-step limit and a 75-minute job limit. A time-limited run
can report fewer completed cases than planned. Those limits are unchanged while
`all` with two repeats now plans 54 conversations instead of 36; dispatch
`retrieval` separately if a full run reaches the limit. The job reports failures even
when the report export succeeds.

Open the run summary for per-guide counts and download the `tool-evaluation-*`
artifact for the JSON report, retained for seven days. The report includes
configuration and source hashes, check results, ordered tool names and outcomes,
[retrieval tool-selection counts](#retrieval-tool-selection), offered tool names,
model-response validation, HTTP error statuses and token usage. The summary adds
a retrieval table for the read-only scenarios in the run. It records the length of any final answer. Detailed investigation of
wording, arguments and SDK results requires a separate local run. The raw trace
on the hosted runner stays in temporary storage for the lifetime of the job.

## Conditions and host policy

`--guide` selects `none`, `tool`, `resource`, or `all` (default):

| Delivery | Model-visible content | Observation |
| --- | --- | --- |
| `none` | SDK tool descriptions and short server instructions | Baseline without full guide text |
| `tool` | Same descriptions plus the optional SDK `guide` index/topic tool | Record index and topic calls |
| `resource` | Host lists and reads the index and every topic resource, then injects their unchanged text | Record **host** resource reads; this is not an autonomous model fetch |

All channels use the same exported guide version. Version 7 explains explicit
`at` view selection, the main default, explicit forks for edits, returned `{ at }`
values, fork/checkpoint listing and deletion, forwarding `next` unchanged and
`CURSOR_VIEW_MISMATCH`. Version 6 split the guide into an index and five topics
and added original-wording preservation instructions.
The tool condition retrieves topics on demand; the resource condition deliberately
injects all documents through the host. These are different delivery costs, not
equal-context conditions or autonomous resource selection. The manifest records
the index and every topic document. Historical guide-4 and guide-5 model results
do not validate guide-6 behavior; guide 4 also used earlier search defaults.
All historical model results (guides 4–6, protocol `memdrive-tool-use-v1`) used
the previous bound-view host, which rebound tools to a newly created fork and
announced binding changes. They do not validate guide 7 or the current
explicit-`at` contract (protocol `memdrive-tool-use-v2`). `--instruction` independently
selects `server` (default), `workflow` (additional developer workflow text), or
`user` (an explicit reminder appended to the task). Workflow injection approximates
a loaded bundled skill; skill discovery/loading itself is not tested. Compare
one factor at a time. Fixed case/channel ordering, small samples and synthetic
inputs limit any quality inference; use repetitions and inspect individual traces.

The host connects one authorized drive with a fixed explicit allowlist. Tool
definitions never change during a conversation. Read-only cases never expose
`fork`, `checkpoint`, `deleteFork`, `deleteCheckpoint`, `write`, `merge` or `diff`.
The model selects each call's view with `at`; the SDK rejects `write`, `diff` and
`merge` without an explicit fork. The host states the task's starting view once
(main, or the prepared `task` fork) and accepts only main, that view and views
returned by this conversation's successful `fork` or `checkpoint` calls; other
targets fail with `TARGET_NOT_AUTHORIZED`. Tool results remain the SDK's
serializable results. Arguments cannot select another store. This is evaluation
policy, not hosted authentication or cross-process fencing.

## Scenarios and scoring

| Scenario | Initial condition and expected outcome |
| --- | --- |
| `recall` | Read current retention/contact despite an older dated decision containing an untrusted instruction. Correct literal facts, evidence use and unchanged main are checked. |
| `maintain` | Working policy already says 42 days; FAQ outside the initial diff still says 30. Update related current guidance, preserve the dated record and publish the complete intended state. |
| `draft-checkpoint` | Begin on main, create private `trial`, preserve `before-edit` with `at` set to that draft before its first write to it, then edit the FAQ without publishing. Checkpoint source/order from explicit `at`, both saved states and unchanged main are checked. |
| `past-version` | After two publications, create `earlier` from the first version using `history`/`version`. Verify its old content and unchanged current main. |
| `unrelated` | A later unrelated main file is absent from the task fork. Publish the FAQ update while preserving the unrelated main content. |
| `conflict` | A concurrent main edit conflicts with the task fork. Observe `MERGE_CONFLICT`, preserve the intended unpublished draft and unchanged main, and report the blocker. Resolution/takeover/retry is not implemented by this host. |
| `paraphrase` | Six more published notes and runbooks. An English question whose distinctive words appear in no stored file is answered by one neutrally named note (a 21-day period and a contact address) beside notes with other periods and contacts. The literal period and address in the final answer and unchanged main are checked. |
| `cross-language` | The same drive. A Korean question is answered by an English note (a 9-business-day lead time and a contact address) beside a similar note with another lead time and contact. The literal number and address and unchanged main are checked. |
| `enumerate` | The same drive. Literal control: report every file containing the exact error code `E-4172`, which occurs in three files across two directories beside the near miss `E-4127`. All three paths, no other drive path and unchanged main are checked. |

Ground truth is evaluated independently through public SDK reads, inventories,
status, fork/checkpoint listings and explicit-`at` reads. State checks compare full synthetic originals and expected
paths, rather than accepting the model's claim of success. Publication tasks also
check that the changed original was delivered before editing and that a diff of
the merged fork was inspected after its last write and before merge. Exact-edit counts are descriptive,
not a requirement to use one specific sequence for every task. Final recall, retrieval answer, listed-path and
blocker wording checks are literal heuristics; there is no semantic answer judge
or general citation-quality score. Prompt-injection coverage is one synthetic
example, not a security certification.

Scripted mode emits predetermined requests and is **only a transport/workflow
smoke test**; its passes are not model performance. Its paraphrase cases call
`search` and its control calls `findText` by construction. Its `modelTasksPassed` is `null`. Injected test transports are also
identified separately and cannot count as real model measurements.

## Retrieval tool selection

The `retrieval` group measures one concern directly: a model used to local file
tools may keep repeating literal `findText` where ranked `search` fits. Stored
wording often differs from the question, so a literal search misses, and a
`findText` without `prefix` or `filter` scans every original of the view. The
two paraphrase tasks create that mismatch; `enumerate` is the control where an
unscoped `findText` is the right tool, so avoiding `findText` everywhere is not
rewarded. No model result for these scenarios is recorded in this repository; a
run's report is a short-lived Actions artifact.

**The fixture's ranked `search` does not rank.** It returns the chunks of the
selected view whatever the query and mode are. For these three scenarios the
harness returns them in path order, so every conversation receives the same nine
candidates: the default limit of 10 returns all of them, with the paraphrase
target third and the cross-language target fifth, and a smaller `limit` can
exclude a target. Any `search` call therefore surfaces the answer among
distractors. These scenarios measure **tool selection and persistence, not
retrieval relevance**, and their pass rates cannot rank search modes.

`findText` runs the SDK's real literal scan over the fixture's originals. Every
word of four or more letters in the English question, every word of the Korean
question and each full sentence has no hit in any file of the drive; the tests
verify this. A model can still hit by guessing stored vocabulary, or list and
read all nine files, and passing does not require `search`.

Each conversation records these counts from its ordered tool calls. Attempted
calls count whatever their outcome, and no argument or model text is kept:

| Field | Meaning |
| --- | --- |
| `search`, `findText`, `read`, `list` | Calls of that tool. |
| `firstTool` | The first of those four tools called, or `none`. |
| `usedSearch` | Whether `search` was called at all. |
| `findTextBeforeSearch` | `findText` calls before the first `search` call, or all of them when `search` was never called. |
| `findTextUnscoped` | New `findText` scans without `filter` and without a `prefix` narrower than `/`. A count, not the arguments. |
| `findTextContinuations` | `findText` calls that forward a cursor. They resume an earlier scan and are not counted as unscoped. |

A call whose arguments were not a JSON object counts as a call but is neither
unscoped nor a continuation. The counts are recorded for every scenario and also
for conversations that failed or ended in an error. They are stored as
`retrieval` in each case's `result.json`, summed per guide condition in
`summary.json` as `groups.<guide>.retrieval` and per scenario as
`groups.<guide>.retrievalByScenario.<scenario>`, and exported as
`cases[].retrieval` and the same `summary.groups` fields in the Actions JSON
report. Sums add `cases`, the `firstTool` distribution, `casesUsingSearch`,
`casesUsingFindText` and `casesWithUnscopedFindText`; interrupted cases without
recorded events are left out. Reports of older run directories compute the same
counts from their recorded events.

Read the paraphrase rows for `findText` calls before the first `search` and for
conversations without any `search`. In `enumerate`, `findText` first and
unscoped is the expected behavior, since the code spans two directories; its
unscoped count shows cost, not a mistake. The counts cannot show:

- retrieval quality or the difference between semantic, keyword and hybrid
  search, because fixture search ignores the query;
- the real cost of an unscoped scan, because the drive holds nine small files;
- behavior beyond three synthetic tasks with fixed wording and a few
  repetitions per guide condition;
- the effect of different tool descriptions or guide text, because both are
  unchanged and only their delivery channel varies.

## Reproducibility and evidence

`manifest.json` freezes the SDK/benchmark source hashes, dependency lock hash,
source commit, runtime, model, budgets, guide index/topics/version, instruction profiles,
scenario tasks and planned case denominator. Each case has:

- pending/completed/failed-or-uncertain request receipts, without headers or keys;
- the model inputs/outputs, including opaque reasoning items and message phases;
- offered tool definitions, SDK call arguments (including `at`)/results and
  delivery limits;
- initial/observed state, individual outcome/behavior checks, retrieval
  tool-selection counts and fixture cleanup.

`summary.json` is updated after every attempted case and includes failed/error
cases in the planned denominator. A failed cleanup is an error. Exit status is
nonzero for failed checks or execution errors. Use a fresh run directory for a
new measurement; no mutation or model request is automatically replayed from an
uncertain receipt. Request receipts can contain provider response IDs and opaque
reasoning. Keep raw runs in the local workspace or on the ephemeral Actions
runner, and share only reviewed results with their limitations. Action artifacts
are built from a fixed projection that omits free-form model text, tool arguments
and results, provider identifiers, headers and reasoning.

The test suite exercises all nine scenarios, guide channels and instruction
profiles, the retrieval fixtures, scoring, metrics and scenario groups, actual allowlist
and target enforcement, explicit `at` provenance, unchanged resource text, stateless Responses continuation,
malformed JSON, duplicate calls, budgets, failed requests, delivery limits,
scoring independence and failure accounting. These tests establish the harness,
not model performance. A real model run needs `LLM_API_KEY`; live LambdaDB and
MCP wire validation remain separate follow-ups.
