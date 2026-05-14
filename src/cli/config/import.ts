import path from 'node:path';
import { resolveConfigPath, writeRawConfig, type RawEntry } from '../../config.js';
import { pathsForImport, readExternalEntries } from '../../config-imports.js';
import { expandHome } from '../../env.js';
import { withFileLock } from '../../fs-json.js';
import { CliUsageError } from '../errors.js';
import { cloneConfig, loadOrCreateConfig } from './shared.js';
import type { ConfigCliOptions } from './types.js';

export interface ImportFlags {
  path?: string;
  filter?: string;
  copy?: boolean;
  format: 'text' | 'json';
}

export async function handleImportCommand(options: ConfigCliOptions, args: string[]): Promise<void> {
  const kind = args.shift();
  if (!kind) {
    throw new CliUsageError('Usage: mcporter config import <kind>');
  }
  const flags = extractImportFlags(args);
  const rootDir = options.loadOptions.rootDir ?? process.cwd();
  const paths = flags.path ? [path.resolve(expandHome(flags.path))] : pathsForImport(kind as never, rootDir);
  const entries: Array<{ name: string; entry: RawEntry; source: string }> = [];
  const seenNames = new Set<string>();
  for (const candidate of paths) {
    const resolved = expandHome(candidate);
    const map = await readExternalEntries(resolved, { projectRoot: rootDir, importKind: kind as never });
    if (!map) {
      continue;
    }
    for (const [name, entry] of map) {
      if (flags.filter && !name.includes(flags.filter)) {
        continue;
      }
      if (seenNames.has(name)) {
        continue;
      }
      seenNames.add(name);
      entries.push({ name, entry, source: resolved });
    }
  }
  if (entries.length === 0) {
    console.log('No entries found.');
    return;
  }
  if (flags.format === 'json') {
    console.log(JSON.stringify({ entries }, null, 2));
  } else {
    for (const item of entries) {
      console.log(`${item.name} (${item.source})`);
    }
  }
  if (flags.copy) {
    const lockPath = resolveConfigPath(options.loadOptions.configPath, rootDir).path;
    let configPath = lockPath;
    await withFileLock(lockPath, async () => {
      const loaded = await loadOrCreateConfig({ ...options.loadOptions, configPath: lockPath });
      configPath = loaded.path;
      const nextConfig = cloneConfig(loaded.config);
      if (!nextConfig.mcpServers) {
        nextConfig.mcpServers = {};
      }
      for (const item of entries) {
        nextConfig.mcpServers[item.name] = structuredClone(item.entry);
      }
      await writeRawConfig(configPath, nextConfig);
    });
    console.log(`Copied ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} to ${configPath}`);
  }
}

function extractImportFlags(args: string[]): ImportFlags {
  const flags: ImportFlags = { format: 'text' };
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    switch (token) {
      case '--path':
        flags.path = args[index + 1];
        args.splice(index, 2);
        continue;
      case '--filter':
        flags.filter = args[index + 1];
        args.splice(index, 2);
        continue;
      case '--copy':
        flags.copy = true;
        args.splice(index, 1);
        continue;
      case '--json':
        flags.format = 'json';
        args.splice(index, 1);
        continue;
      default:
        index += 1;
        break;
    }
  }
  return flags;
}
