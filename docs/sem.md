---
summary: 'Inspect a local Git repository through Sem over stdio MCP.'
read_when:
  - 'Trying structural code navigation with a local MCP server'
---

# Local code navigation with Sem

[Sem](https://github.com/Ataraxy-Labs/sem) exposes structural code search over stdio MCP. This optional example requires no Sem account or API key and makes no model calls.

The [example configuration](https://github.com/openclaw/mcporter/blob/main/examples/sem/mcporter.json) pins the server version and disables editor imports. It requires an explicit repository path so the server does not accidentally index the configuration directory. The path is also used as the server's working directory; an unset `SEM_REPO` fails configuration loading before the server starts. The shell guard below also rejects an empty value.

## Run from a checkout

Use Node 24 or 26 and the pnpm version declared in `package.json`. From the MCPorter repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
export SEM_REPO=/absolute/path/to/trusted/git/repository
: "${SEM_REPO:?Set SEM_REPO to an absolute path to a trusted Git repository}"
node dist/cli.js --config examples/sem/mcporter.json list sem --schema
```

The first invocation downloads the npm package and its native binary. Use a supported macOS or Linux machine (x64 or ARM64). The environment flags disable Sem cloud sync and telemetry; they do not prevent npm downloads or sandbox the process.

Search for a symbol, then request its context explicitly. Replace `parse_config` with a symbol in your repository:

```sh
node dist/cli.js --config examples/sem/mcporter.json call sem.sem_find \
  --args '{"query":"parse_config"}'

node dist/cli.js --config examples/sem/mcporter.json call sem.sem_find \
  --args '{"query":"parse_config","mode":"context","token_budget":1200}'
```

Inspect `list sem --schema` for other arguments. Structural results depend on language support and index coverage; an empty result is not proof that a reference does not exist.

## Scope and safety

- These example calls only request navigation. The server also exposes `sem_check`, which can execute repository commands. Use trusted repositories and review calls before execution.
- `SEM_REPO` selects a checkout, not an OS-level access boundary. Run untrusted code in a separate sandbox.
- To integrate with an existing configuration, copy only the `sem` entry into its `mcpServers` map and preserve its `imports` setting. Set `SEM_REPO` in the environment launching MCPorter.
- Removing the entry disables the integration but does not remove downloaded packages or repository indexes.
