---
summary: 'How to migrate from pnpm mcp:* wrappers to the mcporter package.'
---

# Migration Guide

This guide walks through replacing the Python-based `pnpm mcp:*` helpers with the new TypeScript runtime and CLI.

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
- Append `--tail-log` to stream the last 20 lines of any log file returned by the tool.

## 3. OAuth Tokens

- Tokens are saved in the shared vault under `~/.mcporter/credentials.json` by default, or `$XDG_DATA_HOME/mcporter/credentials.json` when `XDG_DATA_HOME` is set.
- To force a fresh login, delete that directory and rerun the command; the CLI will relaunch the browser.
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

Use `callOnce` for fire-and-forget invocations.

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

For deeper architectural notes and future work, see [`docs/spec.md`](./spec.md).
