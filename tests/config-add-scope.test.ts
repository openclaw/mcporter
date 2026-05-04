import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __configCommandInternals } from '../src/cli/config-command.js';
import type { LoadConfigOptions } from '../src/config.js';

describe('config add --scope targeting', () => {
  let tempHomeDir: string | undefined;
  let tempProjectDir: string | undefined;
  let homedirSpy: { mockRestore(): void } | undefined;
  let previousEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-scope-home-'));
    tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-scope-project-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tempHomeDir);
    previousEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      APPDATA: process.env.APPDATA,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      MCPORTER_CONFIG: process.env.MCPORTER_CONFIG,
    };
    process.env.HOME = tempHomeDir;
    process.env.USERPROFILE = tempHomeDir;
    process.env.APPDATA = path.join(tempHomeDir, 'AppData', 'Roaming');
    process.env.XDG_CONFIG_HOME = path.join(tempHomeDir, '.config');
    delete process.env.MCPORTER_CONFIG;
  });

  afterEach(async () => {
    homedirSpy?.mockRestore();
    homedirSpy = undefined;
    for (const key of Object.keys(previousEnv)) {
      const typedKey = key as keyof typeof previousEnv;
      const value = previousEnv[typedKey];
      if (value === undefined) {
        delete process.env[typedKey];
      } else {
        process.env[typedKey] = value;
      }
    }
    if (tempHomeDir) {
      await fs.rm(tempHomeDir, { recursive: true, force: true }).catch(() => {});
      tempHomeDir = undefined;
    }
    if (tempProjectDir) {
      await fs.rm(tempProjectDir, { recursive: true, force: true }).catch(() => {});
      tempProjectDir = undefined;
    }
  });

  it('writes to home when scope=home', () => {
    const projectDir =
      tempProjectDir ??
      (() => {
        throw new Error('tempProjectDir missing');
      })();
    const homeDir =
      tempHomeDir ??
      (() => {
        throw new Error('tempHomeDir missing');
      })();
    const target = __configCommandInternals.resolveWriteTarget(
      { args: [], env: {}, headers: {}, scope: 'home' },
      {},
      projectDir
    );
    expect(target).toBe(path.join(homeDir, '.config', 'mcporter', 'mcporter.json'));
  });

  it('writes to project when scope=project', () => {
    const projectDir =
      tempProjectDir ??
      (() => {
        throw new Error('tempProjectDir missing');
      })();
    const target = __configCommandInternals.resolveWriteTarget(
      { args: [], env: {}, headers: {}, scope: 'project' },
      {},
      projectDir
    );
    expect(target).toBe(path.join(projectDir, 'config', 'mcporter.json'));
  });

  it('defaults to resolved path when no scope provided', () => {
    const projectDir =
      tempProjectDir ??
      (() => {
        throw new Error('tempProjectDir missing');
      })();
    const loadOptions: LoadConfigOptions = { rootDir: projectDir }; // no config yet
    const target = __configCommandInternals.resolveWriteTarget(
      { args: [], env: {}, headers: {} },
      loadOptions,
      projectDir
    );
    expect(target).toBe(path.join(projectDir, 'config', 'mcporter.json'));
  });
});
