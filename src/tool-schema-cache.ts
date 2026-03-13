import type { ServerToolInfo } from './runtime.js';

interface SchemaCacheEntry {
  tools: ServerToolInfo[];
  timestamp: number;
}

const cache = new Map<string, SchemaCacheEntry>();
const CACHE_TTL_MS = 60_000; // 1 minute

export function getCachedTools(serverName: string): ServerToolInfo[] | null {
  const entry = cache.get(serverName);
  if (!entry) {
    return null;
  }

  const now = Date.now();
  if (now - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(serverName);
    return null;
  }

  return entry.tools;
}

export function setCachedTools(serverName: string, tools: ServerToolInfo[]): void {
  cache.set(serverName, {
    tools,
    timestamp: Date.now(),
  });
}

export function clearToolCache(serverName?: string): void {
  if (serverName) {
    cache.delete(serverName);
  } else {
    cache.clear();
  }
}
