import fs from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { readJsonFile } from '../src/fs-json.js';
import { buildOAuthPersistence, clearOAuthCaches, readCachedAccessToken } from '../src/oauth-persistence.js';
import { clearVaultEntry, loadVaultEntry, saveVaultEntry, vaultKeyForDefinition } from '../src/oauth-vault.js';

const authMocks = vi.hoisted(() => ({
  discoverOAuthServerInfo: vi.fn(),
  refreshAuthorization: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@modelcontextprotocol/sdk/client/auth.js')>()),
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

    expect(await readJsonFile(vaultPath)).toEqual({ version: 1, entries: {} });
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
      expect.objectContaining({ access_token: 'expired-token', refresh_token: 'refresh-123' })
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
        access_token: 'expired-token',
        token_type: 'Bearer',
        refresh_token: 'rotated-out-refresh',
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
        access_token: 'expired-token',
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
        access_token: 'expired-token',
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
        access_token: 'winner-token',
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

    await expect(readCachedAccessToken(definition)).resolves.toBe('winner-token');

    // The winner's tokens must survive — not be clobbered or cleared by the loser.
    await expect(readJsonFile(path.join(cacheDir, 'tokens.json'))).resolves.toEqual(
      expect.objectContaining({ access_token: 'winner-token', refresh_token: 'refresh-new' })
    );
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
});
