---
summary: 'How mcporter negotiates modern and legacy MCP revisions and handles interactive requests.'
read_when:
  - 'Investigating protocol negotiation, elicitation, or modern-versus-legacy behavior'
---

# Protocols and interactive requests

MCPorter uses one runtime surface for modern and legacy Model Context Protocol servers. The transport selects the protocol era for each connection; callers keep using the same list, call, resource, and proxy APIs.

## Negotiation

The default `auto` mode probes for the `2026-07-28` revision and falls back to the legacy initialization flow when necessary. A stdio server that exits during the modern probe is started again in legacy mode. HTTP connections try Streamable HTTP first and retain legacy SSE compatibility.

Set `protocolVersion` when a deployment needs a fixed policy:

```jsonc
{
  "mcpServers": {
    "automatic": { "url": "https://example.com/mcp" },
    "modern": { "url": "https://example.com/mcp", "protocolVersion": "2026-07-28" },
    "legacy": { "url": "https://example.com/mcp", "protocolVersion": "legacy" },
  },
}
```

`auto` is the implicit default. A pinned modern connection fails instead of masking a negotiation error with a legacy retry. `mcporter list <server> --verbose` reports the negotiated revision and era.

## Interactive requests

Both protocol eras can ask the client for more input during a tool call. Legacy connections use MCP elicitation requests; modern servers can also return an `input_required` result that continues through the same handler.

In an interactive terminal, MCPorter:

- identifies the server making the request;
- prompts for supported form fields or displays a URL to open;
- strips terminal control sequences from server-supplied prompt text;
- passes the accepted or declined response back to the server.

Non-interactive calls decline the request and print a hint to rerun the tool in a terminal. Programmatic callers can pass an `elicitationHandler` to `createRuntime()`; the callback receives the request and `{ server }`, so applications can apply server-specific policy.

Daemon-managed calls also decline interactive requests because the daemon socket does not carry a prompt back to the calling terminal. Mark that server `"lifecycle": "ephemeral"` when a tool must prompt during the call.

## Bridge behavior

`mcporter serve` exposes configured keep-alive servers to other MCP clients over stdio or Streamable HTTP. The aggregate endpoint namespaces tools as `server__tool`; `/mcp/<server>` keeps the selected server's original tool names. The bridge accepts modern and legacy downstream clients, but it does not forward upstream interactive prompts.

See [the daemon guide](daemon.md) for lifecycle and bridge setup.

## Verification surface

The repository includes deterministic fixture servers for [modern](https://github.com/openclaw/mcporter/tree/main/tests/servers/modern) and [legacy](https://github.com/openclaw/mcporter/tree/main/tests/servers/legacy) revisions. CI exercises representative fixture paths end-to-end over stdio and Streamable HTTP, including negotiation, tools, resources, elicitation, and selected modern cache and subscription behavior. Opt-in [live tests](livetests.md) cover public hosted servers separately.

Recordings preserve the negotiation exchange and can replay either generation. See [record and replay](record-replay.md) for the compatibility and redaction rules.
