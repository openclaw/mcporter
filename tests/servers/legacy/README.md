# Legacy MCP fixture server

This deterministic fixture exercises the broad MCP 2025-11-25 surface: paginated tools, structured output, progress and logging notifications, sampling and elicitation, resources and subscriptions, templates and completions, prompts, and runtime list changes. Run it from the repository root with `pnpm exec tsx tests/servers/legacy/server.ts --stdio` or `pnpm exec tsx tests/servers/legacy/server.ts --http 3000`; Streamable HTTP is served at `/mcp`.
