import { describe, expect, it } from 'vitest';
import { serializeDefinition } from '../src/cli/config/render.js';
import type { ServerDefinition } from '../src/config-schema.js';

describe('config render helpers', () => {
  it('serializes HTTP definitions with headers and oauth fields', () => {
    const definition: ServerDefinition = {
      name: 'http-server',
      description: 'A test server',
      command: {
        kind: 'http',
        url: new URL('https://example.com/mcp'),
        headers: { Authorization: 'Bearer token' },
      },
      source: { kind: 'import', path: '/tmp/source.json' },
      auth: 'oauth',
      tokenCacheDir: '/tmp/cache',
      clientName: 'mcporter',
      oauthClientId: 'client-123',
      oauthClientSecret: 'do-not-render',
      oauthClientSecretEnv: 'OAUTH_SECRET',
      oauthTokenEndpointAuthMethod: 'client_secret_post',
      oauthRedirectUrl: 'https://example.com/callback',
      oauthScope: 'openid profile',
      httpFetch: 'node-http1',
      allowedTools: ['read'],
      env: { FOO: 'bar' },
    };

    const payload = serializeDefinition(definition);

    expect(payload).toMatchObject({
      transport: 'http',
      baseUrl: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' },
      auth: 'oauth',
      tokenCacheDir: '/tmp/cache',
      clientName: 'mcporter',
      oauthClientId: 'client-123',
      oauthClientSecretEnv: 'OAUTH_SECRET',
      oauthTokenEndpointAuthMethod: 'client_secret_post',
      oauthRedirectUrl: 'https://example.com/callback',
      oauthScope: 'openid profile',
      httpFetch: 'node-http1',
      allowedTools: ['read'],
      env: { FOO: 'bar' },
      source: { kind: 'import', path: '/tmp/source.json' },
    });
    expect(payload).not.toHaveProperty('oauthClientSecret');
  });

  it('serializes stdio definitions with command metadata', () => {
    const definition: ServerDefinition = {
      name: 'stdio-server',
      command: {
        kind: 'stdio',
        command: 'node',
        args: ['--version'],
        cwd: '/tmp',
      },
      blockedTools: ['write'],
    };

    const payload = serializeDefinition(definition);

    expect(payload).toMatchObject({
      transport: 'stdio',
      command: 'node',
      args: ['--version'],
      cwd: '/tmp',
      name: 'stdio-server',
      blockedTools: ['write'],
    });
  });
});
