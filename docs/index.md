---
title: Overview
permalink: /
summary: 'Overview of mcporter as a portable MCP runtime, CLI, generated-CLI toolkit, and typed-client layer.'
description: 'mcporter is a TypeScript runtime, CLI, and code-generation toolkit for the Model Context Protocol — built so AI agents and developers can call any MCP server without boilerplate.'
---

## Try it

mcporter auto-discovers the MCP servers already configured in Cursor, Claude Code/Desktop, Codex, Windsurf, OpenCode, and VS Code. Try it without installing anything:

```bash
# List every MCP server you already have configured.
npx mcporter list

# Inspect a single server with TypeScript-style signatures.
npx mcporter list linear --schema

# Call a tool — colon flags, function-call syntax, or trailing positional values.
npx mcporter call linear.create_comment issueId:ENG-123 body:'Looks good!'
npx mcporter call 'linear.create_comment(issueId: "ENG-123", body: "Looks good!")'

# Read or list MCP resources.
npx mcporter resource docs
npx mcporter resource docs file:///path/to/spec.md

# Mint a standalone CLI for any MCP server, ready to ship.
npx mcporter generate-cli linear --bundle dist/linear.js

# Emit `.d.ts` types or a typed client for agents and tests.
npx mcporter emit-ts linear --mode client --out src/linear-client.ts
```

`--json` produces a stable JSON envelope on stdout; human progress, prompts, and warnings always go to stderr so pipes stay parseable.

## What mcporter does

mcporter leans into the **code-execution-with-MCP** pattern Anthropic recommends: skip the giant tool-schema prompt, generate a small typed surface, and let the agent or the human call MCP servers like normal functions.

- **Zero-config discovery.** Reads your home config (`~/.mcporter/mcporter.json[c]`, or `$XDG_CONFIG_HOME/mcporter/mcporter.json[c]`), then `config/mcporter.json`, then imports from Cursor / Claude / Codex / Windsurf / OpenCode / VS Code. `${ENV}` placeholders are expanded; transports are pooled across calls.
- **One-command CLI generation.** [`mcporter generate-cli`](cli-generator.md) turns any MCP server into a ready-to-run CLI with embedded schemas, optional Rolldown/Bun bundling, and Bun-compiled binaries.
- **Typed clients.** [`mcporter emit-ts`](emit-ts.md) emits `.d.ts` interfaces or a ready-to-run client wrapping `createServerProxy()` so agents call MCP tools with full TypeScript types.
- **Friendly composable API.** [`createServerProxy()`](tool-calling.md) maps tools to camelCase methods, applies JSON-schema defaults, validates required arguments, and returns a `CallResult` with `.text()`, `.markdown()`, `.json()`, `.images()`, `.content()` helpers.
- **Ad-hoc connections + auto-OAuth.** Point the CLI at any MCP endpoint (HTTP, SSE, stdio) without touching config. Hosted MCPs that need a browser login (Supabase, Vercel, etc.) are auto-detected — `mcporter auth <url>` promotes the definition to OAuth on the fly. See [Ad-hoc connections](adhoc.md).
- **MCP bridge for agents.** `mcporter serve` exposes daemon-managed keep-alive servers as one MCP server with namespaced `server__tool` tools, or as per-server HTTP paths that keep original tool names.
- **OAuth & stdio ergonomics.** Built-in OAuth caching, token refresh, log tailing, and stdio wrappers — same interface across HTTP, SSE, and stdio transports.

## Built for agents

mcporter is designed to be the layer between an MCP server and a coding agent. The pattern we recommend:

1. Configure the server once (or import from your editor of choice).
2. Run [`mcporter emit-ts <server>`](emit-ts.md) to get a `.d.ts` of the tool surface.
3. Wire small per-server [agent skills](agent-skills.md) instead of one mega-schema prompt — small prompts, named tools, no unrelated schemas loaded.
4. For shareable workflows, generate a standalone CLI with [`mcporter generate-cli`](cli-generator.md).

Because every transport flows through the same runtime, an agent that knows how to spawn `mcporter call` works with stdio servers, hosted HTTP MCPs, OAuth-gated services, and one-off URLs alike.

## Why a porter?

A _porter_ carries luggage between trains. mcporter does the same for MCP servers: it carries tool calls, schemas, OAuth tokens, and stdio handles between your agent (or your terminal) and whichever MCP server happens to be at the other end of the line. You don't have to know the shape of the server ahead of time, and the runtime keeps the connection warm so repeat calls are cheap.

## Where to next

Getting started:

- [Runtime overview](mcp.md) — the runtime, CLI entry points, and reusable helpers.
- [Architecture](spec.md) — runtime, proxy, and generation design notes.
- [Install](install.md) — npm, npx, Homebrew, or the standalone Bun-compiled binary.
- [Quickstart](quickstart.md) — your first list/call/resource in five minutes.
- [Migration guide](migration.md) — replace legacy `pnpm mcp:*` wrappers with mcporter.
- [Local dev](local.md) — run mcporter directly from the repo without npx.

Configuration:

- [Configuration](config.md) — `mcporter.json`, imports, env interpolation, OAuth.
- [Import reference](import.md) — external config formats and discovery paths.

Calling tools:

- [CLI reference](cli-reference.md) — every subcommand and flag.
- [Agent shortcuts](shortcuts.md) — compact discovery and help commands for agents.
- [Call syntax](call-syntax.md) — function-call and flag argument styles.
- [Call auto-correction](call-heuristic.md) — typo heuristics and suggestions.
- [Tool calling](tool-calling.md) — the `createServerProxy()` API and `CallResult` helpers.
- [Ad-hoc connections](adhoc.md) — point at any MCP endpoint without editing config.

Generation:

- [Generated CLIs](cli-generator.md) — standalone CLI generation, bundling, and regeneration.
- [Typed clients](emit-ts.md) — emit `.d.ts` types or typed client factories.

Hosting & diagnostics:

- [Daemon](daemon.md) — keep-alive daemon, `mcporter serve`, and agent isolation.
- [Logging and diagnostics](logging.md) — persistent daemon logs and focused tracing.
- [Record/replay](record-replay.md) — capture and replay MCP JSON-RPC traffic.
- [Hang debugging](hang-debug.md) — diagnose commands that never exit.
- [Manual testing](manual-testing.md) — tmux-based recipe for real-server checks.
- [tmux](tmux.md) — wrap long-running commands in tmux sessions.
- [Windows & WSL](windows.md) — NTFS/WSL tips for pnpm and test flows.

Testing & release:

- [Live integration tests](livetests.md) — opt-in validation against hosted MCP servers.
- [Known issues](known-issues.md) — hosted OAuth quirks, provider limitations, and upstream gaps.
- [Release](RELEASE.md) — versioning, artifacts, npm publish, GitHub release, and Homebrew tap.

For agents:

- [Agent skills](agent-skills.md) — exposing servers to agents the right way.
