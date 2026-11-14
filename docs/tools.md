# Common memory tools

`@functional-systems/memdrive/tools` supplies provider-independent tool definitions
and execution functions. Calling agents plan queries, choose evidence and generate
answers. A separate hosted MCP service owns authentication, authorization,
protocol handling, deployment and operational limits. No MCP or model client is
bundled with MemDrive.

## Bind tools

```ts
import { createTools } from '@functional-systems/memdrive/tools';

// The application has already opened and authorized this drive.
const tools = await createTools({ drive });
const result = await tools.execute('memdrive_recall', {
    requests: [{ query: 'What was agreed about the meeting?', limit: 10 }],
}, { signal });
```

Creation reads `drive.describe()` once to build schemas from the actual embedding
configuration and metadata declarations, including field descriptions. Pass an
optional `branch` to bind data operations to that branch; otherwise the supplied
handle's branch is used. Model arguments cannot change the drive, connection or
branch. `describe` remains collection-scoped, as it is in the SDK.

The default tools are read-only. `createTools({ drive, writable: true })` also
exposes `remember` and `forget`. This switch and tool annotations are not access
control: the service must authorize each call and select the correct handle.
Collection creation/destruction, configuration and branch administration are not
part of this memory-tool surface.

`definitions` returns detached JSON data. Recreate the registry after changing
the metadata schema; existing input schemas describe the creation-time fields.
A `describe` call reads fresh metadata but does not silently change the registered
tool definitions. Hosted services own any tool-list refresh notification.

## Tool catalog

| Tool | Purpose | Input and result |
| --- | --- | --- |
| `memdrive_recall` | Retrieve evidence for questions or missing facts | `{requests: [...]}` with 1–5 SDK recall requests; `value.results` follows input order, including per-request failures. |
| `memdrive_read` | Expand excerpts to complete originals | `{ids: [...]}` using canonical `memId`; returns `value.mems`, omitting missing IDs. |
| `memdrive_describe` | Discover fields, meanings and search configuration | `{}`; returns the existing SDK drive descriptor. |
| `memdrive_count_values` | Inspect keyword value distributions | `{fields, filter?, excludeIds?, limit?}`; returns buckets, per-field `hasMore` and `asOf`. |
| `memdrive_list` | Browse inventory without a relevance query | `{limit?, cursor?}`; returns original mems and optional `nextCursor`. Continue even after an empty page when a cursor exists. |
| `memdrive_remember` | Add memories or fully replace supplied IDs | `{mems: [...]}`; returns IDs in input order. Available only when writable. |
| `memdrive_forget` | Delete whole memories and their chunks | Exactly `{ids: [...]}` or `{filter: ...}`; success returns `{acknowledged: true}`, not a deletion count. Available only when writable. |

Descriptions state when to use each operation, parameter meanings and important
limitations. Field schemas carry the actual metadata types and descriptions.
Closed objects reject extra top-level arguments, filters use explicit Boolean
expressions, and SDK validation remains authoritative for dates, byte limits,
vector values and other semantic constraints. No silent coercion or null-to-omit
conversion is performed. Input is detached before asynchronous execution.

Recall uses the SDK's existing vector or hybrid pipeline and native reranking
settings. It does not add a query-rewriting model, select evidence or execute a
second search. The tool's five-request bound is separate from the SDK's uncapped
batch length; SDK concurrency remains shared across branch views.

External-vector drives have vector-input schemas. They return references and
metadata without vectors or source text. A model must not invent embeddings;
the caller provides values from the configured vector space.

Counts accept up to five keyword fields and 100 values per field, matching native
facet limits. They count original memories once rather than counting chunks.
An array may contribute to several buckets. Counts can be cached for 60 seconds;
`asOf` is the fetch time, and `hasMore: null` means completeness is unknown.

## Optional session-local short IDs

`createTools({ drive, shortIds: true })` uses `m1`, `m2`, ... in memory-ID fields
of read-only tool results. IDs are assigned on first return and remain stable for
that registry's lifetime. Keep the same registry for a conversation; a new
registry starts a new mapping. Concurrent calls assign aliases in completion
order. This option cannot be combined with `writable: true`.

In this mode, `read.ids`, `excludeIds`, and `id` filter values (`eq`, `neq`, `in`)
accept only aliases previously returned by that registry. Unknown aliases and
raw IDs are rejected without a database request. An invalid recall item does
not prevent valid siblings from running or change their diagnostic indices.
Actual stored IDs that resemble aliases have no special meaning: the session
mapping always determines what `m1` refers to.

Only memory-ID fields change: recall `memId`, read/list `id`, and `id` count
buckets. Content, metadata, scores, offsets, descriptors and pagination cursors
are unchanged. The underlying drive continues to accept and return canonical
IDs. Host code can recover them without exposing the map to the model:

```ts
const tools = await createTools({ drive, shortIds: true });
const result = await tools.execute('memdrive_recall', {
  requests: [{ query: 'Where did I leave the keys?' }],
});
// Resolve a returned alias before storing an application citation.
// For example, if a successful result returned m1:
const canonicalId = tools.resolveId('m1');
```

