import fs from 'node:fs/promises';
import path from 'node:path';
import type { LoadConfigOptions, RawConfig } from '../../config.js';
import { loadRawConfig, resolveConfigPath } from '../../config.js';
import type { ServerDefinition } from '../../config-schema.js';
import { mcporterConfigCandidates } from '../../paths.js';
import { CliUsageError } from '../errors.js';
import { chooseClosestIdentifier, renderIdentifierResolutionMessages } from '../identifier-helpers.js';
import { dimText, supportsAnsiColor } from '../terminal.js';

export const COLOR_ENABLED = (): boolean => Boolean(supportsAnsiColor && process.stdout.isTTY);

export type ConfigLocationSummary = {
  projectPath: string;
  projectExists: boolean;
  systemPath: string;
  systemExists: boolean;
};

export function cloneConfig(config: RawConfig): RawConfig {
  return {
    mcpServers: config.mcpServers ? { ...config.mcpServers } : {},
    imports: config.imports ? [...config.imports] : undefined,
  };
}

export async function loadOrCreateConfig(loadOptions: LoadConfigOptions): Promise<{ config: RawConfig; path: string }> {
  try {
    const { config, path: configPath } = await loadRawConfig(loadOptions);
    return { config, path: configPath };
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      const rootDir = loadOptions.rootDir ?? process.cwd();
      const resolved = resolveConfigPath(loadOptions.configPath, rootDir);
      return { config: { mcpServers: {} }, path: resolved.path };
    }
    throw error;
  }
}

export async function resolveConfigLocations(loadOptions: LoadConfigOptions): Promise<ConfigLocationSummary> {
  const rootDir = loadOptions.rootDir ?? process.cwd();
  const projectPath = path.resolve(rootDir, 'config', 'mcporter.json');
  const projectExists = await pathExists(projectPath);
  const systemCandidates = buildSystemConfigCandidates();
  const systemResolved = await resolveFirstExisting(systemCandidates);
  return {
    projectPath,
    projectExists,
    systemPath: systemResolved.path,
    systemExists: systemResolved.exists,
  };
}

export function logConfigLocations(summary: ConfigLocationSummary, options?: { leadingNewline?: boolean }): void {
  const shouldAddNewline = options?.leadingNewline ?? true;
  if (shouldAddNewline) {
    console.log('');
  }
  console.log(`Project config: ${formatPath(summary.projectPath, summary.projectExists)}`);
  console.log(`System config: ${formatPath(summary.systemPath, summary.systemExists)}`);
}

export function findServerNameWithFuzzyMatch(
  name: string,
  candidates: string[],
  logger: ((message: string) => void) | null = console.log
): string | null {
  if (candidates.includes(name)) {
    return name;
  }
  const resolution = chooseClosestIdentifier(name, candidates);
  if (!resolution) {
    return null;
  }
  const messages = renderIdentifierResolutionMessages({
    entity: 'server',
    attempted: name,
    resolution,
  });
  if (messages.auto && logger) {
    logger(dimText(messages.auto));
  }
  if (resolution.kind === 'auto') {
    return resolution.value;
  }
  if (messages.suggest && logger) {
    logger(dimText(messages.suggest));
  }
  return null;
}

export function resolveServerDefinition(
  name: string,
  servers: ServerDefinition[],
  logger: ((message: string) => void) | null = console.log
): ServerDefinition {
  const direct = servers.find((server) => server.name === name);
  if (direct) {
    return direct;
  }
  const resolution = chooseClosestIdentifier(
    name,
    servers.map((server) => server.name)
  );
  if (!resolution) {
    throw new CliUsageError(`[mcporter] Unknown server '${name}'.`);
  }
  const messages = renderIdentifierResolutionMessages({
    entity: 'server',
    attempted: name,
    resolution,
  });
  if (messages.auto && logger) {
    logger(dimText(messages.auto));
  }
  if (resolution.kind === 'auto') {
    const match = servers.find((server) => server.name === resolution.value);
    if (match) {
      return match;
    }
  }
  if (messages.suggest && logger) {
    logger(dimText(messages.suggest));
  }
  throw new CliUsageError(`[mcporter] Unknown server '${name}'.`);
}

function buildSystemConfigCandidates(): string[] {
  return mcporterConfigCandidates();
}

async function resolveFirstExisting(pathsToCheck: string[]): Promise<{ path: string; exists: boolean }> {
  for (const candidate of pathsToCheck) {
    if (await pathExists(candidate)) {
      return { path: candidate, exists: true };
    }
  }
  return { path: pathsToCheck[0] ?? '', exists: false };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function formatPath(targetPath: string, exists: boolean): string {
  return exists ? targetPath : `${targetPath} (missing)`;
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code);
}
