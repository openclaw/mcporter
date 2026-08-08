---
summary: 'How mcporter keeps stateful MCP servers warm and exposes them through its bridge.'
read_when:
  - 'Configuring keep-alive servers, the daemon, serve mode, or Chrome DevTools'
---

# Keep-alive daemon

MCPorter can keep stateful stdio servers alive across separate CLI invocations. A per-login daemon owns those transports, while the ordinary `mcporter list` and `mcporter call` commands route eligible servers through its local socket.

## Lifecycle selection

Chrome DevTools, Mobile MCP, Playwright MCP, and CloudBase MCP definitions default to keep-alive when MCPorter recognizes their configured name or stdio command. Other servers remain ephemeral unless their config opts in:

```jsonc
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest", "--autoConnect"],
      "lifecycle": "keep-alive",
    },
    "interactive": {
      "url": "https://example.com/mcp",
      "lifecycle": "ephemeral",
    },
  },
}
```

`MCPORTER_KEEPALIVE=name` opts named servers in. `MCPORTER_DISABLE_KEEPALIVE=name` opts them out; both variables accept comma-separated names or `*`. Explicit config remains the clearest choice for project-owned definitions.

Ad-hoc targets passed with `--stdio`, `--http-url`, or a URL selector are per-process. Persist the definition into config before expecting it to participate in the shared daemon.

## Daemon commands

```sh
mcporter daemon status
mcporter daemon start
mcporter daemon restart
mcporter daemon stop
```

Eligible servers start the daemon automatically when a list or call needs them. Use explicit commands to inspect, pre-warm, restart after configuration changes, or stop every managed transport.

Daemon calls are non-interactive. If a server requests elicitation, the call is declined with a hint to use an ephemeral terminal call instead. See [protocols and interactive requests](protocols.md).

The local socket timeout is an idle liveness budget rather than a cap on the whole operation. A current daemon emits progress frames while work is in flight, allowing interactive OAuth to run to its own deadline without causing a daemon restart or a duplicate browser prompt. Mixed versions remain compatible: a current client falls back to the previous flat deadline with an older daemon, while a current daemon sends the single-response format expected by older clients unless the caller explicitly opts into progress frames.

## Expose servers to another MCP client

`mcporter serve` turns the daemon's keep-alive servers back into an MCP server:

```sh
mcporter serve --stdio
mcporter serve --http 3000
mcporter serve --http 3000 --servers chrome-devtools,playwright
```

The stdio form is suitable for clients such as Claude Code and Codex. HTTP mode binds to `127.0.0.1` by default and serves an aggregate endpoint at `/mcp`, with namespaced tools such as `chrome-devtools__list_pages`. It also serves `/mcp/<server>` with that server's original tool names.

## Chrome DevTools through the OpenClaw extension relay

`chrome-devtools-mcp --autoConnect` uses Chrome's remote-debugging handshake, which can display an “Allow remote debugging?” dialog for each session. When the [OpenClaw Chrome extension relay](https://docs.openclaw.ai/tools/chrome-extension/) is paired on the same host, MCPorter can use that extension-backed Chrome control path instead. Automatic rewriting supports direct `chrome-devtools-mcp` commands and the standard `npx`/`bunx` launch forms used by MCPorter definitions. Other shell and package-manager wrappers remain unchanged under `prefer`; `require` rejects recognizable Chrome auto-connect commands behind those unsupported wrappers instead of silently launching the legacy path.

The stable relay bearer never enters the `chrome-devtools-mcp` command line or environment. MCPorter reads the mode-`0600`, current-user credential, probes the authenticated host-local relay, then starts a short-lived proxy bound strictly to `127.0.0.1`. Each proxy gets a fresh 256-bit authorization bearer. MCPorter writes that ephemeral value to an exclusively created mode-`0600` file inside a mode-`0700` temporary directory and passes only the protected file path to a Node preload through the child environment. The preload runs before the Chrome DevTools CLI, validates and consumes the file, removes the handoff variable, and appends `--wsHeaders` only to JavaScript's `process.argv`; the OS command line contains only the credential-free loopback WebSocket endpoint. The proxy accepts that ephemeral authorization and replaces it with the stable OpenClaw bearer upstream.

The preload composes with existing `NODE_OPTIONS`, including MCPorter's separate Chrome compatibility preload. The proxy, handoff file, preload, and temporary directory are closed or removed on normal shutdown, setup failure, abort, and negotiation retry. On POSIX systems, ownership and permissions are checked before the handoff is consumed. On Windows, MCPorter creates the temporary directory atomically with a verified current-user-only ACL before its path exists; setup fails closed if that security descriptor cannot be established. Plaintext relay URLs remain limited to loopback, including custom URLs set with `MCPORTER_CHROME_DEVTOOLS_RELAY_URL`; remote HTTP relay targets and URLs containing credentials are rejected.

Choose routing with `chromeDevtoolsRelay` (or `chrome_devtools_relay`) on the server definition, or override it for the process with `MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY`:

- `prefer` is the default. It uses the extension relay when the relay and protected child handoff are available and otherwise keeps the original legacy `--autoConnect` behavior.
- `require` fails before any legacy auto-connect process is launched if the endpoint, credential, probe, authentication, extension connection, local proxy, or protected handoff is unavailable. Retries remain fail-closed.
- `off` disables relay probing and rewriting. The older `MCPORTER_DISABLE_CHROME_DEVTOOLS_RELAY=1` switch remains an alias for `off`.

```jsonc
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest", "--autoConnect"],
      "lifecycle": "keep-alive",
      "chromeDevtoolsRelay": "require",
    },
  },
}
```

The authenticated `/json/version` probe waits 5 seconds by default. `MCPORTER_CHROME_DEVTOOLS_RELAY_TIMEOUT_MS` accepts milliseconds, clamped to 100–30000; unset, zero, non-integer, and otherwise invalid values use 5000. Credential discovery follows OpenClaw: `OPENCLAW_OAUTH_DIR` wins, otherwise credentials live under `OPENCLAW_STATE_DIR` (or `$OPENCLAW_HOME/.openclaw`) in `credentials/browser-extension-relay.secret`.

Keep-alive daemons include the effective policy, URL, timeout, state directory, and credential directory in their runtime identity. Changing any of them causes the next daemon-backed operation to replace stale state automatically; no manual restart is required. `mcporter daemon status` shows the current or last redacted decision with route, policy, reason, safe logical upstream endpoint, and probe status/duration. Set `MCPORTER_LOG_LEVEL=info` to see the same structured decision during ordinary connection setup. Diagnostics distinguish disabled routing, unsupported or ambiguous launcher commands, missing or invalid credentials, invalid endpoints, unauthorized responses, disconnected extensions (`503`), timeouts, network errors, invalid responses, protected handoff failures, and success without printing stable or ephemeral bearers, handoff paths, headers, pairing strings, or child arguments.

MCPorter also applies its Chrome DevTools auto-connect compatibility patch when relevant. Set `MCPORTER_DISABLE_CHROME_DEVTOOLS_COMPAT=1` to disable that separate behavior.

## Logging and shutdown

Use `mcporter daemon start --log` or `mcporter daemon restart --log` to keep a daemon log. `--log-file <path>` chooses the destination, and `--log-servers <csv>` limits per-call traces. The [logging guide](logging.md) covers environment and per-server controls.

The daemon closes managed transports on `stop`. A top-level `daemonIdleTimeoutMs` can shut down an inactive daemon, while a keep-alive lifecycle object can set an idle timeout for one server. See [configuration](config.md) for both forms.