`resolveId` throws `INVALID_INPUT` for an unknown alias. With the default
`shortIds: false`, it returns its argument unchanged. The mapping is local
memory, is never persisted by the SDK, and lives until the registry is released.

## Optional evidence references

`createTools({ drive, evidenceIds: true })` adds an `evidenceId` such as `e1` to
recall matches and read/list originals. This independent read-only option can be
combined with `shortIds: true`. It preserves every existing result field and
never suppresses repeated bodies, excludes prior results or chooses evidence.
Memory-ID inputs still use `memId`/`id`; an evidence ID is not a memory ID.

A registry assigns one stable reference for each canonical memory and exact
UTF-16 span. Complete originals use `0..content.length`, so the same full span
from recall and read/list shares a reference. Different spans get different IDs.
External-vector references identify only the canonical memory: no text or offsets
are invented. Host code resolves references independently of a model protocol:

```ts
const tools = await createTools({ drive, shortIds: true, evidenceIds: true });
// After a tool result returns evidenceId: 'e1':
const source = tools.resolveEvidence('e1'); // Canonical memId, plus start/end for text.
```

The resolver returns detached data and throws `INVALID_INPUT` for unknown IDs or
when evidence IDs are disabled. References are session-local and identify
previously observed evidence, not a verified current database snapshot. A later
result with the same identity but different content, timestamp or metadata fails
with `INVALID_RESULT`; metadata key order is ignored. Recall failures stay in
their original request slot while valid siblings remain available. Old
references are never rebound to changed source data. Start a new session after
an intentional source update. The registry retains source signatures until it
is released.

The caller owns model delivery and selection. Creating a reference in a raw tool
result does not establish that the model received it: applications that cap or
omit results must track delivered references before accepting citations. No
finish/report tool or model loop is added by this option.

## Evidence and writes

A match with `kind: 'mem'` is already complete; `kind: 'chunk'` contains an excerpt
with UTF-16 offsets. Pass its returned `memId` (canonical by default, a session
alias with `shortIds`) to `memdrive_read` for surrounding context. There are no session-specific evidence tables, automatic deduplication
or finish/report tools. Callers retain earlier results and decide
whether more retrieval is useful. `excludeIds` excludes whole memories and all
their chunks, so it is not equivalent to hiding only previously seen excerpts.

Remember without an ID creates a new memory, including when repeated. Supplying
an existing ID fully replaces content and metadata; it is not a patch. Errors may
contain `completedIds`, `uncertainIds` and `notAttemptedIds`. Preserve these outcomes
and reconcile them before retrying; neither tools nor SDK automatically retry a
multi-request write. Deletion success acknowledges the request and does not prove
that any specified ID existed. Cancellation propagates through `AbortSignal` but
does not undo accepted writes.

## One execution contract, different transports

Every execution returns JSON data in one of these envelopes:

```ts
{ ok: true, value: /* SDK result, or forget acknowledgement */ }
{ ok: false, error: { code, message, status?, details? } }
```

The tool's `outputSchema` describes both. Errors expose actionable SDK codes and
safe write outcomes, without causes, stack traces or raw transport bodies.
Unexpected exceptions use `TOOL_EXECUTION_FAILED` with a generic message. A batch
recall that ran has `ok: true` even when some `value.results` items contain errors;
inspect each item. Unknown or disabled tools return `UNKNOWN_TOOL` before dispatch.

Direct function calling can register the same definitions. For OpenAI Responses,
the registration shape is:

```ts
const functions = tools.definitions.map(tool => ({
    type: 'function', name: tool.name, description: tool.description,
    parameters: tool.inputSchema, strict: false,
}));
// On a function call, parse its arguments and pass the same object to execute.
const result = await tools.execute(call.name, JSON.parse(call.arguments), { signal });
const output = JSON.stringify(result);
```

These portable schemas preserve optional fields and SDK omission semantics.
They are not advertised as OpenAI strict schemas: that mode requires every
property to be required and uses nullable fields for optionality. Explicitly use
`strict: false`; a future provider-specific strict conversion must also define
and test its argument normalization. Claude registration uses the same `name`
and `description` with `input_schema: tool.inputSchema`.

A hosted MCP service lists the same definitions and packages the execution data:

```ts
const result = await tools.execute(name, argumentsObject, { signal });
const mcpResult = {
    isError: !result.ok,
    structuredContent: result,
    content: [{ type: 'text', text: JSON.stringify(result) }],
};
```

This is a mapping example, not an MCP server implementation. The MCP service
handles protocol errors, unknown-tool routing, sessions, cancellation messages
and authentication. In particular, it maps unknown names to the protocol's
unknown-tool error instead of treating them as successful tool dispatches.
It must not change defaults, truncate results silently or implement separate
search logic. Direct function-call output and MCP `structuredContent`/JSON text
carry the same canonical execution result. Provider context limits and differing
agent prompts can still change the model's choices and final answer.

