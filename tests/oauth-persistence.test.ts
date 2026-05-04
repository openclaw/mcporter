import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { readJsonFile } from '../src/fs-json.js';
import { buildOAuthPersistence, clearOAuthCaches } from '../src/oauth-persistence.js';
import { loadVaultEntry, vaultKeyForDefinition } from '../src/oauth-vault.js';

const mkDef = (name: string, tokenCacheDir?: string): ServerDefinition => ({
  name,
  description: `${name} server`,
  command: { kind: 'http', url: new URL('https://example.com/mcp') },
  auth: 'oauth',
  tokenCacheDir,
});

describe('oauth persistence', () => {
  const originalEnv = { ...process.env };
  const tempRoots: string[] = [];
  let homedirSpy!: ReturnType<typeof vi.spyOn>;
  let hasSpy = false;

  afterEach(async () => {
    process.env = { ...originalEnv };
    if (hasSpy) {
      homedirSpy.mockRestore();
      hasSpy = false;
    }
    await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('prefers explicit tokenCacheDir before vault when reading tokens', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;

    const cacheDir = path.join(tmp, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, 'tokens.json'),
      JSON.stringify({ access_token: 'from-cache', token_type: 'Bearer' })
    );

    // Vault also contains a token, but cache dir should win.
    const vaultPath = path.join(tmp, '.mcporter', 'credentials.json');
    await fs.mkdir(path.dirname(vaultPath), { recursive: true });
    const definition = mkDef('service', cacheDir);
    const key = vaultKeyForDefinition(definition);
    await fs.writeFile(
      vaultPath,
      JSON.stringify({
        version: 1,
        entries: {
          [key]: {
            updatedAt: new Date().toISOString(),
            tokens: { access_token: 'from-vault', token_type: 'Bearer' },
            serverName: 'service',
          },
        },
      })
    );

    const persistence = await buildOAuthPersistence(definition);

    expect(await persistence.readTokens()).toEqual({ access_token: 'from-cache', token_type: 'Bearer' });
    // Saving should propagate to both stores.
    await persistence.saveTokens({ access_token: 'new-token', token_type: 'Bearer' });
    const cacheTokens = (await readJsonFile(path.join(cacheDir, 'tokens.json'))) as
      | { access_token: string }
      | undefined;
    expect(cacheTokens?.access_token).toBe('new-token');
    const entry = await loadVaultEntry(definition);
    expect(entry?.tokens?.access_token).toBe('new-token');
  });

  it('migrates legacy per-server cache into the vault', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;

    const legacyDir = path.join(tmp, '.mcporter', 'legacy-service');
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(
      path.join(legacyDir, 'tokens.json'),
      JSON.stringify({ access_token: 'legacy-token', token_type: 'Bearer' })
    );

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as const;
    const definition = mkDef('legacy-service');
    const persistence = await buildOAuthPersistence(definition, logger);

    expect(await persistence.readTokens()).toEqual({ access_token: 'legacy-token', token_type: 'Bearer' });
    const entry = await loadVaultEntry(definition);
    expect(entry?.tokens?.access_token).toBe('legacy-token');
    expect(logger.info).toHaveBeenCalledWith("Migrated legacy OAuth cache for 'legacy-service' into vault.");
  });

  it('writes the shared vault under XDG_DATA_HOME when configured', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-xdg-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
    hasSpy = true;
    process.env.XDG_DATA_HOME = path.join(tmp, 'data');

    const definition = mkDef('xdg-service');
    const persistence = await buildOAuthPersistence(definition);
    await persistence.saveTokens({ access_token: 'xdg-token', token_type: 'Bearer' });

    const vaultPath = path.join(tmp, 'data', 'mcporter', 'credentials.json');
    const key = vaultKeyForDefinition(definition);
    const vault = (await readJsonFile(vaultPath)) as
      | { entries: Record<string, { tokens?: { access_token?: string } }> }
      | undefined;
    expect(vault?.entries[key]?.tokens?.access_token).toBe('xdg-token');
  });

  it('clears vault, legacy, tokenCacheDir, and provider-specific caches', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;

    const cacheDir = path.join(tmp, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, 'tokens.json'),
      JSON.stringify({ access_token: 'cached', token_type: 'Bearer' })
    );

    const legacyDir = path.join(tmp, '.mcporter', 'gmail');
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(
      path.join(legacyDir, 'tokens.json'),
      JSON.stringify({ access_token: 'legacy', token_type: 'Bearer' })
    );

    const gmailLegacyFile = path.join(tmp, '.gmail-mcp', 'credentials.json');
    await fs.mkdir(path.dirname(gmailLegacyFile), { recursive: true });
    await fs.writeFile(gmailLegacyFile, '{}');

    const vaultPath = path.join(tmp, '.mcporter', 'credentials.json');
    await fs.mkdir(path.dirname(vaultPath), { recursive: true });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as const;
    const definition = mkDef('gmail', cacheDir);
    const key = vaultKeyForDefinition(definition);
    await fs.writeFile(
      vaultPath,
      JSON.stringify({
        version: 1,
        entries: {
          [key]: { serverName: 'gmail', updatedAt: new Date().toISOString(), tokens: { access_token: 'vault' } },
        },
      })
    );

    await clearOAuthCaches(definition, logger, 'all');

    await expect(fs.access(path.join(cacheDir, 'tokens.json'))).rejects.toThrow();
    await expect(fs.access(path.join(legacyDir, 'tokens.json'))).rejects.toThrow();
    await expect(fs.access(gmailLegacyFile)).rejects.toThrow();
    const entry = await loadVaultEntry(definition);
    expect(entry).toBeUndefined();
  });
});
