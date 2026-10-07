---
summary: 'How to generate `.d.ts` files or typed client helpers with mcporter emit-ts.'
read_when:
  - 'Adding new emit-ts behavior or troubleshooting generated clients'
---

# `mcporter emit-ts`

`mcporter emit-ts` turns a configured MCP server into TypeScript artifacts so
agents, tests, and tooling can consume the server through strongly typed APIs.
It reuses the same `buildToolDoc()` data that powers `mcporter list`, so doc
comments, parameter hints, and signatures stay perfectly in sync. For a broader
overview of every CLI command, see `docs/cli-reference.md`.

```
mcporter emit-ts <server> --out linear-client.ts \
  [--mode types|client] \
  [--include-optional]
```

- `--mode types` (default) emits a `.d.ts` interface (`LinearTools`) with
  docblocks + promisified signatures. Missing output schemas fall back to
  `CallResult`.
- `--mode client` emits both the interface (auto-derived `.d.ts`) **and** an
  executable `.ts` helper that wraps `createServerProxy`. Each method takes one
  object holding the tool's arguments and returns a `CallResult`; the factory
  exposes a `close()` helper for runtimes the client creates.
- `--include-optional` mirrors `mcporter list --all-parameters`, ensuring every
  parameter is shown even when optional.
- In types-only mode, output schema titles are normalized to TypeScript identifiers (`Search Results`
  becomes `SearchResults`, and `class` becomes `Class`). Titles that cannot form
  an identifier fall back to the schema's structural display type. Named return
  types still need their corresponding declarations in the consuming project. Client wrappers return `CallResult` for every output schema.

Outputs overwrite existing files automatically so you can regenerate artifacts
whenever the server schema changes.

Server names beginning with digits receive a `Server` prefix in generated type
and factory names (`1password` becomes `Server1passwordTools`). The server name
sent to the runtime is unchanged.

## Examples

### 1. Types-only header

```
mcporter emit-ts linear --out types/linear-tools.d.ts
```

Produces:

```ts
import type { CallResult } from 'mcporter';

export interface LinearTools {
  /**
   * List comments for a specific Linear issue.
   *
   * @param issueId The issue ID
   */
  list_comments(issueId: string, limit?: number): Promise<CallResult>;
}
```

Include the file in your agent/project and you can type-check code like
`const result = await proxy.list_comments('LIN-1234');`, the positional form
`createServerProxy()` accepts.

### 2. Client wrappers

```
mcporter emit-ts linear --mode client --out clients/linear.ts
```

Generates two files:

- `clients/linear.ts` – declares and exports the `LinearTools` interface,
  imports `createRuntime` and `createServerProxy`, and exposes a
  `createLinearClient()` factory whose methods are typed by that interface.
- `clients/linear.d.ts` – the same object-argument interface on its own, for
  consumers that only want the types. The client does not import it, so it can
  live anywhere (`--types-out`) or be deleted.

```ts
const client = await createLinearClient({ configPath: './mcporter.json' });
const comments = await client.list_comments({ issueId: 'LIN-1234' });
console.log(comments.text());
await client.close();
```

Every client method takes a single object whose keys are the tool's schema
property names, exactly as they appear on the wire (a property called
`function` stays `function`). Tools without declared properties accept an optional argument object, so both map-style arguments and zero-argument calls work. The
object goes through the proxy's tool method, so JSON-schema defaults fill
omitted properties, required arguments are validated before the call, and the
exact advertised tool name is used, as described in
[Tool calling](tool-calling.md).

When the schema allows dynamic keys, the parameter type retains the declared fields and allows additional keys with `unknown` values. Closed schemas keep excess-property checks. These types are useful call hints; the server still enforces the full JSON Schema constraints.

For a property literally named `__proto__`, construct an own key with `{ ["__proto__"]: value }` or JSON parsing. JavaScript's ordinary colon-form `__proto__` literal initializes a prototype instead of supplying a tool argument.

`--mode types` is unchanged: its `.d.ts` keeps the positional signatures shown
in example 1, which match the positional form `createServerProxy()` accepts.

If you pass an existing runtime (`{ runtime }`), the factory reuses it; the
returned object’s `close()` becomes a no-op.

### Reserved tool names

Client generation skips tools named exactly `close` or `then` and prints a
warning. `close()` remains runtime cleanup; omitting `then` lets the asynchronous
factory resolve normally. All other methods and their declarations regenerate
as usual, including tools named `call`, `listTools`, or `new`.

Types-only mode includes every tool. To invoke either skipped tool, use
`runtime.callTool('my-server', 'close', { args: {} })` (or `'then'`). Direct calls
require schema-valid arguments, do not apply proxy defaults, and return the raw
MCP result. Close owned runtime connections with `runtime.close()` afterward.

### Regenerating clients from 0.13.13 or earlier

Client methods emitted by earlier versions were typed positionally and only
forwarded the first parameter. After regenerating, change calls such as
`client.list_comments('LIN-1234')` to `client.list_comments({ issueId:
'LIN-1234' })`. Output paths do not change.

What a regenerated client changes for an existing caller:

- On the wire, nothing. A call that passed one positional value still reaches
  the proxy's tool method, which maps that value to the first schema property
  exactly as the 0.13.13 wrapper did, so transpile-only callers (`tsx`, `bun`,
  bundlers) keep working before they are edited.
- Under `tsc`, each positional call site reports one TS2345 whose message names
  the object type to switch to. The 0.13.13 client itself did not type-check
  (its `import type` of the sibling `.d.ts` resolved to the client module), so
  no `tsc`-checked positional caller exists to break.

## Flags

| Flag | Description |
| -------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------- |
| `--out <path>` | Required. `.d.ts` target for `types`, `.ts` target for `client`. |
| `--mode types        | client` | Output kind (defaults to `types`). |
| `--types-out <path>` | Optional override for the `.d.ts` file when `--mode client`. Default: derive from `--out`. |
| `--include-optional` | Include every parameter (not just the minimum 5 + required). |
| `--json` | Emit a JSON summary describing the emitted file(s) instead of plain-text logs. |

## Testing

`tests/emit-ts.test.ts` covers:

- Template rendering (doc comments, `Promise<…>` return types, proxy wrappers).
- End-to-end CLI invocation with a stub runtime, ensuring both `.ts` and `.d.ts`
  files are written successfully.
- Client behavior: a two-property tool reaches `tools/call` with both values, a
  property-less tool calls without an object, reserved-word and non-identifier
  property names survive verbatim, schema defaults fill omitted properties
  without overwriting explicit ones, a missing required argument is rejected
  before the call, `--mode types` signatures stay positional, and the emitted
  client plus a caller compile under the repository's strict `tsconfig.json`.
- Regeneration over a 0.13.13 positional caller: the single value still reaches
  `tools/call` mapped to the first property, the positional call site gets one
  TS2345 naming the object type, and the documented object form compiles clean.
- A stdio fixture server (`tests/fixtures/stdio-emit-ts-server.mjs`) that
  echoes the arguments it receives, called through a client generated from its
  live tool listing.
