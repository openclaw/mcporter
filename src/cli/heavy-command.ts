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
import { z } from 'zod';
import { loadRawConfig, writeRawConfig } from '../config.js';
import {
  assertValidHeavyMcpName,
  type HeavyMcpDefinition,
  HeavyMcpServersSchema,
  listHeavyMcpDefinitions,
  readHeavyMcpDefinition,
} from '../heavy/definition.js';
import { type HeavyPaths, resolveHeavyPaths } from '../heavy/paths.js';
import { logWarn } from './logger-context.js';

interface HeavyCliOptions {
  configPath?: string;
  rootDir?: string;
}

const ActiveHeavyMcpMarkerSchema = z.object({
  activated: z.string(),
  serverNames: z.array(z.string()).min(1),
  mcpServers: HeavyMcpServersSchema.optional(),
});

type ActiveHeavyMcpMarker = z.infer<typeof ActiveHeavyMcpMarkerSchema>;

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
      └── active/                # Tracks active heavy MCPs (marker files)
          └── chrome-devtools.json

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

  // Load current config
  const { config, path: configPath } = await loadRawConfig(options);
  const activePath = path.join(paths.activeDir, `${name}.json`);

  if (isHeavyMcpDefinitionActiveInConfig(config.mcpServers, definition)) {
    await fsPromises.mkdir(paths.activeDir, { recursive: true });
    await writeActiveMarker(activePath, definition);
    console.log(`Heavy MCP '${name}' is already active.`);
    return;
  }

  const conflictingServerNames = findConflictingHeavyServerNames(config.mcpServers, definition);
  if (conflictingServerNames.length > 0) {
    throw new Error(
      `Cannot activate heavy MCP '${name}' because these server entries already exist with different settings: ${conflictingServerNames
        .map((serverName) => `'${serverName}'`)
        .join(', ')}.`
    );
  }

  // Merge the heavy MCP servers into main config
  if (!config.mcpServers) {
    config.mcpServers = {};
  }
  for (const [serverName, serverDef] of Object.entries(definition.mcpServers)) {
    config.mcpServers[serverName] = serverDef;
  }

  // Write back config
  await writeRawConfig(configPath, config);

  // Refresh active marker metadata
  await fsPromises.mkdir(paths.activeDir, { recursive: true });
  await writeActiveMarker(activePath, definition);

  console.log(`Activated: ${name}`);
}

