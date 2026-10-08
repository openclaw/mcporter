---
summary: 'How to migrate from pnpm mcp:* wrappers to the mcporter package.'
read_when:
  - 'Helping teammates migrate old pnpm workflows to mcporter'
---

# Migration Guide

This guide covers replacing the older `pnpm mcp:*` helpers with the TypeScript runtime and CLI.

## 1. Install

```bash
pnpm add mcporter
# or
yarn add mcporter
# or
npm install mcporter
```

## 2. Update Scripts

- Replace `pnpm mcporter:list` with `npx mcporter list`.
- Replace `pnpm mcporter:call <server>.<tool> key=value` with `npx mcporter call <server>.<tool> key=value`.
- Add `--config <path>` if your configuration is not under `./config/mcporter.json`.
- Optional: set `"imports"` inside `mcporter.json` (for example `[]` to disable auto-imports or `["cursor", "codex"]` to customize the order).
- Append `--tail-log` to print up to the last 20 lines from the final 1 MiB of a regular log file returned by the tool.

## 3. OAuth Tokens

- Tokens are saved in the shared vault under `~/.mcporter/credentials.json` by default, or `$XDG_DATA_HOME/mcporter/credentials.json` when `XDG_DATA_HOME` is set, with secret values encrypted when `MCPORTER_VAULT_PASSWORD` is set ([Vault Encryption](config.md#vault-encryption)).
- To force a fresh login for one server, run `mcporter auth <server> --reset`. This clears its recognized credentials without deleting unrelated files or other servers' vault entries.
- Custom `token_cache_dir` entries in `mcporter.json` continue to work as explicit overrides.

## 4. Programmatic Usage

```ts
import { createRuntime } from 'mcporter';

const runtime = await createRuntime({ configPath: './config/mcporter.json' });
const tools = await runtime.listTools('chrome-devtools');
await runtime.callTool('chrome-devtools', 'take_screenshot', { args: { url: 'https://x.com' } });
await runtime.close();
```

Prefer `createRuntime` for long-lived agents so connections and OAuth tokens can be reused.

## 5. Single Call Helper

```ts
import { callOnce } from 'mcporter';

await callOnce({
  server: 'firecrawl',
  toolName: 'crawl',
  args: { url: 'https://anthropic.com' },
});
```

Use `callOnce` for a single call with automatic connection cleanup.

## 6. Environment Variables

- `LINEAR_API_KEY`, `FIRECRAWL_API_KEY`, and similar tokens are read exactly as before via `${VAR}` syntax.
- `${VAR:-default}` continues to work; empty values are ignored.
- `$env:VAR` placeholders resolve to raw OS environment variables.

## 7. Troubleshooting

| Symptom              | Fix                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------- |
| Browser did not open | Copy the printed OAuth URL manually into a browser.                                      |
| Authorization hangs  | Ensure the callback URL can bind to `127.0.0.1`; firewalls may block it.                 |
| Tokens are stale     | Run `mcporter auth --reset <server>` or delete the matching vault entry/cache and retry. |
| Stdio command fails  | Pass `--root` to point at the repo root so relative paths resolve.                       |

---

For an overview of the current architecture, see [`docs/mcp.md`](./mcp.md).
