import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfigPath } from '../src/config.js';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('resolveConfigPath', () => {
  const originalEnvValue = process.env.MCPORTER_CONFIG;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  let tempDirs: string[] = [];
  let homedirSpy: { mockRestore(): void } | undefined;

  afterEach(() => {
    if (originalEnvValue === undefined) {
      delete process.env.MCPORTER_CONFIG;
    } else {
      process.env.MCPORTER_CONFIG = originalEnvValue;
    }
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    homedirSpy?.mockRestore();
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it('prefers an explicit config path argument', () => {
    const tempRoot = makeTempDir('mcporter-config-');
    tempDirs.push(tempRoot);
    const explicitPath = path.join(tempRoot, 'custom.json');
    fs.writeFileSync(explicitPath, '{"mcpServers":{}}');

    const resolved = resolveConfigPath(explicitPath, tempRoot);
    expect(resolved.path).toBe(explicitPath);
    expect(resolved.explicit).toBe(true);
  });

  it('uses MCPORTER_CONFIG when set', () => {
    const tempRoot = makeTempDir('mcporter-config-env-');
    tempDirs.push(tempRoot);
    const envPath = path.join(tempRoot, 'env-config.json');
    fs.writeFileSync(envPath, '{"mcpServers":{}}');
    process.env.MCPORTER_CONFIG = envPath;

    const resolved = resolveConfigPath(undefined, tempRoot);
    expect(resolved.path).toBe(envPath);
    expect(resolved.explicit).toBe(true);
  });

  it('falls back to the project config when it exists', () => {
    const tempRoot = makeTempDir('mcporter-project-');
    tempDirs.push(tempRoot);
    const projectConfig = path.join(tempRoot, 'config', 'mcporter.json');
    fs.mkdirSync(path.dirname(projectConfig), { recursive: true });
    fs.writeFileSync(projectConfig, '{"mcpServers":{}}');

    const resolved = resolveConfigPath(undefined, tempRoot);
    expect(resolved.path).toBe(projectConfig);
    expect(resolved.explicit).toBe(false);
  });

  it('falls back to the home config when project config is missing', () => {
    const tempRoot = makeTempDir('mcporter-project-missing-');
    const fakeHome = makeTempDir('mcporter-home-');
    tempDirs.push(tempRoot, fakeHome);
    const homeConfigDir = path.join(fakeHome, '.mcporter');
    const homeConfigPath = path.join(homeConfigDir, 'mcporter.json');
    fs.mkdirSync(homeConfigDir, { recursive: true });
    fs.writeFileSync(homeConfigPath, '{"mcpServers":{}}');
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    delete process.env.XDG_CONFIG_HOME;

    const resolved = resolveConfigPath(undefined, tempRoot);
    expect(resolved.path).toBe(homeConfigPath);
    expect(resolved.explicit).toBe(false);
  });

  it('returns explicit=false when no config exists anywhere (regression for ENOENT bug)', () => {
    // This test verifies the fix for the bug where mcporter crashed with ENOENT
    // when run in an environment with no config file at all. The CLI was passing
    // the resolved (but non-existent) path as if it were explicit.
    const tempRoot = makeTempDir('mcporter-no-config-anywhere-');
    const fakeHome = makeTempDir('mcporter-empty-home-');
    tempDirs.push(tempRoot, fakeHome);
    // No config files created - completely empty environment
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    delete process.env.XDG_CONFIG_HOME;

    const resolved = resolveConfigPath(undefined, tempRoot);
    // Should return the default project path but marked as NOT explicit
    expect(resolved.path).toBe(path.join(tempRoot, 'config', 'mcporter.json'));
    expect(resolved.explicit).toBe(false);
  });

  it('discovers XDG config home before the legacy home config', () => {
    const tempRoot = makeTempDir('mcporter-project-xdg-');
    const fakeHome = makeTempDir('mcporter-xdg-home-');
    tempDirs.push(tempRoot, fakeHome);
    const xdgConfigHome = path.join(fakeHome, '.config');
    const xdgConfigPath = path.join(xdgConfigHome, 'mcporter', 'mcporter.json');
    fs.mkdirSync(path.dirname(xdgConfigPath), { recursive: true });
    fs.writeFileSync(xdgConfigPath, '{"mcpServers":{}}');
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    process.env.XDG_CONFIG_HOME = xdgConfigHome;

    const resolved = resolveConfigPath(undefined, tempRoot);
    expect(resolved.path).toBe(xdgConfigPath);
    expect(resolved.explicit).toBe(false);
  });
});