async function handleHeavyDeactivate(args: string[], paths: HeavyPaths, options: HeavyCliOptions): Promise<void> {
  const name = args.shift();
  if (!name) {
    throw new Error('Usage: mcporter heavy deactivate <name>');
  }
  assertValidHeavyMcpName(name);

  // Load current config
  const { config, path: configPath } = await loadRawConfig(options);
  const activePath = path.join(paths.activeDir, `${name}.json`);

  const marker = await readActiveMarker(activePath);
  let serverNames: string[];
  if (marker) {
    const markerDefinition = getHeavyDefinitionFromMarker(marker);
    let currentDefinition: HeavyMcpDefinition | null = null;
    try {
      currentDefinition = await readHeavyMcpDefinition(paths.availableDir, name);
    } catch {}

    const activeDefinition =
      findActiveHeavyDefinition(config.mcpServers, currentDefinition) ??
      findActiveHeavyDefinition(config.mcpServers, markerDefinition);
    if (!activeDefinition) {
      console.log(`Heavy MCP '${name}' is not active.`);
      return;
    }
    serverNames = Object.keys(activeDefinition.mcpServers);
  } else {
    let definition: HeavyMcpDefinition | null;
    try {
      definition = await readHeavyMcpDefinition(paths.availableDir, name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Cannot deactivate heavy MCP '${name}' because its marker metadata is missing and its definition is invalid: ${message}`
      );
    }

    if (!definition || !isHeavyMcpDefinitionActiveInConfig(config.mcpServers, definition)) {
      console.log(`Heavy MCP '${name}' is not active.`);
      return;
    }

    serverNames = Object.keys(definition.mcpServers);
  }

  // Remove the server(s) from config
  for (const serverName of serverNames) {
    delete config.mcpServers?.[serverName];
  }

  // Write back config
  await writeRawConfig(configPath, config);

  // Remove active marker
  await fsPromises.unlink(activePath).catch(() => {});

  console.log(`Deactivated: ${name}`);
}

async function listActiveHeavyMcps(paths: HeavyPaths, options: HeavyCliOptions): Promise<string[]> {
  const { config } = await loadRawConfig(options);
  const active = new Set<string>();
  const definitions = new Map<string, HeavyMcpDefinition | null>();
  const available = await listHeavyMcpDefinitions(paths.availableDir);
  await Promise.all(
    available.map(async (name) => {
      const definition = await readHeavyDefinitionForActiveDetection(paths.availableDir, name);
      definitions.set(name, definition);
      if (definition && isHeavyMcpDefinitionActiveInConfig(config.mcpServers, definition)) {
        active.add(name);
      }
    })
  );

  const marked = await listHeavyMcpDefinitions(paths.activeDir);
  await Promise.all(
    marked.map(async (name) => {
      let definition: HeavyMcpDefinition | null;
      if (definitions.has(name)) {
        definition = definitions.get(name) ?? null;
      } else {
        definition = await readHeavyDefinitionForActiveDetection(paths.availableDir, name);
        definitions.set(name, definition);
      }

      if (definition) {
        if (isHeavyMcpDefinitionActiveInConfig(config.mcpServers, definition)) {
          active.add(name);
        }
        return;
      }

      const marker = await readActiveMarker(path.join(paths.activeDir, `${name}.json`));
      if (marker && findActiveHeavyDefinition(config.mcpServers, getHeavyDefinitionFromMarker(marker))) {
        active.add(name);
      }
    })
  );

  return [...active];
}

function isHeavyMcpDefinitionActiveInConfig(
  configuredServers: Record<string, unknown> | undefined,
  definition: HeavyMcpDefinition
): boolean {
  return Object.entries(definition.mcpServers).every(([serverName, definitionEntry]) =>
    isDeepStrictEqual(configuredServers?.[serverName], definitionEntry)
  );
}

function findConflictingHeavyServerNames(
  configuredServers: Record<string, unknown> | undefined,
  definition: HeavyMcpDefinition
): string[] {
  return Object.entries(definition.mcpServers)
    .filter(([serverName, definitionEntry]) => {
      const configuredEntry = configuredServers?.[serverName];
      return configuredEntry !== undefined && !isDeepStrictEqual(configuredEntry, definitionEntry);
    })
    .map(([serverName]) => serverName);
}

function findActiveHeavyDefinition(
  configuredServers: Record<string, unknown> | undefined,
  definition: HeavyMcpDefinition | null
): HeavyMcpDefinition | null {
  return definition && isHeavyMcpDefinitionActiveInConfig(configuredServers, definition) ? definition : null;
}

function getHeavyDefinitionFromMarker(marker: ActiveHeavyMcpMarker): HeavyMcpDefinition | null {
  return marker.mcpServers ? { mcpServers: marker.mcpServers } : null;
}

async function readHeavyDefinitionForActiveDetection(
  availableDir: string,
  name: string
): Promise<Awaited<ReturnType<typeof readHeavyMcpDefinition>>> {
  try {
    return await readHeavyMcpDefinition(availableDir, name);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn(`Skipping invalid heavy MCP definition '${name}': ${message}`);
    return null;
  }
}

async function readActiveMarker(activePath: string): Promise<ActiveHeavyMcpMarker | null> {
  try {
    const buffer = await fsPromises.readFile(activePath, 'utf8');
    const parsed = JSON.parse(buffer);
    const validation = ActiveHeavyMcpMarkerSchema.safeParse(parsed);
    if (!validation.success) {
      return null;
    }
    return validation.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    return null;
  }
}

async function writeActiveMarker(activePath: string, definition: HeavyMcpDefinition): Promise<void> {
  const marker: ActiveHeavyMcpMarker = {
    activated: new Date().toISOString(),
    serverNames: Object.keys(definition.mcpServers),
    mcpServers: definition.mcpServers,
  };

  await fsPromises.unlink(activePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  });
  await fsPromises.writeFile(activePath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}