## Standards and validation

Definitions use JSON Schema 2020-12, structured output schemas and tool annotations
following the [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
The [MCP annotation reference](https://modelcontextprotocol.io/specification/2025-11-25/schema#toolannotations)
defines effect hints, not authorization. Reads are marked read-only; remember and
forget can destroy prior data, and remember is not generally idempotent because
IDs may be generated. The tools operate on a bound memory database rather than
arbitrary external destinations.

The [OpenAI function-calling guide](https://developers.openai.com/api/docs/guides/function-calling)
documents strict-mode requirements and explicit non-strict registration.
The [Claude tool-definition guide](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)
emphasizes clear purposes, parameter meanings and limitations. These sources
inform the shared contract; they do not imply live certification by a provider.

Maintained tests compile the schemas with Ajv 2020, validate real SDK fixture
results, exercise branch binding, writable selection, batch correspondence,
partial failures and cancellation, and compare direct/MCP result packaging.
Package checks exercise ESM, CommonJS, public TypeScript types and browser bundles.
Simulated envelope equality is not a live MCP transport or model-quality test.

## Optional retriever

`createRetriever` from `@functional-systems/memdrive/retriever` offers the same
retrieval through `.recall(request, {signal})` and `.tools.execute('memdrive_recall',
request, {signal})`. It defaults to `single_pass`, which invokes one base recall
without creating a model session. Base `drive.recall` and the basic tools above
remain unchanged. The high-level tool accepts **one SDK recall request**, not the
basic `{requests: [...]}` batch. Do not register both tools under the same name.
Strategy, adapter, guidance and budgets are host configuration, never model input.

For `strategy: 'agentic'`, provide `agent.model`, `agent.countTokens` and optional
`agent.instructions` / `agent.limits`. Managed text memories are required; an
external-vector drive is rejected because the SDK cannot generate query vectors.
Each recall creates an isolated read-only tool session with short memory and
evidence IDs. The model can search, read, list, describe and count values, then
select delivered evidence IDs. The result contains canonical `matches`,
`completion` and `usage`. The caller's `limit` bounds the final selection;
individual searches retain their own request limits. There is no automatic
fallback to unselected candidates, duplicate suppression or answer generation.

The adapter implements `createSession({request, instructions, tools})`, returning
`prepare(replies)`. Both are strictly local: no network calls. `prepare` returns
`{inputTokens, respond({signal, maxOutputTokens})}`. Estimate **the entire provider
request**, including instructions, tool schemas, history and opaque state;
reservation is only as conservative as this estimate. `respond` performs one
provider call and returns `{status, usage, calls?}` or
`{status, usage, evidenceIds?}`. Each call has `{id, name, arguments}`; replies have
`{id, name, result}`. IDs must be unique within the retrieval. Preserve provider
conversation/reasoning state in the adapter, and pass the supplied signal to its
transport. Return `status: 'incomplete'` with known usage when parsing a completed
provider response fails. Network failures may throw and are counted as unknown
usage. No provider package is included in MemDrive.

Defaults are 8 model rounds, 24 tool calls, 120 data calls, 48,000 context tokens,
160,000 total model tokens, 4,096 output tokens per call, 16,000 tokens per delivered
tool result and 900,000 milliseconds. Each recall batch item counts as one data
call; read/list/count/describe count as one each. These are **not native database
HTTP limits**. `countTokens` measures the complete serialized tool result; an
oversized result is replaced by an explicit size-limit error, never truncated.
The SDK reserves estimated input plus maximum output before dispatch and checks
reported usage afterward; it cannot undo provider overuse. Adapters must honor
cancellation and output bounds. Synchronous adapter work cannot be preempted.
Async model, tool and record-hook waits are bounded by the retrieval signal.

`completion.status` is `completed`, `budget_exhausted`, `aborted` or `failed`.
Noncompleted outcomes contain no matches and an explicit reason, preserving
usage already observed. Invalid caller requests reject before model work.
`usage` reports model calls, known input/output tokens, unknown-usage calls,
tool/data calls and elapsed milliseconds. `databaseRequests` is null after any
primitive without exact native request accounting; `knownRecallDatabaseRequests`
retains the subtotal from completed base recall results. Initialization performs
one `describe` before retrieval timing and is outside per-recall usage. A native
transport hook can impose a separate hard HTTP budget.

The original caller filter and exclusions constrain every internal search/count
and every original exposed through read/list; the supplied drive fixes the
branch. Scope uses the SDK's filter semantics. Browsing can return an empty page
with a continuation cursor after filtering. Read/list may physically fetch
excluded originals before filtering. This is retrieval selection, **not an
authorization boundary**: authorize the underlying drive separately. Underlying
drive/native diagnostics may contain data outside this selection. Optional
retriever `record` events are detached and scoped; tool events include host-only
canonical source mappings for audit, including oversized results that were not
delivered. Only actually delivered evidence is eligible for final selection.
