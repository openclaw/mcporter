---
summary: 'Quick reference for mcporter subcommands, their arguments, and shared global flags.'
read_when:
  - 'Need a refresher on available CLI commands'
---

# mcporter CLI Reference

A quick reference for the primary `mcporter` subcommands. Each command inherits
`--config <file>` and `--root <dir>` to override where servers are loaded from.

## `mcporter list [server]`

- Without arguments, lists every configured server (with live discovery + brief
  status).
- With a server name, prints TypeScript-style signatures for each tool, doc
  comments, optional summaries, and any server `instructions` returned during
  MCP initialization.
- With `server.tool`, prints just that tool; combine with `--schema` for a single
  tool schema.
- Add `--brief` or `--signatures` with a server or `server.tool` target to keep
  the server header/instructions and print compact signatures without doc
  comments, examples, or schemas.
- Hidden alias: `list-tools` (kept for muscle memory; not advertised in help output).
- Hidden ad-hoc flag aliases: `--sse` for `--http-url`, `--insecure` for `--allow-http` (for plain HTTP testing).
- Flags:
  - `--brief` – compact single-server output; cannot be combined with `--json`,
    `--schema`, `--verbose`, or `--all-parameters`.
  - `--signatures` – alias for `--brief`.
  - `--all-parameters` – include every optional parameter in the signature.
  - `--schema` – pretty-print the JSON schema for each tool.
  - `--timeout <ms>` – per-server timeout when enumerating all servers.

## `mcporter call <server.tool>`

- Invokes a tool once and prints the response; supports positional arguments via
  pseudo-TS syntax and `--arg` flags.
- Useful flags:
  - `--server`, `--tool` – alternate way to target a tool.
  - `--` – stop flag parsing so remaining tokens stay literal positional values.
  - `--timeout <ms>` – override call timeout (defaults to `CALL_TIMEOUT_MS`).
  - `--output text|markdown|json|raw` – choose how to render the `CallResult`.
  - `--save-images <dir>` – persist image content blocks to files under the specified directory.
  - `--raw-strings` – disable numeric coercion for flag-style and positional values.
  - `--no-coerce` – disable all flag-style/positional value coercion.
  - `--tail-log` – stream tail output when the tool returns log handles.

## `mcporter resource <server> [uri]`

- Lists resources exposed by a server when no URI is provided.
- Reads an MCP resource when `uri` is provided and renders text, markdown, JSON,
  or raw output using the same output formatter as `mcporter call`.
- Hidden alias: `resources`.
- Useful flags:
  - `--output auto|text|markdown|json|raw` – choose how to render the response.
  - `--json` – shortcut for `--output json`.
  - `--raw` – shortcut for `--output raw`.

## `mcporter generate-cli`

- Produces a standalone CLI for a single MCP server (optionally bundling or
  compiling with Bun).
- Key flags:
  - `--server <name>` (or inline JSON) – choose the server definition.
  - `--command <url|command>` – point at an ad-hoc HTTP endpoint (include `https://` or use `host/path.tool`) or a stdio command (anything with spaces, e.g., `"npx -y chrome-devtools-mcp@latest"`). If you omit `--command`, the first positional argument is inspected: whitespace → stdio, otherwise the parser probes for HTTP/HTTPS and falls back to config names.
  - `--output <path>` – where to write the TypeScript template.
  - `--bundle <path>` – emit a bundle (Node/Bun) ready for `bun x`.
  - `--bundler rolldown|bun` – pick the bundler implementation (defaults to Rolldown unless the runtime resolves to Bun, in which case Bun’s bundler is used automatically; still requires a local Bun install).
  - `--compile <path>` – compile with Bun (implies `--runtime bun`).
  - `--include-tools <a,b,c>` – only generate subcommands for the specified tools (exact MCP tool names). It is an error if any requested tool is missing.
  - `--exclude-tools <a,b,c>` – generate subcommands for every tool except the ones listed. Unknown tool names are ignored. If all tools are excluded, generation fails.
  - `--include-tools` and `--exclude-tools` are mutually exclusive.
  - `--timeout <ms>` / `--runtime node|bun` – shared via the generator flag
    parser so defaults stay consistent.
  - `--from <artifact>` – reuse metadata from an existing CLI artifact (legacy
    `regenerate-cli` behavior, must point at an existing CLI).
  - `--dry-run` – print the resolved `mcporter generate-cli ...` command without
    executing (requires `--from`).
  - Positional shorthand: `npx mcporter generate-cli linear` uses the configured
    `linear` definition; `npx mcporter generate-cli https://example.com/mcp`
    treats the URL as an ad-hoc server definition.

## `mcporter emit-ts <server>`

- Emits TypeScript definitions (and optionally a ready-to-use client) describing
  a server’s tools. This reuses the same formatter as `mcporter list` so doc
  comments, signatures, and examples stay in sync.
- Modes:
  - `--mode types --out <file.d.ts>` (default) – export an interface whose
    methods return `Promise<CallResult>`, with doc comments and optional
    summaries.
  - `--mode client --out <file.ts>` – emit both the interface (`<file>.d.ts`)
    and a factory that wraps `createServerProxy`, returning objects whose
    methods resolve to `CallResult`.
- Other flags:
  - `--include-optional` (alias `--all-parameters`) – show every optional field.
  - `--types-out <file>` – override where the `.d.ts` sits when using client
    mode.

For more detail (behavioral nuances, OAuth flows, etc.), see `docs/spec.md` and
command-specific docs under `docs/`.
