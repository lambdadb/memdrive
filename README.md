# MemDrive

TypeScript memory SDK backed by LambdaDB. Store original memories, retrieve
relevant evidence, inspect metadata distributions, and read complete originals.
Applications and their agents own query planning, repeated searches, evidence
selection, answer generation and presentation. The SDK accepts an initialized
LambdaDB client; the caller owns connection credentials and transport.

The package is `@functional-systems/memdrive`, licensed under Apache-2.0.
It builds ESM and CommonJS with TypeScript declarations and supports Node.js
20.12+ and browser bundlers. Development packages use the explicit `dev` channel:

```sh
npm install @functional-systems/memdrive@dev
```

Development builds may change before a stable release; pin an exact version for
reproducibility. To build locally, run `npm ci`, `npm run build`, and `npm pack`,
then install the resulting tarball in the consumer project. See [CONTRIBUTING.md](CONTRIBUTING.md) for development and
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
    client, name: 'story_memory',
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
| `open({client, name, branch?, ...}, {signal}?)` | Validates an existing MemDrive; embedding and analyzers come from storage. |
| `list({client, labels?, limit?, cursor?}, {signal}?)` | Returns `{drives, nextCursor?}` for one native collection page. Default limit 10, maximum 100. |
| `drive.describe({signal}?)` | Fresh `{name, description?, labels, metadataSchema, embedding, textSearch?}`. |
| `drive.remember({mems}, {signal}?)` | Appends generated IDs or fully replaces supplied IDs. Returns `{ids}` in input order. |
| `drive.recall(request, {signal}?)` | Returns `{matches, usage}`; no final answer is generated. Default limit 10. |
| `drive.recall({requests}, {signal}?)` | Returns `{results}` in input order, including individual error/usage entries. |
| `drive.countValues({fields, filter?, excludeIds?, limit?}, {signal}?)` | Returns keyword value buckets and counts over original memories, with `asOf` and per-field `hasMore`. Default limit 10, maximum 100. |
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
and the drive catalog. `describe()` is the schema inspection API; there is no
separate agent-specific schema response.
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
Managed text retrieval uses native Jev reranking by default in both cases.
`recall` accepts an optional boolean `rerank`, including on each item of a batch:

| Embedding configuration | Omitted | `false` | `true` |
| --- | --- | --- | --- |
| Managed | Enabled | Disabled | Enabled |
| External | Disabled | Disabled | Rejected |

```js
await drive.recall({ query: 'When is the meeting?', rerank: false });
```

This is a per-request execution option, not a stored setting or a
`create`/`open`/`configure` option. Disabling reranking preserves the existing
KNN `k`, filters and result limit; results retain search order.
Unsupported combinations fail before database requests.

Each `recall` performs one native search request. There is no retrieval `mode`,
internal model adapter, prompt, evidence-selection step or model loop. A caller
can issue multiple queries in a batch, inspect the returned matches, call `read`
for complete originals and search again. Optional text `context` and
`recentDialogue` still become part of the embedding/rerank query without an internal agent
call. The caller owns their relevance and size; the native 8 KiB query bound is
validated without silent truncation. `usage` reports `elapsedMs` and
`databaseRequests`; MemDrive does not report caller model token usage.

Optional `observe` and `record` callbacks expose retrieval diagnostics.
`observe` emits one `retrieved` event for each successful recall; there is no
selection event. Use `observe.matches[].memId` for canonical caller IDs;
`observe.ids` contains internal physical evidence IDs. `record` emits `query`
and `query_result` events, including bodies and memory text. Batch callbacks
include `requestIndex`. Callers control whether and where to retain these events.

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
and reranking are unavailable for external embeddings. Read/list/matches
return references and metadata without vectors or source text. The caller owns
embedding identity compatibility and reconstruction of the local original.

Remember packs complete Mem replacements into native requests up to 6,029,312
JSON bytes. One Mem is never split across write requests. The per-document bound
is 5 MiB. All replacements are validated before writes; subsequent requests are
sequential. Failure details distinguish `completedIds`, `uncertainIds`, and
`notAttemptedIds`. A multi-request remember is not atomic; do not blindly retry
the entire operation. The SDK does not serialize different writes or retry them.

Cancellation is a separate options argument and never enters stored JSON.
It removes queued requests and propagates to native requests. Cancellation does
not undo accepted writes.
Recalls share a default concurrency bound of five across branch views; the
caller may configure it. Batch request count is not artificially capped by the
SDK; a hosted MCP wrapper can impose its own exposed tool limit.

The development format stays `mems-v0` until release. Recreate disposable stores
after incompatible layout changes. MemDrive uses LambdaDB SDK 0.12.0. Build
artifacts are generated with `npm run build`; browser applications bundle the
public package entry point with their own build tools.

## Metadata distributions

Use `describe()` for field declarations and `countValues()` for stored values:

```ts
const { metadataSchema } = await drive.describe();
const distribution = await drive.countValues({
    fields: ['metadata.role', 'metadata.tags'],
    filter: { field: 'timestamp', op: 'gte', value: '2026-01-01T00:00:00Z' },
    excludeIds: ['message-to-exclude'],
    limit: 10,
});
// distribution.values['metadata.role']:
// { buckets: [{ value: 'user', count: 12 }], hasMore: false }
// distribution.asOf: ISO 8601 UTC fetch time
```

Countable fields are `id` and declared `string`/`string[]` metadata fields.
Each request accepts one to five distinct fields, matching the native facet limit. Numeric, boolean and datetime fields can
filter the population but cannot be aggregated. Counts include each original
Mem once, regardless of its chunk count; obsolete chunk slots do not contribute.
An array may place a Mem in multiple buckets, so bucket sums are not the number
of memories. The active branch, filter and excluded IDs determine the population.

Value results are cached for 60 seconds per data handle; schema validation is
cached for five minutes internally. `describe()` itself remains a fresh lookup.
SDK mutations invalidate local counts across views of the same drive. Writes
through another independent handle or client may remain invisible in cached
counts until expiration. `asOf` is the result fetch time, not a database snapshot
identifier. `hasMore` is `true` when another bucket is observed, `false` when the
response is complete, and `null` when the native 100-bucket bound leaves
completeness unknown.

A hosted MCP service can expose these SDK operations and supply tool descriptions
and protocol handling. The service or calling agent owns orchestration; MemDrive
has no model-specific tool schemas, short evidence aliases or finish/report tool.

## Agent tools

Import `createTools` from `@functional-systems/memdrive/tools` to expose portable
memory operations to a calling agent. The common layer provides JSON Schema input
and output definitions, descriptions, effect annotations and SDK execution. It
contains no internal agent loop or MCP server. See [the tool contract](docs/tools.md)
for the catalog, branch binding, write opt-in, error outcomes and direct/MCP mapping.

## Consumers

The prototype was exercised by BEAM, LongMemEval and SillyMemory integrations.
Those applications and evaluation runners remain outside this SDK repository;
their existing local copies have not been switched to the standalone package.
Each caller owns dataset interpretation, recent-context partition, search
orchestration and final prompt assembly. The standalone API no longer accepts
`mode` or `agent`; consumers of the earlier prototype must remove those options
and move any agent loop to the application. SDK unit and package checks do not establish
benchmark answer quality or live service compatibility.
