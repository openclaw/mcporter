import fs from 'node:fs/promises';
import type { ServerDefinition } from './config-schema.js';

interface CacheEntry {
  definitions: ServerDefinition[];
  mtimes: Map<string, number>;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5000; // 5 seconds

export async function loadServerDefinitionsWithCache(
  loader: () => Promise<ServerDefinition[]>,
  configPaths: string[]
): Promise<ServerDefinition[]> {
  const cacheKey = configPaths.sort().join('|');
  const now = Date.now();

  const cached = cache.get(cacheKey);
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    // Validate mtimes haven't changed
    let valid = true;
    for (const [path, cachedMtime] of cached.mtimes) {
      try {
        const stat = await fs.stat(path);
        if (stat.mtimeMs !== cachedMtime) {
          valid = false;
          break;
        }
      } catch {
        valid = false;
        break;
      }
    }

    if (valid) {
      return cached.definitions;
    }
  }

  // Load fresh
  const definitions = await loader();

  // Capture mtimes
  const mtimes = new Map<string, number>();
  for (const path of configPaths) {
    try {
      const stat = await fs.stat(path);
      mtimes.set(path, stat.mtimeMs);
    } catch {
      // Ignore missing files
    }
  }

  cache.set(cacheKey, { definitions, mtimes, timestamp: now });
  return definitions;
}

export function clearConfigCache(): void {
  cache.clear();
}
