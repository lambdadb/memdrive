# MemDrive

TypeScript memory SDK backed by LambdaDB. Store original memories, retrieve
relevant evidence with a single search or an agent, and read complete originals.
Applications own answer generation and presentation. The SDK accepts an initialized
LambdaDB client; the caller owns connection credentials and transport.

The package is `@functional-systems/memdrive`, licensed under Apache-2.0.
It is not published yet. It builds ESM and CommonJS with TypeScript declarations
and supports Node.js 20.12+ and browser bundlers. To try it locally, run `npm ci`,
`npm run build`, and `npm pack`, then install the resulting tarball in the consumer
project. See [CONTRIBUTING.md](CONTRIBUTING.md) for development and
[RELEASING.md](RELEASING.md) for the release policy.

```ts
import { LambdaDBClient } from '@functional-systems/lambdadb';
import { create } from '@functional-systems/memdrive';

const client = new LambdaDBClient({
    baseUrl: 'https://your-lambdadb-endpoint',
    projectName: 'your-project',
    projectApiKey: 'your-project-api-key',
});

const drive = await create({
    client, name: 'story_memory', mode: 'single_pass',
    description: 'Conversation memories for the example application',
    metadataSchema: {
        role: { type: 'string', description: 'Message author role: user or assistant' },
        tags: { type: 'string[]', description: 'Application-defined topics' },
    },
    textSearch: { analyzers: ['english'] },
    labels: { application: 'example', owner: 'account123' },
});
await drive.remember({ mems: [
    { id: 'message-1', content: 'The meeting is on Friday.',
      timestamp: '2026-11-13T12:00:00Z', metadata: { role: 'user' } },
] });
const { matches, usage } = await drive.recall({ query: 'When is the meeting?' });
const { mems } = await drive.read({ ids: [...new Set(matches.map(match => match.memId))] });
```

## Public operations

| Operation | Contract |
| --- | --- |
| `create(options, {signal}?)` | Creates one collection and opens a handle. Existing names fail. |
| `open({client, name, mode, branch?, ...}, {signal}?)` | Validates an existing MemDrive; embedding and analyzers come from storage. |
| `list({client, labels?, limit?, cursor?}, {signal}?)` | Returns `{drives, nextCursor?}` for one native collection page. Default limit 10, maximum 100. |
| `drive.describe({signal}?)` | Fresh `{name, description?, labels, metadataSchema, embedding, textSearch?}`. |
| `drive.remember({mems}, {signal}?)` | Appends generated IDs or fully replaces supplied IDs. Returns `{ids}` in input order. |
| `drive.recall(request, {signal}?)` | Returns `{matches, usage}`; no final answer is generated. Default limit 10. |
| `drive.recall({requests}, {signal}?)` | Returns `{results}` in input order, including individual error/usage entries. |
| `drive.read({ids}, {signal}?)` | Returns full original `{mems}`; absent IDs are omitted. |
| `drive.list({limit?, cursor?}, {signal}?)` | Returns original `{mems, nextCursor?}` from one committed physical document page. Default limit 100, maximum 1000. |
| `drive.forget({ids} or {filter}, {signal}?)` | Removes whole Mems and their chunks. Missing IDs are harmless. |
| `drive.configure({metadataSchema?, description?}, {signal}?)` | Updates the drive description and/or metadata declaration. A supplied schema must retain all existing fields and their types; additions and field-description changes are allowed. |
| `drive.at({branch})` | Returns a branch-bound data handle with the same data APIs. |
| `drive.branches.create({name, source:{branch}}, {signal}?)` | Creates a branch. Latest accepted-write inclusion depends on the LambdaDB server contract. |
| `drive.branches.list({signal}?)`, `.delete(name, {signal}?)` | Lists/deletes branches. The main branch cannot be deleted. |
| `drive.destroy({signal}?)` | Deletes the collection, including its branches. |

Both list APIs may return an empty logical page with `nextCursor`; keep paging
until the cursor is absent. Document listing is committed-state inventory.
`read` and `recall` request consistent reads. A write-dependent read starts after
the caller receives a successful write response. Concurrent writes to the same
Mem have no ordering guarantee.

`metadataSchema` is required at creation; use `{}` when no custom fields are needed.
Metadata types are `string`, `string[]`, `number`, `boolean`, and `datetime`.
Drive and metadata-field descriptions are optional strings, up to 255 UTF-16 code units,
stored in native collection/index descriptions. `configure` preserves omitted
descriptions; an empty string clears one. Descriptions are returned by `describe`
and the drive catalog. Agentic `get_schema` exposes the drive description,
caller labels and field descriptions so the model can inspect their meanings.
Only declared metadata is accepted. Filters use explicit `and`/`or` arrays and
leaves such as `{field:'metadata.role', op:'eq', value:'user'}`. Supported leaf
operators are `eq`, `neq`, `in`, `exists`, `gt`, `gte`, `lt`, `lte`; ranges apply
to numbers and datetimes. `id` and `timestamp` are also filterable.

