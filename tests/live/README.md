# Live MCP tests

Opt-in tests that hit real public MCP servers. They never run in the default gate because they
depend on third-party uptime and network access.

```bash
MCP_LIVE_TESTS=1 pnpm exec vitest run tests/live
```

## Protocol-era conformance

`protocol-era-conformance.test.ts` pins one representative public server per protocol revision
mcporter must interoperate with, so a regression in version negotiation shows up against real
implementations rather than only against the committed fixtures in `tests/servers/`.

Survey of reachable no-auth public servers, 2026-08-02 (31 of 32 probed endpoints connected):

| Revision   | Era    | Servers observed                                                                                                                                                      |
| ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-28 | modern | Hugging Face, Cloudflare Docs/Blog/Demo Day, inference.sh, javadocs.dev                                                                                               |
| 2025-11-25 | legacy | Context7, DeepWiki, Exa, Firecrawl, Clerk, CoinGecko, Twilio, Bun, Storyblok, Vue, Browserbase, Chargebee, Coinbase, Jina, Mapbox docs, svelte-llm, Cloudflare Agents |
| 2025-06-18 | legacy | Microsoft Learn, Astro Docs, Svelte, Chakra UI, Oxylabs                                                                                                               |
| 2025-03-26 | legacy | GitMCP, AWS Knowledge                                                                                                                                                 |

Notes for whoever refreshes this list:

- `javadocs.dev` is the most useful modern target: it advertises multiple supported versions and
  returns a nonzero `ttlMs` with `cacheScope: "public"`, unlike the other modern servers which
  return `ttlMs: 0` / `private`.
- Hugging Face and Cloudflare expose `serverInfo` only under the `_meta`
  `io.modelcontextprotocol/serverInfo` key; javadocs.dev also duplicates it top-level. A client
  reading only the top-level field sees nothing on the former two.
- Endpoints move. If a target starts failing, re-probe before assuming an mcporter regression —
  several vendors have added auth to previously open endpoints.
