import fs from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthTokens } from '@modelcontextprotocol/client';
import type { ServerDefinition } from '../src/config.js';
import { readJsonFile, withFileLock } from '../src/fs-json.js';
import { buildOAuthPersistence, clearOAuthCaches, readCachedAccessToken } from '../src/oauth-persistence.js';
import { withRefreshLock } from '../src/oauth-refresh-lock.js';
import { clearVaultEntry, loadVaultEntry, saveVaultEntry, vaultKeyForDefinition } from '../src/oauth-vault.js';
import { getOAuthVaultPath } from '../src/oauth-vault.js';
import { isVaultSecretJwe, openVaultSecret, sealVaultSecret, vaultSecretKid } from '../src/oauth-vault-encryption.js';
import { DirectoryPersistence, clearLegacyOAuthArtifacts } from '../src/oauth-persistence-stores.js';

const authMocks = vi.hoisted(() => ({
  discoverOAuthServerInfo: vi.fn(),
  refreshAuthorization: vi.fn(),
}));

const codecMocks = vi.hoisted(() => ({ sealVaultSecret: vi.fn() }));
vi.mock('../src/oauth-vault-encryption.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/oauth-vault-encryption.js')>();
  codecMocks.sealVaultSecret.mockImplementation(original.sealVaultSecret);
  return { ...original, sealVaultSecret: codecMocks.sealVaultSecret };
});

vi.mock('@modelcontextprotocol/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@modelcontextprotocol/client')>()),
  discoverOAuthServerInfo: authMocks.discoverOAuthServerInfo,
  refreshAuthorization: authMocks.refreshAuthorization,
}));

const mkDef = (name: string, tokenCacheDir?: string): ServerDefinition => ({
  name,
  description: `${name} server`,
  command: { kind: 'http', url: new URL('https://example.com/mcp') },
  auth: 'oauth',
  tokenCacheDir,
});

const withUrl = (definition: ServerDefinition, url: string): ServerDefinition => ({
  ...definition,
  command: { kind: 'http', url: new URL(url) },
});

