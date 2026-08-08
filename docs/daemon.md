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

MCPorter requires an OpenClaw relay that implements **Browser Relay Authentication v2**, including the connection-bound challenge, completion, authenticated `/json/version`, and same-connection `/cdp` upgrade sequence. An older OpenClaw relay is unsupported: `require` fails with `unsupported-auth`, while `prefer` may launch the original Chrome `--autoConnect` path. MCPorter never retries an old Bearer, Basic, or raw-token relay handshake, even when the v2 endpoint returns `404`, `401`, or `426`, a proof fails, or the handshake times out. During OpenClaw's dual-stack migration window, legacy acceptance exists only for older clients; current MCPorter always uses v2.

The mode-`0600`, current-user relay key never enters an HTTP header, URL, WebSocket subprotocol, application frame, child command line, or child environment. MCPorter derives its non-secret `keyId`, connects once to a numeric loopback address, verifies the connected peer, and keeps that exact raw TCP socket from the HMAC challenge through completion, `/json/version`, and the `/cdp` WebSocket upgrade. It does not follow redirects, reconnect, re-resolve, or hand the key to the proxy. Only after both server proofs verify does MCPorter start a short-lived downstream proxy bound strictly to `127.0.0.1`; that proxy wraps the already-authenticated and already-upgraded socket rather than opening another upstream connection.

The same raw client supports the protocol's separate `json-list` flow: it authenticates one `/json/list` request on the retained socket, reads a bounded response, and closes instead of upgrading.

Each downstream proxy retains the protections introduced for the child handoff: it gets a fresh 256-bit authorization bearer, MCPorter writes that ephemeral value to an exclusively created mode-`0600` file inside a mode-`0700` temporary directory, and only the protected file path reaches a Node preload through the child environment. The preload validates and consumes the file, removes the handoff variable, and appends `--wsHeaders` only to JavaScript's `process.argv`; the OS command line contains only the credential-free loopback WebSocket endpoint. The proxy accepts exactly one authorized downstream WebSocket, synthesizes that child's `101` response, and then bridges frames to the retained upstream socket. Losing either side retires the proxy and its authenticated connection.

The preload composes with existing `NODE_OPTIONS`, including MCPorter's separate Chrome compatibility preload. The proxy, handoff file, preload, and temporary directory are closed or removed on normal shutdown, setup failure, abort, and negotiation retry. On POSIX systems, ownership and permissions are checked before the handoff is consumed. On Windows, MCPorter creates the temporary directory atomically with a verified current-user-only ACL before its path exists; setup fails closed if that security descriptor cannot be established. Plaintext relay URLs remain limited to loopback, including custom URLs set with `MCPORTER_CHROME_DEVTOOLS_RELAY_URL`; remote HTTP relay targets and URLs containing credentials are rejected.

Choose routing with `chromeDevtoolsRelay` (or `chrome_devtools_relay`) on the server definition, or override it for the process with `MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY`:

- `prefer` is the default. It uses the v2 extension relay when authentication and the protected child handoff succeed; otherwise it may keep only the original Chrome `--autoConnect` behavior. It never falls back to legacy relay authentication.
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

Keep-alive daemons include the effective policy, URL, timeout, state directory, credential directory, v2 protocol marker, and derived `keyId` in their runtime identity. Rotating the key at the same path therefore replaces stale daemon state on the next operation without exposing key material; no manual restart is required. `mcporter daemon status` shows the current or last redacted decision with route, policy, reason, safe logical upstream endpoint, and probe status/duration. Set `MCPORTER_LOG_LEVEL=info` to see the same structured decision during ordinary connection setup. Diagnostics distinguish unsupported v2 authentication, bad server proofs, unauthenticated server failures, replay, protocol, freshness, and sequence failures, disconnected extensions (an authenticated `503`), timeouts, network errors, protected handoff failures, and success. They never print keys, proofs, nonces, stable or ephemeral bearers, handoff paths, headers, pairing strings, or child arguments.

MCPorter also applies its Chrome DevTools auto-connect compatibility patch when relevant. Set `MCPORTER_DISABLE_CHROME_DEVTOOLS_COMPAT=1` to disable that separate behavior.

## Logging and shutdown

Use `mcporter daemon start --log` or `mcporter daemon restart --log` to keep a daemon log. `--log-file <path>` chooses the destination, and `--log-servers <csv>` limits per-call traces. The [logging guide](logging.md) covers environment and per-server controls.

The daemon closes managed transports on `stop`. A top-level `daemonIdleTimeoutMs` can shut down an inactive daemon, while a keep-alive lifecycle object can set an idle timeout for one server. See [configuration](config.md) for both forms.
