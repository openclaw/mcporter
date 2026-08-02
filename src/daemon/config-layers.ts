import fs from 'node:fs/promises';
import path from 'node:path';
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
  options: LoadConfigOptions,
  fallbackConfigPath?: string
): Promise<Array<{ path: string; mtimeMs: number | null }>> {
  const layerPaths = await listConfigLayerPaths(options, options.rootDir ?? process.cwd());
  const entries = await Promise.all(
    layerPaths.map(async (layerPath) => ({ path: layerPath, mtimeMs: await statConfigMtime(layerPath) }))
  );
  const fallback = fallbackConfigPath ?? options.configPath;
  if (entries.length === 0 && fallback) {
    entries.push({ path: path.resolve(fallback), mtimeMs: await statConfigMtime(fallback) });
  }
  return entries;
}

export function normalizeConfigLayers(
  layers: Array<{ path: string; mtimeMs: number | null }>
): Array<{ path: string; mtimeMs: number | null }> {
  const normalized = layers.map((entry) => ({
    path: path.isAbsolute(entry.path) ? entry.path : path.resolve(entry.path),
    mtimeMs: entry.mtimeMs ?? null,
  }));
  if (normalized.length < 2) {
    return normalized;
  }
  return normalized.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
