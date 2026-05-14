---
summary: 'How to use mcporter’s ad-hoc HTTP/stdio flags to try MCP servers without editing config files.'
read_when:
  - 'Exploring or debugging unknown MCP endpoints'
---

# Ad-hoc MCP Servers

mcporter is gaining support for "just try it" workflows where you point the CLI at a raw MCP endpoint without first editing a config file. This doc tracks the behavior and heuristics we use to make that experience smooth while keeping the runtime predictable.

## Entry Points

Two new flag sets let you describe a server on the command line:

- `mcporter list --http-url https://mcp.linear.app/mcp [--name linear]`
- `mcporter call --stdio "bun run ./server.ts" --name local-tools`

You can also pass a bare URL as the selector (`mcporter list https://mcp.linear.app/mcp`) or embed the URL in a `call` expression (`mcporter call 'https://mcp.example.com/tools.generate({ topic: "release" })'`).

- Add `--json` to `mcporter list …` when you need a machine-readable summary of status counts and per-server failures, use `--output json`/`--output raw` with `mcporter call` to receive structured `{ server, tool, issue }` envelopes whenever a transport error occurs, and run `mcporter auth … --json` to capture the same envelope if OAuth or transport setup fails.

### Example: HTTP ad-hoc workflow

```bash
# Inspect the server directly via URL (no config entry needed)
mcporter list 'https://mcp.sentry.dev/mcp?agent=1'

# Call a tool by repeating the same URL + tool suffix
mcporter call 'https://mcp.sentry.dev/mcp?agent=1.use_sentry(request: "yo whats up")'
```

Notice that the second command repeats the URL. Ad-hoc definitions are ephemeral unless you pass `--persist`, so there is no stored server named `mcp-sentry-dev-mcp` yet. Reusing the printed slug only works after you persist the definition (see "Naming & Identity" below) or add the server to your config; otherwise keep passing the URL/stdio selector each time.

## Transport Detection

- **HTTP(S)**: Providing a URL defaults to the streamable HTTP transport. `https://` works out of the box; `http://` requires `--allow-http` (or the hidden alias `--insecure`) to acknowledge cleartext traffic. The `--sse` flag is a hidden alias for `--http-url` to match older examples. Use repeatable `--header KEY=value` flags for private servers that require headers such as `Authorization`, `X-API-Key`, or tenant selectors.
- **STDIO**: Supplying `--stdio` (with a command string) or `--stdio-bin` (binary + args) selects the stdio transport. Your current shell environment is inherited automatically; use `--env KEY=value` only when you need to inject/override specific variables (and `--cwd` to change directories).
- **Conflict guard**: Passing both URL and stdio flags errors out so we don’t guess.

## Naming & Identity

- `--name` wins when provided.
- Otherwise we derive a slug:
  - HTTP: `<host>` plus a sanitized path fragment (e.g. `mcp-linear-app-mcp`).
  - STDIO: executable basename + script (`node-singlestep`).
- Until you persist the definition (via `--persist`, `mcporter config add`, etc.), the slug is **only** used as the cache key for OAuth tokens/log prefs—you still need to supply the ad-hoc descriptor (`--http-url`, `--stdio`, or bare URL) every time you invoke `mcporter list|call|auth`.
- Once persisted, the slug becomes a normal server name so `mcporter call <slug>.tool` and `mcporter auth <slug>` work just like any other configured entry.
- If you don’t persist the definition, run `mcporter auth https://mcp.linear.app/mcp` (or supply `--name linear` so `mcporter auth linear` also works) to finish OAuth with the same settings.

This name becomes the cache key for OAuth tokens and log preferences, so repeated ad-hoc calls still benefit from credential reuse.

## OAuth Auto-Detection

Many hosted MCP servers (Supabase, Vercel, etc.) advertise OAuth capabilities but expect clients to discover this dynamically. When an ad-hoc HTTP server responds with `401/403` during the initial handshake, mcporter now:

1. **Promotes the definition to OAuth** and spins up the default browser flow—no need to edit config or supply `auth: "oauth"` manually. On headless hosts, pass `--no-browser` (or `--browser none`) to print the authorization URL instead of launching the platform browser.
2. **Persists the change** whenever you pass `--persist`, so future runs remember that the endpoint requires OAuth without repeating the detection step.

The CLI still avoids surprise prompts during `mcporter list`; the upgrade happens the first time you run `mcporter auth <url>` or any other command that allows OAuth (i.e., not in `--autoAuthorize=false` mode).

## Auth & Persistence

- OAuth flows are allowed; successful tokens store under the inferred name just like regular definitions.
- `mcporter auth` accepts the same `--http-url/--stdio` flags (and even bare URLs), so you can immediately re-run `mcporter auth https://…` after a 401 without touching a config file.
- Use `mcporter auth <url> --no-browser` for human-in-the-loop headless OAuth. Text mode writes only the authorization URL to stdout; `--json --no-browser` writes `authorizationUrl` plus `redirectUrl` as JSON. Keep that URL out of durable CI logs and support bundles.
- When opening the URL on a different machine, remember that loopback redirect URLs point at the browser machine unless an SSH tunnel forwards the callback port back to the mcporter process. Use `oauthRedirectUrl` when you need a predictable callback port.
- Nothing is written to disk unless you pass `--persist /path/to/config.json`. When set, we merge the generated definition into that file (creating it if necessary) so future runs can rely on the standard config pipeline. Ad-hoc HTTP headers are persisted with the entry, so placeholders such as `--header 'Authorization=$env:MY_TOKEN'` keep working through the normal config header resolver.

## Safety Nets

- Non-HTTPS endpoints require `--allow-http`.
- For stdio commands we print a confirmation snippet the first time we see a new command unless `--yes` is present.
- Missing transports or malformed combinations throw descriptive errors, pointing to `docs/adhoc.md` for guidance.

## Follow-ups

- Extend `mcporter config add` to leverage the same helper, making it the one-stop path from exploration to permanence.
- Consider caching inference results so repeated URL calls automatically rehydrate the previous settings (env/cwd).
