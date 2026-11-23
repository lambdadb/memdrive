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
