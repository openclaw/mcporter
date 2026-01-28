import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathsForImport, readExternalEntries } from './config-imports.js';
import { normalizeServerEntry } from './config-normalize.js';
import { parseJsonBuffer } from './config/imports/shared.js';
import {
  DEFAULT_IMPORTS,
  type LoadConfigOptions,
  type RawConfig,
  RawConfigSchema,
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
  const explicitPath = options.configPath ?? process.env.MCPORTER_CONFIG;
  if (explicitPath) {
    return [path.resolve(expandHome(explicitPath.trim()))];
  }

  const paths: string[] = [];
  const homeCandidates = homeConfigCandidates();
  const existingHome = homeCandidates.find((candidate) => pathExists(candidate));
  if (existingHome) {
    paths.push(existingHome);
  }

  const projectPath = path.resolve(rootDir, 'config', 'mcporter.json');
  if (pathExists(projectPath)) {
    paths.push(projectPath);
  }

  return paths;
}

type ConfigLayer = {
  config: RawConfig;
  path: string;
  explicit: boolean;
};

async function loadConfigLayers(options: LoadConfigOptions, rootDir: string): Promise<ConfigLayer[]> {
  const explicitPath = options.configPath ?? process.env.MCPORTER_CONFIG;
  if (explicitPath) {
    const resolvedPath = path.resolve(expandHome(explicitPath.trim()));
    const config = await readConfigFile(resolvedPath, true);
    return [{ config, path: resolvedPath, explicit: true }];
  }

  const layers: ConfigLayer[] = [];

  const homeCandidates = homeConfigCandidates();
  const existingHome = homeCandidates.find((candidate) => pathExists(candidate));
  if (existingHome) {
    layers.push({ config: await readConfigFile(existingHome, false), path: existingHome, explicit: false });
  }

  const projectPath = path.resolve(rootDir, 'config', 'mcporter.json');
  if (pathExists(projectPath)) {
    layers.push({ config: await readConfigFile(projectPath, false), path: projectPath, explicit: false });
  }

  if (layers.length === 0) {
    // Preserve prior behavior: a missing default config returns an empty list and assumes the project path.
    layers.push({ config: { mcpServers: {} }, path: projectPath, explicit: false });
  }

  return layers;
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
  if (configPath) {
    return { path: path.resolve(configPath), explicit: true };
  }
  const envConfig = process.env.MCPORTER_CONFIG;
  if (envConfig && envConfig.trim().length > 0) {
    return { path: path.resolve(expandHome(envConfig.trim())), explicit: true };
  }
  const projectPath = path.resolve(rootDir, 'config', 'mcporter.json');
  if (pathExists(projectPath)) {
    return { path: projectPath, explicit: false };
  }
  const homeCandidates = homeConfigCandidates();
  const existingHome = homeCandidates.find((candidate) => pathExists(candidate));
  if (existingHome) {
    return { path: existingHome, explicit: false };
  }
  return { path: projectPath, explicit: false };
}

const warnedConfigPaths = new Set<string>();

async function readConfigFile(configPath: string, explicit: boolean): Promise<RawConfig> {
  if (!explicit && !(await pathExistsAsync(configPath))) {
    return { mcpServers: {} };
  }
  try {
    const buffer = await fs.readFile(configPath, 'utf8');
    return RawConfigSchema.parse(parseJsonBuffer(buffer));
  } catch (error) {
    if (!explicit && isMissingConfigError(error)) {
      return { mcpServers: {} };
    }
    if (!explicit && isSyntaxError(error)) {
      warnConfigFallback(configPath, error);
      return { mcpServers: {} };
    }
    throw error;
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code);
}

function isMissingConfigError(error: unknown): boolean {
  return isErrno(error, 'ENOENT') || includesErrnoMessage(error, 'ENOENT');
}

function isSyntaxError(error: unknown): error is SyntaxError {
  return error instanceof SyntaxError;
}

function pathExists(filePath: string): boolean {
  try {
    fsSync.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

async function pathExistsAsync(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function warnConfigFallback(configPath: string, error: unknown): void {
  if (warnedConfigPaths.has(configPath)) {
    return;
  }
  warnedConfigPaths.add(configPath);
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(`[mcporter] Ignoring config at ${configPath}: ${reason}`);
}

function includesErrnoMessage(error: unknown, code: string): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.includes(code);
}

function homeConfigCandidates(): string[] {
  const homeDir = os.homedir();
  const base = path.join(homeDir, '.mcporter');
  return [path.join(base, 'mcporter.json'), path.join(base, 'mcporter.jsonc')];
}
