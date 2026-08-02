import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveClientMetadata } from '@modelcontextprotocol/client';
import type { ServerDefinition } from '../src/config.js';
import { __oauthInternals, createOAuthSession } from '../src/oauth.js';
import { loadVaultEntry } from '../src/oauth-vault.js';
import { createIsolatedTestHome, type IsolatedTestHome } from './helpers/isolated-test-home.js';

type StatefulProvider = {
  redirectUrl: string | URL;
  state: () => Promise<string>;
  redirectToAuthorization: (authorizationUrl: URL) => Promise<void>;
  hasAuthorizationRedirectStarted: () => boolean;
};

const requestStatus = (target: URL): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        family: 4,
        method: 'GET',
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.resume();
        resolve(status);
      }
    );
    req.on('error', reject);
    req.end();
  });

const authorizationUrlFor = (verifier: string) => {
  const url = new URL('https://auth.example.com/authorize');
  url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
  return url;
};

describe('FileOAuthClientProvider session lifecycle', () => {
  const tempDirs: string[] = [];
  let isolatedHome: IsolatedTestHome;

  beforeEach(async () => {
    isolatedHome = await createIsolatedTestHome('mcporter-oauth-session');
  });

  afterEach(async () => {
    try {
      delete process.env.MCPORTER_TEST_OAUTH_SECRET;
      await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
      await isolatedHome.cleanup();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('rejects pending authorization waits when the session closes early', async () => {
    const tokenCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-test-'));
    tempDirs.push(tokenCacheDir);
    const definition: ServerDefinition = {
      name: 'test-oauth',
      description: 'Test OAuth server',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'oauth',
      tokenCacheDir,
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const session = await createOAuthSession(definition, logger);
    const waitPromise = session.waitForAuthorizationCode();
    await session.close();
    await expect(waitPromise).rejects.toThrow(/closed before receiving authorization code/i);
  });

  it('uses oauthScope when explicitly configured', async () => {
    const tokenCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-test-'));
    tempDirs.push(tokenCacheDir);
    const definition: ServerDefinition = {
      name: 'test-oauth-scope',
      description: 'Test OAuth server',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'oauth',
      tokenCacheDir,
      oauthScope: 'openid email profile',
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const session = await createOAuthSession(definition, logger);
    expect((session.provider as { clientMetadata: { scope?: string } }).clientMetadata.scope).toBe(
      'openid email profile'
    );
    await session.close();
  });

  it('surfaces CIMD config and lets the SDK derive native application_type', async () => {
    const tokenCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-test-'));
    tempDirs.push(tokenCacheDir);
    const definition: ServerDefinition = {
      name: 'test-oauth-cimd',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'oauth',
      tokenCacheDir,
      oauthClientMetadataUrl: 'https://client.example.com/oauth/metadata.json',
    };
    const session = await createOAuthSession(definition, { info: vi.fn(), warn: vi.fn(), error: vi.fn() });

    expect(session.provider.clientMetadataUrl).toBe('https://client.example.com/oauth/metadata.json');
    expect(resolveClientMetadata(session.provider).application_type).toBe('native');
    await session.close();
  });

  it('round-trips discovery state and resolved URLs through the provider and vault', async () => {
    const tokenCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-test-'));
    tempDirs.push(tokenCacheDir);
    const definition: ServerDefinition = {
      name: 'test-oauth-discovery',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'oauth',
      tokenCacheDir,
    };
    const session = await createOAuthSession(definition, { info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    const state = { authorizationServerUrl: 'https://auth.example.com' };

    await session.provider.saveDiscoveryState?.(state);
    await session.provider.saveAuthorizationServerUrl?.('https://auth.example.com');
    await session.provider.saveResourceUrl?.('https://example.com/mcp');

    await expect(session.provider.discoveryState?.()).resolves.toEqual(state);
    await expect(session.provider.authorizationServerUrl?.()).resolves.toBe('https://auth.example.com');
    await expect(session.provider.resourceUrl?.()).resolves.toBe('https://example.com/mcp');
    await expect(loadVaultEntry(definition)).resolves.toMatchObject({
      discoveryState: state,
      authorizationServerUrl: 'https://auth.example.com',
      resourceUrl: 'https://example.com/mcp',
    });
    await session.close();
  });

  it('discards issuer-mismatched credentials but accepts legacy unstamped records', async () => {
    const tokenCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-test-'));
    tempDirs.push(tokenCacheDir);
    const definition: ServerDefinition = {
      name: 'test-oauth-issuer-binding',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'oauth',
      tokenCacheDir,
    };
    const session = await createOAuthSession(definition, { info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    await session.provider.saveTokens({
      access_token: 'old-token',
      token_type: 'Bearer',
      issuer: 'https://old-issuer.example',
    });
    await session.provider.saveClientInformation?.({
      client_id: 'old-client',
      issuer: 'https://old-issuer.example',
    });

    await expect(session.provider.tokens({ issuer: 'https://new-issuer.example' })).resolves.toBeUndefined();
    await expect(session.provider.clientInformation({ issuer: 'https://new-issuer.example' })).resolves.toBeUndefined();
    await expect(fs.access(path.join(tokenCacheDir, 'tokens.json'))).rejects.toThrow();
    await expect(fs.access(path.join(tokenCacheDir, 'client.json'))).rejects.toThrow();

    await session.provider.saveTokens({ access_token: 'legacy-token', token_type: 'Bearer' });
    await expect(session.provider.tokens({ issuer: 'https://new-issuer.example' })).resolves.toMatchObject({
      access_token: 'legacy-token',
    });
    await session.provider.saveTokens({
      access_token: 'stamped-token',
      token_type: 'Bearer',
      issuer: 'https://new-issuer.example',
    });
    await expect(session.provider.tokens({ issuer: 'https://new-issuer.example' })).resolves.toMatchObject({
      issuer: 'https://new-issuer.example',
    });
    await session.close();
  });

  it('returns configured static OAuth client information without dynamic registration', async () => {
    const tokenCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-test-'));
    tempDirs.push(tokenCacheDir);
    process.env.MCPORTER_TEST_OAUTH_SECRET = 'client-secret-value';
    const definition: ServerDefinition = {
      name: 'test-oauth-static-client',
      description: 'Test OAuth server',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'oauth',
      tokenCacheDir,
      oauthClientId: 'client-123',
      oauthClientSecretEnv: 'MCPORTER_TEST_OAUTH_SECRET',
      oauthTokenEndpointAuthMethod: 'client_secret_post',
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const session = await createOAuthSession(definition, logger);
    const clientInfo = await session.provider.clientInformation();
    expect(clientInfo).toMatchObject({
      client_id: 'client-123',
      client_secret: 'client-secret-value',
      token_endpoint_auth_method: 'client_secret_post',
    });
    await session.close();
  });

  it('clears stale client registrations when redirect URI changes with dynamic ports', async () => {
    const tokenCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-test-'));
    tempDirs.push(tokenCacheDir);
    await fs.writeFile(
      path.join(tokenCacheDir, 'client.json'),
      JSON.stringify({ redirect_uris: ['http://127.0.0.1:9999/callback'] }, null, 2),
      'utf8'
    );
    const definition: ServerDefinition = {
      name: 'test-oauth-stale-client',
      description: 'Test OAuth server',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'oauth',
      tokenCacheDir,
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const session = await createOAuthSession(definition, logger);
    await session.close();

    await expect(fs.readFile(path.join(tokenCacheDir, 'client.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('clearing stale client registration'));
  });

  it('closes the callback server when stale-client reads have I/O errors', async () => {
    const tokenCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-test-'));
    tempDirs.push(tokenCacheDir);
    const definition: ServerDefinition = {
      name: 'test-oauth-read-failure',
      description: 'Test OAuth server',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'oauth',
      tokenCacheDir,
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const readError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const readFileSpy = vi.spyOn(fs, 'readFile').mockRejectedValueOnce(readError);
    const originalCreateServer = http.createServer.bind(http);
    const createdServers: http.Server[] = [];
    const createServerSpy = vi.spyOn(http, 'createServer').mockImplementation((...args) => {
      const server = originalCreateServer(...args);
      createdServers.push(server);
      return server;
    });

    try {
      await expect(createOAuthSession(definition, logger)).rejects.toMatchObject({ code: 'EACCES' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(createdServers).toHaveLength(1);
      expect(createdServers[0]?.listening).toBe(false);
    } finally {
      readFileSpy.mockRestore();
      createServerSpy.mockRestore();
    }
  });

  it('resolves waiters created before redirectToAuthorization', async () => {
    const tokenCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-test-'));
    tempDirs.push(tokenCacheDir);
    const definition: ServerDefinition = {
      name: 'test-oauth-wait-before-redirect',
      description: 'Test OAuth server',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'oauth',
      tokenCacheDir,
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const session = await createOAuthSession(definition, logger);
    const provider = session.provider as StatefulProvider;
    vi.spyOn(__oauthInternals, 'openExternal').mockImplementation(() => {});
    const waitPromise = session.waitForAuthorizationCode();
    await provider.redirectToAuthorization(new URL('https://example.com/auth'));

    const callback = new URL(String(provider.redirectUrl));
    callback.hostname = '127.0.0.1';
    callback.searchParams.set('code', 'prewait-code');
    const status = await requestStatus(callback);
    expect(status).toBe(200);
    await expect(waitPromise).resolves.toBe('prewait-code');
    await session.close();
  });

  it('does not replace the pending authorization deferred on repeated redirect calls', async () => {
    const tokenCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-test-'));
    tempDirs.push(tokenCacheDir);
    const definition: ServerDefinition = {
      name: 'test-oauth-repeat-redirect',
      description: 'Test OAuth server',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'oauth',
      tokenCacheDir,
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const session = await createOAuthSession(definition, logger);
    const provider = session.provider as StatefulProvider;
    vi.spyOn(__oauthInternals, 'openExternal').mockImplementation(() => {});
    const waitPromise = session.waitForAuthorizationCode();
    await provider.redirectToAuthorization(new URL('https://example.com/auth-one'));
    await provider.redirectToAuthorization(new URL('https://example.com/auth-two'));

    const callback = new URL(String(provider.redirectUrl));
    callback.hostname = '127.0.0.1';
    callback.searchParams.set('code', 'stable-deferred-code');
    const status = await requestStatus(callback);
    expect(status).toBe(200);
    await expect(waitPromise).resolves.toBe('stable-deferred-code');
    await session.close();
  });

  it('suppresses browser launch and reports authorization URL when configured', async () => {
    const tokenCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-test-'));
    tempDirs.push(tokenCacheDir);
    const definition: ServerDefinition = {
      name: 'test-oauth-no-browser-url',
      description: 'Test OAuth server',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'oauth',
      tokenCacheDir,
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const onAuthorizationUrl = vi.fn();

    const session = await createOAuthSession(definition, logger, {
      suppressBrowserLaunch: true,
      onAuthorizationUrl,
    });
    const provider = session.provider as StatefulProvider;
    const openSpy = vi.spyOn(__oauthInternals, 'openExternal').mockImplementation(() => {});
    const authorizationUrl = new URL('https://example.com/auth?code=xyz');
    const waitPromise = session.waitForAuthorizationCode().catch(() => undefined);

    await provider.redirectToAuthorization(authorizationUrl);

    expect(openSpy).not.toHaveBeenCalled();
    expect(onAuthorizationUrl).toHaveBeenCalledWith({
      authorizationUrl: authorizationUrl.toString(),
      redirectUrl: String(provider.redirectUrl),
    });
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining(`visit ${authorizationUrl.toString()} manually`)
    );
    expect(provider.hasAuthorizationRedirectStarted()).toBe(true);

    await session.close();
    await waitPromise;
  });

  it('logs the manual OAuth URL at warn level for headless terminals (#139)', async () => {
    const tokenCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-test-'));
    tempDirs.push(tokenCacheDir);
    const definition: ServerDefinition = {
      name: 'test-oauth-headless-url',
      description: 'Test OAuth server',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'oauth',
      tokenCacheDir,
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const session = await createOAuthSession(definition, logger);
    const provider = session.provider as StatefulProvider;
    vi.spyOn(__oauthInternals, 'openExternal').mockImplementation(() => {});
    const authorizationUrl = new URL('https://example.com/auth?code=xyz');
    const waitPromise = session.waitForAuthorizationCode().catch(() => undefined);

    await provider.redirectToAuthorization(authorizationUrl);

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`visit ${authorizationUrl.toString()} manually`));

    await session.close();
    await waitPromise;
  });

  it('keeps session persistence out of ambient OAuth credentials', async () => {
    const tokenCacheDir = await fs.mkdtemp(path.join(isolatedHome.homeDir, 'token-cache-'));
    tempDirs.push(tokenCacheDir);
    const definition: ServerDefinition = {
      name: 'test-oauth-isolated-home',
      description: 'Test OAuth server',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'oauth',
      tokenCacheDir,
    };
    const session = await createOAuthSession(definition, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    });
    try {
      await (session.provider as StatefulProvider).state();
      await expect(fs.access(isolatedHome.vaultPath)).resolves.toBeUndefined();
      await isolatedHome.assertAmbientVaultUntouched();
    } finally {
      await session.close();
    }
  });

  it('serializes overlapping interactive authorizations into one completable transaction', async () => {
    const tokenCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-test-'));
    tempDirs.push(tokenCacheDir);
    const definition: ServerDefinition = {
      name: 'test-oauth-singleflight',
      description: 'Test OAuth server',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'oauth',
      tokenCacheDir,
    };
    const prompts: URL[] = [];
    const session = await createOAuthSession(
      definition,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      {
        suppressBrowserLaunch: true,
        onAuthorizationUrl: ({ authorizationUrl }) => {
          prompts.push(new URL(authorizationUrl));
        },
      }
    );
    const provider = session.provider;

    try {
      // Two SDK auth() flows interleave: both save their verifier before either redirects.
      await provider.saveCodeVerifier?.('verifier-first');
      await provider.saveCodeVerifier?.('verifier-second');
      await provider.redirectToAuthorization(authorizationUrlFor('verifier-first'));
      await provider.redirectToAuthorization(authorizationUrlFor('verifier-second'));

      // Only the first flow prompts, and the persisted verifier matches its challenge.
      expect(prompts).toHaveLength(1);
      await expect(provider.codeVerifier?.()).resolves.toBe('verifier-first');

      // A verifier saved while the transaction is pending must not clobber it.
      await provider.saveCodeVerifier?.('verifier-late');
      await expect(provider.codeVerifier?.()).resolves.toBe('verifier-first');

      // Completing the callback ends the transaction; the next flow prompts normally.
      const state = await (session.provider as StatefulProvider).state();
      const callback = new URL((session.provider as StatefulProvider).redirectUrl.toString());
      callback.searchParams.set('code', 'auth-code');
      callback.searchParams.set('state', state);
      const waitPromise = session.waitForAuthorizationCode();
      expect(await requestStatus(callback)).toBe(200);
      await expect(waitPromise).resolves.toBe('auth-code');

      await provider.saveCodeVerifier?.('verifier-next');
      await provider.redirectToAuthorization(authorizationUrlFor('verifier-next'));
      expect(prompts).toHaveLength(2);
      await expect(provider.codeVerifier?.()).resolves.toBe('verifier-next');
      const trailingWait = session.waitForAuthorizationCode();
      await session.close();
      await expect(trailingWait).rejects.toThrow(/closed before receiving authorization code/i);
    } finally {
      await session.close();
    }
  });
});
