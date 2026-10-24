---
summary: 'Run keyless Keenable web search and page fetching through an isolated HTTP MCP configuration.'
read_when:
  - 'Trying web search or page fetching without an API key'
---

# Keenable web search

[Keenable MCP](https://docs.keenable.ai/mcp-server) provides `search_web_pages` and `fetch_page_content` over Streamable HTTP without an API key. Keyless access is limited per IP to 1,000 requests per hour and 10 requests per second.

The [example configuration](https://github.com/openclaw/mcporter/blob/main/examples/keenable-search/mcporter.json) registers a `keenable` server and disables editor imports. Its `X-Keenable-Title` header names the calling app, which keyless requests must include. Passing the file explicitly with `--config` keeps these commands separate from your project and user configuration.

## Run from a checkout

Use Node 24 or 26 and the pnpm version declared in `package.json`. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js --config examples/keenable-search/mcporter.json list keenable --schema
```

Search for sources, then fetch a page for more detail:

```sh
node dist/cli.js --config examples/keenable-search/mcporter.json call keenable.search_web_pages \
  --args '{"query":"Model Context Protocol official documentation","max_results":5}'

node dist/cli.js --config examples/keenable-search/mcporter.json call keenable.fetch_page_content \
  --args '{"url":"https://modelcontextprotocol.io/"}'
```

Search output lists a title, URL and text snippet for each result. Fetch output contains the page as markdown. Use `list keenable --schema` to inspect current tool arguments, such as `site` and `published_after`, before extending the calls, and add `--output json` when processing results in a script.

## Use your own configuration

Copy the `keenable` server entry into your existing `mcpServers` map to use it alongside other servers, and keep your existing `imports` setting. Without a key, the entry above is enough.

An API key removes the hourly cap. Add it from an environment variable; mcporter resolves the placeholder when the transport runs and stops with the variable name if it is unset:

```json
{
  "mcpServers": {
    "keenable": {
      "baseUrl": "https://api.keenable.ai/mcp",
      "headers": {
        "X-Keenable-Title": "mcporter",
        "X-API-Key": "${KEENABLE_API_KEY}"
      }
    }
  }
}
```

See [Keenable rate limits](https://docs.keenable.ai/rate-limits) for the keyless and keyed limits.
