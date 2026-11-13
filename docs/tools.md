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

## Evidence and writes

A match with `kind: 'mem'` is already complete; `kind: 'chunk'` contains an excerpt
with UTF-16 offsets. Pass its canonical `memId` to `memdrive_read` for surrounding
context. There are no short aliases, session-specific evidence tables, automatic
deduplication or finish/report tools. Callers retain earlier results and decide
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
