---
summary: 'How to expose mcporter-backed MCP servers to agents through small per-server skills.'
read_when:
  - 'Writing agent skill docs or wiring mcporter into an agent runtime'
  - 'Triaging requests for a generic mcporter skill'
---

# Agent Skill Pattern

Prefer one small skill per MCP server or workflow instead of a single generic
`mcporter` skill. A focused skill keeps the agent prompt small, names the useful
tools directly, and avoids loading schemas for servers that are irrelevant to the
current task.

## Recommended Flow

1. Add or import the MCP server:

   ```bash
   npx mcporter config add docs https://mcp.context7.com/mcp --scope home
   ```

2. Inspect the tool surface:

   ```bash
   npx mcporter list docs --brief
   npx mcporter list docs --schema
   ```

3. Write a skill that calls only the relevant tools via `mcporter call`:

   ```markdown
   ---
   name: docs-mcp
   description: Fetch package and framework docs through the configured docs MCP server.
   ---

   # Docs MCP

   Use `npx mcporter call docs.resolve-library-id libraryName=<name>` to resolve
   a package, then call `npx mcporter call docs.get-library-docs ...` with the
   resolved ID and optional topic.
   ```

4. For repeated or shareable workflows, generate a dedicated CLI instead of
   teaching the agent raw `mcporter call` syntax:

   ```bash
   npx mcporter generate-cli docs --bundle dist/docs-mcp.js
   ```

## Why Not One Generic Skill?

A generic skill has to teach the agent how to discover, choose, and call every
configured server. That recreates the large-schema context problem MCPorter is
trying to avoid. Per-server skills stay small and let the skill author describe
the safe, useful workflows for that server.

Use `allowedTools` or `blockedTools` in `mcporter.json` when a server exposes
tools that should not be shown to agents.
