import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listConfigLayerPaths, pathExistsAsync } from '../src/config/path-discovery.js';

describe('config layer path discovery', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-layer-paths-'));
    process.env = { ...originalEnv, XDG_CONFIG_HOME: path.join(tempDir, 'xdg') };
    delete process.env.MCPORTER_CONFIG;
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns existing home and project layers in merge order', async () => {
    const homePath = path.join(tempDir, 'xdg', 'mcporter', 'mcporter.json');
    const projectPath = path.join(tempDir, 'project', 'config', 'mcporter.json');
    await fs.mkdir(path.dirname(homePath), { recursive: true });
    await fs.mkdir(path.dirname(projectPath), { recursive: true });
    await fs.writeFile(homePath, '{}');
    await fs.writeFile(projectPath, '{}');

    await expect(listConfigLayerPaths({}, path.join(tempDir, 'project'))).resolves.toEqual([homePath, projectPath]);
    await expect(pathExistsAsync(homePath)).resolves.toBe(true);
    await expect(pathExistsAsync(path.join(tempDir, 'missing.json'))).resolves.toBe(false);
  });

  it('uses a trimmed explicit environment path without merging defaults', async () => {
    const explicit = path.join(tempDir, 'explicit.json');
    process.env.MCPORTER_CONFIG = `  ${explicit}  `;
    await expect(listConfigLayerPaths({}, tempDir)).resolves.toEqual([explicit]);
  });
});
