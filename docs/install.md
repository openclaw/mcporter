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

Each release also ships Bun-compiled standalone binaries for macOS arm64 and x86_64. Grab `mcporter_<version>_darwin_arm64.tar.gz` or `mcporter_<version>_darwin_x86_64.tar.gz` from the [GitHub releases page](https://github.com/openclaw/mcporter/releases), verify it against the basename-only `checksums.txt`, then extract it onto `$PATH`.

Official macOS binaries use the stable `org.openclaw.mcporter` identifier, OpenClaw Foundation Developer ID team `FWJYW4S8P8`, hardened runtime, timestamping, and Apple notarization. `provenance.json` records the exact signed tag, commit, builder versions, asset inventory, architectures, and payload hashes. v0.12.3's standalone binary did not meet this contract and is not a signing or checksum continuity baseline.

## Verify

```bash
mcporter --version
mcporter list
```

The `list` command prints every MCP server discovered across your configs (Cursor, Claude Code/Desktop, Codex, Windsurf, OpenCode, VS Code). If nothing shows up, jump to [Configuration](config.md) to add a server.

## Updating

- `npm`: `npm install -g mcporter@latest`
- `pnpm`: `pnpm up -g mcporter@latest`
- `brew`: `brew upgrade steipete/tap/mcporter`
- Standalone binary: download a fresh release asset.

## Uninstall

- `npm uninstall -g mcporter`
- `brew uninstall steipete/tap/mcporter`
- Standalone binary: delete the file you copied onto `$PATH`.

OAuth credentials use `~/.mcporter/credentials.json` or `$XDG_DATA_HOME/mcporter/credentials.json`; cached schemas use `~/.mcporter/<server>/` or `$XDG_CACHE_HOME/mcporter/<server>/`. Custom `tokenCacheDir` settings can place them elsewhere. With `MCPORTER_VAULT_PASSWORD` set, the secret values in these files are encrypted; see [Vault Encryption](config.md#vault-encryption). Run `mcporter config logout <server>` to clear that server's credentials while preserving unrelated files. See [configuration paths](config.md#config-resolution-order) before removing any remaining config or cache files.
