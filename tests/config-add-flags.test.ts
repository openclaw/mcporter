import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAddCommand } from '../src/cli/config/add.js';
import type { LoadConfigOptions } from '../src/config.js';
import { createTempConfig } from './fixtures/config-fixture.js';

describe('config add flag parsing', () => {
  let loadOptions: LoadConfigOptions;
  let cleanup: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    const ctx = await createTempConfig();
    loadOptions = ctx.loadOptions;
    cleanup = () => ctx.cleanup();
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
    vi.restoreAllMocks();
  });

  it('merges env, headers, description and auth metadata, and respects dry-run', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleAddCommand({ loadOptions } as never, [
      'example',
      'https://api.example.com/mcp',
      '--env',
      'FOO=bar',
      '--header',
      'X-Test=1',
      '--description',
      'desc',
      '--auth',
      'oauth',
      '--client-name',
      'mcporter',
      '--oauth-client-id',
      'client-123',
      '--oauth-client-secret-env',
      'HUBSPOT_CLIENT_SECRET',
      '--oauth-token-endpoint-auth-method',
      'client_secret_post',
      '--oauth-redirect-url',
      'https://example.com/callback',
      '--dry-run',
    ]);

    const payloadLine = logSpy.mock.calls
      .map((call) => call[0])
      .find((msg) => typeof msg === 'string' && msg.trim().startsWith('{'));
    logSpy.mockRestore();

    expect(payloadLine).toBeDefined();
    const payload = JSON.parse(String(payloadLine)) as Record<string, unknown>;
    const entry = payload.example as Record<string, unknown>;
    expect(entry.baseUrl).toBe('https://api.example.com/mcp');
    expect(entry.env).toEqual({ FOO: 'bar' });
    expect(entry.headers).toEqual({ 'X-Test': '1' });
    expect(entry.description).toBe('desc');
    expect(entry.auth).toBe('oauth');
    expect(entry.clientName).toBe('mcporter');
    expect(entry.oauthClientId).toBe('client-123');
    expect(entry.oauthClientSecretEnv).toBe('HUBSPOT_CLIENT_SECRET');
    expect(entry.oauthTokenEndpointAuthMethod).toBe('client_secret_post');
    expect(entry.oauthRedirectUrl).toBe('https://example.com/callback');
  });

  it('accepts --args as an alias for stdio args', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleAddCommand({ loadOptions } as never, [
      'stdio-example',
      '--command',
      'node',
      '--args',
      'server.js',
      '--args',
      '--port=3000',
      '--dry-run',
    ]);

    const payloadLine = logSpy.mock.calls
      .map((call) => call[0])
      .find((msg) => typeof msg === 'string' && msg.trim().startsWith('{'));
    logSpy.mockRestore();

    expect(payloadLine).toBeDefined();
    const payload = JSON.parse(String(payloadLine)) as Record<string, unknown>;
    const entry = payload['stdio-example'] as Record<string, unknown>;
    expect(entry.command).toBe('node');
    expect(entry.args).toEqual(['server.js', '--port=3000']);
  });
});
