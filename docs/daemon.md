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

## Chrome DevTools without repeated approval dialogs

`chrome-devtools-mcp --autoConnect` uses Chrome's remote-debugging handshake, which can display an “Allow remote debugging?” dialog for each session. When the [OpenClaw Chrome extension relay](https://docs.openclaw.ai/tools/chrome-extension/) is paired on the same host, MCPorter probes its loopback endpoint and rewrites `--autoConnect` to the relay's authenticated WebSocket endpoint.

The rewrite is best-effort. If the host-local relay secret is missing, the relay is unavailable or unpaired, or the endpoint is not loopback-only, MCPorter keeps the original arguments. Set `MCPORTER_DISABLE_CHROME_DEVTOOLS_RELAY=1` to disable relay detection. Set `MCPORTER_CHROME_DEVTOOLS_RELAY_URL` only to another loopback HTTP endpoint.

MCPorter also applies its Chrome DevTools auto-connect compatibility patch when relevant. Set `MCPORTER_DISABLE_CHROME_DEVTOOLS_COMPAT=1` to disable that separate behavior.

## Logging and shutdown

Use `mcporter daemon start --log` or `mcporter daemon restart --log` to keep a daemon log. `--log-file <path>` chooses the destination, and `--log-servers <csv>` limits per-call traces. The [logging guide](logging.md) covers environment and per-server controls.

The daemon closes managed transports on `stop`. A top-level `daemonIdleTimeoutMs` can shut down an inactive daemon, while a keep-alive lifecycle object can set an idle timeout for one server. See [configuration](config.md) for both forms.
