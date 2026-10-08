import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { getOAuthVaultPath, vaultKeyForDefinition } from '../src/oauth-vault.js';
import { sealVaultSecret, vaultSecretKid } from '../src/oauth-vault-encryption.js';
import { applyCachedAuthIfAvailable } from '../src/runtime/cached-auth.js';

const definition: ServerDefinition = {
  name: 'enc',
  command: { kind: 'http', url: new URL('https://example.com/mcp') },
  auth: 'oauth',
};
const logger = { info() {}, warn() {}, error() {}, debug: vi.fn() };
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-cached-auth-'));
  vi.stubEnv('XDG_DATA_HOME', path.join(dir, 'data'));
  const key = vaultKeyForDefinition(definition);
  const sealed = await sealVaultSecret(
    'access-enc',
    vaultSecretKid(key, ['tokens', 'access_token']),
    'cached-auth-password-0123456789'
  );
  await fs.mkdir(path.dirname(getOAuthVaultPath()), { recursive: true });
  await fs.writeFile(
    getOAuthVaultPath(),
    JSON.stringify({
      version: 2,
      entries: {
        [key]: {
          serverName: 'enc',
          serverUrl: 'https://example.com/mcp',
          updatedAt: 'now',
          tokens: { access_token: sealed, token_type: 'Bearer' },
        },
      },
    }),
    'utf8'
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

it('surfaces the vault error instead of silently starting an auth flow', async () => {
  await expect(applyCachedAuthIfAvailable(definition, logger, true)).rejects.toMatchObject({
    name: 'VaultEncryptionError',
    code: 'password_missing',
  });
  expect(logger.debug).not.toHaveBeenCalledWith(expect.stringContaining('Failed to read cached OAuth token'));
});
