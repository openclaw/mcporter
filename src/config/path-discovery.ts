import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { LoadConfigOptions } from '../config-schema.js';
import { expandHome } from '../env.js';
import { mcporterConfigCandidates } from '../paths.js';

export interface ResolvedConfigPath {
  path: string;
  explicit: boolean;
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

export function resolveConfigPath(configPath: string | undefined, rootDir: string): ResolvedConfigPath {
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

export function homeConfigCandidates(): string[] {
  return mcporterConfigCandidates();
}

export function pathExists(filePath: string): boolean {
  try {
    fsSync.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function pathExistsAsync(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
