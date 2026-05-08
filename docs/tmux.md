---
summary: 'How to wrap mcporter commands in tmux sessions to monitor hangs and capture output.'
read_when:
  - 'Debugging long-running commands or needing persistent logs'
---

# tmux Hang Diagnostics

Use `tmux` to verify whether a CLI command actually exits or is stalled on open handles. This keeps the main shell free while you inspect logs.

1. Start the command in a detached session:
   ```bash
   tmux new-session -ds mcporter-check "pnpm exec tsx src/cli.ts list"
   ```
2. Wait a few seconds, then ask tmux if the session is still running:

   ```bash
   tmux has-session -t mcporter-check
   ```

   - Exit status **1** (`can't find session`) means the process exited normally.
   - Exit status **0** means the command is still running (or hung) inside the session.

3. Capture the output without attaching:
   ```bash
   tmux capture-pane -pt mcporter-check | tail -n 40
   ```
4. Once finished, clean up the session:
   ```bash
   tmux kill-session -t mcporter-check
   ```

This workflow makes it easy to confirm whether `mcporter` commands return promptly after shutdown changes (for example, when debugging lingering MCP stdio servers). Use `MCPORTER_DEBUG_HANG=1` to emit active-handle diagnostics inside the tmux session when necessary. For OAuth flows that keep a session open, set `--oauth-timeout 5000` (or `MCPORTER_OAUTH_TIMEOUT_MS=5000`) so the CLI proves it can exit without waiting the full 5 minute default for a browser callback.
