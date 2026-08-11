import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auth as sdkAuth, resolveClientMetadata } from '@modelcontextprotocol/client';
import type { ServerDefinition } from '../src/config.js';
import { __oauthInternals, createOAuthSession, OAuthRedirectUriMismatchError } from '../src/oauth.js';
import { loadVaultEntry } from '../src/oauth-vault.js';
import { createIsolatedTestHome, type IsolatedTestHome } from './helpers/isolated-test-home.js';

type StatefulProvider = {
  redirectUrl: string | URL;
  state: () => Promise<string>;
  redirectToAuthorization: (authorizationUrl: URL) => Promise<void>;
  hasAuthorizationRedirectStarted: () => boolean;
};

const requestResponse = (target: URL): Promise<{ status: number; body: string; contentType?: string }> =>
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
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          resolve({
            status,
            body: Buffer.concat(chunks).toString('utf8'),
            ...(typeof res.headers['content-type'] === 'string' ? { contentType: res.headers['content-type'] } : {}),
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });

const requestStatus = async (target: URL): Promise<number> => (await requestResponse(target)).status;

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

  it('does not leave a callback listener bound when CIMD configuration is invalid', async () => {
    const tokenCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-test-'));
    tempDirs.push(tokenCacheDir);
    const definition: ServerDefinition = {
      name: 'test-oauth-invalid-cimd',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'oauth',
      tokenCacheDir,
      oauthClientMetadataUrl: 'http://client.example.com/oauth/metadata.json',
    };
    const originalCreateServer = http.createServer.bind(http);
    const createdServers: http.Server[] = [];
    const createServerSpy = vi.spyOn(http, 'createServer').mockImplementation((...args) => {
      const server = originalCreateServer(...args);
      createdServers.push(server);
      return server;
    });

    try {
      await expect(createOAuthSession(definition, { info: vi.fn(), warn: vi.fn(), error: vi.fn() })).rejects.toThrow();
      expect(createdServers.every((server) => !server.listening)).toBe(true);
    } finally {
      await Promise.all(
        createdServers.map(
          (server) =>
            new Promise<void>((resolve) => {
              if (!server.listening) return resolve();
              server.close(() => resolve());
            })
        )
      );
      createServerSpy.mockRestore();
    }
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

  it('lets the SDK reauthorize when expired tokens have no dynamic client registration', async () => {
    const tokenCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-test-'));
    tempDirs.push(tokenCacheDir);
    const oauthServer = await startOAuthMetadataServer(false);
    await fs.writeFile(
      path.join(tokenCacheDir, 'tokens.json'),
      JSON.stringify({
        access_token: 'expired-token',
        token_type: 'Bearer',
        refresh_token: 'orphaned-refresh-token',
        expires_at: 1,
      }),
      'utf8'
    );
    const definition: ServerDefinition = {
      name: 'test-oauth-missing-client',
      command: { kind: 'http', url: new URL(oauthServer.serverUrl) },
      auth: 'oauth',
      tokenCacheDir,
    };
    const authorizationRequests: URL[] = [];
    const session = await createOAuthSession(
      definition,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      {
        suppressBrowserLaunch: true,
        onAuthorizationUrl: ({ authorizationUrl }) => {
          authorizationRequests.push(new URL(authorizationUrl));
        },
      }
    );

    try {
      await expect(sdkAuth(session.provider, { serverUrl: oauthServer.serverUrl })).resolves.toBe('REDIRECT');
      expect(oauthServer.registrationCount()).toBe(1);
      expect(authorizationRequests).toHaveLength(1);
      expect(authorizationRequests[0]?.searchParams.get('client_id')).toBe('replacement-dcr-client');
    } finally {
      const pending = session.waitForAuthorizationCode().catch(() => undefined);
      await session.close();
      await pending;
      await oauthServer.close();
    }
  });

  it('preserves refreshable credentials when a new session allocates a different dynamic port', async () => {
    const tokenCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-test-'));
    tempDirs.push(tokenCacheDir);
    await fs.writeFile(
      path.join(tokenCacheDir, 'tokens.json'),
      JSON.stringify(
        {
          access_token: 'expired-token',
          token_type: 'Bearer',
          refresh_token: 'refresh-token',
          expires_at: 1,
        },
        null,
        2
      ),
      'utf8'
    );
    await fs.writeFile(
      path.join(tokenCacheDir, 'client.json'),
      JSON.stringify(
        {
          client_id: 'refreshable-client',
          redirect_uris: ['http://127.0.0.1:9999/callback'],
        },
        null,
        2
      ),
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

    await expect(fs.readFile(path.join(tokenCacheDir, 'client.json'), 'utf8').then(JSON.parse)).resolves.toMatchObject({
      client_id: 'refreshable-client',
      redirect_uris: ['http://127.0.0.1:9999/callback'],
    });
    await expect(fs.readFile(path.join(tokenCacheDir, 'tokens.json'), 'utf8').then(JSON.parse)).resolves.toMatchObject({
      refresh_token: 'refresh-token',
    });
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('clearing stale client registration'));
  });

  it('replaces an obsolete dynamic registration only when interactive authorization starts', async () => {
    const tokenCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-test-'));
    tempDirs.push(tokenCacheDir);
    await fs.writeFile(
      path.join(tokenCacheDir, 'tokens.json'),
      JSON.stringify({
        access_token: 'expired-token',
        token_type: 'Bearer',
        refresh_token: 'rejected-refresh-token',
        expires_at: 1,
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(tokenCacheDir, 'client.json'),
      JSON.stringify({
        client_id: 'obsolete-client',
        redirect_uris: ['http://127.0.0.1:9999/callback'],
      }),
      'utf8'
    );
    const definition: ServerDefinition = {
      name: 'test-oauth-interactive-replacement',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'oauth',
      tokenCacheDir,
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const onAuthorizationUrl = vi.fn();
    const session = await createOAuthSession(definition, logger, {
      suppressBrowserLaunch: true,
      onAuthorizationUrl,
    });
    const provider = session.provider;
    const authorizationUrl = new URL('https://auth.example.com/authorize');

    await expect(provider.redirectToAuthorization(authorizationUrl)).rejects.toBeInstanceOf(
      OAuthRedirectUriMismatchError
    );
    await expect(fs.access(path.join(tokenCacheDir, 'client.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(path.join(tokenCacheDir, 'tokens.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(onAuthorizationUrl).not.toHaveBeenCalled();

    const replacement = {
      client_id: 'replacement-client',
      redirect_uris: [String(provider.redirectUrl)],
    };
    await provider.saveClientInformation?.(replacement);
    await provider.redirectToAuthorization(authorizationUrl);

    expect(onAuthorizationUrl).toHaveBeenCalledTimes(1);
    await expect(provider.clientInformation()).resolves.toMatchObject(replacement);
    const pending = session.waitForAuthorizationCode().catch(() => undefined);
    await session.close();
    await pending;
  });

  it('repairs a stale DCR client when a configured metadata URL is unsupported', async () => {
    const tokenCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-test-'));
    tempDirs.push(tokenCacheDir);
    const oauthServer = await startOAuthMetadataServer(false);
    const metadataUrl = 'https://client.example.com/oauth/metadata.json';
    const issuer = new URL(oauthServer.serverUrl).origin;
    await fs.writeFile(
      path.join(tokenCacheDir, 'tokens.json'),
      JSON.stringify({ access_token: 'expired-token', token_type: 'Bearer', expires_at: 1, issuer }),
      'utf8'
    );
    await fs.writeFile(
      path.join(tokenCacheDir, 'client.json'),
      JSON.stringify({
        client_id: 'fallback-dcr-client',
        redirect_uris: ['http://127.0.0.1:9999/callback'],
        token_endpoint_auth_method: 'none',
        issuer,
      }),
      'utf8'
    );
    const definition: ServerDefinition = {
      name: 'test-oauth-cimd-dcr-fallback',
      command: { kind: 'http', url: new URL(oauthServer.serverUrl) },
      auth: 'oauth',
      tokenCacheDir,
      oauthClientMetadataUrl: metadataUrl,
    };
    const authorizationRequests: URL[] = [];
    const session = await createOAuthSession(
      definition,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      {
        suppressBrowserLaunch: true,
        onAuthorizationUrl: ({ authorizationUrl }) => {
          authorizationRequests.push(new URL(authorizationUrl));
        },
      }
    );

    try {
      await expect(sdkAuth(session.provider, { serverUrl: oauthServer.serverUrl })).rejects.toBeInstanceOf(
        OAuthRedirectUriMismatchError
      );
      expect(oauthServer.registrationCount()).toBe(0);
      await expect(fs.access(path.join(tokenCacheDir, 'client.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(path.join(tokenCacheDir, 'tokens.json'))).rejects.toMatchObject({ code: 'ENOENT' });

      await expect(sdkAuth(session.provider, { serverUrl: oauthServer.serverUrl })).resolves.toBe('REDIRECT');
      expect(oauthServer.registrationCount()).toBe(1);
      expect(authorizationRequests).toHaveLength(1);
      expect(authorizationRequests[0]?.searchParams.get('client_id')).toBe('replacement-dcr-client');
      await expect(session.provider.clientInformation()).resolves.toMatchObject({
        client_id: 'replacement-dcr-client',
        redirect_uris: [String(session.provider.redirectUrl)],
      });
    } finally {
      const pending = session.waitForAuthorizationCode().catch(() => undefined);
      await session.close();
      await pending;
      await oauthServer.close();
    }
  });

  it('preserves a genuine metadata-URL client identity across callback ports', async () => {
    const tokenCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-test-'));
    tempDirs.push(tokenCacheDir);
    const oauthServer = await startOAuthMetadataServer(true);
    const metadataUrl = 'https://client.example.com/oauth/metadata.json';
    const issuer = new URL(oauthServer.serverUrl).origin;
    await fs.writeFile(
      path.join(tokenCacheDir, 'client.json'),
      JSON.stringify({
        client_id: metadataUrl,
        redirect_uris: ['http://127.0.0.1:9999/callback'],
        issuer,
      }),
      'utf8'
    );
    const definition: ServerDefinition = {
      name: 'test-oauth-cimd-client',
      command: { kind: 'http', url: new URL(oauthServer.serverUrl) },
      auth: 'oauth',
      tokenCacheDir,
      oauthClientMetadataUrl: metadataUrl,
    };
    const authorizationRequests: URL[] = [];
    const session = await createOAuthSession(
      definition,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      {
        suppressBrowserLaunch: true,
        onAuthorizationUrl: ({ authorizationUrl }) => {
          authorizationRequests.push(new URL(authorizationUrl));
        },
      }
    );

    try {
      await expect(sdkAuth(session.provider, { serverUrl: oauthServer.serverUrl })).resolves.toBe('REDIRECT');
      expect(oauthServer.registrationCount()).toBe(0);
      expect(authorizationRequests).toHaveLength(1);
      expect(authorizationRequests[0]?.searchParams.get('client_id')).toBe(metadataUrl);
      await expect(session.provider.clientInformation()).resolves.toMatchObject({ client_id: metadataUrl });
    } finally {
      const pending = session.waitForAuthorizationCode().catch(() => undefined);
      await session.close();
      await pending;
      await oauthServer.close();
    }
  });

  it('closes the callback server when interactive stale-client reads have I/O errors', async () => {
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
    const originalCreateServer = http.createServer.bind(http);
    const createdServers: http.Server[] = [];
    const createServerSpy = vi.spyOn(http, 'createServer').mockImplementation((...args) => {
      const server = originalCreateServer(...args);
      createdServers.push(server);
      return server;
    });

    try {
      const session = await createOAuthSession(definition, logger);
      const readFileSpy = vi.spyOn(fs, 'readFile').mockRejectedValueOnce(readError);
      await expect(
        session.provider.redirectToAuthorization(new URL('https://auth.example.com/authorize'))
      ).rejects.toMatchObject({ code: 'EACCES' });
      readFileSpy.mockRestore();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(createdServers).toHaveLength(1);
      expect(createdServers[0]?.listening).toBe(false);
    } finally {
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

  it('does not reflect OAuth callback errors into HTML or terminal-facing errors', async () => {
    const tokenCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-test-'));
    tempDirs.push(tokenCacheDir);
    const definition: ServerDefinition = {
      name: 'test-oauth-error-callback',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'oauth',
      tokenCacheDir,
    };
    const session = await createOAuthSession(definition, { info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    const provider = session.provider as StatefulProvider;
    const state = await provider.state();
    const payload = '<script>globalThis.pwned = true</script>\u001b[2J';
    const callback = new URL(String(provider.redirectUrl));
    callback.searchParams.set('error', payload);
    callback.searchParams.set('state', state);
    const waitPromise = session.waitForAuthorizationCode().then(
      () => undefined,
      (error: unknown) => error
    );

    const response = await requestResponse(callback);
    const rejection = await waitPromise;

    expect(response.status).toBe(400);
    expect(response.contentType).toContain('text/html');
    expect(response.body).not.toContain(payload);
    expect(response.body).not.toContain('<script>');
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).not.toContain(payload);
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

  it.each(['1', 'true', 'TRUE', 'yes', ' YeS '])(
    'suppresses browser launch via truthy MCPORTER_OAUTH_NO_BROWSER=%j without session options (#283)',
    async (envValue) => {
      const tokenCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-test-'));
      tempDirs.push(tokenCacheDir);
      const definition: ServerDefinition = {
        name: 'test-oauth-env-no-browser',
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

      vi.stubEnv('MCPORTER_OAUTH_NO_BROWSER', envValue);
      try {
        const session = await createOAuthSession(definition, logger);
        const provider = session.provider as StatefulProvider;
        const openSpy = vi.spyOn(__oauthInternals, 'openExternal').mockImplementation(() => {});
        const authorizationUrl = new URL('https://example.com/auth?code=xyz');

        await provider.redirectToAuthorization(authorizationUrl);

        // Waiters fail fast with a server-named error instead of waiting out the
        // authorization timeout — including ones that attach after the redirect.
        await expect(session.waitForAuthorizationCode()).rejects.toMatchObject({
          name: 'BrowserLaunchSuppressedError',
          serverName: 'test-oauth-env-no-browser',
        });

        expect(openSpy).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining("run 'mcporter auth test-oauth-env-no-browser --no-browser' to authorize")
        );
        expect(logger.warn.mock.calls.flat().join('\n')).not.toContain(authorizationUrl.toString());
        expect(provider.hasAuthorizationRedirectStarted()).toBe(true);

        await session.close();
      } finally {
        vi.unstubAllEnvs();
      }
    }
  );

  it.each(['0', 'false', 'FALSE', 'no', '', 'unexpected'])(
    'ignores falsy MCPORTER_OAUTH_NO_BROWSER=%j and still opens the browser',
    async (envValue) => {
      const tokenCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-test-'));
      tempDirs.push(tokenCacheDir);
      const definition: ServerDefinition = {
        name: 'test-oauth-env-no-browser-falsy',
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

      vi.stubEnv('MCPORTER_OAUTH_NO_BROWSER', envValue);
      try {
        const session = await createOAuthSession(definition, logger);
        const provider = session.provider as StatefulProvider;
        const openSpy = vi.spyOn(__oauthInternals, 'openExternal').mockImplementation(() => {});
        const authorizationUrl = new URL('https://example.com/auth?code=xyz');
        const waitPromise = session.waitForAuthorizationCode().catch(() => undefined);

        await provider.redirectToAuthorization(authorizationUrl);

        expect(openSpy).toHaveBeenCalledWith(authorizationUrl.toString());

        await session.close();
        await waitPromise;
      } finally {
        vi.unstubAllEnvs();
      }
    }
  );

  it('lets explicit suppressBrowserLaunch false override a truthy environment value', async () => {
    const tokenCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-test-'));
    tempDirs.push(tokenCacheDir);
    const definition: ServerDefinition = {
      name: 'test-oauth-explicit-browser',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'oauth',
      tokenCacheDir,
    };
    vi.stubEnv('MCPORTER_OAUTH_NO_BROWSER', 'yes');
    try {
      const session = await createOAuthSession(
        definition,
        { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        { suppressBrowserLaunch: false }
      );
      const provider = session.provider as StatefulProvider;
      const openSpy = vi.spyOn(__oauthInternals, 'openExternal').mockImplementation(() => {});
      const authorizationUrl = new URL('https://example.com/auth?explicit=true');
      const pending = session.waitForAuthorizationCode().catch(() => undefined);

      await provider.redirectToAuthorization(authorizationUrl);

      expect(openSpy).toHaveBeenCalledWith(authorizationUrl.toString());
      await session.close();
      await pending;
    } finally {
      vi.unstubAllEnvs();
    }
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

async function startOAuthMetadataServer(supportsUrlBasedClientId: boolean): Promise<{
  serverUrl: string;
  registrationCount: () => number;
  close: () => Promise<void>;
}> {
  let origin = '';
  let serverUrl = '';
  let registrations = 0;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', origin);
    if (url.pathname.includes('.well-known/oauth-protected-resource')) {
      sendJson(response, { resource: serverUrl, authorization_servers: [origin] });
      return;
    }
    if (
      url.pathname.includes('.well-known/oauth-authorization-server') ||
      url.pathname.includes('openid-configuration')
    ) {
      sendJson(response, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        client_id_metadata_document_supported: supportsUrlBasedClientId,
      });
      return;
    }
    if (url.pathname === '/register' && request.method === 'POST') {
      registrations += 1;
      const body = await readRequestJson(request);
      sendJson(response, { ...body, client_id: 'replacement-dcr-client' });
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  serverUrl = `${origin}/mcp`;
  return {
    serverUrl,
    registrationCount: () => registrations,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function sendJson(response: http.ServerResponse, body: unknown): void {
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}

async function readRequestJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}
