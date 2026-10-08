import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { loadConfigSnapshot } from '../src/config.js';
import { RawConfigSchema } from '../src/config-schema.js';
import { privateFixtureDirectory } from './helpers/private-directory.js';

const server = { url: 'https://example.com/mcp', auth: 'oauth' };
async function snapshotOf(config: unknown) {
  const root = await privateFixtureDirectory('mcp-vault-policy-');
  try {
    await fs.writeFile(`${root}/config.json`, JSON.stringify(config));
    return await loadConfigSnapshot({ configPath: `${root}/config.json` });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe('oauthVaultEncryption', () => {
  it('is absent when the config does not set it', async () => {
    const snapshot = await snapshotOf({ imports: [], mcpServers: { api: server } });
    expect(snapshot.vaultEncryption).toBeUndefined();
    expect('oauthVaultEncryption' in (snapshot.servers[0] ?? {})).toBe(false);
  });
  it('is carried on every definition and on the snapshot', async () => {
    const snapshot = await snapshotOf({
      imports: [],
      oauthVaultEncryption: 'required',
      mcpServers: { api: server, other: server },
    });
    expect(snapshot.vaultEncryption).toBe('required');
    expect(snapshot.servers.map((d) => d.oauthVaultEncryption)).toEqual(['required', 'required']);
  });
  it('rejects unknown values', () => {
    expect(() => RawConfigSchema.parse({ mcpServers: {}, oauthVaultEncryption: 'always' })).toThrow();
  });
});
