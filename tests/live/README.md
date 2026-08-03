# Live MCP tests

These opt-in tests hit real public MCP servers. They never run in the default gate because third-party uptime,
authentication policy, tool names, and protocol support can change independently of mcporter.

```bash
pnpm build
MCP_LIVE_TESTS=1 pnpm test:live
```

## Coverage

The suite exercises substantially more than initialization:

- negotiation and successful tool calls for `2026-07-28`, `2025-11-25`, `2025-06-18`, and `2025-03-26`;
- modern and legacy resource/prompt enumeration, a readable resource, and advertised-but-empty lists;
- SpaceMolt's 200+ distinct tools and duplicate-name response (the live regression for #260);
- Jina's standalone `/sse` transport fallback through a real tool call;
- actionable, structured 401 results for Linear and Notion without starting OAuth;
- a live keep-alive upstream exposed by `mcporter serve --http 0`, consumed by modern-pinned and legacy SDK clients;
- a real modern record/replay round trip, including a recorded `server/discover` probe and replay against a dead URL;
- explicit modern pins against modern and legacy-only servers (the live regression for #259); and
- DeepWiki's ordinary Streamable HTTP output plus its deprecated endpoint's structured 410 classification.

Every live test contains a short regression-versus-vendor-drift note next to its assertions. Assertions favor MCP
result structure over mutable prose. Tests may skip a tool call when a vendor renames the tool or adds auth, but a
transport, pagination, decoding, bridge, record/replay, or error-classification failure remains a hard failure.

## Public-server survey

Re-probed 2026-08-02; every endpoint below returned HTTP 200 and completed MCP negotiation unless noted.

| Revision     | Era    | Servers observed                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2026-07-28` | modern | [Hugging Face](https://huggingface.co/mcp), [Cloudflare Docs](https://docs.mcp.cloudflare.com/mcp), [Cloudflare Blog](https://blog.mcp.cloudflare.com/mcp), [javadocs.dev](https://www.javadocs.dev/mcp), [inference.sh](https://api.inference.sh/mcp) (listing is public; calls require auth)                                                                                                        |
| `2025-11-25` | legacy | [Context7](https://mcp.context7.com/mcp), [DeepWiki](https://mcp.deepwiki.com/mcp), [Exa](https://mcp.exa.ai/mcp), [Firecrawl](https://mcp.firecrawl.dev/v2/mcp), [Clerk](https://mcp.clerk.com/mcp), [CoinGecko](https://mcp.api.coingecko.com/mcp), [Bun](https://bun.com/docs/mcp), [Twilio](https://mcp.twilio.com/docs), [Vue](https://mcp.vue-mcp.org/mcp), [Jina SSE](https://mcp.jina.ai/sse) |
| `2025-06-18` | legacy | [Microsoft Learn](https://learn.microsoft.com/api/mcp), [Astro](https://mcp.docs.astro.build/mcp), [Svelte](https://mcp.svelte.dev/mcp), [Chakra UI](https://mcp.chakra-ui.com/mcp), [Oxylabs](https://mcp.oxylabs.io/mcp)                                                                                                                                                                            |
| `2025-03-26` | legacy | [GitMCP](https://gitmcp.io/docs), [AWS Knowledge](https://knowledge-mcp.global.api.aws)                                                                                                                                                                                                                                                                                                               |

Additional survey cases:

| Behavior                     | Endpoint                                                                   | Expected observation                                             |
| ---------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| OAuth required               | [Linear](https://mcp.linear.app/mcp), [Notion](https://mcp.notion.com/mcp) | HTTP 401 classified as `auth`, with an `mcporter auth` command   |
| Large/duplicate tool list    | [SpaceMolt](https://game.spacemolt.com/mcp)                                | 213 advertised entries, 212 distinct names at the last probe     |
| Modern resources             | [Hugging Face](https://huggingface.co/mcp)                                 | non-empty resources list with readable `skill://` content        |
| Modern prompts               | [Cloudflare Docs](https://docs.mcp.cloudflare.com/mcp)                     | non-empty prompts list                                           |
| Legacy resources and prompts | [Exa](https://mcp.exa.ai/mcp)                                              | at least one of each; first resource is readable                 |
| Advertised empty lists       | [Microsoft Learn](https://learn.microsoft.com/api/mcp)                     | resources and prompts are advertised but both lists may be empty |

## Triage a weekly failure

Start with the comment in the failing test, then rerun that one file with `MCP_LIVE_TESTS=1`. A wrong protocol
revision, missing tool, newly empty list, 401/403, or changed HTTP status is usually vendor drift; re-probe another
server in the same survey row before changing mcporter. Do not silently delete an era or capability case—substitute
another listed endpoint and record the substitution here.

A failure after successful negotiation is more suspicious: duplicate-list rejection, fewer than 200 SpaceMolt tools,
an SSE error replacing the SDK pin error, replay contacting the dead URL, a bridge failure for only one downstream
era, or an auth response classified as offline is likely an mcporter regression. Capture the structured JSON/error,
compare it with the adjacent test comment, and reproduce against the deterministic fixtures before weakening an
assertion.

No surveyed public server is treated as a stable source of prose. If a vendor changes content but preserves a valid
MCP result shape, adjust the narrow vendor-specific expectation rather than pinning its new wording.
