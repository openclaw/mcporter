# MCPorter

TypeScript runtime, CLI, and code-generation toolkit for the Model Context
Protocol. MCPorter discovers MCP servers already configured on your machine,
calls their tools from a stable CLI or TypeScript API, and can generate
server-specific CLIs or typed clients when a workflow needs a smaller surface.

## Try It

```bash
npx mcporter list
npx mcporter list linear --schema
npx mcporter call linear.create_comment issueId:ENG-123 body:'Looks good!'
npx mcporter generate-cli linear --bundle dist/linear.js
npx mcporter emit-ts linear --mode client --out src/linear-client.ts
```

Human progress and prompts go to stderr. Use command-specific machine output
flags for scripts, such as `mcporter call --output json`.

## What It Does

- Discovers home, project, and imported MCP config from Cursor, Claude,
  Codex, Windsurf, OpenCode, and VS Code.
- Calls HTTP, SSE, and stdio MCP tools through one CLI/runtime surface.
- Handles OAuth setup and cached token refresh without putting secrets in
  project files.
- Keeps selected stateful servers warm through the daemon and can expose them
  through `mcporter serve`.
- Generates standalone CLIs with embedded schemas and typed clients for agent
  or test workflows.
- Records and replays MCP JSON-RPC traffic for offline debugging and redacted
  repros.

## Docs

- [Product vision](VISION.md)
- [Docs home](docs/index.md)
- [Runtime overview](docs/mcp.md)
- [Install](docs/install.md)
- [Quickstart](docs/quickstart.md)
- [Migration guide](docs/migration.md)
- [Configuration](docs/config.md)
- [CLI reference](docs/cli-reference.md)
- [Agent shortcuts](docs/shortcuts.md)
- [Ad-hoc connections](docs/adhoc.md)
- [Known issues](docs/known-issues.md)
- [Tool calling](docs/tool-calling.md)
- [Call syntax](docs/call-syntax.md)
- [Generated CLIs](docs/cli-generator.md)
- [Typed clients](docs/emit-ts.md)
- [Agent skills](docs/agent-skills.md)
- [Daemon](docs/daemon.md)
- [Logging and diagnostics](docs/logging.md)
- [Record/replay](docs/record-replay.md)
- [Manual testing](docs/manual-testing.md)
- [Live integration tests](docs/livetests.md)
- [Release](docs/RELEASE.md)

Portfolio routing and ownership notes live in the LDMB123 tracked wiki:
`~/Developer/GitHub/LDMB123/home-agent-config/.openclaw/wiki/main/knowledge/entities/mcporter-repo.md`.

## Developer Workflow

Use pnpm and the repo runner so guardrails apply consistently:

```bash
pnpm install
./runner pnpm check
./runner pnpm test
./runner pnpm build
```

Useful local smokes:

```bash
./runner pnpm mcporter:list
./runner pnpm mcporter:call -- --help
```

Live MCP tests are opt-in:

```bash
MCP_LIVE_TESTS=1 ./runner pnpm test:live
```

## Safety

Keep OAuth tokens, bearer tokens, `.env*`, and provider credentials in local
environment, the MCPorter vault, or provider-managed stores. Project config may
reference environment variables, but should not store secret values directly.

## License

MIT. See [LICENSE](LICENSE).
