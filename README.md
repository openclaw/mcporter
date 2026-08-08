# MCPorter 🧳 — Carry MCP tools into scripts, CLIs, and agents

[![CI](https://img.shields.io/github/actions/workflow/status/openclaw/mcporter/ci.yml?branch=main&style=flat-square&label=ci)](https://github.com/openclaw/mcporter/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/mcporter?style=flat-square)](https://www.npmjs.com/package/mcporter)
[![Node](https://img.shields.io/node/v/mcporter?style=flat-square)](https://nodejs.org)
[![License](https://img.shields.io/github/license/openclaw/mcporter?style=flat-square)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-mcporter.sh-2563eb?style=flat-square)](https://mcporter.sh)

<p align="center">
  <img src="mcporter.png" alt="MCPorter header banner" width="1100">
</p>

MCPorter is a TypeScript runtime and command-line tool for discovering and calling Model Context Protocol servers. It is for developers and coding agents that need the same MCP tools from a terminal, a script, or a generated standalone CLI.

## Install

Try the CLI without installing it:

```sh
npx mcporter --version
```

Install it for repeated command-line use:

```sh
brew install steipete/tap/mcporter
# or
npm install -g mcporter
```

Node 24 or newer is required for npm installs. For the TypeScript runtime, add `mcporter` to your project with your package manager. Signed macOS binaries and the other supported install paths are covered in the [install guide](docs/install.md).

## Quick start

Inspect a public MCP server, then call one of its tools:

```sh
npx mcporter list https://mcp.context7.com/mcp --brief
npx mcporter call https://mcp.context7.com/mcp.resolve-library-id \
  query="React hooks docs" libraryName=react
```

The first command prints the server's TypeScript-style tool signatures. The second returns matching Context7 library IDs without requiring local configuration or credentials. See the [five-minute quickstart](docs/quickstart.md) for resources, generated CLIs, and typed clients.

## Core workflows

| Goal                                      | Command or API                       | Details                                    |
| ----------------------------------------- | ------------------------------------ | ------------------------------------------ |
| Discover servers and tools                | `mcporter list`                      | [CLI reference](docs/cli-reference.md)     |
| Call tools and read resources             | `mcporter call`, `mcporter resource` | [Call syntax](docs/call-syntax.md)         |
| Connect to a one-off URL or stdio command | `--http-url`, `--stdio`              | [Ad-hoc servers](docs/adhoc.md)            |
| Complete or seed OAuth                    | `mcporter auth`, `mcporter vault`    | [Configuration](docs/config.md)            |
| Generate a focused CLI                    | `mcporter generate-cli`              | [CLI generator](docs/cli-generator.md)     |
| Generate TypeScript types or clients      | `mcporter emit-ts`                   | [Typed clients](docs/emit-ts.md)           |
| Capture a reproducible MCP session        | `mcporter record`, `mcporter replay` | [Record and replay](docs/record-replay.md) |

Human-readable output goes to stdout by default. Use JSON output when another program or agent needs a stable result, and consult `mcporter <command> --help` for the flags supported by that command.

## Configuration and discovery

MCPorter reads project and user config, then imports MCP servers from Cursor, Claude Code and Desktop, Codex, Windsurf, OpenCode, and VS Code. A minimal `config/mcporter.json` looks like this:

```json
{
  "mcpServers": {
    "context7": {
      "url": "https://mcp.context7.com/mcp"
    }
  }
}
```

Config files accept JSONC, environment placeholders, HTTP and stdio definitions, OAuth settings, tool filters, and lifecycle policy. The [configuration guide](docs/config.md) defines precedence and the full schema; the [import reference](docs/import.md) lists every discovered client format.

Chrome DevTools definitions using `--autoConnect` can control Chrome through a paired [OpenClaw extension relay](docs/daemon.md#chrome-devtools-through-the-openclaw-extension-relay). MCPorter uses Browser Relay Authentication v2 over one retained loopback socket, keeps the host key out of the network and child process, and gives `chrome-devtools-mcp` a credential-free loopback URL plus ephemeral authorization through an OS-protected preload handoff. This requires OpenClaw's v2 relay capability; old relay authentication is never retried. Routing defaults to `prefer`, which may fall back only to Chrome's original auto-connect path; `require` fails closed and `off` keeps original auto-connect.

## TypeScript runtime

Use `createRuntime()` when a process needs explicit server definitions, connection reuse, or several calls:

```ts
import { createRuntime } from 'mcporter';

const runtime = await createRuntime({
  servers: [{ name: 'context7', command: { kind: 'http', url: new URL('https://mcp.context7.com/mcp') } }],
});
try {
  console.log((await runtime.listTools('context7')).map((tool) => tool.name));
} finally {
  await runtime.close();
}
```

`callOnce()` handles a single configured call and cleanup. `createServerProxy()` maps MCP tool names to callable camelCase properties and wraps results with text, Markdown, JSON, image, and raw-content helpers. See the [runtime overview](docs/mcp.md) and [tool-calling guide](docs/tool-calling.md).

## Protocols and long-lived servers

MCPorter connects to stdio, Streamable HTTP, and legacy SSE servers. It negotiates the current `2026-07-28` protocol or a legacy revision per server, while legacy connections advertise client elicitation capabilities. Interactive CLI calls can answer form and URL requests; headless and daemon-managed calls decline them with an actionable hint.

The repository's modern and legacy fixture servers cover both generations; CI exercises representative fixture paths end-to-end over stdio and Streamable HTTP. See [protocols and interactive requests](docs/protocols.md) for negotiation controls and [the keep-alive daemon](docs/daemon.md) for pooled servers, the MCP bridge, and Chrome DevTools integration.

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm docs:site
```

The project uses the Node and pnpm versions declared in `package.json`. Live hosted-server tests are opt-in; see [live tests](docs/livetests.md) and [manual testing](docs/manual-testing.md).

## Related

- [CodexBar](https://codexbar.app) keeps Codex token windows visible in the macOS menu bar.
- [Trimmy](https://trimmy.app) flattens multi-line shell snippets for one-shot pasting.
- [Oracle](https://github.com/steipete/oracle) bundles prompts and files for multi-model runs.
- [Model Context Protocol specification](https://github.com/modelcontextprotocol/specification).

## License

MIT — see [LICENSE](LICENSE).
