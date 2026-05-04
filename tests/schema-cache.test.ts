import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { resolveSchemaCacheDir } from '../src/schema-cache.js';

const mkDef = (name: string, tokenCacheDir?: string): ServerDefinition => ({
  name,
  command: { kind: 'http', url: new URL('https://example.com/mcp') },
  tokenCacheDir,
});

describe('schema cache paths', () => {
  const originalEnv = { ...process.env };
  let homedirSpy: { mockRestore(): void } | undefined;

  afterEach(() => {
    process.env = { ...originalEnv };
    homedirSpy?.mockRestore();
    homedirSpy = undefined;
  });

  it('uses XDG_CACHE_HOME by default', () => {
    process.env.XDG_CACHE_HOME = '/tmp/xdg-cache';

    expect(resolveSchemaCacheDir(mkDef('server'))).toBe('/tmp/xdg-cache/mcporter/server');
  });

  it('keeps tokenCacheDir as the explicit override', () => {
    process.env.XDG_CACHE_HOME = '/tmp/xdg-cache';

    expect(resolveSchemaCacheDir(mkDef('server', '/explicit/cache'))).toBe('/explicit/cache');
  });

  it('falls back to the legacy mcporter directory without XDG_CACHE_HOME', () => {
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue('/home/tester');
    delete process.env.XDG_CACHE_HOME;

    expect(resolveSchemaCacheDir(mkDef('server'))).toBe(path.join('/home/tester', '.mcporter', 'server'));
  });
});
