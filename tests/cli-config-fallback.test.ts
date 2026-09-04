import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPORTER_VERSION } from '../src/runtime.js';

process.env.MCPORTER_DISABLE_AUTORUN = '1';
const cliModulePromise = import('../src/cli.js');

describe('mcporter CLI config fallback', () => {
  let tempDir: string;
  let originalCwd: string;
  let previousNoForceExit: string | undefined;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-cli-config-')));
    process.chdir(tempDir);
    previousNoForceExit = process.env.MCPORTER_NO_FORCE_EXIT;
    process.env.MCPORTER_NO_FORCE_EXIT = '1';
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    process.exitCode = undefined;
    if (previousNoForceExit === undefined) {
      delete process.env.MCPORTER_NO_FORCE_EXIT;
    } else {
      process.env.MCPORTER_NO_FORCE_EXIT = previousNoForceExit;
    }
  });

  it('lists servers even when the config directory is missing', async () => {
    const { runCli } = await cliModulePromise;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      if (typeof value === 'string') {
        logs.push(value);
      }
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(runCli(['config', 'list'])).resolves.not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('warns once and continues when the default config is corrupt', async () => {
    const { runCli } = await cliModulePromise;
    await fs.mkdir(path.join(tempDir, 'config'), { recursive: true });
    const configPath = path.join(tempDir, 'config', 'mcporter.json');
    await fs.writeFile(configPath, '{ invalid : json', 'utf8');
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      if (typeof value === 'string') {
        logs.push(value);
      }
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(runCli(['config', 'list'])).resolves.not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]?.[0]?.toString() ?? '';
    expect(message).toContain('Ignoring config');
    expect(message).toContain(configPath);
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('prints the doctor banner even when config is missing', async () => {
    const { runCli } = await cliModulePromise;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      if (typeof value === 'string') {
        logs.push(value);
      }
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(runCli(['config', 'doctor'])).resolves.not.toThrow();
    expect(logs[0]).toBe(`MCPorter ${MCPORTER_VERSION}`);
    expect(warnSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('doctor warns once and keeps running when the config is corrupt', async () => {
    const { runCli } = await cliModulePromise;
    await fs.mkdir(path.join(tempDir, 'config'), { recursive: true });
    const configPath = path.join(tempDir, 'config', 'mcporter.json');
    await fs.writeFile(configPath, '{ not valid }', 'utf8');
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      if (typeof value === 'string') {
        logs.push(value);
      }
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(runCli(['config', 'doctor'])).resolves.not.toThrow();
    expect(logs[0]).toBe(`MCPorter ${MCPORTER_VERSION}`);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain(configPath);
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe('mcporter CLI with completely empty environment (ENOENT regression)', () => {
  let tempDir: string;
  let originalCwd: string;
  let previousNoForceExit: string | undefined;
  let homedirSpy: { mockRestore(): void } | undefined;
  let previousEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    originalCwd = process.cwd();
    // Create a completely empty temp directory - no config files anywhere
    tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-cli-empty-env-')));
    process.chdir(tempDir);
    previousNoForceExit = process.env.MCPORTER_NO_FORCE_EXIT;
    process.env.MCPORTER_NO_FORCE_EXIT = '1';
    // Mock homedir to an empty directory to ensure no home config exists
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
    // Save and override env vars that could point to config files
    previousEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      APPDATA: process.env.APPDATA,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      MCPORTER_CONFIG: process.env.MCPORTER_CONFIG,
    };
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
    process.env.APPDATA = path.join(tempDir, 'AppData', 'Roaming');
    process.env.XDG_CONFIG_HOME = path.join(tempDir, '.config');
    delete process.env.MCPORTER_CONFIG;
  });

  afterEach(async () => {
    homedirSpy?.mockRestore();
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    process.exitCode = undefined;
    if (previousNoForceExit === undefined) {
      delete process.env.MCPORTER_NO_FORCE_EXIT;
    } else {
      process.env.MCPORTER_NO_FORCE_EXIT = previousNoForceExit;
    }
    // Restore env vars
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('list command succeeds with no config files anywhere (regression test)', async () => {
    // This is the key regression test: before the fix, this would crash with:
    // ENOENT: no such file or directory, open '.../config/mcporter.json'
    const { runCli } = await cliModulePromise;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      if (typeof value === 'string') {
        logs.push(value);
      }
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // This should NOT throw - it should gracefully handle missing config
    await expect(runCli(['list'])).resolves.not.toThrow();

    // Should not have any warnings about missing config (since it's optional)
    expect(warnSpy).not.toHaveBeenCalled();
    // Should show "No MCP servers configured" or similar empty state
    const output = logs.join('\n');
    expect(output).toContain('No MCP servers configured');

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('list --json succeeds with no config files anywhere', async () => {
    const { runCli } = await cliModulePromise;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      if (typeof value === 'string') {
        logs.push(value);
      }
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(runCli(['list', '--json'])).resolves.not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();

    // Should output valid JSON with empty servers array
    const jsonOutput = JSON.parse(logs[logs.length - 1] ?? '{}');
    expect(jsonOutput).toHaveProperty('servers');
    expect(jsonOutput.servers).toEqual([]);

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('config list succeeds with no config files anywhere', async () => {
    const { runCli } = await cliModulePromise;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      if (typeof value === 'string') {
        logs.push(value);
      }
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(runCli(['config', 'list'])).resolves.not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('config doctor succeeds with no config files anywhere', async () => {
    const { runCli } = await cliModulePromise;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      if (typeof value === 'string') {
        logs.push(value);
      }
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(runCli(['config', 'doctor'])).resolves.not.toThrow();
    expect(logs[0]).toBe(`MCPorter ${MCPORTER_VERSION}`);
    expect(warnSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('daemon starts without configuration or keep-alive definitions', async () => {
    const { runCli } = await cliModulePromise;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      if (typeof value === 'string') {
        logs.push(value);
      }
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(runCli(['daemon', 'start'])).resolves.not.toThrow();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(logs.join('\n')).toContain('Single-user daemon started.');
    } finally {
      await runCli(['daemon', 'stop']);
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
