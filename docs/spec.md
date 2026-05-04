---
summary: 'Plan for the mcporter package replacing the Sweetistics pnpm MCP helpers.'
---

# mcporter Roadmap

> Inspired in part by Anthropic’s guidance on MCP code execution agents: https://www.anthropic.com/engineering/code-execution-with-mcp

## Goals

- Provide a TypeScript runtime + CLI that exposes all MCP servers defined in `~/Projects/sweetistics/config/mcporter.json`.
- Preserve current one-shot `pnpm mcporter:call` ergonomics while enabling reusable connections for Bun/Node agents.
- Keep feature parity with the Python helper (env interpolation, stdio wrapping, OAuth caching) and extend test coverage.

## Deliverables

- `packages/mcporter` (standalone npm package) exporting:
  - `createRuntime()` for shared connections (list/call tools, resolve resources).
  - `callOnce()` convenience matching today’s single-call flow.
  - Typed utilities for env/header resolution and stdio command execution.
- CLI entry point (`npx mcporter list|call`) built on the same runtime with configurable log levels (`--log-level` flag, `MCPORTER_LOG_LEVEL` env) defaulting to `warn`. Single-server listings must render as TypeScript-style headers: dimmed `/** ... */` doc blocks followed by `function name(...)` signatures, inferred return annotations when schemas expose a `title`, inline enum/format hints, and an optional-parameter summary (`// optional (N): a, b, ...`). Optional fields are hidden by default (unless there are ≤2 of them and <4 required parameters) and the CLI should tell users to run `--all-parameters` whenever anything is suppressed. The CLI should also infer the verb when users omit it: bare server names run `list <server>` (with the same typo-friendly heuristic used by `mcporter list`), while dotted tokens such as `linear.list_issues` dispatch to `call` automatically. Anonymous HTTP MCP servers (e.g., shadcn) must be auto-detected: if an ad-hoc URL returns MCP-shaped JSON even with a non-200 status, mcporter treats it as authenticated instead of launching the OAuth flow. Likewise, `call` must recognise HTTP selectors that inline the tool name (e.g., `https://www.shadcn.io/api/mcp.getComponent(...)`), strip the `.tool` suffix to derive the base server, parse any function-call arguments, and reuse an existing definition when the base URL matches a configured server. Selectors may omit the protocol entirely—we assume HTTPS when no scheme is present and treat hosts that only differ by a leading `www.` as identical for reuse purposes. See [docs/cli-reference.md](./cli-reference.md) for day-to-day usage/flag details.
- CLI generator (`npx mcporter generate-cli`) that emits standalone CLIs (plain TypeScript or bundled JS) with embedded schemas and Commander-based subcommands, targeting Node or Bun.
- CLI generator (`npx mcporter generate-cli`) that emits standalone CLIs (plain TypeScript or bundled JS) with embedded schemas and Commander-based subcommands, targeting Node or Bun. It must accept server references by name (positional), JSON, HTTP URL (with optional `.tool` suffix / missing scheme), or inline stdio commands (split into `command` + `args` so invocations like `--command "npx -y chrome-devtools-mcp@latest"` or positional equivalents work without a config entry) just like the main CLI.
- Test harness using the Sweetistics MCP fixtures to validate every configured server definition.
- Documentation: README, usage examples, migration guide for replacing `pnpm mcp:*`.

## Architecture Notes

- Load MCP definitions from JSON (support relative paths + HTTPS).
- Reuse `@modelcontextprotocol/sdk` transports; invoke stdio servers directly (e.g., call `npx` with env overrides) without an extra wrapper script.
- Automatically detect OAuth requirements for ad-hoc HTTP servers by retrying failed handshakes and promoting the definition to `auth: "oauth"` when a 401/403 is encountered, then launching the browser flow immediately.
- Mirror Python helper behavior:
  - `${VAR}`, `${VAR:-default}`, `$env:VAR` interpolation.
- Optional OAuth token cache directory handling (defaulting to `~/.mcporter/<server>` when none is provided, or XDG paths when configured).
  - Tool signature + schema fetching for `list`.
- Provide lazy connection pooling per server to minimize startup cost.
- Expose a lightweight server proxy (`createServerProxy`) that maps camelCase method accesses to tool names, fills JSON-schema defaults, validates required arguments, and returns a helper (`CallResult`) for extracting text/markdown/JSON without re-parsing the content envelope.
- Document Cursor-compatible `config/mcporter.json` structure; support env-sourced headers and stdio commands while keeping inline overrides available for scripts.

## Schema-Aware Proxy Strategy

