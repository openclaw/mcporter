# mcporter health

At-a-glance status check for every configured MCP server.

```bash
mcporter health                 # check all servers
mcporter health --server linear # check one
mcporter health --json          # machine-readable
mcporter health --timeout 5     # per-server timeout in seconds
```

Reports per-server status (ok / auth_required / unreachable / error), initialize latency, tool count, and OAuth
token state. Exits non-zero if any server is not ok.
