import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { legacyMcporterDir, mcporterConfigCandidates, mcporterDir } from '../src/paths.js';

describe('mcporter path helpers', () => {
  const originalEnv = { ...process.env };
  let homedirSpy: { mockRestore(): void } | undefined;

  afterEach(() => {
    process.env = { ...originalEnv };
    homedirSpy?.mockRestore();
    homedirSpy = undefined;
  });

  it('falls back to legacy ~/.mcporter when XDG env is unset', () => {
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue('/home/tester');
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_STATE_HOME;
    delete process.env.XDG_CACHE_HOME;

    const legacy = path.join('/home/tester', '.mcporter');
    expect(legacyMcporterDir()).toBe(legacy);
    expect(mcporterDir('config')).toBe(legacy);
    expect(mcporterDir('data')).toBe(legacy);
    expect(mcporterDir('state')).toBe(legacy);
    expect(mcporterDir('cache')).toBe(legacy);
  });

  it('honors absolute XDG homes by kind', () => {
    process.env.XDG_CONFIG_HOME = '/xdg/config';
    process.env.XDG_DATA_HOME = '/xdg/data';
    process.env.XDG_STATE_HOME = '/xdg/state';
    process.env.XDG_CACHE_HOME = '/xdg/cache';

    expect(mcporterDir('config')).toBe(path.join('/xdg/config', 'mcporter'));
    expect(mcporterDir('data')).toBe(path.join('/xdg/data', 'mcporter'));
    expect(mcporterDir('state')).toBe(path.join('/xdg/state', 'mcporter'));
    expect(mcporterDir('cache')).toBe(path.join('/xdg/cache', 'mcporter'));
    expect(mcporterConfigCandidates()).toEqual([
      path.join('/xdg/config', 'mcporter', 'mcporter.json'),
      path.join('/xdg/config', 'mcporter', 'mcporter.jsonc'),
    ]);
  });

  it('ignores relative XDG homes and keeps the legacy fallback', () => {
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue('/home/tester');
    process.env.XDG_CONFIG_HOME = 'relative/config';

    expect(mcporterDir('config')).toBe(path.join('/home/tester', '.mcporter'));
  });
});
