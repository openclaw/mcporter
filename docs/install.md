---
summary: 'How to install mcporter — npx, npm, pnpm, Homebrew, or a standalone Bun-compiled binary.'
---

# Install

mcporter ships as both a published npm package and a Homebrew formula. Most workflows can also run mcporter without installing anything via `npx`.

## Try without installing

```bash
npx mcporter --version
npx mcporter list
```

`npx` keeps the package in your npm cache, so subsequent runs are instant. This is the recommended first step.

## npm / pnpm / Bun

Install globally:

```bash
npm install -g mcporter
```

Or add it to a project:

```bash
pnpm add mcporter        # or: npm install mcporter / bun add mcporter
```

mcporter targets Node 24+ and works under Bun. The package exposes both an importable runtime (`createRuntime`, `callOnce`, `createServerProxy`) and the `mcporter` CLI binary.

## Homebrew

```bash
brew install steipete/tap/mcporter
```

The tap publishes alongside npm. If you previously installed from an older tap, run `brew update` before reinstalling so Homebrew picks up the new formula path.

## Standalone binary

Each release also ships a Bun-compiled standalone binary you can drop on `$PATH` without a Node toolchain. Grab the asset for your OS/arch from the [GitHub releases page](https://github.com/steipete/mcporter/releases) and `chmod +x` it. The compiled CLI behaves the same as the Node build but boots noticeably faster and bundles its dependencies.

## Verify

```bash
mcporter --version
mcporter list
```

The first invocation will print every MCP server it discovered across your configs (Cursor, Claude Code/Desktop, Codex, Windsurf, OpenCode, VS Code). If nothing shows up, jump to [Configuration](config.md) to add a server.

## Updating

- `npm`: `npm install -g mcporter@latest`
- `pnpm`: `pnpm up -g mcporter@latest`
- `brew`: `brew upgrade steipete/tap/mcporter`
- Standalone binary: download a fresh release asset.

## Uninstall

- `npm uninstall -g mcporter`
- `brew uninstall steipete/tap/mcporter`
- Standalone binary: delete the file you copied onto `$PATH`.

mcporter stores OAuth tokens and cached schemas under `~/.mcporter/` (or `$XDG_CACHE_HOME/mcporter/` when set). Remove that directory if you want a fully clean slate.
