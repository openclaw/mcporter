---
summary: 'Reference for capturing mcporter diagnostics (daemon logs, per-server overrides, env flags).'
read_when:
  - 'Need persistent daemon logs or want to trace keep-alive STDIO servers.'
---

# Logging & Diagnostics

## Daemon logging

The keep-alive daemon can tee its stdout/stderr (and per-server call traces) into a file so you can see crashes or repeated failures without rerunning it in the foreground.

### CLI flags

- `mcporter daemon start --log` — enable logging at the default path `~/.mcporter/daemon/daemon-<config-hash>.log`, or `$XDG_STATE_HOME/mcporter/daemon/daemon-<config-hash>.log` when `XDG_STATE_HOME` is set.
- `mcporter daemon start --log-file /tmp/mcporter-daemon.log` — write logs to a specific file (path is created if needed).
- `mcporter daemon start --log-servers chrome-devtools,mobile-mcp` — only emit per-call entries for the listed servers. Without this flag, `--log` records every keep-alive server’s calls.

`mcporter daemon restart` accepts the same logging flags, so you can bounce the daemon without retyping your tracing preferences.

Foreground mode (`mcporter daemon start --foreground --log`) still prints to your terminal; the log file mirrors the same content.

### Environment overrides

Set these before invoking `mcporter` (helpful for scripts/CI):

- `MCPORTER_DAEMON_LOG=1` — enable logging.
- `MCPORTER_DAEMON_LOG_PATH=/tmp/mcporter-daemon.log` — custom log file.
- `MCPORTER_DAEMON_LOG_SERVERS=chrome-devtools,playwright` — per-server call filtering.

The CLI flags take precedence; env vars are the fallback.

### Per-server opt-in

Add a logging block inside the server definition (alongside `lifecycle`) when you only want a specific STDIO transport to produce call traces, regardless of global flags:

```json
"chrome-devtools": {
  "description": "Chrome DevTools protocol bridge",
  "command": "npx",
  "args": ["-y", "chrome-devtools-mcp@latest"],
  "lifecycle": "keep-alive",
  "logging": {
    "daemon": { "enabled": true }
  }
}
```

When combined with `--log`/`MCPORTER_DAEMON_LOG=1`, any server that has `logging.daemon.enabled` emits `callTool start/success/error` lines even if it isn’t listed in `--log-servers`.

### Inspecting logs

- `mcporter daemon status` prints both the socket path and the current log file (if logging is enabled) so you can `tail -f` the output quickly.
- Each call looks like:
  ```
  [daemon] 2025-11-10T15:08:21.123Z callTool start server=chrome-devtools tool=take_snapshot
  [daemon] 2025-11-10T15:08:22.004Z callTool success server=chrome-devtools tool=take_snapshot
  ```
- Shutdown events and errors are logged the same way (`callTool error … err=...`, `listTools error …`, etc.).

### Defaults & cleanup

Log files live under `~/.mcporter/daemon/` next to the socket/metadata, or under `$XDG_STATE_HOME/mcporter/daemon/` when `XDG_STATE_HOME` is set. They’re not rotated automatically yet; delete/rotate them manually if they grow large. Running `mcporter daemon stop` leaves the log intact so you can inspect it after a crash.

## Foreground debugging

When troubleshooting deeply, run `mcporter daemon start --foreground --log` in a dedicated terminal. This keeps the daemon attached (so Ctrl+C stops it) and still writes to the configured log file for later inspection.
