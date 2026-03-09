import fs from 'node:fs/promises';
import type { LoadConfigOptions } from '../config.js';
import { listConfigLayerPaths } from '../config.js';

export async function statConfigMtime(configPath: string): Promise<number | null> {
  try {
    const stats = await fs.stat(configPath);
    return stats.mtimeMs;
  } catch {
    return null;
  }
}

export async function collectConfigLayers(
  options: LoadConfigOptions
): Promise<Array<{ path: string; mtimeMs: number | null }>> {
  const layerPaths = await listConfigLayerPaths(options, options.rootDir ?? process.cwd());
  const entries: Array<{ path: string; mtimeMs: number | null }> = [];
  for (const layerPath of layerPaths) {
    entries.push({ path: layerPath, mtimeMs: await statConfigMtime(layerPath) });
  }
  return entries;
}
