import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { __oauthInternals, createOAuthSession } from '../src/oauth.js';

type StatefulProvider = {
  redirectUrl: string | URL;
  state: () => Promise<string>;
  redirectToAuthorization: (authorizationUrl: URL) => Promise<void>;
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

describe('FileOAuthClientProvider session lifecycle', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.MCPORTER_TEST_OAUTH_SECRET;
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
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

  it('closes the callback server when stale-client reads throw', async () => {
    const tokenCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-test-'));
    tempDirs.push(tokenCacheDir);
    await fs.writeFile(path.join(tokenCacheDir, 'client.json'), '{not-valid-json', 'utf8');
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

    const originalCreateServer = http.createServer.bind(http);
    const createdServers: http.Server[] = [];
    const createServerSpy = vi.spyOn(http, 'createServer').mockImplementation((...args) => {
      const server = originalCreateServer(...args);
      createdServers.push(server);
      return server;
    });

    try {
      await expect(createOAuthSession(definition, logger)).rejects.toThrow(SyntaxError);
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
});
