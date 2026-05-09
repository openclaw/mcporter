---
summary: 'Implementation specification for unattended OAuth credential seeding through a thin mcporter vault CLI surface.'
read_when:
  - 'Planning or implementing non-interactive OAuth credential provisioning'
  - 'Working on the OAuth vault, persistence layer, or headless deployment flows'
---

# Unattended OAuth Vault Seeding

`mcporter vault` seeds or clears OAuth credentials without launching a browser flow. It exists for multitenant and multideployment automation where an external provisioner already holds valid OAuth credentials.

The command exposes existing mcporter credential persistence through a scriptable CLI. It does not create a second vault format, duplicate key computation, or require callers to know internal storage details.

`vault` is a top-level command. Config and vault data are different mcporter entities with different storage classes: config describes server definitions, while the vault stores OAuth credential material derived from those definitions.

## Objectives

- Let CI, containers, deployment controllers, and fleet provisioners seed OAuth credentials without a browser flow.
- Keep server identity resolution inside mcporter so callers never reproduce the vault key format.
- Preserve the same credential read/write behavior used by runtime OAuth flows.
- Support tenant/deployment isolation through the existing `--config <path>` and `--root <dir>` global flags.
- Keep stdout/stderr script-safe: never print token material, return non-zero on invalid input, and keep validation messages concise.

## CLI

```bash
mcporter vault set <server> --tokens-file <path>
mcporter vault set <server> --stdin
mcporter vault clear <server>
```

`<server>` resolves through the same config/import discovery stack as `mcporter list`, `mcporter call`, `mcporter auth`, and `mcporter config logout`. The command honors explicit `--config <path>` and `--root <dir>` overrides so automated deployments can target an isolated config file and project root.

`--tokens-file` and `--stdin` are mutually exclusive. Missing input, duplicate input sources, malformed JSON, missing `tokens`, or unknown servers fail before writing anything.

`vault set` does not require the server definition to declare `auth: "oauth"`. Older configs and some imported definitions may still rely on cached OAuth credentials without that marker, and unattended provisioning should not force unrelated config rewrites.

## Payload Contract

The input payload mirrors mcporter's own single-entry vault storage schema when possible. It is not the full `credentials.json` file. The full vault file contains internal map keys derived from the resolved server definition; that key format remains private.

Required shape:

```json
{
  "tokens": {
    "access_token": "...",
    "refresh_token": "...",
    "token_type": "Bearer"
  },
  "clientInfo": {
    "client_id": "..."
  }
}
```

`tokens` is required. `clientInfo` is optional because some deployments use pre-registered OAuth clients from config and only need to seed tokens. Use mcporter vault terminology (`tokens`, `clientInfo`) in the public contract so the CLI, docs, and on-disk entry shape stay unambiguous.

For portability with exported vault-entry-shaped data, the CLI may accept these metadata fields:

```json
{
  "serverName": "linear",
  "serverUrl": "https://mcp.linear.app/mcp",
  "updatedAt": "2026-05-09T00:00:00.000Z",
  "tokens": { "access_token": "...", "token_type": "Bearer" },
  "clientInfo": { "client_id": "..." }
}
```

When present, `serverName`, `serverUrl`, and `updatedAt` are compatibility metadata only. mcporter computes authoritative storage metadata from the resolved server definition and current write time.

`state` and `codeVerifier` exist in mcporter's internal `VaultEntry` type, but they are not part of the public seed contract. They are transient browser-flow artifacts, not deployment credentials.

A future `mcporter vault export <server>` can reuse this same single-entry payload shape. That command is out of scope for issue #156, but the import contract should avoid blocking a later export/import workflow.

## Implementation Requirements

The command is a thin CLI adapter over existing primitives:

- Use `loadServerDefinitions(...)` for config/import discovery.
- Use `resolveServerDefinition(...)` for server lookup, fuzzy matching, and error behavior.
- Use `buildOAuthPersistence(definition)` to save `tokens` and optional `clientInfo`.
- Use `clearOAuthCaches(definition)` for `vault clear`.
- Reuse existing JSON file/stdin parsing patterns where practical.

The CLI must not:

- call `vaultKeyForDefinition(...)` directly,
- hand-edit `credentials.json`,
- duplicate `saveVaultEntry(...)` behavior,
- introduce a second credential persistence path,
- add dependencies for payload validation or parsing.

Writing through `buildOAuthPersistence(definition)` is important because runtime OAuth reads from the same abstraction. If a server defines `tokenCacheDir`, persistence writes must stay compatible with that override instead of seeding only the shared vault and leaving an older cache to shadow the new credentials.

`vault clear` uses the same clearing semantics as `mcporter config logout`: it removes the shared vault entry, legacy `~/.mcporter/<server>/` cache, provider-specific legacy files, and explicit `tokenCacheDir` when present.

## Validation

Validation is strict enough for automation but avoids replacing the MCP SDK's OAuth token typing:

- The payload must be a JSON object.
- `tokens` must be a JSON object.
- Token field validation mirrors mcporter's stored `OAuthTokens` shape instead of inventing a stricter CLI-only schema.
- If known token fields such as `access_token`, `refresh_token`, or `token_type` are present, they must have the same primitive types mcporter would persist in the vault.
- `clientInfo`, when present, must be a JSON object.
- Secret values must not be echoed in errors, logs, or success messages.

Unknown extra fields are ignored unless they conflict with the public contract. Ignoring unknown fields keeps exported credential payloads portable across minor mcporter versions.

## Test Plan

Add focused tests for:

- `vault set <server> --tokens-file <path>` writes credentials that runtime persistence can read.
- `vault set <server> --stdin` reads the same payload shape.
- `vault set` rejects missing input, both input sources at once, invalid JSON, missing `tokens`, and unknown servers.
- `vault clear <server>` clears via the same semantics as `config logout`.
- `--config <path>` and `--root <dir>` select the intended server definition.
- Token material never appears in success output or validation errors.

Before opening the upstream PR, run the repository green gate through the local wrapper:

```bash
./runner pnpm run docs:list
./runner pnpm run check
./runner pnpm test
```

## Upstream PR Notes

The upstream PR should describe this as unattended OAuth credential provisioning for multitenant and multideployment systems. It should emphasize that the implementation exposes existing mcporter behavior instead of creating a new credential subsystem.

Keep the patch focused: CLI handler, help text, tests, docs, and a changelog entry for the new user-facing command.
