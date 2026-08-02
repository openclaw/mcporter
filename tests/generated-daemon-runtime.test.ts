import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { createGeneratedKeepAliveRuntime } from '../src/generated-daemon-runtime.js';
import type { Runtime } from '../src/runtime.js';

describe('createGeneratedKeepAliveRuntime', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-generated-runtime-'));
    vi.stubEnv('MCPORTER_GENERATED_CONFIG_DIR', tempDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('leaves ephemeral servers on the base runtime and preserves targeted close', async () => {
    const base = runtimeDouble();
    const server: ServerDefinition = {
      name: 'ephemeral',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      lifecycle: { mode: 'ephemeral' },
    };

    const context = await createGeneratedKeepAliveRuntime(base as unknown as Runtime, server);
    await context.close('ephemeral');

    expect(context.runtime).toBe(base);
    expect(base.close).toHaveBeenCalledWith('ephemeral');
    expect(await fs.readdir(tempDir)).toEqual([]);
  });

  it('writes and reuses a complete HTTP daemon config without persisting inline secrets', async () => {
    const base = runtimeDouble();
    const server: ServerDefinition = {
      name: 'remote',
      description: 'Remote service',
      command: {
        kind: 'http',
        url: new URL('https://example.com/mcp'),
        headers: { Authorization: 'Bearer from-env' },
      },
      env: { REGION: 'test' },
      auth: 'oauth',
      tokenCacheDir: '/tmp/tokens',
      clientName: 'generated-client',
      oauthClientId: 'client-id',
      oauthClientSecret: 'must-not-be-written',
      oauthClientSecretEnv: 'CLIENT_SECRET',
      oauthTokenEndpointAuthMethod: 'client_secret_post',
      oauthRedirectUrl: 'http://127.0.0.1/callback',
      oauthClientMetadataUrl: 'https://example.com/client.json',
      oauthScope: 'read write',
      oauthCommand: { args: ['--profile', 'test'] },
      refresh: { tokenEndpoint: 'https://example.com/token', accessTokenEnv: 'ACCESS_TOKEN' },
      httpFetch: 'node-http1',
      lifecycle: { mode: 'keep-alive', idleTimeoutMs: 12_345 },
      logging: { daemon: { enabled: true } },
      allowedTools: ['read'],
    };

    const first = await createGeneratedKeepAliveRuntime(base as unknown as Runtime, server);
    const [filename] = await fs.readdir(tempDir);
    expect(filename).toMatch(/^generated-[a-f0-9]{12}\.json$/u);
    const configPath = path.join(tempDir, filename!);
    const firstStat = await fs.stat(configPath);
    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      imports: unknown[];
      mcpServers: Record<string, Record<string, unknown>>;
    };

    expect(config.imports).toEqual([]);
    expect(config.mcpServers.remote).toEqual({
      description: 'Remote service',
      env: { REGION: 'test' },
      auth: 'oauth',
      tokenCacheDir: '/tmp/tokens',
      clientName: 'generated-client',
      oauthClientId: 'client-id',
      oauthClientSecretEnv: 'CLIENT_SECRET',
      oauthTokenEndpointAuthMethod: 'client_secret_post',
      oauthRedirectUrl: 'http://127.0.0.1/callback',
      oauthClientMetadataUrl: 'https://example.com/client.json',
      oauthScope: 'read write',
      oauthCommand: { args: ['--profile', 'test'] },
      refresh: { tokenEndpoint: 'https://example.com/token', accessTokenEnv: 'ACCESS_TOKEN' },
      httpFetch: 'node-http1',
      lifecycle: { mode: 'keep-alive', idleTimeoutMs: 12_345 },
      logging: { daemon: { enabled: true } },
      allowedTools: ['read'],
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer from-env' },
    });
    expect(config.mcpServers.remote).not.toHaveProperty('oauthClientSecret');

    await createGeneratedKeepAliveRuntime(base as unknown as Runtime, server);
    expect((await fs.stat(configPath)).mtimeMs).toBe(firstStat.mtimeMs);
    await first.close('ignored-by-daemon-runtime');
    expect(base.close).toHaveBeenCalledWith();
  });

  it('serializes stdio commands, blocked tools, and compact lifecycle values', async () => {
    const base = runtimeDouble();
    const keepAlive: ServerDefinition = {
      name: 'local',
      command: { kind: 'stdio', command: 'node', args: ['server.js'], cwd: '/work' },
      lifecycle: { mode: 'keep-alive' },
      blockedTools: ['delete'],
    };
    await createGeneratedKeepAliveRuntime(base as unknown as Runtime, keepAlive);

    const ephemeral = { ...keepAlive, name: 'local-ephemeral', lifecycle: { mode: 'ephemeral' as const } };
    const forced = { ...ephemeral, lifecycle: { mode: 'keep-alive' as const, idleTimeoutMs: 0 } };
    await createGeneratedKeepAliveRuntime(base as unknown as Runtime, forced);

    const entries = await Promise.all(
      (await fs.readdir(tempDir)).map(
        async (filename) =>
          JSON.parse(await fs.readFile(path.join(tempDir, filename), 'utf8')) as {
            mcpServers: Record<string, Record<string, unknown>>;
          }
      )
    );
    const serialized = Object.assign({}, ...entries.map((entry) => entry.mcpServers));
    expect(serialized.local).toEqual({
      lifecycle: 'keep-alive',
      blockedTools: ['delete'],
      command: 'node',
      args: ['server.js'],
      cwd: '/work',
    });
    expect(serialized['local-ephemeral']?.lifecycle).toEqual({ mode: 'keep-alive', idleTimeoutMs: 0 });
  });
});

function runtimeDouble(): Pick<Runtime, 'close'> {
  return { close: vi.fn().mockResolvedValue(undefined) };
}
