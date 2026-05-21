import os from 'node:os';
import path from 'node:path';
import { expandHome } from './env.js';

export type McporterPathKind = 'config' | 'data' | 'state' | 'cache';

const XDG_HOME_ENV: Record<McporterPathKind, string> = {
  config: 'XDG_CONFIG_HOME',
  data: 'XDG_DATA_HOME',
  state: 'XDG_STATE_HOME',
  cache: 'XDG_CACHE_HOME',
};

export function legacyMcporterDir(): string {
  return path.join(os.homedir(), '.mcporter');
}

export function mcporterDir(kind: McporterPathKind): string {
  const raw = process.env[XDG_HOME_ENV[kind]];
  if (raw && raw.trim().length > 0) {
    const resolved = expandHome(raw.trim());
    if (path.isAbsolute(resolved)) {
      return path.join(resolved, 'mcporter');
    }
  }
  return legacyMcporterDir();
}

export function mcporterConfigCandidates(): string[] {
  const base = mcporterDir('config');
  const candidates = [path.join(base, 'mcporter.json'), path.join(base, 'mcporter.jsonc')];
  if (base !== legacyMcporterDir()) {
    const legacy = legacyMcporterDir();
    candidates.push(path.join(legacy, 'mcporter.json'), path.join(legacy, 'mcporter.jsonc'));
  }
  return candidates;
}
