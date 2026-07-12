---
summary: 'Five-minute walk through listing MCP servers, calling a tool, and emitting a typed client.'
---

# Quickstart

This walkthrough uses the public Context7 server so you can follow the tool examples without existing MCP configuration. Add it with `mcporter config add context7 https://mcp.context7.com/mcp` if it is not already discovered from Cursor, Claude Code/Desktop, Codex, Windsurf, OpenCode, or VS Code. See [Configuration](config.md) for more options and the full schema.

## 1. List the servers mcporter sees

```bash
npx mcporter list
```

You get one row per server with auth status, transport type, and tool count. Add `--json` for machine output, `--quiet` for a silent health gate, or `--verbose` to see which config files registered each server.

## 2. Inspect a single server

```bash
npx mcporter list context7
```

Single-server output reads like a TypeScript header file: dimmed `/** … */` doc comments above each `function name(...)` signature, with optional parameters summarised so the screen stays scannable. Add flags to drill in:

- `--brief` (alias `--signatures`) — compact signatures only.
- `--all-parameters` — show every optional parameter inline.
- `--schema` — pretty-print the JSON schema for each tool.
- `--json` — machine-readable schema payload.
- `--status` — concise status only, without tool docs.

`mcporter list shadcn.io/api/mcp.getComponents` works too — bare URLs (with or without a `.tool` suffix or scheme) auto-resolve.

## 3. Call a tool

```bash
# Colon-delimited flags (shell-friendly).
npx mcporter call context7.resolve-library-id query:'React hooks docs' libraryName:react

# Function-call style copy/pasted from `mcporter list`.
npx mcporter call 'context7.resolve-library-id(query: "React hooks docs", libraryName: "react")'
```

Pick the output format with `--output text|markdown|json|raw`. Use `--save-images <dir>` to persist binary content blocks. See [CLI reference](cli-reference.md) for the full flag list.

## 4. Read MCP resources (optional)

Context7 exposes tools but not resources. If another configured server exposes resources, list or read them with:

```bash
npx mcporter resource my-resource-server                          # list resources
npx mcporter resource my-resource-server file:///path/to/spec.md  # read a resource
```

Output formatting is shared with `mcporter call` (`--output`, `--json`, `--raw`).

## 5. Generate a standalone CLI

When you want to share a tool with someone who shouldn't have to learn `mcporter call`:

```bash
npx mcporter generate-cli context7 --runtime node --bundler rolldown --bundle dist/context7.js
node dist/context7.js resolve-library-id --query 'React hooks docs' --library-name react
```

Add `--compile <path>` for a Bun-compiled binary, or `--include-tools a,b,c` to ship a subset. Full details in [CLI generator](cli-generator.md).

## 6. Emit typed clients for agents

```bash
npx mcporter emit-ts context7 --mode client --out src/context7-client.ts
```

You get a `.d.ts` interface and a `createServerProxy()`-backed factory. Calls return `CallResult` objects with `.text()`, `.markdown()`, `.json()`, `.images()`, `.content()` helpers — see [Tool calling](tool-calling.md) for the proxy API and [emit-ts](emit-ts.md) for the generator.

## What next

- [Configuration](config.md) — `mcporter.json` schema, env interpolation, OAuth fields.
- [Ad-hoc connections](adhoc.md) — point at any MCP endpoint without editing config.
- [Agent skills](agent-skills.md) — wiring per-server skills into a coding agent.
