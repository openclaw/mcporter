import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { handleVault } from '../src/cli/vault-command.js';
import { readJsonFile } from '../src/fs-json.js';
import { getOAuthVaultPath, loadVaultEntry, vaultKeyForDefinition } from '../src/oauth-vault.js';
import { isVaultSecretJwe, openVaultSecret, vaultSecretKid } from '../src/oauth-vault-encryption.js';

const definition: ServerDefinition = {
  name: 'calendar',
  command: {
    kind: 'http',
    url: new URL('https://calendar.example/mcp'),
    headers: { accept: 'application/json, text/event-stream' },
  },
  auth: 'oauth',
  source: { kind: 'local', path: '/tmp/mcporter.json' },
};

describe('vault command', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-vault-command-'));
    process.env = {
      ...originalEnv,
      XDG_DATA_HOME: path.join(tempDir, 'data'),
    };
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('seeds sealed values when MCPORTER_VAULT_PASSWORD is set', async () => {
    const password = 'vault-command-password-0123456789';
    process.env.MCPORTER_VAULT_PASSWORD = password;
    const payloadPath = path.join(tempDir, 'tokens.json');
    await fs.writeFile(
      payloadPath,
      JSON.stringify({ tokens: { access_token: 'access-enc', refresh_token: 'refresh-enc', token_type: 'Bearer' } }),
      'utf8'
    );
    await handleVault(runtimeFor(definition), ['set', 'calendar', '--tokens-file', payloadPath]);
    const key = vaultKeyForDefinition(definition);
    const stored = (await readJsonFile<{
      entries: Record<string, { tokens: { access_token: string; token_type: string } }>;
    }>(getOAuthVaultPath()))!;
    const tokens = stored.entries[key]!.tokens;
    expect(tokens.token_type).toBe('Bearer');
    expect(isVaultSecretJwe(tokens.access_token)).toBe(true);
    await expect(
      openVaultSecret(tokens.access_token, vaultSecretKid(key, ['tokens', 'access_token']), password)
    ).resolves.toBe('access-enc');
    await expect(loadVaultEntry(definition)).resolves.toMatchObject({ tokens: { access_token: 'access-enc' } });
    await handleVault(runtimeFor(definition), ['clear', 'calendar']);
    await expect(loadVaultEntry(definition)).resolves.toBeUndefined();
  });

  it('keeps accepting string-only client info from a file', async () => {
    const payloadPath = path.join(tempDir, 'tokens.json');
    await fs.writeFile(
      payloadPath,
      JSON.stringify({
        tokens: {
          access_token: 'access-123',
          refresh_token: 'refresh-123',
          token_type: 'Bearer',
        },
        clientInfo: {
          client_id: 'client-123',
          token_endpoint_auth_method: 'none',
        },
      }),
      'utf8'
    );

    await handleVault(runtimeFor(definition), ['set', 'calendar', '--tokens-file', payloadPath]);

    await expect(loadVaultEntry(definition)).resolves.toMatchObject({
      serverName: 'calendar',
      serverUrl: 'https://calendar.example/mcp',
      tokens: {
        access_token: 'access-123',
        refresh_token: 'refresh-123',
        token_type: 'Bearer',
      },
      clientInfo: {
        client_id: 'client-123',
        token_endpoint_auth_method: 'none',
      },
    });
  });

  it('preserves OAuth dynamic client registration metadata from stdin JSON', async () => {
    await handleVault(runtimeFor(definition), ['set', 'calendar', '--stdin'], {
      readStdin: async () =>
        JSON.stringify({
          tokens: {
            access_token: 'dcr-token',
            token_type: 'Bearer',
          },
          clientInfo: {
            client_id: 'dcr-client',
            redirect_uris: ['https://calendar.example/callback'],
            grant_types: ['authorization_code'],
            response_types: ['code'],
            contacts: ['oauth-admin@calendar.example'],
            token_endpoint_auth_method: 'none',
            client_name: null,
            client_uri: 'not parsed as a URL for backward compatibility',
            jwks: { keys: [] },
            client_id_issued_at: 1_754_611_200,
            client_secret_expires_at: 0,
            provider_metadata: { tenant: 'calendar' },
          },
        }),
    });

    await expect(loadVaultEntry(definition)).resolves.toMatchObject({
      clientInfo: {
        client_id: 'dcr-client',
        redirect_uris: ['https://calendar.example/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        contacts: ['oauth-admin@calendar.example'],
        token_endpoint_auth_method: 'none',
        client_name: null,
        client_uri: 'not parsed as a URL for backward compatibility',
        jwks: { keys: [] },
        client_id_issued_at: 1_754_611_200,
        client_secret_expires_at: 0,
        provider_metadata: { tenant: 'calendar' },
      },
    });
  });

  it('seeds OAuth credentials from stdin JSON and normalizes relative expiry', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_754_611_200_000);

    await handleVault(runtimeFor(definition), ['set', 'calendar', '--stdin'], {
      readStdin: async () =>
        JSON.stringify({
          tokens: {
            access_token: 'stdin-token',
            token_type: 'Bearer',
            expires_in: 3600,
          },
        }),
    });

    await expect(loadVaultEntry(definition)).resolves.toMatchObject({
      tokens: {
        access_token: 'stdin-token',
        token_type: 'Bearer',
        expires_in: 3600,
        expires_at: 1_754_614_800,
      },
    });
  });

  // A payload carries no issuance timestamp, so `expires_in` can only be read
  // as lifetime remaining at import. Credentials imported later than they were
  // issued must therefore say so with an absolute expiry, and that value has to
  // survive normalization untouched — otherwise a stale token is stored as live
  // and refreshable_bearer sends it instead of refreshing.
  for (const alias of ['expires_at', 'expiresAt'] as const) {
    it(`keeps an explicit ${alias} from a delayed import`, async () => {
      vi.spyOn(Date, 'now').mockReturnValue(1_754_611_200_000);
      // Issued 55 minutes before this import: 5 minutes of the hour remain.
      const trueExpiry = 1_754_611_200 + 300;

      await handleVault(runtimeFor(definition), ['set', 'calendar', '--stdin'], {
        readStdin: async () =>
          JSON.stringify({
            tokens: {
              access_token: 'delayed-token',
              token_type: 'Bearer',
              expires_in: 3600,
              [alias]: trueExpiry,
            },
          }),
      });

      // Both aliases are persistence-only, so they are not on OAuthTokens.
      const stored = (await loadVaultEntry(definition))?.tokens as
        | { access_token?: string; expires_at?: number; expiresAt?: number }
        | undefined;
      expect(stored?.access_token).toBe('delayed-token');
      // The relative reading would have stored now + 3600 and hidden the expiry.
      expect(stored?.expires_at ?? stored?.expiresAt).toBe(trueExpiry);
    });
  }

  it('clears the server vault entry', async () => {
    await handleVault(runtimeFor(definition), ['set', 'calendar', '--stdin'], {
      readStdin: async () => JSON.stringify({ tokens: { access_token: 'token', token_type: 'Bearer' } }),
    });

    await handleVault(runtimeFor(definition), ['clear', 'calendar']);

    await expect(loadVaultEntry(definition)).resolves.toBeUndefined();
  });

  it('requires a tokens object', async () => {
    await expect(
      handleVault(runtimeFor(definition), ['set', 'calendar', '--stdin'], {
        readStdin: async () => JSON.stringify({ clientInfo: { client_id: 'client' } }),
      })
    ).rejects.toThrow("Vault payload must include a 'tokens' object.");
  });

  it('rejects malformed token issuer stamps', async () => {
    await expect(
      handleVault(runtimeFor(definition), ['set', 'calendar', '--stdin'], {
        readStdin: async () =>
          JSON.stringify({
            tokens: {
              access_token: 'token',
              token_type: 'Bearer',
              issuer: { url: 'https://issuer.example' },
            },
          }),
      })
    ).rejects.toThrow('Vault payload tokens.issuer must be a string.');

    await expect(loadVaultEntry(definition)).resolves.toBeUndefined();
  });
});

function runtimeFor(server: ServerDefinition) {
  return {
    getDefinition: (name: string) => {
      if (name !== server.name) {
        throw new Error(`Unknown MCP server '${name}'.`);
      }
      return server;
    },
  };
}
