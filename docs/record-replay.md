---
summary: 'How to record MCP JSON-RPC traffic to NDJSON and replay it deterministically for offline debugging.'
read_when:
  - 'Debugging or reproducing MCP-backed tool calls without contacting the live server.'
---

# Record and replay MCP calls

`mcporter record` captures the JSON-RPC traffic between the runtime and configured MCP servers. `mcporter replay` reads the captured stream and serves the recorded responses back to the same requests without contacting the live MCP server.

Recordings live under `~/.mcporter/recordings/` as newline-delimited JSON:

```bash
mcporter record demo-session -- mcporter call linear.list_issues limit:5
mcporter replay demo-session -- mcporter call linear.list_issues limit:5
```

To record or replay a later command, create the session configuration and export the matching environment variable:

```bash
mcporter record demo-session
MCPORTER_RECORD=demo-session mcporter call linear.list_issues limit:5

mcporter replay demo-session
MCPORTER_REPLAY=demo-session mcporter call linear.list_issues limit:5
```

Use `--server` when you only want one server's traffic:

```bash
mcporter record demo-session --server linear -- mcporter call linear.list_issues limit:5
mcporter replay demo-session --server linear -- mcporter call linear.list_issues limit:5
```

## File format

Each line is one JSON-RPC envelope with an added `_meta` object:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_issues","arguments":{"limit":5}},"_meta":{"dir":"send","server":"linear","ts":"2026-05-16T12:00:00.000Z"}}
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"..."}]},"_meta":{"dir":"recv","server":"linear","ts":"2026-05-16T12:00:00.100Z"}}
```

`_meta.dir` is `send`, `recv`, or `lifecycle`. Replay strips `_meta` before delivering a response. Lifecycle events such as transport start and close are recorded for diagnostics but ignored during replay.

## Deterministic matching

Replay is strict. For each server, mcporter expects requests to arrive in the same order with the same JSON-RPC method and deeply equal `params`. If the next request differs, replay fails with an error that names the incoming request and the next recorded request it expected.

This makes recordings useful as reproducible bug fixtures: a replay either follows the captured MCP exchange exactly or fails at the first point where the workflow diverges.
