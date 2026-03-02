import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { createOAuthSession } from '../src/oauth.js';

describe('FileOAuthClientProvider session lifecycle', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
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
});