- Cache tool schemas on first access, persist them under `~/.mcporter/<server>/schema.json` or `$XDG_CACHE_HOME/mcporter/<server>/schema.json` for reuse across processes, and tolerate failures by falling back to raw `callTool`.
- Allow direct method-style invocations such as `context7.getLibraryDocs("react")` by:
  - Mapping camelCase properties to kebab-case tool names.
  - Detecting positional arguments and assigning them to required schema fields in order.
  - Handling multi-argument tools (e.g., Firecrawl’s `scrape`/`map`) via positional arrays, plain objects, or mixed option bags.
  - Merging JSON-schema defaults and validating required fields before dispatch.
- Return `CallResult` objects exposing `.raw`, `.text()`, `.markdown()`, `.json()` helpers for consistent post-processing.
- Keep implementation generic—no hardcoded knowledge of specific servers—so new MCP servers automatically gain the ergonomic API.
- Encourage lightweight composition helpers in examples (e.g., resolving then fetching Context7 docs) while keeping library exports generic.
- Back the proxy with targeted unit tests that cover primitive-only calls, positional tuples + option bags, and error fallbacks when schemas are missing.

## Standalone CLI Generation

- `generate-cli` should accept inline JSON, file paths, inline stdio commands (either via `--command` or as the first positional argument), or existing config names and produce a ready-to-run CLI that maps tools to Commander subcommands.
- Embed schemas (via `listTools { includeSchema: true }`) directly in the generated source so repeat executions avoid additional metadata calls.
- Support optional bundling through esbuild, producing Node-friendly `.cjs` files or Bun-ready `.js` binaries with executable shebangs.
- Surface flags for output path, runtime target (`node` or `bun`), bundle destination, and per-call timeout (default 30s).
- Add integration tests asserting the generated CLI can list tools, execute with positional/flag arguments, and hydrate cache files without additional list calls.

## Configuration

- Single file `config/mcporter.json` mirrors Cursor/Claude schema: `mcpServers` map with entries containing `baseUrl` or `command`+`args`, optional `headers`, `env`, `description`, `auth`, `tokenCacheDir`, and convenience `bearerToken`/`bearerTokenEnv` fields.
- Optional `imports` array (defaulting to ['cursor', 'claude-code', 'claude-desktop', 'codex', 'windsurf', 'vscode']) controls auto-merging of editor configs; entries earlier in the list win conflicts while local definitions can still override.
- Provide `configPath` override for scripts/tests; keep inline overrides in examples for completeness but default to file-based configuration.
- Add fixtures validating HTTP vs. stdio normalization, header/env behavior, and editor config imports (Cursor, Claude Code/Desktop, Codex, Windsurf, VS Code) to ensure priority ordering matches defaults.

## Work Phases

1. **Scaffold Package**
   - Init pnpm workspace config, tsconfig, lint/test scaffolding, build script.
2. **Core Runtime**
   - Port config parsing + env/header logic.
   - Implement connection cache, tool invocation, resource helpers.
3. **CLI Surface**

- Implement `list` (with optional schema) and `call` commands.
- Render tool metadata as pseudo-TypeScript declarations: blue `function` signatures, grey doc comments using `@param` lines, inferred return names, and compact optional summaries that collapse longer lists until users pass `--all-parameters`. The default view must still surface at least five parameters (even if they’re optional) before summarising the remainder.
- Ensure output parity with existing helper.
- `call` has to parse both `server.tool` tokens and HTTP selectors like `https://host/path.tool(args)`; in the HTTP case we need to peel off the `.tool` suffix, infer/auto-register the ad-hoc server (respecting `--allow-http`), and hydrate arguments from parentheses or trailing `key=value` pairs.
- Add `generate-cli` for standalone/bundled CLIs with embedded schema caching.
- Ensure `generate-cli`, `inspect-cli`, and `emit-ts` share the same server-resolution logic as `list/call`, including HTTP URL matching and scheme-less selectors with `.tool` suffixes.

4. **Testing & Fixtures**
   - Mock representative MCP servers (stdio + HTTP + OAuth) for integration tests.
   - Snapshot output for `list` vs. `call`.
5. **Docs & Migration**
   - Write README + migration doc.
   - Update Sweetistics docs to point to the new package.

## Open Questions

- How aggressively should we parallelize list calls? Current helper serializes to avoid load.
- Should we bundle a minimal REPL for ad-hoc debugging, or keep CLI focused on list/call?
- Do we expose streaming/async iterator interfaces for tools returning logs?
- What UX do we provide for completing OAuth browser flows (automated callback server vs. copy/paste codes)?
