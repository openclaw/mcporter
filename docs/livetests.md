---
summary: 'Opt-in live MCP integration tests that hit real hosted servers (off by default in CI).'
read_when:
  - 'Running end-to-end validation against hosted MCP servers'
---

# Live MCP Tests

These tests hit real hosted MCP servers and require outbound HTTP. They are **off by default** to keep CI and local runs deterministic.

## When to run

- Before releases when you want end-to-end validation against hosted servers.
- When debugging regressions that only repro against real servers (e.g., DeepWiki).

## How to run

```bash
MCP_LIVE_TESTS=1 pnpm test:live
```

This runs the Vitest suite under `tests/live`, in-band, with longer timeouts.

## Current coverage

The suite negotiates and calls real servers across all supported revisions (`2026-07-28`, `2025-11-25`,
`2025-06-18`, and `2025-03-26`). It also exercises resources, prompts, 200+ tool pagination with a duplicate tool
name, standalone SSE fallback, OAuth-required classification, modern/legacy downstream clients through
`mcporter serve`, modern record/replay, and explicit version pins. DeepWiki remains as a focused Streamable HTTP
rendering and deprecated-endpoint classification check.

The full endpoint survey, expected drift, and weekly failure triage live in
[`tests/live/README.md`](https://github.com/openclaw/mcporter/blob/main/tests/live/README.md).

## Notes

- Tests are skipped entirely unless `MCP_LIVE_TESTS=1` is set.
- Ensure network egress is allowed. No secrets are required for the live checks.
- As of 2026-03-29, DeepWiki's hosted `/sse` endpoint responds with HTTP `410`, so the live suite treats that as a compatibility/error-classification smoke rather than a success-path transport check.
- Keep assertions structural where vendor content can change. Transport, protocol, pagination, bridge, replay, and
  error-classification behavior are contracts and should still fail loudly.