function held(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('oauth persistence', () => {
  const originalEnv = { ...process.env };
  const tempRoots: string[] = [];
  let homedirSpy!: ReturnType<typeof vi.spyOn>;
  let hasSpy = false;

  beforeEach(() => {
    // The vault honors XDG_* dirs (src/paths.ts), which the os.homedir() spy does
    // not cover — without this, tests read and write the developer's real vault.
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_STATE_HOME;
    delete process.env.XDG_CACHE_HOME;
  });

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
    if (hasSpy) {
      homedirSpy.mockRestore();
      hasSpy = false;
    }
    await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('degrades corrupt credential caches to undefined but keeps corrupt OAuth state failing closed', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-corrupt-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;

    const cacheDir = path.join(tmp, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    // Truncated / malformed credential files, e.g. an interrupted write.
    await fs.writeFile(path.join(cacheDir, 'tokens.json'), '{ "access_token": "part');
    await fs.writeFile(path.join(cacheDir, 'client.json'), 'not json at all');
    await fs.writeFile(path.join(cacheDir, 'state.txt'), '"unterminated');

    const persistence = await buildOAuthPersistence(mkDef('service', cacheDir));

    // Corrupt credential caches must read as "no usable credentials" (degrade to
    // re-auth), not surface a SyntaxError that crashes the connection.
    expect(await persistence.readTokens()).toBeUndefined();
    expect(await persistence.readClientInfo()).toBeUndefined();
    // OAuth state must NOT silently degrade: returning undefined would skip the
    // CSRF state check on callback (oauth.ts). It must fail closed.
    await expect(persistence.readState()).rejects.toThrow(SyntaxError);
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

  it('round-trips discovery state and resolved URLs through directory and vault stores', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-discovery-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;
    const definition = mkDef('discovery-service', path.join(tmp, 'cache'));
    const persistence = await buildOAuthPersistence(definition);
    const discoveryState = {
      authorizationServerUrl: 'https://auth.example.com',
      resourceMetadataUrl: 'https://example.com/.well-known/oauth-protected-resource',
    };

    await persistence.saveDiscoveryState(discoveryState);
    await persistence.saveAuthorizationServerUrl('https://auth.example.com');
    await persistence.saveResourceUrl('https://example.com/mcp');

    await expect(persistence.readDiscoveryState()).resolves.toEqual(discoveryState);
    await expect(persistence.readAuthorizationServerUrl()).resolves.toBe('https://auth.example.com');
    await expect(persistence.readResourceUrl()).resolves.toBe('https://example.com/mcp');
    const vaultEntry = await loadVaultEntry(definition);
    expect(vaultEntry).toMatchObject({
      discoveryState,
      authorizationServerUrl: 'https://auth.example.com',
      resourceUrl: 'https://example.com/mcp',
    });
  });

  it('preserves cached OAuth state when the configured server URL is unchanged', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-url-same-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
    hasSpy = true;
    process.env.XDG_DATA_HOME = path.join(tmp, 'data');

    const definition = mkDef('supabase', path.join(tmp, 'cache'));
    const initial = await buildOAuthPersistence(definition);
    await initial.saveTokens({ access_token: 'token-a', token_type: 'Bearer' });
    await initial.saveClientInfo({ client_id: 'client-a' });
    await initial.saveCodeVerifier('verifier-a');
    await initial.saveState('state-a');

    const unchanged = await buildOAuthPersistence(withUrl(definition, 'https://example.com/mcp'));
    await expect(unchanged.readTokens()).resolves.toMatchObject({ access_token: 'token-a' });
    await expect(unchanged.readClientInfo()).resolves.toMatchObject({ client_id: 'client-a' });
    await expect(unchanged.readCodeVerifier()).resolves.toBe('verifier-a');
    await expect(unchanged.readState()).resolves.toBe('state-a');
  });

  it('invalidates cached OAuth state when the configured server URL changes', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-url-change-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
    hasSpy = true;
    process.env.XDG_DATA_HOME = path.join(tmp, 'data');

    const original = mkDef('supabase', path.join(tmp, 'cache'));
    const initial = await buildOAuthPersistence(original);
    await initial.saveTokens({ access_token: 'token-a', token_type: 'Bearer' });
    await initial.saveClientInfo({ client_id: 'client-a' });
    await initial.saveCodeVerifier('verifier-a');
    await initial.saveState('state-a');

    const changed = await buildOAuthPersistence(withUrl(original, 'https://other.example.com/mcp'));
    await expect(changed.readTokens()).resolves.toBeUndefined();
    await expect(changed.readClientInfo()).resolves.toBeUndefined();
    await expect(changed.readCodeVerifier()).resolves.toBeUndefined();
    await expect(changed.readState()).resolves.toBeUndefined();
  });

  it('does not restore cached OAuth state when a changed server URL is reverted', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-url-revert-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
    hasSpy = true;
    process.env.XDG_DATA_HOME = path.join(tmp, 'data');

    const original = mkDef('supabase', path.join(tmp, 'cache'));
    const initial = await buildOAuthPersistence(original);
    await initial.saveTokens({ access_token: 'token-a', token_type: 'Bearer' });
    await initial.saveClientInfo({ client_id: 'client-a' });

    const changed = await buildOAuthPersistence(withUrl(original, 'https://other.example.com/mcp'));
    await expect(changed.readTokens()).resolves.toBeUndefined();

    const reverted = await buildOAuthPersistence(original);
    await expect(reverted.readTokens()).resolves.toBeUndefined();
    await expect(reverted.readClientInfo()).resolves.toBeUndefined();
  });

  it.runIf(process.platform !== 'win32')(
    'keeps an explicit token cache usable when the lower-priority vault is unreadable',
    async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-cache-vault-unreadable-'));
      tempRoots.push(tmp);
      homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
      hasSpy = true;
      process.env.XDG_DATA_HOME = path.join(tmp, 'data');

      const cacheDir = path.join(tmp, 'cache');
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(
        path.join(cacheDir, 'tokens.json'),
        JSON.stringify({ access_token: 'from-cache', token_type: 'Bearer' })
      );
      await fs.writeFile(path.join(cacheDir, 'client.json'), JSON.stringify({ client_id: 'cache-client' }));

      const vaultPath = path.join(tmp, 'data', 'mcporter', 'credentials.json');
      await fs.mkdir(path.dirname(vaultPath), { recursive: true });
      await fs.writeFile(vaultPath, JSON.stringify({ version: 1, entries: {} }), 'utf8');

      try {
        await fs.chmod(vaultPath, 0o000);
        const persistence = await buildOAuthPersistence(mkDef('service', cacheDir));

        await expect(persistence.readTokens()).resolves.toEqual({
          access_token: 'from-cache',
          token_type: 'Bearer',
        });
        await expect(persistence.readClientInfo()).resolves.toEqual({ client_id: 'cache-client' });
      } finally {
        await fs.chmod(vaultPath, 0o600).catch(() => {});
      }
    }
  );

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

  it('retains a hidden token generation while migrating a generated legacy cache', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-generated-migration-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;

    const definition = mkDef('generated-migration');
    const legacyDir = path.join(tmp, '.mcporter', definition.name);
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(
      path.join(legacyDir, 'tokens.json'),
      JSON.stringify({ access_token: 'old', token_type: 'Bearer', __mcporter_generation: 'gen-1' })
    );

    await buildOAuthPersistence(definition);

    const rawVault = (await readJsonFile(path.join(tmp, '.mcporter', 'credentials.json'))) as
      | { entries: Record<string, { tokens?: { __mcporter_generation?: string } }> }
      | undefined;
    expect(rawVault?.entries[vaultKeyForDefinition(definition)]?.tokens?.__mcporter_generation).toBe('gen-1');
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

  it('serializes concurrent shared vault writes for different servers', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-vault-race-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
    hasSpy = true;
    process.env.XDG_DATA_HOME = path.join(tmp, 'data');

    const definitions = Array.from({ length: 12 }, (_, index) => mkDef(`service-${index}`));
    await Promise.all(
      definitions.map((definition, index) =>
        saveVaultEntry(definition, {
          tokens: { access_token: `token-${index}`, token_type: 'Bearer' },
        })
      )
    );

    const vaultPath = path.join(tmp, 'data', 'mcporter', 'credentials.json');
    const vault = (await readJsonFile(vaultPath)) as
      | { entries: Record<string, { tokens?: { access_token?: string } }> }
      | undefined;
    expect(Object.keys(vault?.entries ?? {})).toHaveLength(definitions.length);
    for (const [index, definition] of definitions.entries()) {
      expect(vault?.entries[vaultKeyForDefinition(definition)]?.tokens?.access_token).toBe(`token-${index}`);
    }
  });

  it('reuses same-url vault credentials after an OAuth server is renamed', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-vault-rename-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
    hasSpy = true;
    process.env.XDG_DATA_HOME = path.join(tmp, 'data');

    const oldDefinition = mkDef('cloudflare-oauth');
    const currentDefinition = mkDef('cloudflare');
    await saveVaultEntry(oldDefinition, {
      tokens: {
        access_token: 'expired-token',
        token_type: 'Bearer',
        refresh_token: 'refresh-123',
        expires_at: Math.floor(Date.now() / 1000) - 30,
      } as never,
      clientInfo: {
        client_id: 'client-123',
        redirect_uris: ['http://127.0.0.1:44444/callback'],
      },
    });
    await saveVaultEntry(currentDefinition, {
      clientInfo: {
        client_id: 'client-123',
        redirect_uris: ['http://127.0.0.1:55555/callback'],
      },
    });

    authMocks.discoverOAuthServerInfo.mockResolvedValue({
      authorizationServerUrl: 'https://auth.example.com',
      authorizationServerMetadata: { token_endpoint: 'https://auth.example.com/token' },
      resourceMetadata: { resource: 'https://example.com/mcp' },
    });
    authMocks.refreshAuthorization.mockResolvedValue({
      access_token: 'fresh-token',
      token_type: 'Bearer',
      refresh_token: 'refresh-456',
      expires_in: 3600,
    });

    await expect(readCachedAccessToken(currentDefinition)).resolves.toBe('fresh-token');

    expect(authMocks.refreshAuthorization).toHaveBeenCalledWith(
      'https://auth.example.com',
      expect.objectContaining({
        clientInformation: expect.objectContaining({ client_id: 'client-123' }),
        refreshToken: 'refresh-123',
        resource: new URL('https://example.com/mcp'),
      })
    );
    await expect(loadVaultEntry(currentDefinition)).resolves.toMatchObject({
      serverName: 'cloudflare',
      tokens: { access_token: 'fresh-token', refresh_token: 'refresh-456' },
      clientInfo: { client_id: 'client-123' },
    });
  });

  it('materializes inherited OAuth client info when renamed credentials refresh', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-vault-rename-materialize-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
    hasSpy = true;
    process.env.XDG_DATA_HOME = path.join(tmp, 'data');

    const oldDefinition = mkDef('cloudflare-oauth');
    const currentDefinition = mkDef('cloudflare');
    await saveVaultEntry(oldDefinition, {
      tokens: {
        access_token: 'expired-token',
        token_type: 'Bearer',
        refresh_token: 'refresh-123',
        expires_at: Math.floor(Date.now() / 1000) - 30,
      } as never,
      clientInfo: { client_id: 'client-123' },
    });

    authMocks.discoverOAuthServerInfo.mockResolvedValue({
      authorizationServerUrl: 'https://auth.example.com',
      authorizationServerMetadata: { token_endpoint: 'https://auth.example.com/token' },
    });
    authMocks.refreshAuthorization.mockResolvedValue({
      access_token: 'fresh-token',
      token_type: 'Bearer',
      refresh_token: 'refresh-456',
      expires_in: 3600,
    });

    await expect(readCachedAccessToken(currentDefinition)).resolves.toBe('fresh-token');

    await expect(loadVaultEntry(currentDefinition)).resolves.toMatchObject({
      serverName: 'cloudflare',
      tokens: { access_token: 'fresh-token', refresh_token: 'refresh-456' },
      clientInfo: { client_id: 'client-123' },
    });
  });

  it('materializes inherited OAuth client info into partial renamed vault entries', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-vault-rename-partial-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
    hasSpy = true;
    process.env.XDG_DATA_HOME = path.join(tmp, 'data');

    const oldDefinition = mkDef('cloudflare-oauth');
    const currentDefinition = mkDef('cloudflare');
    await saveVaultEntry(oldDefinition, {
      tokens: {
        access_token: 'expired-token',
        token_type: 'Bearer',
        refresh_token: 'refresh-123',
        expires_at: Math.floor(Date.now() / 1000) - 30,
      } as never,
      clientInfo: { client_id: 'client-123' },
    });
    await saveVaultEntry(currentDefinition, { state: 'oauth-state' });

    authMocks.discoverOAuthServerInfo.mockResolvedValue({ authorizationServerUrl: 'https://auth.example.com' });
    authMocks.refreshAuthorization.mockResolvedValue({
      access_token: 'fresh-token',
      token_type: 'Bearer',
      refresh_token: 'refresh-456',
      expires_in: 3600,
    });

    await expect(readCachedAccessToken(currentDefinition)).resolves.toBe('fresh-token');

    await expect(loadVaultEntry(currentDefinition)).resolves.toMatchObject({
      state: 'oauth-state',
      tokens: { access_token: 'fresh-token' },
      clientInfo: { client_id: 'client-123' },
    });
  });

  it('does not combine same-url OAuth tokens with a different dynamic client', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-vault-client-mismatch-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
    hasSpy = true;
    process.env.XDG_DATA_HOME = path.join(tmp, 'data');

    const oldDefinition = mkDef('cloudflare-oauth');
    const currentDefinition = mkDef('cloudflare');
    await saveVaultEntry(oldDefinition, {
      tokens: { access_token: 'old-token', token_type: 'Bearer', refresh_token: 'refresh-123' },
      clientInfo: { client_id: 'old-client' },
    });
    await saveVaultEntry(currentDefinition, {
      clientInfo: { client_id: 'current-client' },
    });

    await expect(loadVaultEntry(currentDefinition)).resolves.toMatchObject({
      serverName: 'cloudflare',
      clientInfo: { client_id: 'current-client' },
    });
    expect((await loadVaultEntry(currentDefinition))?.tokens).toBeUndefined();
    await expect(readCachedAccessToken(currentDefinition)).resolves.toBeUndefined();
    expect(authMocks.refreshAuthorization).not.toHaveBeenCalled();
  });

  it('does not inherit same-url OAuth tokens for a different configured client id', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-vault-static-client-mismatch-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
    hasSpy = true;
    process.env.XDG_DATA_HOME = path.join(tmp, 'data');

    await saveVaultEntry(mkDef('cloudflare-oauth'), {
      tokens: { access_token: 'old-token', token_type: 'Bearer', refresh_token: 'refresh-123' },
      clientInfo: { client_id: 'old-client' },
    });

    const currentDefinition: ServerDefinition = {
      ...mkDef('cloudflare'),
      oauthClientId: 'current-client',
    };
    await expect(loadVaultEntry(currentDefinition)).resolves.toBeUndefined();
    await expect(readCachedAccessToken(currentDefinition)).resolves.toBeUndefined();
    expect(authMocks.refreshAuthorization).not.toHaveBeenCalled();
  });

  it('uses one same-url vault entry for inherited OAuth tokens and client info', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-vault-single-source-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
    hasSpy = true;
    process.env.XDG_DATA_HOME = path.join(tmp, 'data');

    await saveVaultEntry(mkDef('cloudflare-oauth'), {
      tokens: { access_token: 'old-token', token_type: 'Bearer', refresh_token: 'refresh-old' },
      clientInfo: { client_id: 'old-client' },
    });
    await saveVaultEntry(mkDef('cloudflare-newer-client-only'), {
      clientInfo: { client_id: 'newer-client' },
    });

    await expect(loadVaultEntry(mkDef('cloudflare'))).resolves.toMatchObject({
      serverName: 'cloudflare',
      tokens: { access_token: 'old-token' },
      clientInfo: { client_id: 'old-client' },
    });
  });

  it('does not inherit unrelated same-url OAuth vault credentials', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-vault-unrelated-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
    hasSpy = true;
    process.env.XDG_DATA_HOME = path.join(tmp, 'data');

    await saveVaultEntry(mkDef('cloudflare-other'), {
      tokens: { access_token: 'other-token', token_type: 'Bearer', refresh_token: 'refresh-other' },
      clientInfo: { client_id: 'other-client' },
    });

    await expect(loadVaultEntry(mkDef('cloudflare'))).resolves.toBeUndefined();
  });

  it('does not add same-url client info to an exact token-only vault entry', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-vault-token-only-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
    hasSpy = true;
    process.env.XDG_DATA_HOME = path.join(tmp, 'data');

    const currentDefinition = mkDef('cloudflare');
    await saveVaultEntry(currentDefinition, {
      tokens: { access_token: 'current-token', token_type: 'Bearer', refresh_token: 'refresh-current' },
    });
    await saveVaultEntry(mkDef('cloudflare-other'), {
      tokens: { access_token: 'other-token', token_type: 'Bearer', refresh_token: 'refresh-other' },
      clientInfo: { client_id: 'other-client' },
    });

    const entry = await loadVaultEntry(currentDefinition);
    expect(entry?.tokens?.access_token).toBe('current-token');
    expect(entry?.clientInfo).toBeUndefined();
  });

  it('does not materialize inherited client info when exact tokens already exist', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-vault-token-save-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
    hasSpy = true;
    process.env.XDG_DATA_HOME = path.join(tmp, 'data');

    const currentDefinition = mkDef('cloudflare');
    await saveVaultEntry(currentDefinition, {
      tokens: { access_token: 'current-token', token_type: 'Bearer', refresh_token: 'refresh-current' },
    });
    await saveVaultEntry(mkDef('cloudflare-oauth'), {
      tokens: { access_token: 'old-token', token_type: 'Bearer', refresh_token: 'refresh-old' },
      clientInfo: { client_id: 'old-client' },
    });
    await saveVaultEntry(currentDefinition, {
      tokens: { access_token: 'new-current-token', token_type: 'Bearer', refresh_token: 'refresh-new-current' },
    });

    const entry = await loadVaultEntry(currentDefinition);
    expect(entry?.tokens?.access_token).toBe('new-current-token');
    expect(entry?.clientInfo).toBeUndefined();
  });

  it('clears inherited same-url OAuth vault credentials', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-vault-clear-inherited-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
    hasSpy = true;
    process.env.XDG_DATA_HOME = path.join(tmp, 'data');

    const oldDefinition = mkDef('cloudflare-oauth');
    const currentDefinition = mkDef('cloudflare');
    await saveVaultEntry(oldDefinition, {
      tokens: { access_token: 'old-token', token_type: 'Bearer', refresh_token: 'refresh-123' },
      clientInfo: { client_id: 'old-client' },
    });

    await expect(loadVaultEntry(currentDefinition)).resolves.toMatchObject({
      tokens: { access_token: 'old-token' },
      clientInfo: { client_id: 'old-client' },
    });

    await clearVaultEntry(currentDefinition, 'all');

    await expect(loadVaultEntry(currentDefinition)).resolves.toBeUndefined();
    await expect(loadVaultEntry(oldDefinition)).resolves.toBeUndefined();
  });

  it('keeps inherited OAuth client info reachable after token-only invalidation', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-vault-clear-inherited-tokens-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
    hasSpy = true;
    process.env.XDG_DATA_HOME = path.join(tmp, 'data');

    const oldDefinition = mkDef('cloudflare-oauth');
    const currentDefinition = mkDef('cloudflare');
    await saveVaultEntry(oldDefinition, {
      tokens: { access_token: 'old-token', token_type: 'Bearer', refresh_token: 'refresh-123' },
      clientInfo: { client_id: 'old-client' },
    });

    await clearVaultEntry(currentDefinition, 'tokens');

    const entry = await loadVaultEntry(currentDefinition);
    expect(entry?.tokens).toBeUndefined();
    expect(entry?.clientInfo).toEqual(expect.objectContaining({ client_id: 'old-client' }));
  });

  it('clears legacy renamed credentials blocked by an exact client mismatch', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-vault-clear-blocked-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
    hasSpy = true;
    process.env.XDG_DATA_HOME = path.join(tmp, 'data');

    const oldDefinition = mkDef('cloudflare-oauth');
    const currentDefinition = mkDef('cloudflare');
    await saveVaultEntry(oldDefinition, {
      tokens: { access_token: 'old-token', token_type: 'Bearer', refresh_token: 'refresh-123' },
      clientInfo: { client_id: 'old-client' },
    });
    await saveVaultEntry(currentDefinition, {
      tokens: { access_token: 'current-token', token_type: 'Bearer', refresh_token: 'refresh-456' },
      clientInfo: { client_id: 'current-client' },
    });

    await clearVaultEntry(currentDefinition, 'all');

    await expect(loadVaultEntry(currentDefinition)).resolves.toBeUndefined();
    await expect(loadVaultEntry(oldDefinition)).resolves.toBeUndefined();
  });

  it('does not create a vault file when clearing a missing vault entry', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-vault-clear-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
    hasSpy = true;
    process.env.XDG_DATA_HOME = path.join(tmp, 'data');

    const vaultPath = path.join(tmp, 'data', 'mcporter', 'credentials.json');
    await clearVaultEntry(mkDef('missing'), 'all');

    await expect(fs.access(vaultPath)).rejects.toThrow();
    await expect(fs.access(`${vaultPath}.lock`)).rejects.toThrow();
  });

  it('rewrites a corrupt vault file when clearing a missing vault entry', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-vault-corrupt-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
    hasSpy = true;
    process.env.XDG_DATA_HOME = path.join(tmp, 'data');

    const vaultPath = path.join(tmp, 'data', 'mcporter', 'credentials.json');
    await fs.mkdir(path.dirname(vaultPath), { recursive: true });
    await fs.writeFile(vaultPath, '{"version":1,"entries": { bad', 'utf8');

    await clearVaultEntry(mkDef('missing'), 'all');

    expect(await readJsonFile(vaultPath)).toEqual({ version: 2, entries: {} });
    await expect(fs.access(`${vaultPath}.lock`)).rejects.toThrow();
  });

  it('skips malformed unrelated vault entries during same-url fallback scans', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-vault-malformed-entry-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
    hasSpy = true;
    process.env.XDG_DATA_HOME = path.join(tmp, 'data');

    const definition = mkDef('cloudflare');
    const vaultPath = path.join(tmp, 'data', 'mcporter', 'credentials.json');
    await fs.mkdir(path.dirname(vaultPath), { recursive: true });
    await fs.writeFile(
      vaultPath,
      JSON.stringify({
        version: 1,
        entries: {
          bad: null,
          malformed: { serverName: 'cloudflare-oauth', serverUrl: 'https://example.com/mcp' },
        },
      }),
      'utf8'
    );

    await expect(loadVaultEntry(definition)).resolves.toBeUndefined();
    await expect(saveVaultEntry(definition, { state: 'ok' })).resolves.toBeUndefined();
    await expect(clearVaultEntry(definition, 'all')).resolves.toBeUndefined();
  });

  it('degrades malformed stored issuer stamps to missing credentials', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-vault-invalid-issuer-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
    hasSpy = true;
    process.env.XDG_DATA_HOME = path.join(tmp, 'data');

    const definition = mkDef('invalid-issuer');
    const vaultPath = path.join(tmp, 'data', 'mcporter', 'credentials.json');
    await fs.mkdir(path.dirname(vaultPath), { recursive: true });
    await fs.writeFile(
      vaultPath,
      JSON.stringify({
        version: 2,
        entries: {
          [vaultKeyForDefinition(definition)]: {
            serverName: definition.name,
            serverUrl: 'https://example.com/mcp',
            tokens: {
              access_token: 'token',
              token_type: 'Bearer',
              issuer: { url: 'https://issuer.example' },
            },
            updatedAt: new Date().toISOString(),
          },
        },
      }),
      'utf8'
    );

    const persistence = await buildOAuthPersistence(definition);
    await expect(persistence.readTokens()).resolves.toBeUndefined();
    await expect(loadVaultEntry(definition)).resolves.not.toHaveProperty('tokens');
    await expect(readCachedAccessToken(definition)).resolves.toBeUndefined();
  });

  it.runIf(process.platform !== 'win32')('surfaces unreadable vault files', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-vault-unreadable-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
    hasSpy = true;
    process.env.XDG_DATA_HOME = path.join(tmp, 'data');

    const definition = mkDef('unreadable');
    const vaultPath = path.join(tmp, 'data', 'mcporter', 'credentials.json');
    await fs.mkdir(path.dirname(vaultPath), { recursive: true });
    await fs.writeFile(vaultPath, JSON.stringify({ version: 1, entries: {} }), 'utf8');

    try {
      await fs.chmod(vaultPath, 0o000);
      await expect(loadVaultEntry(definition)).rejects.toThrow();
    } finally {
      await fs.chmod(vaultPath, 0o600).catch(() => {});
    }
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

  it('refreshes expired cached OAuth access tokens without starting a browser flow', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-refresh-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;

    const cacheDir = path.join(tmp, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, 'tokens.json'),
      JSON.stringify({
        access_token: 'expired-token',
        token_type: 'Bearer',
        refresh_token: 'refresh-123',
        expires_at: Math.floor(Date.now() / 1000) - 30,
      })
    );
    await fs.writeFile(path.join(cacheDir, 'client.json'), JSON.stringify({ client_id: 'client-123' }));

    authMocks.discoverOAuthServerInfo.mockResolvedValue({
      authorizationServerUrl: 'https://auth.example.com',
      authorizationServerMetadata: { token_endpoint: 'https://auth.example.com/token' },
      resourceMetadata: { resource: 'https://example.com/mcp' },
    });
    authMocks.refreshAuthorization.mockResolvedValue({
      access_token: 'fresh-token',
      token_type: 'Bearer',
      refresh_token: 'refresh-456',
      expires_in: 3600,
    });

    const definition = mkDef('refresh-service', cacheDir);
    await expect(readCachedAccessToken(definition)).resolves.toBe('fresh-token');

    expect(authMocks.refreshAuthorization).toHaveBeenCalledWith(
      'https://auth.example.com',
      expect.objectContaining({
        clientInformation: { client_id: 'client-123' },
        refreshToken: 'refresh-123',
        resource: new URL('https://example.com/mcp'),
      })
    );
    const persisted = (await readJsonFile(path.join(cacheDir, 'tokens.json'))) as
      | { access_token?: string; refresh_token?: string; expires_at?: number }
      | undefined;
    expect(persisted?.access_token).toBe('fresh-token');
    expect(persisted?.refresh_token).toBe('refresh-456');
    expect(persisted?.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('rejects issuer-mismatched silent refresh credentials without transmitting the refresh token', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-refresh-issuer-mismatch-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;

    const cacheDir = path.join(tmp, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, 'tokens.json'),
      JSON.stringify({
        access_token: 'expired-token',
        token_type: 'Bearer',
        refresh_token: 'refresh-secret-a',
        expires_at: Math.floor(Date.now() / 1000) - 30,
        issuer: 'https://issuer-a.example',
      })
    );
    await fs.writeFile(
      path.join(cacheDir, 'client.json'),
      JSON.stringify({ client_id: 'client-a', issuer: 'https://issuer-a.example' })
    );
    authMocks.discoverOAuthServerInfo.mockResolvedValue({
      authorizationServerUrl: 'https://issuer-b.example',
      authorizationServerMetadata: { token_endpoint: 'https://issuer-b.example/token' },
    });

    const definition = mkDef('issuer-bound-service', cacheDir);
    await expect(readCachedAccessToken(definition)).rejects.toThrow(
      /issuer-bound-service.*expected https:\/\/issuer-a\.example.*received https:\/\/issuer-b\.example/i
    );

    expect(authMocks.refreshAuthorization).not.toHaveBeenCalled();
    await expect(readJsonFile(path.join(cacheDir, 'tokens.json'))).resolves.toBeUndefined();
    await expect(readJsonFile(path.join(cacheDir, 'client.json'))).resolves.toBeUndefined();
  });

  it('stamps refreshed OAuth tokens with the discovered issuer', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-refresh-issuer-stamp-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;

    const cacheDir = path.join(tmp, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, 'tokens.json'),
      JSON.stringify({
        access_token: 'expired-token',
        token_type: 'Bearer',
        refresh_token: 'refresh-123',
        expires_at: Math.floor(Date.now() / 1000) - 30,
        issuer: 'https://auth.example.com',
      })
    );
    await fs.writeFile(
      path.join(cacheDir, 'client.json'),
      JSON.stringify({ client_id: 'client-123', issuer: 'https://auth.example.com' })
    );
    authMocks.discoverOAuthServerInfo.mockResolvedValue({
      authorizationServerUrl: 'https://auth.example.com',
      authorizationServerMetadata: { token_endpoint: 'https://auth.example.com/token' },
    });
    authMocks.refreshAuthorization.mockResolvedValue({
      access_token: 'fresh-token',
      token_type: 'Bearer',
      refresh_token: 'refresh-456',
      expires_in: 3600,
    });

    await expect(readCachedAccessToken(mkDef('issuer-stamp-service', cacheDir))).resolves.toBe('fresh-token');
    await expect(readJsonFile(path.join(cacheDir, 'tokens.json'))).resolves.toMatchObject({
      access_token: 'fresh-token',
      issuer: 'https://auth.example.com',
    });
  });

  it('omits OAuth resource during silent refresh when protected-resource metadata is absent', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-refresh-no-resource-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;

    const cacheDir = path.join(tmp, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, 'tokens.json'),
      JSON.stringify({
        access_token: 'expired-token',
        token_type: 'Bearer',
        refresh_token: 'refresh-123',
        expires_at: Math.floor(Date.now() / 1000) - 30,
      })
    );
    await fs.writeFile(path.join(cacheDir, 'client.json'), JSON.stringify({ client_id: 'client-123' }));

    authMocks.discoverOAuthServerInfo.mockResolvedValue({
      authorizationServerUrl: 'https://auth.example.com',
      authorizationServerMetadata: { token_endpoint: 'https://auth.example.com/token' },
    });
    authMocks.refreshAuthorization.mockResolvedValue({
      access_token: 'fresh-token',
      token_type: 'Bearer',
      refresh_token: 'refresh-456',
      expires_in: 3600,
    });

    const definition = mkDef('refresh-without-resource-service', cacheDir);
    await expect(readCachedAccessToken(definition)).resolves.toBe('fresh-token');

    const [, options] = authMocks.refreshAuthorization.mock.calls[0] ?? [];
    expect(options).not.toHaveProperty('resource');
  });

  it('clears cached OAuth tokens when silent refresh fails permanently', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-refresh-fail-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;

    const cacheDir = path.join(tmp, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, 'tokens.json'),
      JSON.stringify({
        access_token: 'expired-token',
        token_type: 'Bearer',
        refresh_token: 'refresh-123',
        expires_at: Math.floor(Date.now() / 1000) - 30,
      })
    );
    await fs.writeFile(path.join(cacheDir, 'client.json'), JSON.stringify({ client_id: 'client-123' }));

    authMocks.discoverOAuthServerInfo.mockResolvedValue({ authorizationServerUrl: 'https://auth.example.com' });
    authMocks.refreshAuthorization.mockRejectedValue(
      Object.assign(new Error('Refresh token expired'), { errorCode: 'invalid_grant' })
    );

    const definition = mkDef('refresh-fail-service', cacheDir);
    await expect(readCachedAccessToken(definition)).resolves.toBeUndefined();

    const persisted = (await readJsonFile(path.join(cacheDir, 'tokens.json'))) as
      | { access_token?: string; refresh_token?: string }
      | undefined;
    expect(persisted).toBeUndefined();
    await expect(readJsonFile(path.join(cacheDir, 'client.json'))).resolves.toEqual({ client_id: 'client-123' });
  });

  it('keeps newer cached OAuth tokens when a concurrent refresh wins first', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-refresh-race-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;

    const cacheDir = path.join(tmp, 'cache');
    const definition = mkDef('refresh-race-service', cacheDir);
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, 'tokens.json'),
      JSON.stringify({
        access_token: 'expired-token',
        token_type: 'Bearer',
        refresh_token: 'refresh-old',
        expires_at: Math.floor(Date.now() / 1000) - 30,
      })
    );
    await fs.writeFile(path.join(cacheDir, 'client.json'), JSON.stringify({ client_id: 'client-123' }));

    authMocks.discoverOAuthServerInfo.mockResolvedValue({ authorizationServerUrl: 'https://auth.example.com' });
    authMocks.refreshAuthorization.mockImplementation(async () => {
      const persistence = await buildOAuthPersistence(definition);
      await persistence.saveTokens({
        access_token: 'fresh-token',
        token_type: 'Bearer',
        refresh_token: 'refresh-old',
        expires_in: 3600,
      });
      throw Object.assign(new Error('Refresh token expired'), { errorCode: 'invalid_grant' });
    });

    await expect(readCachedAccessToken(definition)).resolves.toBe('fresh-token');
    await expect(readJsonFile(path.join(cacheDir, 'tokens.json'))).resolves.toEqual(
      expect.objectContaining({ access_token: 'fresh-token', refresh_token: 'refresh-old' })
    );
  });

  it('clears migrated legacy OAuth tokens when silent refresh fails permanently', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-legacy-refresh-fail-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;

    const definition = mkDef('legacy-refresh-fail-service');
    const legacyDir = path.join(tmp, '.mcporter', definition.name);
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(
      path.join(legacyDir, 'tokens.json'),
      JSON.stringify({
        access_token: 'expired-token',
        token_type: 'Bearer',
        refresh_token: 'refresh-123',
        expires_at: Math.floor(Date.now() / 1000) - 30,
      })
    );
    await fs.writeFile(path.join(legacyDir, 'client.json'), JSON.stringify({ client_id: 'client-123' }));

    authMocks.discoverOAuthServerInfo.mockResolvedValue({ authorizationServerUrl: 'https://auth.example.com' });
    authMocks.refreshAuthorization.mockRejectedValue(
      Object.assign(new Error('Refresh token expired'), { errorCode: 'invalid_grant' })
    );

    await expect(readCachedAccessToken(definition)).resolves.toBeUndefined();
    // Without a vault password the legacy copy is kept as before; only the
    // rejected tokens are cleared.
    await expect(readJsonFile(path.join(legacyDir, 'tokens.json'))).resolves.toBeUndefined();
    await expect(readJsonFile(path.join(legacyDir, 'client.json'))).resolves.toEqual({ client_id: 'client-123' });

    authMocks.refreshAuthorization.mockClear();
    await expect(readCachedAccessToken(definition)).resolves.toBeUndefined();
    expect(authMocks.refreshAuthorization).not.toHaveBeenCalled();
  });

  it('clears cached OAuth client registration when refresh reports an invalid client', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-refresh-invalid-client-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;

    const cacheDir = path.join(tmp, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, 'tokens.json'),
      JSON.stringify({
        access_token: 'expired-token',
        token_type: 'Bearer',
        refresh_token: 'refresh-123',
        expires_at: Math.floor(Date.now() / 1000) - 30,
      })
    );
    await fs.writeFile(path.join(cacheDir, 'client.json'), JSON.stringify({ client_id: 'stale-client' }));

    authMocks.discoverOAuthServerInfo.mockResolvedValue({ authorizationServerUrl: 'https://auth.example.com' });
    authMocks.refreshAuthorization.mockRejectedValue(
      Object.assign(new Error('Client ID mismatch'), { errorCode: 'invalid_client' })
    );

    const definition = mkDef('refresh-invalid-client-service', cacheDir);
    await expect(readCachedAccessToken(definition)).resolves.toBeUndefined();

    await expect(readJsonFile(path.join(cacheDir, 'tokens.json'))).resolves.toBeUndefined();
    await expect(readJsonFile(path.join(cacheDir, 'client.json'))).resolves.toBeUndefined();
  });

  it('clears rejected credentials from stores that supplied different refresh inputs', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-split-refresh-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;
    process.env.XDG_DATA_HOME = path.join(tmp, 'data');

    const cacheDir = path.join(tmp, 'cache');
    const definition = mkDef('split-refresh', cacheDir);
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, 'client.json'), JSON.stringify({ client_id: 'stale' }));
    await saveVaultEntry(definition, {
      tokens: {
        access_token: 'old',
        token_type: 'Bearer',
        refresh_token: 'dead',
        expires_at: Math.floor(Date.now() / 1000) - 30,
      } as OAuthTokens,
    });

    authMocks.discoverOAuthServerInfo.mockResolvedValue({ authorizationServerUrl: 'https://auth.example.com' });
    authMocks.refreshAuthorization.mockRejectedValue(
      Object.assign(new Error('Client rejected'), { errorCode: 'invalid_client' })
    );

    await expect(readCachedAccessToken(definition)).resolves.toBeUndefined();
    await expect(readJsonFile(path.join(cacheDir, 'client.json'))).resolves.toBeUndefined();
    const remaining = await loadVaultEntry(definition);
    expect(remaining?.tokens).toBeUndefined();
  });

  it('preserves a concurrent directory-backed auth session during invalid-client recovery', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-directory-auth-race-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;

    const cacheDir = path.join(tmp, 'cache');
    const definition = mkDef('directory-auth-race', cacheDir);
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, 'tokens.json'),
      JSON.stringify({
        access_token: 'old',
        token_type: 'Bearer',
        refresh_token: 'dead',
        expires_at: Math.floor(Date.now() / 1000) - 30,
      })
    );
    await fs.writeFile(path.join(cacheDir, 'client.json'), JSON.stringify({ client_id: 'stale' }));

    authMocks.discoverOAuthServerInfo.mockResolvedValue({ authorizationServerUrl: 'https://auth.example.com' });
    authMocks.refreshAuthorization.mockImplementation(async () => {
      const concurrent = await buildOAuthPersistence(definition);
      await concurrent.saveClientInfo({ client_id: 'fresh' });
      await concurrent.saveCodeVerifier('verify');
      await concurrent.saveState('state');
      throw Object.assign(new Error('Client rejected'), { errorCode: 'invalid_client' });
    });

    await expect(readCachedAccessToken(definition)).resolves.toBeUndefined();
    await expect(readJsonFile(path.join(cacheDir, 'tokens.json'))).resolves.toBeUndefined();
    const remaining = await buildOAuthPersistence(definition);
    await expect(remaining.readClientInfo()).resolves.toEqual({ client_id: 'fresh' });
    await expect(remaining.readCodeVerifier()).resolves.toBe('verify');
    await expect(remaining.readState()).resolves.toBe('state');
  });

  it('preserves a same-value client registration rewritten by concurrent auth', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-client-generation-race-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;

    const cacheDir = path.join(tmp, 'cache');
    const definition = mkDef('client-generation-race', cacheDir);
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, 'tokens.json'),
      JSON.stringify({
        access_token: 'old',
        token_type: 'Bearer',
        refresh_token: 'dead',
        expires_at: Math.floor(Date.now() / 1000) - 30,
      })
    );
    await fs.writeFile(path.join(cacheDir, 'client.json'), JSON.stringify({ client_id: 'same' }));

    authMocks.discoverOAuthServerInfo.mockResolvedValue({ authorizationServerUrl: 'https://auth.example.com' });
    authMocks.refreshAuthorization.mockImplementation(async () => {
      const concurrent = await buildOAuthPersistence(definition);
      await concurrent.saveClientInfo({ client_id: 'same' });
      throw Object.assign(new Error('Client rejected'), { errorCode: 'invalid_client' });
    });

    await expect(readCachedAccessToken(definition)).resolves.toBeUndefined();
    await expect(readJsonFile(path.join(cacheDir, 'tokens.json'))).resolves.toBeUndefined();
    const remaining = await buildOAuthPersistence(definition);
    await expect(remaining.readClientInfo()).resolves.toEqual({ client_id: 'same' });
  });

  it.each(['invalid_client', 'unauthorized_client'] as const)(
    'preserves a same-token newer-expiry winner during %s recovery',
    async (errorCode) => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `mcporter-oauth-${errorCode}-winner-`));
      tempRoots.push(tmp);
      homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
      hasSpy = true;
      process.env.XDG_DATA_HOME = path.join(tmp, 'data');

      const cacheDir = path.join(tmp, 'cache');
      const definition = mkDef(`${errorCode}-winner-service`, cacheDir);
      const accessToken = 'same';
      const refreshToken = 'same-r';
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(
        path.join(cacheDir, 'tokens.json'),
        JSON.stringify({
          access_token: accessToken,
          token_type: 'Bearer',
          refresh_token: refreshToken,
          expires_at: Math.floor(Date.now() / 1000) - 30,
        })
      );
      await fs.writeFile(path.join(cacheDir, 'client.json'), JSON.stringify({ client_id: 'client-123' }));

      authMocks.discoverOAuthServerInfo.mockResolvedValue({ authorizationServerUrl: 'https://auth.example.com' });
      authMocks.refreshAuthorization.mockImplementation(async () => {
        // This write represents the other process landing after our failed
        // generation was read but before recovery compare-and-clears stores.
        // Some providers retain both token strings while extending expiry.
        await saveVaultEntry(definition, {
          tokens: {
            access_token: accessToken,
            token_type: 'Bearer',
            refresh_token: refreshToken,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          } as OAuthTokens,
          clientInfo: { client_id: 'client-123' },
        });
        throw Object.assign(new Error(errorCode), { errorCode });
      });

      await expect(readCachedAccessToken(definition)).resolves.toBe(accessToken);

      // The stale directory generation is gone, while the complete newer vault
      // value and its client registration survive and become authoritative.
      await expect(readJsonFile(path.join(cacheDir, 'tokens.json'))).resolves.toBeUndefined();
      await expect(readJsonFile(path.join(cacheDir, 'client.json'))).resolves.toBeUndefined();
      const winner = await loadVaultEntry(definition);
      expect(winner?.tokens).toEqual(
        expect.objectContaining({
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_at: expect.any(Number),
        })
      );
      expect(winner?.clientInfo).toEqual(expect.objectContaining({ client_id: 'client-123' }));
    }
  );

  it('preserves a concurrent vault auth session while clearing inherited rejected credentials', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-inherited-invalid-client-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
    hasSpy = true;
    process.env.XDG_DATA_HOME = path.join(tmp, 'data');

    const definition = mkDef('renamed-client');
    const legacyDefinition = mkDef('renamed-client-oauth');
    await saveVaultEntry(legacyDefinition, {
      tokens: {
        access_token: 'old',
        token_type: 'Bearer',
        refresh_token: 'dead',
        expires_at: Math.floor(Date.now() / 1000) - 30,
      } as OAuthTokens,
      clientInfo: { client_id: 'stale-client' },
    });
    await saveVaultEntry(definition, {
      clientInfo: { client_id: 'stale-client' },
    });

    authMocks.discoverOAuthServerInfo.mockResolvedValue({ authorizationServerUrl: 'https://auth.example.com' });
    authMocks.refreshAuthorization.mockImplementation(async () => {
      await saveVaultEntry(definition, {
        // The winner can legitimately reuse the exact same registration
        // payload; its save generation, not its public fields, distinguishes it.
        clientInfo: { client_id: 'stale-client' },
        codeVerifier: 'verify',
        state: 'state',
      });
      throw Object.assign(new Error('Client rejected'), { errorCode: 'invalid_client' });
    });

    await expect(readCachedAccessToken(definition)).resolves.toBeUndefined();
    const current = await loadVaultEntry(definition);
    expect(current?.tokens).toBeUndefined();
    expect(current?.clientInfo).toEqual({ client_id: 'stale-client' });
    expect(current?.codeVerifier).toBe('verify');
    expect(current?.state).toBe('state');
    const legacy = await loadVaultEntry(legacyDefinition);
    expect(legacy?.tokens).toBeUndefined();
    expect(legacy?.clientInfo).toBeUndefined();
  });

  it('clears only the renamed vault entry that supplied rejected credentials', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-renamed-source-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
    hasSpy = true;
    process.env.XDG_DATA_HOME = path.join(tmp, 'data');

    const definition = mkDef('multi-rename');
    const vaultPath = path.join(tmp, 'data', 'mcporter', 'credentials.json');
    await fs.mkdir(path.dirname(vaultPath), { recursive: true });
    await fs.writeFile(
      vaultPath,
      JSON.stringify({
        version: 1,
        entries: {
          selected: {
            serverName: 'multi-rename-oauth',
            serverUrl: 'https://example.com/mcp',
            updatedAt: '2026-01-02T00:00:00.000Z',
            tokens: {
              access_token: 'old',
              token_type: 'Bearer',
              refresh_token: 'dead',
              expires_at: Math.floor(Date.now() / 1000) - 30,
            },
            clientInfo: { client_id: 'bad' },
          },
          unrelated: {
            serverName: 'multi-rename-oauth',
            serverUrl: 'https://example.com/mcp',
            updatedAt: '2026-01-01T00:00:00.000Z',
            tokens: { access_token: 'keep', token_type: 'Bearer', refresh_token: 'live' },
            clientInfo: { client_id: 'other' },
          },
        },
      })
    );

    authMocks.discoverOAuthServerInfo.mockResolvedValue({ authorizationServerUrl: 'https://auth.example.com' });
    authMocks.refreshAuthorization.mockRejectedValue(
      Object.assign(new Error('Client rejected'), { errorCode: 'invalid_client' })
    );

    await expect(readCachedAccessToken(definition)).resolves.toBe('keep');
    const vault = (await readJsonFile(vaultPath)) as
      | {
          entries: Record<string, { tokens?: { access_token?: string }; clientInfo?: { client_id?: string } }>;
        }
      | undefined;
    expect(vault?.entries.selected?.tokens).toBeUndefined();
    expect(vault?.entries.selected?.clientInfo).toBeUndefined();
    expect(vault?.entries.unrelated?.tokens?.access_token).toBe('keep');
    expect(vault?.entries.unrelated?.clientInfo?.client_id).toBe('other');
  });

  it('preserves a lower-priority generated token when the rejected legacy snapshot differs', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-legacy-mixed-cache-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;
    process.env.XDG_DATA_HOME = path.join(tmp, 'data');

    const cacheDir = path.join(tmp, 'cache');
    const definition = mkDef('legacy-mixed-cache', cacheDir);
    const expiredAt = Math.floor(Date.now() / 1000) - 30;
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, 'tokens.json'),
      JSON.stringify({
        access_token: 'old',
        token_type: 'Bearer',
        refresh_token: 'dead',
        expires_at: expiredAt,
      })
    );
    await fs.writeFile(path.join(cacheDir, 'client.json'), JSON.stringify({ client_id: 'client-123' }));

    // This live vault write receives a generation marker, while the directory
    // remains a legacy shape with a different expiry spelling and second.
    await saveVaultEntry(definition, {
      tokens: {
        access_token: 'old',
        token_type: 'Bearer',
        refresh_token: 'dead',
        expiresAt: expiredAt + 1,
      } as OAuthTokens,
      clientInfo: { client_id: 'client-123' },
    });

    authMocks.discoverOAuthServerInfo.mockResolvedValue({ authorizationServerUrl: 'https://auth.example.com' });
    authMocks.refreshAuthorization.mockRejectedValue(
      Object.assign(new Error('Grant rejected'), { errorCode: 'invalid_grant' })
    );

    await expect(readCachedAccessToken(definition)).resolves.toBe('old');
    await expect(readJsonFile(path.join(cacheDir, 'tokens.json'))).resolves.toBeUndefined();
    const remaining = await loadVaultEntry(definition);
    expect(remaining?.tokens).toEqual(expect.objectContaining({ access_token: 'old', expiresAt: expiredAt + 1 }));
    expect(remaining?.clientInfo).toEqual(expect.objectContaining({ client_id: 'client-123' }));
  });

  it('keeps cached OAuth tokens when silent refresh fails transiently', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-refresh-transient-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;

    const cacheDir = path.join(tmp, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, 'tokens.json'),
      JSON.stringify({
        access_token: 'expired-token',
        token_type: 'Bearer',
        refresh_token: 'refresh-123',
        expires_at: Math.floor(Date.now() / 1000) - 30,
      })
    );
    await fs.writeFile(path.join(cacheDir, 'client.json'), JSON.stringify({ client_id: 'client-123' }));

    authMocks.discoverOAuthServerInfo.mockResolvedValue({ authorizationServerUrl: 'https://auth.example.com' });
    authMocks.refreshAuthorization.mockRejectedValue(new Error('network timeout'));

    const definition = mkDef('refresh-transient-service', cacheDir);
    await expect(readCachedAccessToken(definition)).resolves.toBe('expired-token');

    const persisted = (await readJsonFile(path.join(cacheDir, 'tokens.json'))) as
      | { access_token?: string; refresh_token?: string }
      | undefined;
    expect(persisted).toEqual(
      expect.objectContaining({
        access_token: 'expired-token',
        refresh_token: 'refresh-123',
      })
    );
  });

  it('keeps cached OAuth tokens when discovery fails with an invalid-client-like message', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-discovery-message-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;

    const cacheDir = path.join(tmp, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, 'tokens.json'),
      JSON.stringify({
        access_token: 'expired-token',
        token_type: 'Bearer',
        refresh_token: 'refresh-123',
        expires_at: Math.floor(Date.now() / 1000) - 30,
      })
    );
    await fs.writeFile(path.join(cacheDir, 'client.json'), JSON.stringify({ client_id: 'client-123' }));

    authMocks.discoverOAuthServerInfo.mockRejectedValue(new Error('invalid_client certificate chain'));

    const definition = mkDef('discovery-message-service', cacheDir);
    await expect(readCachedAccessToken(definition)).resolves.toBe('expired-token');

    await expect(readJsonFile(path.join(cacheDir, 'tokens.json'))).resolves.toEqual(
      expect.objectContaining({ access_token: 'expired-token' })
    );
    await expect(readJsonFile(path.join(cacheDir, 'client.json'))).resolves.toEqual({ client_id: 'client-123' });
    expect(authMocks.refreshAuthorization).not.toHaveBeenCalled();
  });

  it('refreshes explicit refreshable bearer tokens through the configured token endpoint', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-bearer-refresh-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;
    process.env.CLIENT_ID = 'client-id';
    process.env.CLIENT_SECRET = 'client-secret';

    const cacheDir = path.join(tmp, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, 'tokens.json'),
      JSON.stringify({
        access_token: 'expired-token',
        token_type: 'Bearer',
        refresh_token: 'refresh-123',
        expires_at: Math.floor(Date.now() / 1000) - 30,
      })
    );

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'fresh-bearer',
          token_type: 'Bearer',
          expires_in: '3600',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const definition: ServerDefinition = {
      name: 'stdio-refresh',
      command: { kind: 'stdio', command: 'node', args: ['server.js'], cwd: tmp },
      auth: 'refreshable_bearer',
      tokenCacheDir: cacheDir,
      refresh: {
        tokenEndpoint: 'https://auth.example.com/token',
        clientIdEnv: 'CLIENT_ID',
        clientSecretEnv: 'CLIENT_SECRET',
        clientAuthMethod: 'client_secret_post',
        accessTokenEnv: 'EXAMPLE_ACCESS_TOKEN',
      },
    };

    await expect(readCachedAccessToken(definition)).resolves.toBe('fresh-bearer');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://auth.example.com/token',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        }),
      })
    );
    const [, request] = fetchMock.mock.calls[0] ?? [];
    expect((request as { body?: URLSearchParams }).body?.toString()).toContain('grant_type=refresh_token');
    expect((request as { body?: URLSearchParams }).body?.toString()).toContain('client_id=client-id');
    expect((request as { body?: URLSearchParams }).body?.toString()).toContain('client_secret=client-secret');

    const persisted = (await readJsonFile(path.join(cacheDir, 'tokens.json'))) as
      | { access_token?: string; refresh_token?: string; expires_at?: number }
      | undefined;
    expect(persisted?.access_token).toBe('fresh-bearer');
    expect(persisted?.refresh_token).toBe('refresh-123');
    expect(persisted?.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('form-encodes refresh credentials for client_secret_basic', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-bearer-basic-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;
    process.env.CLIENT_ID = 'client:id';
    process.env.CLIENT_SECRET = 'secret + value';

    const cacheDir = path.join(tmp, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, 'tokens.json'),
      JSON.stringify({
        access_token: 'expired-token',
        token_type: 'Bearer',
        refresh_token: 'refresh-123',
        expires_at: Math.floor(Date.now() / 1000) - 30,
      })
    );

    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'fresh-basic', token_type: 'Bearer' }), { status: 200 })
      );
    vi.stubGlobal('fetch', fetchMock);

    const definition: ServerDefinition = {
      name: 'basic-refresh',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'refreshable_bearer',
      tokenCacheDir: cacheDir,
      refresh: {
        tokenEndpoint: 'https://auth.example.com/token',
        clientIdEnv: 'CLIENT_ID',
        clientSecretEnv: 'CLIENT_SECRET',
      },
    };

    await expect(readCachedAccessToken(definition)).resolves.toBe('fresh-basic');

    const [, request] = fetchMock.mock.calls[0] ?? [];
    const headers = (request as { headers?: Record<string, string> }).headers;
    expect(headers?.authorization).toBe(`Basic ${Buffer.from('client%3Aid:secret+%2B+value').toString('base64')}`);
  });

  it('does not return expired refreshable bearer tokens when refresh fails', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-bearer-refresh-fail-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;
    process.env.CLIENT_ID = 'client-id';
    process.env.CLIENT_SECRET = 'client-secret';

    const cacheDir = path.join(tmp, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, 'tokens.json'),
      JSON.stringify({
        access_token: 'expired-token',
        token_type: 'Bearer',
        refresh_token: 'refresh-123',
        expires_at: Math.floor(Date.now() / 1000) - 30,
      })
    );

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 500 })));

    const definition: ServerDefinition = {
      name: 'failed-refresh',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'refreshable_bearer',
      tokenCacheDir: cacheDir,
      refresh: {
        tokenEndpoint: 'https://auth.example.com/token',
        clientIdEnv: 'CLIENT_ID',
        clientSecretEnv: 'CLIENT_SECRET',
      },
    };

    await expect(readCachedAccessToken(definition)).rejects.toThrow(
      "Failed to refresh cached bearer token for 'failed-refresh'"
    );

    // A transient failure must not clear the cache: the refresh token stays for retry.
    await expect(readJsonFile(path.join(cacheDir, 'tokens.json'))).resolves.toEqual(
      expect.objectContaining({ refresh_token: 'refresh-123' })
    );
  });

  it('clears cached bearer tokens instead of replaying a refresh token rejected with invalid_grant', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-bearer-invalid-grant-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;
    process.env.CLIENT_ID = 'client-id';

    const cacheDir = path.join(tmp, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, 'tokens.json'),
      JSON.stringify({
        access_token: 'old',
        token_type: 'Bearer',
        refresh_token: 'dead',
        expires_at: Math.floor(Date.now() / 1000) - 30,
      })
    );

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token rotated' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const definition: ServerDefinition = {
      name: 'invalid-grant-refresh',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'refreshable_bearer',
      tokenCacheDir: cacheDir,
      refresh: {
        tokenEndpoint: 'https://auth.example.com/token',
        clientIdEnv: 'CLIENT_ID',
        clientAuthMethod: 'none',
      },
    };

    await expect(readCachedAccessToken(definition)).rejects.toThrow('invalid_grant');

    // The dead refresh token must not survive to be replayed on later invocations.
    await expect(readJsonFile(path.join(cacheDir, 'tokens.json'))).resolves.toBeUndefined();

    fetchMock.mockClear();
    await expect(readCachedAccessToken(definition)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears inherited same-url bearer tokens on invalid_grant while keeping inherited client info', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-bearer-inherited-invalid-grant-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
    hasSpy = true;
    process.env.XDG_DATA_HOME = path.join(tmp, 'data');
    process.env.CLIENT_ID = 'client-id';

    // A renamed refreshable_bearer definition whose exact vault entry has no
    // tokens: readTokens() inherits the poison tokens from the same-url legacy
    // <name>-oauth entry (see loadVaultEntry).
    const currentDefinition: ServerDefinition = {
      name: 'inherited-bearer',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'refreshable_bearer',
      refresh: {
        tokenEndpoint: 'https://auth.example.com/token',
        clientIdEnv: 'CLIENT_ID',
        clientAuthMethod: 'none',
      },
    };
    const legacyDefinition = mkDef('inherited-bearer-oauth');
    await saveVaultEntry(legacyDefinition, {
      tokens: {
        access_token: 'old',
        token_type: 'Bearer',
        refresh_token: 'dead',
        expires_at: Math.floor(Date.now() / 1000) - 30,
      } as OAuthTokens,
      clientInfo: { client_id: 'inherited-client' },
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token rotated' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(readCachedAccessToken(currentDefinition)).rejects.toThrow('invalid_grant');

    // The poison tokens are cleared from the source entry, but its client info
    // stays reachable for re-auth.
    const legacyEntry = await loadVaultEntry(legacyDefinition);
    expect(legacyEntry?.tokens).toBeUndefined();
    expect(legacyEntry?.clientInfo).toEqual(expect.objectContaining({ client_id: 'inherited-client' }));
    const inherited = await loadVaultEntry(currentDefinition);
    expect(inherited?.tokens).toBeUndefined();
    expect(inherited?.clientInfo).toEqual(expect.objectContaining({ client_id: 'inherited-client' }));

    // A later invocation cannot reread or replay the dead refresh token.
    fetchMock.mockClear();
    await expect(readCachedAccessToken(currentDefinition)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('adopts a concurrent winner persisted to the inherited same-url entry instead of clearing it', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-bearer-inherited-winner-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmp, 'home'));
    hasSpy = true;
    process.env.XDG_DATA_HOME = path.join(tmp, 'data');
    process.env.CLIENT_ID = 'client-id';

    const currentDefinition: ServerDefinition = {
      name: 'inherited-winner-bearer',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'refreshable_bearer',
      refresh: {
        tokenEndpoint: 'https://auth.example.com/token',
        clientIdEnv: 'CLIENT_ID',
        clientAuthMethod: 'none',
      },
    };
    const legacyDefinition = mkDef('inherited-winner-bearer-oauth');
    await saveVaultEntry(legacyDefinition, {
      tokens: {
        access_token: 'old',
        token_type: 'Bearer',
        refresh_token: 'refresh-old',
        expires_at: Math.floor(Date.now() / 1000) - 30,
      } as OAuthTokens,
      clientInfo: { client_id: 'inherited-client' },
    });

    // A concurrent invocation rotates the refresh token and persists the winner
    // back onto the same source entry before our failed refresh recovers.
    const fetchMock = vi.fn().mockImplementation(async () => {
      await saveVaultEntry(legacyDefinition, {
        tokens: {
          access_token: 'new',
          token_type: 'Bearer',
          refresh_token: 'refresh-new',
          expires_in: 3600,
        },
      });
      return new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(readCachedAccessToken(currentDefinition)).resolves.toBe('new');

    // The winner's newer tokens on the source entry are preserved, not cleared.
    const legacyEntry = await loadVaultEntry(legacyDefinition);
    expect(legacyEntry?.tokens?.access_token).toBe('new');
    expect(legacyEntry?.tokens?.refresh_token).toBe('refresh-new');
  });

  it('clears all cached bearer credentials when refresh reports an invalid client', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-bearer-invalid-client-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;
    process.env.CLIENT_ID = 'client-id';

    const cacheDir = path.join(tmp, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, 'tokens.json'),
      JSON.stringify({
        access_token: 'old',
        token_type: 'Bearer',
        refresh_token: 'refresh-123',
        expires_at: Math.floor(Date.now() / 1000) - 30,
      })
    );

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'invalid_client' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    const definition: ServerDefinition = {
      name: 'invalid-client-refresh',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'refreshable_bearer',
      tokenCacheDir: cacheDir,
      refresh: {
        tokenEndpoint: 'https://auth.example.com/token',
        clientIdEnv: 'CLIENT_ID',
        clientAuthMethod: 'none',
      },
    };

    await expect(readCachedAccessToken(definition)).rejects.toThrow('invalid_client');
    await expect(readJsonFile(path.join(cacheDir, 'tokens.json'))).resolves.toBeUndefined();
  });

  it('adopts the concurrent winner token when a bearer refresh loses the race with invalid_grant', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-bearer-refresh-race-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;
    process.env.CLIENT_ID = 'client-id';

    const cacheDir = path.join(tmp, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, 'tokens.json'),
      JSON.stringify({
        access_token: 'old',
        token_type: 'Bearer',
        refresh_token: 'refresh-old',
        expires_at: Math.floor(Date.now() / 1000) - 30,
      })
    );

    const definition: ServerDefinition = {
      name: 'bearer-race-refresh',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'refreshable_bearer',
      tokenCacheDir: cacheDir,
      refresh: {
        tokenEndpoint: 'https://auth.example.com/token',
        clientIdEnv: 'CLIENT_ID',
        clientAuthMethod: 'none',
      },
    };

    // The token endpoint rejects our (already rotated-out) refresh token, but a
    // concurrent invocation has meanwhile persisted the rotated replacement.
    const fetchMock = vi.fn().mockImplementation(async () => {
      const persistence = await buildOAuthPersistence(definition);
      await persistence.saveTokens({
        access_token: 'new',
        token_type: 'Bearer',
        refresh_token: 'refresh-new',
        expires_in: 3600,
      });
      return new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(readCachedAccessToken(definition)).resolves.toBe('new');

    // The winner's tokens must survive — not be clobbered or cleared by the loser.
    await expect(readJsonFile(path.join(cacheDir, 'tokens.json'))).resolves.toEqual(
      expect.objectContaining({ access_token: 'new', refresh_token: 'refresh-new' })
    );
  });

  it('preserves and adopts a late winner that persisted mid-recovery instead of clearing it', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-bearer-late-winner-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;
    process.env.CLIENT_ID = 'client-id';

    const cacheDir = path.join(tmp, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, 'tokens.json'),
      JSON.stringify({
        access_token: 'old',
        token_type: 'Bearer',
        refresh_token: 'refresh-old',
        expires_at: Math.floor(Date.now() / 1000) - 30,
      })
    );

    const definition: ServerDefinition = {
      name: 'late-winner-refresh',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'refreshable_bearer',
      tokenCacheDir: cacheDir,
      refresh: {
        tokenEndpoint: 'https://auth.example.com/token',
        clientIdEnv: 'CLIENT_ID',
        clientAuthMethod: 'none',
      },
    };

    // A concurrent winner's saveTokens writes stores independently; here its
    // vault write has landed while the directory cache still holds the failed
    // tokens. The loser's recovery must not treat the stale directory read as
    // "nothing changed" and wipe the winner's vault entry along with it.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        await saveVaultEntry(definition, {
          tokens: {
            access_token: 'new',
            token_type: 'Bearer',
            refresh_token: 'refresh-new',
            expires_in: 3600,
          },
        });
        return new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      })
    );

    await expect(readCachedAccessToken(definition)).resolves.toBe('new');

    // The failed directory tokens are cleared, the winner's vault entry survives.
    await expect(readJsonFile(path.join(cacheDir, 'tokens.json'))).resolves.toBeUndefined();
    const entry = await loadVaultEntry(definition);
    expect(entry?.tokens?.access_token).toBe('new');
    expect(entry?.tokens?.refresh_token).toBe('refresh-new');
  });

  it('leaves a mismatched directory token cache untouched while clearing the matching vault copy', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-bearer-dir-winner-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;
    process.env.CLIENT_ID = 'client-id';

    const failedTokens = {
      access_token: 'old',
      token_type: 'Bearer',
      refresh_token: 'refresh-old',
      expires_at: Math.floor(Date.now() / 1000) - 30,
    };
    const cacheDir = path.join(tmp, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, 'tokens.json'), JSON.stringify(failedTokens));

    const definition: ServerDefinition = {
      name: 'dir-winner-refresh',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'refreshable_bearer',
      tokenCacheDir: cacheDir,
      refresh: {
        tokenEndpoint: 'https://auth.example.com/token',
        clientIdEnv: 'CLIENT_ID',
        clientAuthMethod: 'none',
      },
    };
    await saveVaultEntry(definition, { tokens: failedTokens });

    // The opposite interleaving of the late-winner case: the winner's directory
    // write landed but its vault write has not. The failed vault copy must be
    // cleared while the winner's directory tokens survive and are adopted.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        await fs.writeFile(
          path.join(cacheDir, 'tokens.json'),
          JSON.stringify({
            access_token: 'new',
            token_type: 'Bearer',
            refresh_token: 'refresh-new',
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          })
        );
        return new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      })
    );

    await expect(readCachedAccessToken(definition)).resolves.toBe('new');

    await expect(readJsonFile(path.join(cacheDir, 'tokens.json'))).resolves.toEqual(
      expect.objectContaining({ access_token: 'new', refresh_token: 'refresh-new' })
    );
    const entry = await loadVaultEntry(definition);
    expect(entry?.tokens).toBeUndefined();
  });

  it('rejects expired refreshable bearer tokens without refresh metadata', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-bearer-no-refresh-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;

    const cacheDir = path.join(tmp, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, 'tokens.json'),
      JSON.stringify({
        access_token: 'expired-token',
        token_type: 'Bearer',
        expires_at: Math.floor(Date.now() / 1000) - 30,
      })
    );

    const definition: ServerDefinition = {
      name: 'missing-refresh',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'refreshable_bearer',
      tokenCacheDir: cacheDir,
    };

    await expect(readCachedAccessToken(definition)).rejects.toThrow(
      "Cached bearer token for 'missing-refresh' is expired"
    );
  });

  it('uses unexpired cached OAuth tokens without refresh', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-current-'));
    tempRoots.push(tmp);
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    hasSpy = true;

    const cacheDir = path.join(tmp, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, 'tokens.json'),
      JSON.stringify({
        access_token: 'current-token',
        token_type: 'Bearer',
        refresh_token: 'refresh-123',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      })
    );

    const definition = mkDef('current-service', cacheDir);
    await expect(readCachedAccessToken(definition)).resolves.toBe('current-token');
    expect(authMocks.refreshAuthorization).not.toHaveBeenCalled();
  });

  describe('refresh transaction serialization', () => {
    const expiredAt = Math.floor(Date.now() / 1000) - 60;

    async function seedExpiredCache(prefix: string): Promise<{ cacheDir: string; tmp: string }> {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `mcporter-${prefix}-`));
      tempRoots.push(tmp);
      homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
      hasSpy = true;
      const cacheDir = path.join(tmp, 'cache');
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(
        path.join(cacheDir, 'tokens.json'),
        JSON.stringify({
          access_token: 'stale-token',
          token_type: 'Bearer',
          refresh_token: 'stale-refresh',
          expires_at: expiredAt,
        })
      );
      return { cacheDir, tmp };
    }

    it('returns the persisted token without redeeming when the refresh lock stays held', async () => {
      const { cacheDir } = await seedExpiredCache('oauth-lock-timeout');
      const definition = mkDef('lock-timeout', cacheDir);
      process.env.MCPORTER_TEST_REFRESH_LOCK_TIMEOUT_MS = '50';

      const holding = held();
      const release = held();
      const holder = withRefreshLock(definition, async () => {
        holding.resolve();
        await release.promise;
      });
      await holding.promise;

      // Redeeming here would be the concurrent redemption the lock prevents.
      await expect(readCachedAccessToken(definition)).resolves.toBe('stale-token');
      expect(authMocks.refreshAuthorization).not.toHaveBeenCalled();

      release.resolve();
      await holder;
    });

    it('adopts a token another refresh persisted while this caller waited', async () => {
      const { cacheDir } = await seedExpiredCache('oauth-adopt-winner');
      const definition = mkDef('adopt-winner', cacheDir);

      const holding = held();
      const release = held();
      const holder = withRefreshLock(definition, async () => {
        holding.resolve();
        await release.promise;
      });
      await holding.promise;

      const caller = readCachedAccessToken(definition);
      // Let the caller finish its pre-lock read and start waiting on the lock.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const winner = await buildOAuthPersistence(definition);
      await winner.saveTokens({
        access_token: 'winner-token',
        token_type: 'Bearer',
        refresh_token: 'winner-refresh',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      } as OAuthTokens);

      release.resolve();
      await holder;

      await expect(caller).resolves.toBe('winner-token');
      expect(authMocks.refreshAuthorization).not.toHaveBeenCalled();
    });

    it('bounds the bearer token request so a stalled endpoint cannot hold the lock', async () => {
      const { cacheDir } = await seedExpiredCache('bearer-bound');
      const fetchMock = vi.fn(async () =>
        Response.json({ access_token: 'fresh-bearer', token_type: 'Bearer', expires_in: 3600 })
      );
      vi.stubGlobal('fetch', fetchMock);

      const definition: ServerDefinition = {
        name: 'bearer-bound',
        command: { kind: 'stdio', command: 'node', args: ['server.js'], cwd: process.cwd() },
        auth: 'refreshable_bearer',
        tokenCacheDir: cacheDir,
        refresh: {
          tokenEndpoint: 'https://auth.example.com/token',
          clientAuthMethod: 'none',
          accessTokenEnv: 'EXAMPLE_ACCESS_TOKEN',
        },
      };

      await expect(readCachedAccessToken(definition)).resolves.toBe('fresh-bearer');
      expect(fetchMock).toHaveBeenCalledWith(
        'https://auth.example.com/token',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('treats an aborted bearer token request as recoverable, not a rejected grant', async () => {
      const { cacheDir } = await seedExpiredCache('bearer-abort');
      const abortError = new Error('The operation was aborted due to timeout');
      abortError.name = 'TimeoutError';
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw abortError;
        })
      );

      const definition: ServerDefinition = {
        name: 'bearer-abort',
        command: { kind: 'stdio', command: 'node', args: ['server.js'], cwd: process.cwd() },
        auth: 'refreshable_bearer',
        tokenCacheDir: cacheDir,
        refresh: {
          tokenEndpoint: 'https://auth.example.com/token',
          clientAuthMethod: 'none',
          accessTokenEnv: 'EXAMPLE_ACCESS_TOKEN',
        },
      };

      await expect(readCachedAccessToken(definition)).rejects.toThrow(/Failed to refresh cached bearer token/);
      // A timeout must not be mistaken for invalid_grant, which would clear the family.
      const persisted = (await readJsonFile(path.join(cacheDir, 'tokens.json'))) as
        | { refresh_token?: string }
        | undefined;
      expect(persisted?.refresh_token).toBe('stale-refresh');
    });

    it('returns the persisted bearer token instead of throwing when the refresh lock stays held', async () => {
      const { cacheDir } = await seedExpiredCache('bearer-lock-timeout');
      process.env.MCPORTER_TEST_REFRESH_LOCK_TIMEOUT_MS = '50';
      const fetchMock = vi.fn(async () =>
        Response.json({ access_token: 'should-not-run', token_type: 'Bearer', expires_in: 3600 })
      );
      vi.stubGlobal('fetch', fetchMock);

      const definition: ServerDefinition = {
        name: 'bearer-lock-timeout',
        command: { kind: 'stdio', command: 'node', args: ['server.js'], cwd: process.cwd() },
        auth: 'refreshable_bearer',
        tokenCacheDir: cacheDir,
        refresh: {
          tokenEndpoint: 'https://auth.example.com/token',
          clientAuthMethod: 'none',
          accessTokenEnv: 'EXAMPLE_ACCESS_TOKEN',
        },
      };

      const holding = held();
      const release = held();
      const holder = withRefreshLock(definition, async () => {
        holding.resolve();
        await release.promise;
      });
      await holding.promise;

      await expect(readCachedAccessToken(definition)).resolves.toBe('stale-token');
      expect(fetchMock).not.toHaveBeenCalled();

      release.resolve();
      await holder;
    });

    it('prefers a newer vault generation over a stale token cache before redeeming', async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-divergent-'));
      tempRoots.push(tmp);
      homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
      hasSpy = true;

      const cacheDir = path.join(tmp, 'cache');
      await fs.mkdir(cacheDir, { recursive: true });
      const definition = mkDef('divergent-stores', cacheDir);

      // A save that only partly landed: the cache kept the spent generation
      // while the vault took the rotated one. The cache is read first.
      await fs.writeFile(
        path.join(cacheDir, 'tokens.json'),
        JSON.stringify({
          access_token: 'spent-access',
          token_type: 'Bearer',
          refresh_token: 'spent-refresh',
          expires_at: Math.floor(Date.now() / 1000) - 120,
        })
      );
      await saveVaultEntry(definition, {
        tokens: {
          access_token: 'rotated-access',
          token_type: 'Bearer',
          refresh_token: 'rotated-refresh',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        } as OAuthTokens,
      });

      // Redeeming the cache's spent refresh token here would replay it and
      // revoke the family, so the newer vault generation has to win.
      await expect(readCachedAccessToken(definition)).resolves.toBe('rotated-access');
      expect(authMocks.refreshAuthorization).not.toHaveBeenCalled();

      // The stale store is deliberately left alone. Flattening every store to
      // the winner would make rejected-credential recovery clear all copies,
      // discarding a generation that should survive; the next successful refresh
      // converges them instead.
      const cached = (await readJsonFile(path.join(cacheDir, 'tokens.json'))) as { access_token?: string } | undefined;
      expect(cached?.access_token).toBe('spent-access');
    });

    it('redeems the newer generation when both stores are expired but divergent', async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-divergent-expired-'));
      tempRoots.push(tmp);
      homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
      hasSpy = true;

      const cacheDir = path.join(tmp, 'cache');
      await fs.mkdir(cacheDir, { recursive: true });
      const definition = mkDef('divergent-expired', cacheDir);

      await fs.writeFile(
        path.join(cacheDir, 'tokens.json'),
        JSON.stringify({
          access_token: 'spent-access',
          token_type: 'Bearer',
          refresh_token: 'spent-refresh',
          expires_at: Math.floor(Date.now() / 1000) - 600,
        })
      );
      await saveVaultEntry(definition, {
        clientInfo: { client_id: 'divergent-client', redirect_uris: ['http://127.0.0.1/callback'] },
        tokens: {
          access_token: 'newer-access',
          token_type: 'Bearer',
          refresh_token: 'newer-refresh',
          expires_at: Math.floor(Date.now() / 1000) - 30,
        } as OAuthTokens,
      });

      authMocks.discoverOAuthServerInfo.mockResolvedValue({
        authorizationServerUrl: 'https://auth.example.com',
        authorizationServerMetadata: { issuer: 'https://auth.example.com' },
        resourceMetadata: undefined,
      });
      authMocks.refreshAuthorization.mockResolvedValue({
        access_token: 'refreshed-access',
        token_type: 'Bearer',
        refresh_token: 'refreshed-refresh',
        expires_in: 3600,
      });

      await expect(readCachedAccessToken(definition)).resolves.toBe('refreshed-access');

      // The spent cache token must never be the one presented to the provider.
      expect(authMocks.refreshAuthorization).toHaveBeenCalledTimes(1);
      expect(authMocks.refreshAuthorization.mock.calls[0]?.[1]).toMatchObject({ refreshToken: 'newer-refresh' });
    });

    it('honors a custom refresh skew when adopting a concurrently persisted token', async () => {
      const { cacheDir } = await seedExpiredCache('bearer-skew');
      const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
        Response.json({ access_token: 'redeemed-token', token_type: 'Bearer', expires_in: 3600 })
      );
      vi.stubGlobal('fetch', fetchMock);

      const definition: ServerDefinition = {
        name: 'bearer-skew',
        command: { kind: 'stdio', command: 'node', args: ['server.js'], cwd: process.cwd() },
        auth: 'refreshable_bearer',
        tokenCacheDir: cacheDir,
        refresh: {
          tokenEndpoint: 'https://auth.example.com/token',
          clientAuthMethod: 'none',
          accessTokenEnv: 'EXAMPLE_ACCESS_TOKEN',
          // A token expiring in 10 minutes is fresh at the 60s default but stale here.
          refreshSkewSeconds: 1_800,
        },
      };

      const persistence = await buildOAuthPersistence(definition);
      await persistence.saveTokens({
        access_token: 'not-fresh-enough',
        token_type: 'Bearer',
        refresh_token: 'winner-refresh',
        expires_at: Math.floor(Date.now() / 1000) + 600,
      } as OAuthTokens);

      // The configured skew still considers the persisted token stale, so the
      // transaction redeems its refresh token rather than adopting it.
      await expect(readCachedAccessToken(definition)).resolves.toBe('redeemed-token');
      const request = fetchMock.mock.calls[0]?.[1] as { body?: URLSearchParams } | undefined;
      expect(request?.body?.toString()).toContain('refresh_token=winner-refresh');
    });
  });
});

