import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { handleVault } from '../src/cli/vault-command.js';
import { loadVaultEntry } from '../src/oauth-vault.js';

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

  it('seeds OAuth credentials from a file using mcporter vault keys', async () => {
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
      },
    });
  });

  it('seeds OAuth credentials from stdin JSON', async () => {
    await handleVault(runtimeFor(definition), ['set', 'calendar', '--stdin'], {
      readStdin: async () =>
        JSON.stringify({
          tokens: {
            access_token: 'stdin-token',
            token_type: 'Bearer',
          },
        }),
    });

    await expect(loadVaultEntry(definition)).resolves.toMatchObject({
      tokens: {
        access_token: 'stdin-token',
        token_type: 'Bearer',
      },
    });
  });

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
