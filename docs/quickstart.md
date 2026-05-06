---
summary: 'Five-minute walk through listing MCP servers, calling a tool, and emitting a typed client.'
---

# Quickstart

This walkthrough assumes you already have an MCP server configured in Cursor, Claude Code/Desktop, Codex, Windsurf, OpenCode, or VS Code. If not, copy [`config/mcporter.example.json`](https://github.com/steipete/mcporter/blob/main/config/mcporter.example.json) into `~/.mcporter/mcporter.json` and edit it — see [Configuration](config.md) for the full schema.

## 1. List the servers mcporter sees

```bash
npx mcporter list
```

You get one row per server with auth status, transport type, and tool count. Add `--json` for machine output, or `--verbose` to see which config files registered each server.

## 2. Inspect a single server

```bash
npx mcporter list linear
```

Single-server output reads like a TypeScript header file: dimmed `/** … */` doc comments above each `function name(...)` signature, with optional parameters summarised so the screen stays scannable. Add flags to drill in:

- `--brief` (alias `--signatures`) — compact signatures only.
- `--all-parameters` — show every optional parameter inline.
- `--schema` — pretty-print the JSON schema for each tool.
- `--json` — machine-readable schema payload.

`mcporter list shadcn.io/api/mcp.getComponents` works too — bare URLs (with or without a `.tool` suffix or scheme) auto-resolve.

## 3. Call a tool

```bash
# Colon-delimited flags (shell-friendly).
npx mcporter call linear.create_comment issueId:ENG-123 body:'Looks good!'

# Function-call style copy/pasted from `mcporter list`.
npx mcporter call 'linear.create_comment(issueId: "ENG-123", body: "Looks good!")'

# Anything after `--` is a literal positional value.
npx mcporter call docs.fetch -- --raw-string-with-leading-dashes
```

Pick the output format with `--output text|markdown|json|raw`. Use `--save-images <dir>` to persist binary content blocks. See [CLI reference](cli-reference.md) for the full flag list.

## 4. Read MCP resources

```bash
npx mcporter resource docs                          # list resources
npx mcporter resource docs file:///path/to/spec.md  # read a resource
```

Output formatting is shared with `mcporter call` (`--output`, `--json`, `--raw`).

## 5. Generate a standalone CLI

When you want to share a tool with someone who shouldn't have to learn `mcporter call`:

```bash
npx mcporter generate-cli linear --bundle dist/linear.js
node dist/linear.js create-comment --issue-id ENG-123 --body 'Looks good!'
```

Add `--compile <path>` for a Bun-compiled binary, or `--include-tools a,b,c` to ship a subset. Full details in [CLI generator](cli-generator.md).

## 6. Emit typed clients for agents

```bash
npx mcporter emit-ts linear --mode client --out src/linear-client.ts
```

You get a `.d.ts` interface and a `createServerProxy()`-backed factory. Calls return `CallResult` objects with `.text()`, `.markdown()`, `.json()`, `.images()`, `.content()` helpers — see [Tool calling](tool-calling.md) for the proxy API and [emit-ts](emit-ts.md) for the generator.

## What next

- [Configuration](config.md) — `mcporter.json` schema, env interpolation, OAuth fields.
- [Ad-hoc connections](adhoc.md) — point at any MCP endpoint without editing config.
- [Agent skills](agent-skills.md) — wiring per-server skills into a coding agent.
