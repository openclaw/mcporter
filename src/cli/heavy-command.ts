/**
 * Heavy MCP management commands.
 *
 * Some MCP servers (like chrome-devtools) have large tool schemas that consume
 * significant context tokens. The "heavy" system allows on-demand loading of
 * these servers to save context when they're not needed.
 *
 * Usage:
 *   mcporter heavy list              - List available and active heavy MCPs
 *   mcporter heavy activate <name>   - Activate a heavy MCP
 *   mcporter heavy deactivate <name> - Deactivate a heavy MCP
 */

import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadRawConfig, writeRawConfig } from '../config.js';
import { assertValidHeavyMcpName, listHeavyMcpDefinitions, readHeavyMcpDefinition } from '../heavy/definition.js';
import { type HeavyPaths, resolveHeavyPaths } from '../heavy/paths.js';

interface HeavyCliOptions {
  configPath?: string;
  rootDir?: string;
}

export async function handleHeavyCli(args: string[], options: HeavyCliOptions): Promise<void> {
  const subcommand = args.shift();
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    process.exitCode = 0;
    printHeavyHelp();
    return;
  }

  const { path: configPath } = await loadRawConfig(options);
  const paths = resolveHeavyPaths(configPath);

  if (subcommand === 'list') {
    await handleHeavyList(paths, options);
    return;
  }
  if (subcommand === 'activate') {
    await handleHeavyActivate(args, paths, options);
    return;
  }
  if (subcommand === 'deactivate') {
    await handleHeavyDeactivate(args, paths, options);
    return;
  }

  throw new Error(`Unknown heavy subcommand '${subcommand}'. Run 'mcporter heavy --help'.`);
}

function printHeavyHelp(): void {
  console.error(`Usage: mcporter heavy <list|activate|deactivate>

Manage "heavy" MCP servers that are loaded on-demand to save context.

Heavy MCPs are servers with large tool schemas (e.g., chrome-devtools) that
consume significant context tokens. By default, they are not loaded. Use this
command to activate them when needed and deactivate when done.

Commands:
  list              List available and currently active heavy MCPs.
  activate <name>   Activate a heavy MCP (adds to main config).
  deactivate <name> Deactivate a heavy MCP (removes from main config).

Directory structure:
  ~/.mcporter/
  ├── mcporter.json              # Main config (without heavy MCPs by default)
  └── heavy/
      ├── available/             # Heavy MCP definitions
      │   └── chrome-devtools.json
      └── active/                # Tracks active heavy MCPs (symlinks)
          └── chrome-devtools.json -> ../available/chrome-devtools.json

Examples:
  mcporter heavy list
  mcporter heavy activate chrome-devtools
  mcporter heavy deactivate chrome-devtools`);
}

async function handleHeavyList(paths: HeavyPaths, options: HeavyCliOptions): Promise<void> {
  const available = await listHeavyMcpDefinitions(paths.availableDir);
  const active = await listActiveHeavyMcps(paths, options);

  console.log('=== Available Heavy MCPs ===');
  if (available.length === 0) {
    console.log('(none)');
    console.log('');
    console.log(`Place JSON files in ${paths.availableDir}/ to add heavy MCPs.`);
  } else {
    for (const name of available) {
      const isActive = active.includes(name);
      const status = isActive ? ' [active]' : '';
      console.log(`  ${name}${status}`);
    }
  }

  console.log('');
  console.log('=== Active Heavy MCPs ===');
  if (active.length === 0) {
    console.log('(none)');
  } else {
    for (const name of active) {
      console.log(`  ${name}`);
    }
  }
}

async function handleHeavyActivate(args: string[], paths: HeavyPaths, options: HeavyCliOptions): Promise<void> {
  const name = args.shift();
  if (!name) {
    throw new Error('Usage: mcporter heavy activate <name>');
  }
  assertValidHeavyMcpName(name);

  // Check if the heavy MCP definition exists
  const definition = await readHeavyMcpDefinition(paths.availableDir, name);
  if (!definition) {
    throw new Error(`Heavy MCP '${name}' not found in ${paths.availableDir}`);
  }

  // Check if already active
  const active = await listActiveHeavyMcps(paths, options);
  if (active.includes(name)) {
    console.log(`Heavy MCP '${name}' is already active.`);
    return;
  }

  // Load current config
  const { config, path: configPath } = await loadRawConfig(options);

  // Merge the heavy MCP servers into main config
  if (!config.mcpServers) {
    config.mcpServers = {};
  }
  for (const [serverName, serverDef] of Object.entries(definition.mcpServers)) {
    config.mcpServers[serverName] = serverDef;
  }

  // Write back config
  await writeRawConfig(configPath, config);

  // Create active marker (symlink)
  await fsPromises.mkdir(paths.activeDir, { recursive: true });
  const activePath = path.join(paths.activeDir, `${name}.json`);
  const availablePath = path.join(paths.availableDir, `${name}.json`);
  try {
    await fsPromises.symlink(availablePath, activePath);
  } catch {
    // Fallback to creating a marker file if symlink fails (e.g., on Windows)
    await fsPromises.writeFile(activePath, JSON.stringify({ activated: new Date().toISOString() }, null, 2));
  }

  console.log(`Activated: ${name}`);
}

async function handleHeavyDeactivate(args: string[], paths: HeavyPaths, options: HeavyCliOptions): Promise<void> {
  const name = args.shift();
  if (!name) {
    throw new Error('Usage: mcporter heavy deactivate <name>');
  }
  assertValidHeavyMcpName(name);

  // Check if active
  const active = await listActiveHeavyMcps(paths, options);
  if (!active.includes(name)) {
    console.log(`Heavy MCP '${name}' is not active.`);
    return;
  }

  // Load current config
  const { config, path: configPath } = await loadRawConfig(options);

  // Remove the server(s) from config
  const definition = await readHeavyMcpDefinition(paths.availableDir, name);
  if (definition) {
    for (const serverName of Object.keys(definition.mcpServers)) {
      delete config.mcpServers?.[serverName];
    }
  } else {
    // Definition file was removed, try to remove by name
    delete config.mcpServers?.[name];
  }

  // Write back config
  await writeRawConfig(configPath, config);

  // Remove active marker
  const activePath = path.join(paths.activeDir, `${name}.json`);
  await fsPromises.unlink(activePath).catch(() => {});

  console.log(`Deactivated: ${name}`);
}

async function listActiveHeavyMcps(paths: HeavyPaths, options: HeavyCliOptions): Promise<string[]> {
  const active = new Set(await listHeavyMcpDefinitions(paths.activeDir));
  const { config } = await loadRawConfig(options);
  const available = await listHeavyMcpDefinitions(paths.availableDir);
  if (available.length === 0) {
    return [...active];
  }

  const configuredServers = new Set(Object.keys(config.mcpServers ?? {}));
  const configuredHeavyMcps = await Promise.all(
    available.map(async (name) => {
      const definition = await readHeavyMcpDefinition(paths.availableDir, name);
      if (!definition) {
        return null;
      }
      const serverEntries = Object.entries(definition.mcpServers);
      return serverEntries.every(([serverName, definitionEntry]) => {
        if (!configuredServers.has(serverName)) {
          return false;
        }
        return isDeepStrictEqual(config.mcpServers?.[serverName], definitionEntry);
      })
        ? name
        : null;
    })
  );

  for (const name of configuredHeavyMcps) {
    if (name) {
      active.add(name);
    }
  }

  return [...active];
}
