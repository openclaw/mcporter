import fs from 'node:fs/promises';
import path from 'node:path';
import { type LoadConfigOptions, type RawConfig, RawConfigSchema } from '../config-schema.js';
import { expandHome } from '../env.js';
import { parseJsonBuffer } from './imports/shared.js';
import { homeConfigCandidates, pathExists, pathExistsAsync } from './path-discovery.js';

export type ConfigLayer = {
  config: RawConfig;
  path: string;
  explicit: boolean;
};

export async function loadConfigLayers(options: LoadConfigOptions, rootDir: string): Promise<ConfigLayer[]> {
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

export async function readConfigFile(configPath: string, explicit: boolean): Promise<RawConfig> {
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

const warnedConfigPaths = new Set<string>();

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
