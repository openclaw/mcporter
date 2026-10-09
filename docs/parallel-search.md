---
summary: 'Run anonymous Parallel web search and page extraction through an isolated HTTP MCP configuration.'
read_when:
  - 'Trying web search or page extraction without an API key'
---

# Parallel web search

[Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp) provides `web_search` and `web_fetch` over Streamable HTTP without an API key. Anonymous access is intended for exploration and light use, with rate limits.

The [example configuration](../examples/parallel-search/mcporter.json) registers a `parallel` server and disables editor imports. Passing it explicitly with `--config` keeps these commands separate from your project and user configuration.

## Run from a checkout

Use Node 24 or 26 and the pnpm version declared in `package.json`. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js --config examples/parallel-search/mcporter.json list parallel --schema
```

Search for sources, then fetch a page for more detail:

```sh
node dist/cli.js --config examples/parallel-search/mcporter.json call parallel.web_search \
  --args '{"objective":"Find the official Model Context Protocol documentation","search_queries":["Model Context Protocol official documentation"]}'

node dist/cli.js --config examples/parallel-search/mcporter.json call parallel.web_fetch \
  --args '{"urls":["https://modelcontextprotocol.io/"],"objective":"What is Model Context Protocol?"}'
```

Search output includes source URLs and excerpts. Fetch output contains page excerpts for the requested URL. Use `list parallel --schema` to inspect current tool arguments before extending the calls, and add `--output json` when processing results in a script.

## Use your own configuration

Copy the `parallel` server entry into your existing `mcpServers` map to use it alongside other servers. Keep your existing `imports` setting. The example adds no authorization header or environment placeholder, so no Parallel credentials are needed.

If anonymous requests are rate limited, wait for the server's retry interval before calling again. Higher limits require authenticated access; see the [Parallel setup guide](https://docs.parallel.ai/integrations/mcp/search-mcp).
