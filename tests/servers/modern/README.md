# Modern MCP fixture server

This deterministic fixture exercises MCP 2026-07-28 discovery and per-request identity, cacheable lists, structured tool output, streamed progress, multi-round-trip form elicitation with protected request state, resources, prompts, and `subscriptions/listen` tool changes, while retaining the SDK's stateless 2025 fallback. Run it from the repository root with `pnpm exec tsx tests/servers/modern/server.ts --stdio` or `pnpm exec tsx tests/servers/modern/server.ts --http 3000`; Streamable HTTP is served at `/mcp`.
