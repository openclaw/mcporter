import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectConfigLayers, normalizeConfigLayers } from '../src/daemon/config-layers.js';
import { makeShortTempDir } from './fixtures/test-helpers.js';

describe('daemon config layers', () => {
  it('normalizes paths, missing mtimes, and ordering', () => {
    expect(
      normalizeConfigLayers([
        { path: 'z/config.json', mtimeMs: null },
        { path: 'a/config.json', mtimeMs: 42 },
      ])
    ).toEqual([
      { path: path.resolve('a/config.json'), mtimeMs: 42 },
      { path: path.resolve('z/config.json'), mtimeMs: null },
    ]);
  });

  it('retains a missing explicit config layer with a null mtime', async () => {
    const rootDir = await makeShortTempDir('daemon-config-layers');
    const configPath = path.join(rootDir, 'missing.json');

    await expect(collectConfigLayers({ configPath, rootDir })).resolves.toEqual([{ path: configPath, mtimeMs: null }]);
  });
});
