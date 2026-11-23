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
npm run benchmark:tools -- --mode scripted --output artifacts/tool-use/smoke

# Provide LLM_API_KEY through the environment or ignored .env.local.
# A small first model pilot compares all three guide channels for one task.
npm run benchmark:tools -- --mode model --scenario recall --guide all \
  --model gpt-6.1-sol --output artifacts/tool-use/model-recall

# Six tasks, three guide channels, two repetitions: 36 separate conversations.
npm run benchmark:tools -- --mode model --guide all --repeats 2 \
  --instruction server --output artifacts/tool-use/model-server

# Separate profiles for workflow guidance and an explicit user reminder.
npm run benchmark:tools -- --mode model --instruction workflow \
  --output artifacts/tool-use/model-workflow
npm run benchmark:tools -- --mode model --instruction user \
  --output artifacts/tool-use/model-user
```

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

# After reviewing the pilot: six tasks, all three guide conditions, two repeats.
gh workflow run tool-evaluation.yaml --ref main -f scenario=all -f repeats=2
```

The workflow always compares `none`, `tool` and `resource`. It defaults to
`gpt-6.1-sol`, the `server` profile and one repetition. The dispatch form also
accepts an explicit model ID, `workflow` or `user` instructions, and up to five
repetitions. Each dispatch can incur model charges. Runs execute one at a time,
with a 60-minute model-step limit and a 75-minute job limit. A time-limited run
can report fewer completed cases than planned. The job reports failures even
when the report export succeeds.

Open the run summary for per-guide counts and download the `tool-evaluation-*`
artifact for the JSON report, retained for seven days. The report includes
configuration and source hashes, check results, ordered tool names and outcomes,
offered tool names, model-response validation, HTTP error statuses and token
usage. It records the length of any final answer. Detailed investigation of
wording, arguments and SDK results requires a separate local run. The raw trace
on the hosted runner stays in temporary storage for the lifetime of the job.

## Conditions and host policy

`--guide` selects `none`, `tool`, `resource`, or `all` (default):

| Delivery | Model-visible content | Observation |
| --- | --- | --- |
| `none` | SDK tool descriptions and short server instructions | Baseline without full guide text |
| `tool` | Same descriptions plus the optional SDK `guide` tool | Record whether the model calls it |
| `resource` | Host lists and reads the guide resource, then injects its unchanged text | Record a **host** resource read; this is not an autonomous model fetch |

All channels use the same exported guide version. Guide version 5 describes the
semantic/no-rerank defaults and explicit search modes. Earlier guide-4 model
measurements used the previous search defaults; they do not validate model
selection with the new descriptions. `--instruction` independently
selects `server` (default), `workflow` (additional developer workflow text), or
`user` (an explicit reminder appended to the task). Workflow injection approximates
a loaded bundled skill; skill discovery/loading itself is not tested. Compare
one factor at a time. Fixed case/channel ordering, small samples and synthetic
inputs limit any quality inference; use repetitions and inspect individual traces.

The host binds one authorized store/view and an explicit allowlist. Read-only
cases never expose mutating tools. Main never exposes working-only operations.
For tasks that authorize creating a working copy, the host opens only the newly
returned same-store fork and offers a new binding on the next model round. Tool
results remain the SDK's serializable results. Arguments cannot select another
store or arbitrary view, and calls from a stale binding in the same batch fail.
This is evaluation policy, not hosted authentication or cross-process fencing.

## Scenarios and scoring

| Scenario | Initial condition and expected outcome |
| --- | --- |
| `recall` | Read current retention/contact despite an older dated decision containing an untrusted instruction. Correct literal facts, evidence use and unchanged main are checked. |
| `maintain` | Working policy already says 42 days; FAQ outside the initial diff still says 30. Update related current guidance, preserve the dated record and publish the complete intended state. |
| `draft-checkpoint` | Begin on main, create private `trial`, preserve `before-edit` on that draft before its first write, then edit the FAQ without publishing. Host rebinding, checkpoint provenance/order, both saved states and unchanged main are checked. |
| `past-version` | After two publications, create `earlier` from the first version using `history`/`version`. Verify its old content and unchanged current main. |
| `unrelated` | A later unrelated main file is absent from the task fork. Publish the FAQ update while preserving the unrelated main content. |
| `conflict` | A concurrent main edit conflicts with the task fork. Observe `MERGE_CONFLICT`, preserve the intended unpublished draft and unchanged main, and report the blocker. Resolution/takeover/retry is not implemented by this host. |

Ground truth is evaluated independently through public SDK reads, inventories,
status and ref opens. State checks compare full synthetic originals and expected
paths, rather than accepting the model's claim of success. Publication tasks also
check that the changed original was delivered before editing and that a diff was
inspected after the last write and before merge. Exact-edit counts are descriptive,
not a requirement to use one specific sequence for every task. Final recall and
blocker wording checks are literal heuristics; there is no semantic answer judge
or general citation-quality score. Prompt-injection coverage is one synthetic
example, not a security certification.

Scripted mode emits predetermined requests and is **only a transport/workflow
smoke test**. Its `modelTasksPassed` is `null`. Injected test transports are also
identified separately and cannot count as real model measurements.

## Reproducibility and evidence

`manifest.json` freezes the SDK/benchmark source hashes, dependency lock hash,
source commit, runtime, model, budgets, guide text/version, instruction profiles,
scenario tasks and planned case denominator. Each case has:

- pending/completed/failed-or-uncertain request receipts, without headers or keys;
- the model inputs/outputs, including opaque reasoning items and message phases;
- offered tool definitions and bindings, SDK call arguments/results, delivery
  limits and explicit host rebindings;
- initial/observed state, individual outcome/behavior checks and fixture cleanup.

`summary.json` is updated after every attempted case and includes failed/error
cases in the planned denominator. A failed cleanup is an error. Exit status is
nonzero for failed checks or execution errors. Use a fresh run directory for a
new measurement; no mutation or model request is automatically replayed from an
uncertain receipt. Request receipts can contain provider response IDs and opaque
reasoning. Keep raw runs in the local workspace or on the ephemeral Actions
runner, and share only reviewed results with their limitations. Action artifacts
are built from a fixed projection that omits free-form model text, tool arguments
and results, provider identifiers, headers and reasoning.

The test suite exercises all six scenarios and guide channels, actual allowlist
enforcement, rebinding, unchanged resource text, stateless Responses continuation,
malformed JSON, duplicate calls, budgets, failed requests, delivery limits,
scoring independence and failure accounting. These tests establish the harness,
not model performance. A real model run needs `LLM_API_KEY`; live LambdaDB and
MCP wire validation remain separate follow-ups.
