import fs from 'node:fs/promises';
import path from 'node:path';
import {
  listConfigLayerPaths as discoverConfigLayerPaths,
  resolveConfigPath as discoverConfigPath,
} from './config/path-discovery.js';
import { loadConfigLayers, readConfigFile } from './config/read-config.js';
import { pathsForImport, readExternalEntries } from './config-imports.js';
import { normalizeServerEntry } from './config-normalize.js';
import {
  DEFAULT_IMPORTS,
  type LoadConfigOptions,
  type RawConfig,
  type RawEntry,
  RawEntrySchema,
  type ServerDefinition,
  type ServerSource,
} from './config-schema.js';
import { expandHome } from './env.js';

export { toFileUrl } from './config-imports.js';
export { __configInternals } from './config-normalize.js';
export type {
  CommandSpec,
  HttpCommand,
  LoadConfigOptions,
  RawConfig,
  RawEntry,
  ServerDefinition,
  ServerLifecycle,
  ServerLoggingOptions,
  ServerSource,
  StdioCommand,
} from './config-schema.js';

export async function loadServerDefinitions(options: LoadConfigOptions = {}): Promise<ServerDefinition[]> {
  const rootDir = options.rootDir ?? process.cwd();
  const layers = await loadConfigLayers(options, rootDir);

  const merged = new Map<string, { raw: RawEntry; baseDir: string; source: ServerSource; sources: ServerSource[] }>();

  for (const layer of layers) {
    const configuredImports = layer.config.imports;
    const imports = configuredImports
      ? configuredImports.length === 0
        ? configuredImports
        : [...configuredImports, ...DEFAULT_IMPORTS.filter((kind) => !configuredImports.includes(kind))]
      : DEFAULT_IMPORTS;

    for (const importKind of imports) {
      const candidates = pathsForImport(importKind, rootDir);
      for (const candidate of candidates) {
        const resolved = expandHome(candidate);
        const entries = await readExternalEntries(resolved, { projectRoot: rootDir, importKind: importKind });
        if (!entries) {
          continue;
        }
        for (const [name, rawEntry] of entries) {
          if (merged.has(name)) {
            continue;
          }
          const source: ServerSource = { kind: 'import', path: resolved, importKind };
          const existing = merged.get(name);
          // Keep the first-seen source as canonical while tracking all alternates
          if (existing) {
            existing.sources.push(source);
            continue;
          }
          merged.set(name, {
            raw: rawEntry,
            baseDir: path.dirname(resolved),
            source,
            sources: [source],
          });
        }
      }
    }

    for (const [name, entryRaw] of Object.entries(layer.config.mcpServers)) {
      const source: ServerSource = { kind: 'local', path: layer.path };
      const parsed = RawEntrySchema.parse(entryRaw);
      const existing = merged.get(name);
      // Local definitions win; stash any prior imports after the local path
      if (existing) {
        const sources = [source, ...existing.sources];
        merged.set(name, { raw: parsed, baseDir: path.dirname(layer.path), source, sources });
        continue;
      }
      merged.set(name, {
        raw: parsed,
        baseDir: path.dirname(layer.path),
        source,
        sources: [source],
      });
    }
  }

  const servers: ServerDefinition[] = [];
  for (const [name, { raw, baseDir: entryBaseDir, source, sources }] of merged) {
    servers.push(normalizeServerEntry(name, raw, entryBaseDir, source, sources));
  }

  return servers;
}

export async function loadRawConfig(
  options: LoadConfigOptions = {}
): Promise<{ config: RawConfig; path: string; explicit: boolean }> {
  const rootDir = options.rootDir ?? process.cwd();
  const resolved = resolveConfigPath(options.configPath, rootDir);
  const config = await readConfigFile(resolved.path, resolved.explicit);
  return { config, ...resolved };
}

export async function listConfigLayerPaths(
  options: LoadConfigOptions = {},
  rootDir: string = process.cwd()
): Promise<string[]> {
  return await discoverConfigLayerPaths(options, rootDir);
}

export async function writeRawConfig(targetPath: string, config: RawConfig): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  await fs.writeFile(targetPath, serialized, 'utf8');
}

export function resolveConfigPath(
  configPath: string | undefined,
  rootDir: string
): {
  path: string;
  explicit: boolean;
} {
  return discoverConfigPath(configPath, rootDir);
}
