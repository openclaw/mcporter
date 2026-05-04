---
summary: 'Where mcporter looks for external MCP configs and the formats each import kind understands.'
read_when:
  - 'Investigating missing imported servers'
  - 'Adding or modifying config import kinds'
---

# Import Reference

mcporter merges your local `config/mcporter.json` with editor- or tool-specific config files so you can reuse servers without copying them manually. This document spells out the supported formats, the directories we scan for each import kind, and how precedence works.

## Import Pipeline

1. `config/mcporter.json` is loaded first (or the file passed to `--config`). If it includes an `"imports"` array, that array defines the exact order we follow. If the array is omitted, we use the default order `["cursor", "claude-code", "claude-desktop", "codex", "windsurf", "opencode", "vscode"]`.
2. For each import kind, we probe the project-relative path (e.g., `.cursor/mcp.json`) and then the per-user path. The first readable file is parsed and converted into mcporter’s normalized schema. Names collide on a “first wins” basis—once an imported name is merged, later imports with the same name are ignored unless the local config defines an override.
3. Finally, any servers declared inside `mcpServers` take precedence over imports regardless of the order above.

Set `"imports": []` when you want to disable auto-merging entirely, or supply a subset (for example `["cursor", "codex"]`) to reduce the latency of `mcporter list`.

## Supported Formats

- **JSON containers**: Cursor, Claude Code, Windsurf, and VS Code configs use JSON. We accept three shapes:
  - Root-level dictionary where each key is a server (`{ "my-server": { ... } }`).
  - `{ "mcpServers": { ... } }` (Cursor-style).
  - `{ "servers": { ... } }` (older VS Code previews).
- **TOML container**: Codex uses TOML files with `[mcp_servers.<name>]` tables. Only `.codex/config.toml` is recognized.
- **Shared fields**: We convert JSON/TOML entries into mcporter’s schema, honoring `baseUrl`, `command` (string or array), `args`, `headers`, `env`, `bearerToken`, `bearerTokenEnv`, `description`, `tokenCacheDir`, `clientName`, `oauthClientId`, `oauthClientSecretEnv`, `oauthTokenEndpointAuthMethod`, and `auth`. Extra properties are ignored.

## Import Support Matrix

| Kind             | Typical owner         | Format                                        | Project paths                                                              | User paths                                                                                                                                                                                          | Notes                                                                                                                                  |
| ---------------- | --------------------- | --------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `cursor`         | Cursor IDE            | JSON (`mcpServers`)                           | `.cursor/mcp.json`                                                         | macOS/Linux: `${XDG_CONFIG_HOME:-~/.config}/Cursor/User/mcp.json`<br>Windows: `%APPDATA%/Cursor/User/mcp.json`                                                                                      | Mirrors Cursor’s “MCP Servers” panel. Per-workspace files override the global file when both exist.                                    |
| `claude-code`    | Claude Code (browser) | JSON (`mcpServers`)                           | `.claude/settings.local.json`, `.claude/settings.json`, `.claude/mcp.json` | `~/.claude/settings.json`, `~/.claude/mcp.json`, `~/.claude.json`                                                                                                                                   | `settings.local.json` (ignored by git) overrides `settings.json`, which is the shared project config; both beat the legacy `mcp.json`. |
| `claude-desktop` | Claude Desktop        | JSON (`mcpServers`)                           | —                                                                          | macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`<br>Windows: `%APPDATA%/Claude/claude_desktop_config.json`<br>Linux: `~/.config/Claude/claude_desktop_config.json`          | Desktop Claude stores all servers per-machine, so there’s no project-relative file.                                                    |
| `codex`          | Sweetistics Codex     | TOML (`[mcp_servers.*]`)                      | `.codex/config.toml`                                                       | `~/.codex/config.toml`                                                                                                                                                                              | Only `config.toml` is recognized; the deprecated `mcp.toml` filename is ignored.                                                       |
| `windsurf`       | Codeium Windsurf      | JSON (`mcpServers`)                           | —                                                                          | Windows: `%APPDATA%/Codeium/windsurf/mcp_config.json`<br>macOS/Linux: `~/.codeium/windsurf/mcp_config.json`                                                                                         | Global-only config managed by Codeium.                                                                                                 |
| `opencode`       | OpenCode              | JSON/JSONC (`mcp`, `mcpServers`, or root map) | `opencode.json`, `opencode.jsonc`                                          | `OPENCODE_CONFIG` override<br>`OPENCODE_CONFIG_DIR/opencode.json(c)`<br>macOS/Linux: `${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.json(c)`<br>Windows: `%APPDATA%/opencode/opencode.json(c)`    | Accepts comment-friendly `.jsonc` files and honors OpenCode’s precedence env vars.                                                     |
| `vscode`         | VS Code MCP extension | JSON (`mcpServers` or `servers`)              | —                                                                          | macOS: `~/Library/Application Support/Code(/Code - Insiders)/User/mcp.json`<br>Windows: `%APPDATA%/Code(/Code - Insiders)/User/mcp.json`<br>Linux: `~/.config/Code(/Code - Insiders)/User/mcp.json` | We probe both Stable and Insiders directories; the first readable file wins.                                                           |

> Tip: mcporter resolves `~` and `$XDG_CONFIG_HOME` inside these paths automatically, so you can rely on the same `imports` list across platforms.
>
> Claude tip: keep shared servers in `.claude/settings.json` and stash personal tweaks or credentials in `.claude/settings.local.json`, which Claude auto-ignores in git.

## Default Order & Overrides

- When `config/mcporter.json` omits the `"imports"` key, we load imports in this order: `["cursor", "claude-code", "claude-desktop", "codex", "windsurf", "opencode", "vscode"]`.
- If you set a non-empty `"imports"` array, mcporter appends any missing defaults after your list, so shared presets stay available without extra JSON churn.
- Set `"imports": []` to disable auto-merging entirely (handy for CI or projects that want deterministic configs).

## Verifying & Troubleshooting

- Run `mcporter list --source import --json` (or pipe through `rg '"source":'`) to confirm the resolved file for each imported server.
- Use `mcporter list --source import` to limit the output to merged definitions when you’re debugging precedence or verifying first-wins behavior.
- If a server is defined in multiple tools (e.g., Cursor and OpenCode), the first import in the list wins. Reorder `"imports"` or copy the entry locally via `mcporter config import <kind> --copy` to break ties.
- When debugging OpenCode, remember that `OPENCODE_CONFIG` beats every other path. Clearing or overriding that env var is often the fastest way to validate changes.
- When tests need deterministic data, follow `tests/config-imports.test.ts`—it copies fixtures into a fake home directory and asserts the merged server order. Mirror that pattern when adding new import kinds.

Keeping this reference up to date is the best way to prevent “my editor has servers but mcporter can’t see them” bug reports. If you add a new import kind, update this table, add fixtures under `tests/fixtures/imports`, and document the format here.
