import fs from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('keeps the original cached OAuth token when silent refresh fails', async () => {
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
    authMocks.refreshAuthorization.mockRejectedValue(new Error('invalid_grant'));

    const definition = mkDef('refresh-fail-service', cacheDir);
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
