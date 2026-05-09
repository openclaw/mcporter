---
summary: 'Cheatsheet for the various mcporter call argument syntaxes and best practices.'
read_when:
  - 'Designing or debugging tool invocation UX'
---

# Tool Calling Cheatsheet

mcporter accepts multiple argument styles so you can match whatever feels most natural in your shell or script. Every style feeds the same validation pipeline (schema-driven type coercion, required-field checks, enum hints), so pick the one that's easiest to type.

## 1. Inferred Call Command

```bash
mcporter linear.list_issues team=ENG
mcporter context7.resolve-library-id libraryName:value
mcporter firecrawl.scrape 'url: "https://example.com"'
```

- Dotted tokens (`server.tool`) automatically run the `call` command.
- Trailing arguments can use `key=value`, `key:value`, or `key: value` formats; multi-word values need normal shell quoting.
- `server=value` / `tool=value` behave like their flag counterparts if you need to override the selector.

## 2. Explicit `call` + Flags

```bash
mcporter call linear.create_issue --team ENG --title "Bug report"
mcporter call chrome-devtools.take_snapshot output=markdown
mcporter call context7.resolve-library-id libraryName: value
```

- Use `--flag value` when you prefer long-form CLI syntax.
- Mixed forms are fine: `mcporter call linear.create_issue --team ENG title=value due: tomorrow`.
- `--args '{"title":"Bug"}'` still ingests JSON payloads directly.
- Unknown long flags now error instead of silently becoming tool arguments; use `title=value`, `--args`, or `--` before literal positional values beginning with `--`.

## 3. Function-Call Syntax

```bash
mcporter call 'linear.create_issue(title: "Bug", team: "ENG")'
mcporter 'context7.resolve-library-id(query: "React hooks docs", libraryName: "react")'
mcporter 'context7.resolve-library-id("React hooks docs", "react")'
```

- Mirrors the pseudo-TypeScript signature printed by `mcporter list`.
- You may omit labels and rely on the schema order—`mcporter 'context7.resolve-library-id("React hooks docs", "react")'` maps arguments to the live schema order automatically.
- Supports nested objects/arrays and gives detailed parser errors when the expression is malformed.
- Wrap the whole expression in quotes so the shell leaves parentheses/commas intact.

## 4. Mixed Server/Tool Overrides

```bash
mcporter call --server linear resolve_library_id libraryName=value
mcporter call --tool scrape firecrawl url=https://example.com
```

- Pass `--server` / `--tool` when you want to reuse cached selectors or the command inference isn’t enough.
- Anything after the selector uses the same unified key/value parsing.

## 5. Ad-hoc Servers

```bash
mcporter call https://mcp.deepwiki.com/sse.ask_question repoName=value question:"What's new?"
mcporter call --http-url https://mcp.example.com/mcp fetch_docs repoName=value
```

- Bare URLs trigger ad-hoc server registration; you can still use all of the styles above for arguments.
- Combine with `--stdio "bun run ./server.ts"` (plus `--stdio-arg`, `--env`, `--cwd`) for local transports.

---

**Tips**

- Use `mcporter list <server>` to see parameter names, return types, and example invocations.
- Optional fields hide by default; add `--all-parameters` when listing a server to reveal everything.
- `mcporter auth <server|url>` accepts the same ad-hoc flags, so you can authenticate immediately after a 401 without editing config.