Labels are native collection tags, with a total native limit of five. `memory.*`
is reserved: two internal tags leave three caller labels for managed stores;
three internal tags leave two for external-vector stores. Over-limit input fails
before a request is sent. Descriptions do not consume tag slots. Labels aid discovery,
not authorization. The caller verifies its expected ownership before mutations.
Incompatible stores are rejected by `open` and skipped by the catalog. There is
no automatic migration or legacy-store deletion. Snapshot retention is not a
MemDrive option: new collections omit the setting and use LambdaDB's default of
30 days. Opening an existing drive does not change its native retention setting.

## Storage and retrieval

Managed stores use native `text-embedding-3-small` embeddings. At creation,
omitting `embedding` and passing `embedding: { mode: 'managed' }` are equivalent.
The managed model settings are fixed; `open` recovers them from storage. Supplying
`textSearch.analyzers` enables hybrid retrieval; omission uses vector retrieval.
Managed `single_pass` uses native Jev reranking by default in both cases.
`recall` accepts an optional boolean `rerank`, including on each item of a batch:

| Effective recall mode | Omitted | `false` | `true` |
| --- | --- | --- | --- |
| Managed `single_pass` | Enabled | Disabled | Enabled |
| External `single_pass` | Disabled | Disabled | Rejected |
| `agentic` | Disabled | Disabled | Rejected |

```js
await drive.recall({ query: 'When is the meeting?', rerank: false });
```

This is a per-request execution option, not a stored setting or a
`create`/`open`/`configure` option. The effective mode is the recall's `mode`
override or the handle default. Disabling reranking preserves the existing
KNN `k`, filters and result limit; results retain search order.
Unsupported combinations fail before database or model requests.

`agentic` requires
an `agent.model` adapter and exposes the SDK's search, schema/distribution,
original-read, and final-ID reporting tools. Application-specific optional
instructions and answer budgets belong to the caller. The SDK returns selected
evidence; the caller assembles the final answer input.

The adapter contract is exported as `AgentModel`. It provides `name`, `provider`,
`respond(request, {signal}?)`, and `checkContext(request)`, with optional `reasoning`.
The wire format currently follows the OpenAI Responses API: requests contain
function tools and conversation items; successful responses must have
`status: 'completed'` and an `output` array containing function calls with
`type`, `call_id`, `name`, and JSON-string `arguments`. Other providers need an
adapter to this format. Optional response `usage` supplies token accounting.
Its fields are `input_tokens`, `input_tokens_details.cached_tokens`, and
`output_tokens`; unavailable or invalid counts become `null` in public usage.
`checkContext` returns `false` or throws to stop an oversized request; no context
is silently truncated. Provider SDKs and credentials are not bundled.

Optional `observe` and `record` callbacks expose retrieval diagnostics. Use
`observe.matches[].memId` for canonical caller IDs; `observe.ids` contains internal
physical evidence IDs, distinct from the short aliases shown to the agent.
`record` includes request/response bodies and memory text, so callers control
whether and where to retain those events.

Managed text uses the current 800-code-point splitter, Unicode-aware with UTF-16
source offsets and no overlap. Short full Mems store `content` once. Long Mems
store their original in unindexed `memContent` and searchable `content` chunks.
An overwrite replaces obsolete chunk slots with bodyless documents. Public
matches identify `kind: 'mem'` or `'chunk'`, `memId`, and the returned text span.

For caller-provided embeddings, create with:

```js
embedding: { mode: 'external', dimensions: 768,
             similarity: 'cosine', identity: 'caller-model-v1' }
```

Remember `{id?, embedding, timestamp?, metadata?}` and recall with
`{queryVector, filter?, excludeIds?, limit?}`. Text, chunking, keyword search,
reranking and agentic mode are unavailable for this mode. Read/list/matches
return references and metadata without vectors or source text. The caller owns
embedding identity compatibility and reconstruction of the local original.

Remember packs complete Mem replacements into native requests up to 6,029,312
JSON bytes. One Mem is never split across write requests. The per-document bound
is 5 MiB. All replacements are validated before writes; subsequent requests are
sequential. Failure details distinguish `completedIds`, `uncertainIds`, and
`notAttemptedIds`. A multi-request remember is not atomic; do not blindly retry
the entire operation. The SDK does not serialize different writes or retry them.

Cancellation is a separate options argument and never enters stored/model JSON.
It removes queued recalls and propagates to native requests and the model adapter's
`respond(request, {signal})`. Cancellation does not undo accepted writes.
Recalls share a default concurrency bound of five across branch views; the
caller may configure it. Batch request count is not artificially capped by the
SDK; a hosted MCP wrapper can impose its own exposed tool limit.

The development format stays `mems-v0` until release. Recreate disposable stores
after incompatible layout changes. MemDrive uses LambdaDB SDK 0.12.0. Build
artifacts are generated with `npm run build`; browser applications bundle the
public package entry point with their own build tools.

## Consumers

The prototype was exercised by BEAM, LongMemEval and SillyMemory integrations.
Those applications and evaluation runners remain outside this SDK repository;
their existing local copies have not been switched to the standalone package.
Each caller owns dataset interpretation, recent-context partition, provider
adapters and final prompt assembly. SDK unit and package checks do not establish
benchmark answer quality or live service compatibility.
