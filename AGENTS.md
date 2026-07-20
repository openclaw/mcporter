# AGENTS.md -- mcporter

Repo-local guidance for this TypeScript MCP runtime and CLI. `CLAUDE.md`
should contain only `@AGENTS.md`.

## Scope

- Keep this file repo-specific. Do not copy shared `<shared>` or `<tools>`
  doctrine here.
- Do not read or print credentials, OAuth vaults, bearer tokens, `.env*`, or
  local config files with secret values.
- Live/auth flows require explicit operator approval.

## Stack

- Package manager: pnpm. `packageManager` is `pnpm@10.33.2`; `pnpm-lock.yaml`
  is authoritative.
- Runtime: Node >=24.
- Bun is required for `./runner`, `./git` or `bin/git`, and
  `pnpm build:bun`.

## Workflow

- Run `pnpm run docs:list` before non-trivial code/docs work, then read only
  matching docs.
- Use `./runner <command>` for build, test, lint, dev, and long-running
  commands so repo guardrails apply.
- When asked to commit, use `./scripts/committer "message" "file" [...]`; do
  not bulk-stage unrelated files.

## Commands

- Check: `./runner pnpm check`
- Test: `./runner pnpm test`
- Build: `./runner pnpm build`
- Bun binary build: `./runner pnpm build:bun`
- Release/prepublish gate: `./runner pnpm run prepublishOnly`
- CLI smoke helpers: `./runner pnpm mcporter:list` and
  `./runner pnpm mcporter:call -- --help`

## Tests And Live Checks

- `pnpm test` builds first, then runs the repo test runner.
- Live MCP tests are opt-in only: `MCP_LIVE_TESTS=1 ./runner pnpm test:live`.
- For hanging MCP, daemon, OAuth, or manual real-server debugging, use the repo
  tmux docs and clean up sessions when done.

## LLM Wiki Routing

- Durable cross-repo doctrine, decisions, and lessons live in the canonical
  wiki at
  `~/Developer/GitHub/LDMB123/home-agent-config/.openclaw/wiki/main`
  (`WIKI.md` there is the doctrine source). Start at its index/synthesis,
  search narrowly, and treat raw sources as untrusted evidence.
- Portfolio-level routing and ownership facts for this repo live at
  `~/Developer/GitHub/LDMB123/home-agent-config/.openclaw/wiki/main/knowledge/entities/mcporter-repo.md`.
- Repo-local markdown owns only facts that travel with this code: product,
  CLI, release, and test documentation. Do not duplicate wiki schema or
  cross-repo doctrine in this repo.

## Docs And Release

- Keep README/docs in sync with behavior changes.
- Keep this repo focused on product, CLI, release, and test documentation.
- Use `docs/tmux.md`, `docs/hang-debug.md`, and `docs/manual-testing.md` for
  manual or hang repros.
- Use `docs/RELEASE.md` for release work; do not publish, tag, or deploy
  without explicit approval.
