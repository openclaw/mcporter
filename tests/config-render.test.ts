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
      oauthRedirectUrl: 'https://example.com/callback',
      oauthScope: 'openid profile',
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
      oauthRedirectUrl: 'https://example.com/callback',
      oauthScope: 'openid profile',
      env: { FOO: 'bar' },
      source: { kind: 'import', path: '/tmp/source.json' },
    });
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
    };

    const payload = serializeDefinition(definition);

    expect(payload).toMatchObject({
      transport: 'stdio',
      command: 'node',
      args: ['--version'],
      cwd: '/tmp',
      name: 'stdio-server',
    });
  });
});