const vaultPlainEntry = (d: ServerDefinition) => ({
  serverName: d.name,
  serverUrl: 'https://example.com/mcp',
  tokens: { access_token: 'access-enc', refresh_token: 'refresh-enc', token_type: 'Bearer' },
  clientInfo: {
    client_id: 'client-enc',
    client_secret: 'secret-enc',
    token_endpoint_auth_method: 'client_secret_post',
  },
  updatedAt: new Date().toISOString(),
});
const vaultSealedEntry = async (d: ServerDefinition, password: string) => {
  const key = vaultKeyForDefinition(d);
  const e = vaultPlainEntry(d);
  const seal = (p: readonly string[], v: string) => sealVaultSecret(v, vaultSecretKid(key, p), password);
  return {
    ...e,
    tokens: {
      ...e.tokens,
      access_token: await seal(['tokens', 'access_token'], 'access-enc'),
      refresh_token: await seal(['tokens', 'refresh_token'], 'refresh-enc'),
    },
    clientInfo: { ...e.clientInfo, client_secret: await seal(['clientInfo', 'client_secret'], 'secret-enc') },
  };
};

describe('vault encryption at rest', () => {
  const PASSWORD = 'vault-password-for-tests-0123456789';
  let dir: string;
  let vaultPath: string;

  // The suite above replaces process.env with a plain object, which neither
  // the env stubbing restore nor os.homedir() follow; set and clear keys directly.
  let savedDataHome: string | undefined;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-vault-enc-'));
    savedDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(dir, 'data');
    delete process.env.MCPORTER_VAULT_PASSWORD;
    delete process.env.MCPORTER_VAULT_ENCRYPTION;
    vaultPath = getOAuthVaultPath();
  });
  afterEach(async () => {
    delete process.env.MCPORTER_VAULT_PASSWORD;
    delete process.env.MCPORTER_VAULT_ENCRYPTION;
    if (savedDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = savedDataHome;
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const seed = async (entries: Record<string, unknown>) => {
    await fs.mkdir(path.dirname(vaultPath), { recursive: true });
    await fs.writeFile(vaultPath, JSON.stringify({ version: 2, entries }), 'utf8');
  };
  type StoredEntry = { serverName: string; tokens: Record<string, unknown>; clientInfo: Record<string, unknown> };
  const stored = async () =>
    (await readJsonFile<{ version: number; entries: Record<string, StoredEntry> }>(vaultPath))!;

  it('opens sealed values and keeps metadata', async () => {
    const d = mkDef('enc-read');
    await seed({ [vaultKeyForDefinition(d)]: await vaultSealedEntry(d, PASSWORD) });
    process.env.MCPORTER_VAULT_PASSWORD = PASSWORD;
    await expect(loadVaultEntry(d)).resolves.toMatchObject({
      serverUrl: 'https://example.com/mcp',
      tokens: { access_token: 'access-enc', refresh_token: 'refresh-enc', token_type: 'Bearer' },
      clientInfo: { client_id: 'client-enc', client_secret: 'secret-enc' },
    });
  });

  it('fails closed with the password unset and leaves the file untouched', async () => {
    const d = mkDef('enc-fail');
    await seed({ [vaultKeyForDefinition(d)]: await vaultSealedEntry(d, PASSWORD) });
    const before = await fs.readFile(vaultPath, 'utf8');
    await expect(loadVaultEntry(d)).rejects.toMatchObject({ name: 'VaultEncryptionError', code: 'password_missing' });
    await expect(clearVaultEntry(d, 'all')).rejects.toMatchObject({ code: 'password_missing' });
    await expect(saveVaultEntry(d, { state: 'x' })).rejects.toMatchObject({ code: 'password_missing' });
    expect(await fs.readFile(vaultPath, 'utf8')).toBe(before);
  });

  it('fails closed on a wrong password for reads and saves, but clear still removes the entry', async () => {
    const d = mkDef('enc-wrong');
    await seed({ [vaultKeyForDefinition(d)]: await vaultSealedEntry(d, PASSWORD) });
    const before = await fs.readFile(vaultPath, 'utf8');
    process.env.MCPORTER_VAULT_PASSWORD = 'another-vault-password-9876543210';
    await expect(loadVaultEntry(d)).rejects.toMatchObject({ code: 'decrypt_failed' });
    await expect(saveVaultEntry(d, { state: 'x' })).rejects.toMatchObject({ code: 'decrypt_failed' });
    expect(await fs.readFile(vaultPath, 'utf8')).toBe(before);
    // The documented recovery after a password change: clear needs no decryption.
    await clearVaultEntry(d, 'all');
    await expect(loadVaultEntry(d)).resolves.toBeUndefined();
  });

  it('isolates entries: a value sealed under another password does not block other servers', async () => {
    const a = mkDef('enc-other-password');
    const b = mkDef('enc-current-password');
    await seed({
      [vaultKeyForDefinition(a)]: await vaultSealedEntry(a, 'another-vault-password-9876543210'),
      [vaultKeyForDefinition(b)]: await vaultSealedEntry(b, PASSWORD),
    });
    process.env.MCPORTER_VAULT_PASSWORD = PASSWORD;
    await expect(loadVaultEntry(b)).resolves.toMatchObject({ tokens: { access_token: 'access-enc' } });
    await expect(loadVaultEntry(a)).rejects.toMatchObject({ code: 'decrypt_failed' });
    const sealedA = (await stored()).entries[vaultKeyForDefinition(a)]!.tokens.refresh_token;
    await saveVaultEntry(b, { state: 'updated' });
    // Untouched sealed values are written back byte-identical, not re-sealed.
    expect((await stored()).entries[vaultKeyForDefinition(a)]!.tokens.refresh_token).toBe(sealedA);
    await clearVaultEntry(a, 'all');
    await expect(loadVaultEntry(a)).resolves.toBeUndefined();
    await expect(loadVaultEntry(b)).resolves.toMatchObject({ state: 'updated' });
  });

  it('refuses a value moved to another entry', async () => {
    const a = mkDef('enc-a');
    const b = mkDef('enc-b');
    const sa = await vaultSealedEntry(a, PASSWORD);
    await seed({
      [vaultKeyForDefinition(a)]: sa,
      [vaultKeyForDefinition(b)]: { ...vaultPlainEntry(b), tokens: { ...sa.tokens } },
    });
    process.env.MCPORTER_VAULT_PASSWORD = PASSWORD;
    await expect(loadVaultEntry(b)).rejects.toMatchObject({ code: 'payload_invalid' });
  });

  it('reads mixed sealed and plaintext values, and plaintext with a password set', async () => {
    const d = mkDef('enc-mixed');
    const key = vaultKeyForDefinition(d);
    const e = vaultPlainEntry(d);
    await seed({
      [key]: {
        ...e,
        tokens: {
          ...e.tokens,
          refresh_token: await sealVaultSecret(
            'refresh-enc',
            vaultSecretKid(key, ['tokens', 'refresh_token']),
            PASSWORD
          ),
        },
      },
    });
    process.env.MCPORTER_VAULT_PASSWORD = PASSWORD;
    await expect(loadVaultEntry(d)).resolves.toMatchObject({
      tokens: { access_token: 'access-enc', refresh_token: 'refresh-enc' },
    });
  });

  it('refuses every access under required without a password, from env or config', async () => {
    process.env.MCPORTER_VAULT_ENCRYPTION = 'required';
    await expect(loadVaultEntry(mkDef('req'))).rejects.toMatchObject({ code: 'password_missing' });
    await expect(saveVaultEntry(mkDef('req'), { state: 'x' })).rejects.toMatchObject({ code: 'password_missing' });
    delete process.env.MCPORTER_VAULT_ENCRYPTION;
    const configured = { ...mkDef('req-config'), oauthVaultEncryption: 'required' as const };
    await expect(loadVaultEntry(configured)).rejects.toMatchObject({ code: 'password_missing' });
    await expect(saveVaultEntry(configured, { state: 'x' })).rejects.toMatchObject({ code: 'password_missing' });
  });

  it('seals the secret values and nothing else on write', async () => {
    process.env.MCPORTER_VAULT_PASSWORD = PASSWORD;
    const d = mkDef('enc-write');
    const key = vaultKeyForDefinition(d);
    await saveVaultEntry(d, {
      tokens: { access_token: 'written', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600 },
      clientInfo: { client_id: 'cid', client_secret: 'cs', token_endpoint_auth_method: 'client_secret_post' },
    });
    const entry = (await stored()).entries[key]!;
    expect(entry.serverName).toBe('enc-write');
    expect(entry.tokens.token_type).toBe('Bearer');
    expect(entry.tokens.expires_in).toBe(3600);
    expect(entry.clientInfo.client_id).toBe('cid');
    for (const [p, v] of [
      [['tokens', 'access_token'], 'written'],
      [['tokens', 'refresh_token'], 'r'],
      [['clientInfo', 'client_secret'], 'cs'],
    ] as const) {
      const value = entry[p[0]]![p[1]] as string;
      expect(isVaultSecretJwe(value), p.join('/')).toBe(true);
      await expect(openVaultSecret(value, vaultSecretKid(key, p), PASSWORD)).resolves.toBe(v);
    }
  });

  it('seals plaintext values on the next write', async () => {
    const legacy = mkDef('legacy');
    await seed({ [vaultKeyForDefinition(legacy)]: vaultPlainEntry(legacy) });
    process.env.MCPORTER_VAULT_PASSWORD = PASSWORD;
    await saveVaultEntry(mkDef('third'), { state: 'pending' });
    const entry = (await stored()).entries[vaultKeyForDefinition(legacy)]!;
    expect(isVaultSecretJwe(entry.tokens.refresh_token)).toBe(true);
    expect(isVaultSecretJwe(entry.clientInfo.client_secret)).toBe(true);
    await expect(loadVaultEntry(legacy)).resolves.toMatchObject({ tokens: { access_token: 'access-enc' } });
  });

  it('keeps writing plaintext without a password and skips missing fields with one', async () => {
    const d = mkDef('plain-write');
    await saveVaultEntry(d, { tokens: { access_token: 'plain', token_type: 'Bearer' } });
    expect((await stored()).entries[vaultKeyForDefinition(d)]!.tokens.access_token).toBe('plain');
    process.env.MCPORTER_VAULT_PASSWORD = PASSWORD;
    await saveVaultEntry(d, { state: 'x' });
    const entry = (await stored()).entries[vaultKeyForDefinition(d)]!;
    expect(isVaultSecretJwe(entry.tokens.access_token)).toBe(true);
    expect('refresh_token' in entry.tokens).toBe(false);
    expect(entry.clientInfo).toBeUndefined();
  });

  it('seals a tokenCacheDir the same way', async () => {
    process.env.MCPORTER_VAULT_PASSWORD = PASSWORD;
    const cacheDir = path.join(dir, 'cache');
    const d = mkDef('cached', cacheDir);
    const persistence = await buildOAuthPersistence(d);
    await persistence.saveTokens({ access_token: 'dir-access', refresh_token: 'dir-refresh', token_type: 'Bearer' });
    await persistence.saveClientInfo({ client_id: 'dir-client', client_secret: 'dir-secret' });
    const tokens = (await readJsonFile<{ access_token: string; refresh_token: string; token_type: string }>(
      path.join(cacheDir, 'tokens.json')
    ))!;
    const client = (await readJsonFile<{ client_id: string; client_secret: string }>(
      path.join(cacheDir, 'client.json')
    ))!;
    expect(tokens.token_type).toBe('Bearer');
    expect(client.client_id).toBe('dir-client');
    expect(isVaultSecretJwe(tokens.access_token)).toBe(true);
    expect(isVaultSecretJwe(tokens.refresh_token)).toBe(true);
    expect(isVaultSecretJwe(client.client_secret)).toBe(true);
    await expect(openVaultSecret(tokens.refresh_token, 'tokens.json/refresh_token', PASSWORD)).resolves.toBe(
      'dir-refresh'
    );
    await expect(persistence.readSnapshot()).resolves.toMatchObject({
      tokens: { access_token: 'dir-access', refresh_token: 'dir-refresh' },
      clientInfo: { client_secret: 'dir-secret' },
    });
  });

  it('clears rejected credentials in a tokenCacheDir when the password is set', async () => {
    process.env.MCPORTER_VAULT_PASSWORD = PASSWORD;
    const cacheDir = path.join(dir, 'cache-clear');
    const store = new DirectoryPersistence(cacheDir, undefined, 'https://example.com/mcp');
    await store.saveTokens({ access_token: 'dir-access', refresh_token: 'dir-refresh', token_type: 'Bearer' });
    await store.saveClientInfo({ client_id: 'dir-client', client_secret: 'dir-secret' });
    const tokens = await store.readTokens();
    const info = await store.readClientInfo();
    await store.clearRejectedCredentials(tokens, info);
    await expect(fs.access(path.join(cacheDir, 'tokens.json'))).rejects.toThrow();
    await expect(fs.access(path.join(cacheDir, 'client.json'))).rejects.toThrow();
  });

  it('refuses a plaintext tokenCacheDir under required without a password', async () => {
    const cacheDir = path.join(dir, 'cache-required');
    const d = mkDef('cached-required', cacheDir);
    const store = new DirectoryPersistence(cacheDir, undefined, 'https://example.com/mcp');
    await store.saveTokens({ access_token: 'dir-access', token_type: 'Bearer' });
    process.env.MCPORTER_VAULT_ENCRYPTION = 'required';
    const persistence = await buildOAuthPersistence(d);
    await expect(persistence.readTokens()).rejects.toMatchObject({ code: 'password_missing' });
    await expect(persistence.readSnapshot()).rejects.toMatchObject({ code: 'password_missing' });
    await expect(persistence.saveState('x')).rejects.toMatchObject({ code: 'password_missing' });
    await expect(readCachedAccessToken(d)).rejects.toMatchObject({ code: 'password_missing' });
  });

  it('refuses every tokenCacheDir operation under a config required policy without a password', async () => {
    const cacheDir = path.join(dir, 'cache-required-direct');
    const store = new DirectoryPersistence(cacheDir, undefined, 'https://example.com/mcp', false, 'required');
    await expect(store.readTokens()).rejects.toMatchObject({ code: 'password_missing' });
    await expect(store.saveState('x')).rejects.toMatchObject({ code: 'password_missing' });
    await expect(store.clear('all')).rejects.toMatchObject({ code: 'password_missing' });
    await expect(fs.access(cacheDir)).rejects.toThrow();
    // The composite's first-value reads never reach the vault, so the directory must refuse on its own.
    const d = { ...mkDef('cached-required-reads', cacheDir), oauthVaultEncryption: 'required' as const };
    const persistence = await buildOAuthPersistence(d);
    await expect(persistence.readCodeVerifier()).rejects.toMatchObject({ code: 'password_missing' });
    await expect(persistence.readState()).rejects.toMatchObject({ code: 'password_missing' });
  });

  it('refuses to clear legacy artifacts under a config required policy without a password', async () => {
    vi.spyOn(os, 'homedir').mockReturnValue(dir);
    const d = { ...mkDef('req-legacy-clear'), oauthVaultEncryption: 'required' as const };
    const legacyTokens = path.join(dir, '.mcporter', d.name, 'tokens.json');
    await fs.mkdir(path.dirname(legacyTokens), { recursive: true });
    await fs.writeFile(legacyTokens, JSON.stringify({ access_token: 'legacy', token_type: 'Bearer' }), 'utf8');
    await expect(clearLegacyOAuthArtifacts(d, undefined, 'all')).rejects.toMatchObject({ code: 'password_missing' });
    await expect(fs.access(legacyTokens)).resolves.toBeUndefined();
  });

  it('clears a tokenCacheDir under the lock the sealing writes hold', async () => {
    // Without the lock a concurrent first-sealing save could read a file, lose
    // the race to clear's unlink, and write the sealed copy back.
    const cacheDir = path.join(dir, 'cache-clear-lock');
    const tokensPath = path.join(cacheDir, 'tokens.json');
    const store = new DirectoryPersistence(cacheDir);
    await store.saveTokens({ access_token: 'dir-access', token_type: 'Bearer' });
    const gate = Promise.withResolvers<void>();
    const acquired = Promise.withResolvers<void>();
    const lockHeld = withFileLock(tokensPath, async () => {
      acquired.resolve();
      await gate.promise;
    });
    await acquired.promise;
    const cleared = store.clear('all');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(fs.access(tokensPath)).resolves.toBeUndefined();
    gate.resolve();
    await lockHeld;
    await cleared;
    await expect(fs.access(tokensPath)).rejects.toThrow();
  });

  it('refuses every write to a sealed tokenCacheDir without a password and leaves it untouched', async () => {
    const cacheDir = path.join(dir, 'cache-downgrade');
    const d = mkDef('cached-downgrade', cacheDir);
    process.env.MCPORTER_VAULT_PASSWORD = PASSWORD;
    const store = new DirectoryPersistence(cacheDir, undefined, 'https://example.com/mcp');
    await store.saveTokens({ access_token: 'dir-access', refresh_token: 'dir-refresh', token_type: 'Bearer' });
    await store.saveClientInfo({ client_id: 'dir-client', client_secret: 'dir-secret' });
    const snapshot = async () =>
      Object.fromEntries(
        await Promise.all(
          (await fs.readdir(cacheDir))
            .toSorted()
            .map(async (f) => [f, await fs.readFile(path.join(cacheDir, f), 'utf8')])
        )
      );
    const before = await snapshot();
    delete process.env.MCPORTER_VAULT_PASSWORD;
    await expect(store.saveTokens({ access_token: 'plain', token_type: 'Bearer' })).rejects.toMatchObject({
      code: 'password_missing',
    });
    await expect(
      store.saveDiscoveryState({ authorizationServerUrl: 'https://auth.example.com' })
    ).rejects.toMatchObject({ code: 'password_missing' });
    // The composite path the SDK uses: the directory refuses on its own, before the vault answers.
    const persistence = await buildOAuthPersistence(d);
    await expect(persistence.saveTokens({ access_token: 'plain', token_type: 'Bearer' })).rejects.toMatchObject({
      code: 'password_missing',
    });
    // Deleting is a modification too; the vault refuses it the same way.
    await expect(store.clear('all')).rejects.toMatchObject({ code: 'password_missing' });
    expect(await snapshot()).toEqual(before);
  });

  it('refuses to invalidate a sealed tokenCacheDir on a server URL change without a password', async () => {
    const cacheDir = path.join(dir, 'cache-url-change');
    process.env.MCPORTER_VAULT_PASSWORD = PASSWORD;
    await new DirectoryPersistence(cacheDir, undefined, 'https://a.example.com/mcp').saveTokens({
      access_token: 'dir-access',
      token_type: 'Bearer',
    });
    delete process.env.MCPORTER_VAULT_PASSWORD;
    const moved = new DirectoryPersistence(cacheDir, undefined, 'https://b.example.com/mcp');
    await expect(moved.readTokens()).rejects.toMatchObject({ code: 'password_missing' });
    await expect(fs.access(path.join(cacheDir, 'tokens.json'))).resolves.toBeUndefined();
    expect((await fs.readFile(path.join(cacheDir, 'server_url.txt'), 'utf8')).trim()).toBe('https://a.example.com/mcp');
  });

  it('seals a plaintext tokenCacheDir on a metadata save with a password', async () => {
    const cacheDir = path.join(dir, 'cache-metadata-sweep');
    const store = new DirectoryPersistence(cacheDir, undefined, 'https://example.com/mcp');
    await store.saveTokens({ access_token: 'dir-access', refresh_token: 'dir-refresh', token_type: 'Bearer' });
    await store.saveClientInfo({ client_id: 'dir-client', client_secret: 'dir-secret' });
    process.env.MCPORTER_VAULT_PASSWORD = PASSWORD;
    await store.saveResourceUrl('https://example.com/mcp');
    const tokens = (await readJsonFile<{ access_token: string; refresh_token: string }>(
      path.join(cacheDir, 'tokens.json')
    ))!;
    const client = (await readJsonFile<{ client_secret: string }>(path.join(cacheDir, 'client.json')))!;
    expect(isVaultSecretJwe(tokens.access_token)).toBe(true);
    expect(isVaultSecretJwe(tokens.refresh_token)).toBe(true);
    expect(isVaultSecretJwe(client.client_secret)).toBe(true);
    await expect(store.readSnapshot()).resolves.toMatchObject({
      tokens: { access_token: 'dir-access' },
      clientInfo: { client_secret: 'dir-secret' },
      resourceUrl: 'https://example.com/mcp',
    });
  });

  it('does not let a plaintext tokenCacheDir hide a sealed vault without a password', async () => {
    const cacheDir = path.join(dir, 'cache-hides-vault');
    const d = mkDef('cached-hides-vault', cacheDir);
    await seed({ [vaultKeyForDefinition(d)]: await vaultSealedEntry(d, PASSWORD) });
    const store = new DirectoryPersistence(cacheDir, undefined, 'https://example.com/mcp');
    await store.saveTokens({ access_token: 'dir-access', token_type: 'Bearer' });
    await store.saveClientInfo({ client_id: 'dir-client' });
    const persistence = await buildOAuthPersistence(d);
    await expect(persistence.readTokens()).rejects.toMatchObject({ code: 'password_missing' });
    await expect(persistence.readClientInfo()).rejects.toMatchObject({ code: 'password_missing' });
    await expect(readCachedAccessToken(d)).rejects.toMatchObject({ code: 'password_missing' });
  });

  it('seals every plaintext secret file in a tokenCacheDir on the first write with a password', async () => {
    const cacheDir = path.join(dir, 'cache-sweep');
    const store = new DirectoryPersistence(cacheDir, undefined, 'https://example.com/mcp');
    await store.saveTokens({ access_token: 'dir-access', refresh_token: 'dir-refresh', token_type: 'Bearer' });
    await store.saveClientInfo({ client_id: 'dir-client', client_secret: 'dir-secret' });
    await store.saveCodeVerifier('verifier-plain');
    process.env.MCPORTER_VAULT_PASSWORD = PASSWORD;
    await store.saveState('state-plain');
    const readFiles = async () => ({
      tokens: (await readJsonFile<{ access_token: string; refresh_token: string }>(
        path.join(cacheDir, 'tokens.json')
      ))!,
      client: (await readJsonFile<{ client_id: string; client_secret: string }>(path.join(cacheDir, 'client.json')))!,
      verifier: (await fs.readFile(path.join(cacheDir, 'code_verifier.txt'), 'utf8')).trim(),
      state: (await readJsonFile<string>(path.join(cacheDir, 'state.txt')))!,
    });
    const first = await readFiles();
    expect(first.client.client_id).toBe('dir-client');
    for (const [label, value] of [
      ['tokens.json/access_token', first.tokens.access_token],
      ['tokens.json/refresh_token', first.tokens.refresh_token],
      ['client.json/client_secret', first.client.client_secret],
      ['code_verifier.txt', first.verifier],
      ['state.txt', first.state],
    ] as const) {
      expect(isVaultSecretJwe(value), label).toBe(true);
    }
    await expect(store.readSnapshot()).resolves.toMatchObject({
      tokens: { access_token: 'dir-access', refresh_token: 'dir-refresh' },
      clientInfo: { client_id: 'dir-client', client_secret: 'dir-secret' },
      codeVerifier: 'verifier-plain',
      state: 'state-plain',
    });
    // Already sealed files are left byte-identical by later writes.
    await store.saveState('state-next');
    const second = await readFiles();
    expect(second.tokens).toEqual(first.tokens);
    expect(second.client).toEqual(first.client);
    expect(second.verifier).toBe(first.verifier);
  });

  it('moves a legacy per-server cache into the vault and removes it when a password is set', async () => {
    const d = mkDef('legacy-dir');
    const legacyDir = path.join(dir, '.mcporter', 'legacy-dir');
    vi.spyOn(os, 'homedir').mockReturnValue(dir);
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(
      path.join(legacyDir, 'tokens.json'),
      JSON.stringify({ access_token: 'legacy-access', refresh_token: 'legacy-refresh', token_type: 'Bearer' }),
      'utf8'
    );
    process.env.MCPORTER_VAULT_PASSWORD = PASSWORD;
    await buildOAuthPersistence(d);
    await expect(loadVaultEntry(d)).resolves.toMatchObject({ tokens: { access_token: 'legacy-access' } });
    expect(isVaultSecretJwe((await stored()).entries[vaultKeyForDefinition(d)]!.tokens.refresh_token)).toBe(true);
    await expect(fs.access(path.join(legacyDir, 'tokens.json'))).rejects.toThrow();
  });

  it('keeps the legacy per-server cache without a password, as before', async () => {
    const d = mkDef('legacy-dir-plain');
    const legacyDir = path.join(dir, '.mcporter', 'legacy-dir-plain');
    vi.spyOn(os, 'homedir').mockReturnValue(dir);
    await fs.mkdir(legacyDir, { recursive: true });
    const tokens = { access_token: 'legacy-access', refresh_token: 'legacy-refresh', token_type: 'Bearer' };
    await fs.writeFile(path.join(legacyDir, 'tokens.json'), JSON.stringify(tokens), 'utf8');
    await buildOAuthPersistence(d);
    await expect(loadVaultEntry(d)).resolves.toMatchObject({ tokens: { access_token: 'legacy-access' } });
    await expect(readJsonFile(path.join(legacyDir, 'tokens.json'))).resolves.toEqual(tokens);
  });

  it('rejects a refresh whose vault write fails instead of returning the stale token', async () => {
    const d = mkDef('refresh-write-fails');
    const e = vaultPlainEntry(d);
    // serverUrls is pre-populated so the URL reconciliation on read does not
    // write; the first vault write is then the save after the refresh.
    await fs.mkdir(path.dirname(vaultPath), { recursive: true });
    await fs.writeFile(
      vaultPath,
      JSON.stringify({
        version: 2,
        entries: {
          [vaultKeyForDefinition(d)]: { ...e, tokens: { ...e.tokens, expires_at: Math.floor(Date.now() / 1000) - 30 } },
        },
        serverUrls: { [d.name]: 'https://example.com/mcp' },
      }),
      'utf8'
    );
    process.env.MCPORTER_VAULT_PASSWORD = PASSWORD;
    authMocks.discoverOAuthServerInfo.mockResolvedValue({ authorizationServerUrl: 'https://auth.example.com' });
    authMocks.refreshAuthorization.mockResolvedValue({
      access_token: 'fresh-access',
      refresh_token: 'fresh-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
    });
    const { VaultEncryptionError } = await import('../src/oauth-vault-encryption.js');
    codecMocks.sealVaultSecret.mockRejectedValueOnce(new VaultEncryptionError('payload_invalid', 'self-check failed'));
    await expect(readCachedAccessToken(d)).rejects.toMatchObject({ code: 'payload_invalid' });
  });

  it('repairs a corrupt vault as today when the password is set', async () => {
    await fs.mkdir(path.dirname(vaultPath), { recursive: true });
    await fs.writeFile(vaultPath, '{"version":1,"entries": { bad', 'utf8');
    process.env.MCPORTER_VAULT_PASSWORD = PASSWORD;
    await clearVaultEntry(mkDef('missing'), 'all');
    expect(await readJsonFile(vaultPath)).toEqual({ version: 2, entries: {} });
  });
});
