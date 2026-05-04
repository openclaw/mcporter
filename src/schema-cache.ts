import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerDefinition } from './config.js';
import { mcporterDir } from './paths.js';

const SCHEMA_FILENAME = 'schema.json';

export interface SchemaCacheSnapshot {
  readonly updatedAt: string;
  readonly tools: Record<string, unknown>;
}

// resolveSchemaCacheDir determines where schemas should be cached for a server.
export function resolveSchemaCacheDir(definition: ServerDefinition): string {
  return definition.tokenCacheDir ?? path.join(mcporterDir('cache'), definition.name);
}

// resolveSchemaCachePath builds the schema cache file path for a server definition.
export function resolveSchemaCachePath(definition: ServerDefinition): string {
  return path.join(resolveSchemaCacheDir(definition), SCHEMA_FILENAME);
}

// readSchemaCache reads a cached tool schema snapshot from disk when present.
export async function readSchemaCache(definition: ServerDefinition): Promise<SchemaCacheSnapshot | undefined> {
  const filePath = resolveSchemaCachePath(definition);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as SchemaCacheSnapshot;
    if (!parsed || typeof parsed !== 'object') {
      return undefined;
    }
    if (!parsed.tools || typeof parsed.tools !== 'object') {
      return undefined;
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

// writeSchemaCache persists the latest tool schema snapshot for a server.
export async function writeSchemaCache(definition: ServerDefinition, snapshot: SchemaCacheSnapshot): Promise<void> {
  const filePath = resolveSchemaCachePath(definition);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
}
