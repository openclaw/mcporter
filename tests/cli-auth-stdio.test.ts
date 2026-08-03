import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAuth } from '../src/cli/auth-command.js';
import type { ServerDefinition } from '../src/config.js';
import type { Runtime } from '../src/runtime.js';

function runtimeFor(definition: ServerDefinition, listTools = vi.fn().mockResolvedValue([{ name: 'one' }])): Runtime {
  return {
    getDefinitions: () => [definition],
    getDefinition: () => definition,
    registerDefinition: vi.fn(),
    listTools,
  } as unknown as Runtime;
}

describe('CLI auth helper and validation behavior', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-auth-stdio-'));
    process.env = { ...originalEnv, XDG_DATA_HOME: path.join(tempDir, 'data') };
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('runs a configured STDIO auth helper to completion', async () => {
    const definition: ServerDefinition = {
      name: 'local',
      command: {
        kind: 'stdio',
        command: process.execPath,
        args: ['-e', 'process.exit(process.env.MCPORTER_OAUTH_NO_BROWSER === "1" ? 0 : 4)'],
        cwd: tempDir,
      },
      oauthCommand: { args: [] },
    };
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(handleAuth(runtimeFor(definition), ['local', '--no-browser'])).resolves.toBeUndefined();
  });

  it('surfaces a non-zero STDIO auth helper exit', async () => {
    const definition: ServerDefinition = {
      name: 'local',
      command: { kind: 'stdio', command: process.execPath, args: ['-e', 'process.exit(3)'], cwd: tempDir },
      oauthCommand: { args: [] },
    };

    await expect(handleAuth(runtimeFor(definition), ['local'])).rejects.toThrow('Auth helper exited with code 3');
  });

  it('clears cached credentials before starting a reset flow', async () => {
    const definition: ServerDefinition = {
      name: 'linear',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      tokenCacheDir: path.join(tempDir, 'tokens'),
    };
    const listTools = vi.fn().mockResolvedValue([{ name: 'one' }, { name: 'two' }]);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleAuth(runtimeFor(definition, listTools), ['linear', '--reset']);

    expect(listTools).toHaveBeenCalledWith('linear', { autoAuthorize: true });
  });

  it('rejects missing targets and incomplete browser aliases', async () => {
    const definition: ServerDefinition = {
      name: 'linear',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
    };
    const runtime = runtimeFor(definition);

    await expect(handleAuth(runtime, [])).rejects.toThrow('Usage: mcporter auth <server | url>');
    await expect(handleAuth(runtime, ['linear', '--browser'])).rejects.toThrow("Flag '--browser' requires a value");
  });

  it.each(['0', 'false', 'no', '', 'unexpected'])('keeps browser launch enabled for env value %j', async (value) => {
    process.env.MCPORTER_OAUTH_NO_BROWSER = value;
    const definition: ServerDefinition = {
      name: 'linear',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
    };
    const listTools = vi.fn().mockResolvedValue([]);

    await handleAuth(runtimeFor(definition, listTools), ['linear']);

    expect(listTools).toHaveBeenCalledWith('linear', { autoAuthorize: true });
  });
});
