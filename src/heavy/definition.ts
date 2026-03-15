/**
 * Heavy MCP definition file handling.
 *
 * A heavy MCP definition file is a JSON file containing MCP server configurations
 * that are stored separately from the main mcporter.json to save context tokens.
 *
 * Example (chrome-devtools.json):
 * {
 *   "mcpServers": {
 *     "chrome-devtools": {
 *       "command": "npx",
 *       "args": ["-y", "chrome-devtools-mcp@latest"]
 *     }
 *   }
 * }
 */

import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { RawEntry } from '../config-schema.js';

export interface HeavyMcpDefinition {
  mcpServers: Record<string, RawEntry>;
}

/**
 * Read a heavy MCP definition file.
 *
 * @param availableDir - Directory containing available heavy MCPs
 * @param name - Name of the heavy MCP (without .json extension)
 * @returns The definition or null if not found
 */
export async function readHeavyMcpDefinition(availableDir: string, name: string): Promise<HeavyMcpDefinition | null> {
  const definitionPath = path.join(availableDir, `${name}.json`);

  try {
    const content = await fsPromises.readFile(definitionPath, 'utf8');
    const parsed = JSON.parse(content);
    return parsed as HeavyMcpDefinition;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Write a heavy MCP definition file.
 *
 * @param availableDir - Directory containing available heavy MCPs
 * @param name - Name of the heavy MCP (without .json extension)
 * @param definition - The definition to write
 */
export async function writeHeavyMcpDefinition(
  availableDir: string,
  name: string,
  definition: HeavyMcpDefinition
): Promise<void> {
  await fsPromises.mkdir(availableDir, { recursive: true });
  const definitionPath = path.join(availableDir, `${name}.json`);
  const content = `${JSON.stringify(definition, null, 2)}\n`;
  await fsPromises.writeFile(definitionPath, content, 'utf8');
}

/**
 * List all available heavy MCP definitions.
 *
 * @param availableDir - Directory containing available heavy MCPs
 * @returns Array of heavy MCP names (without .json extension)
 */
export async function listHeavyMcpDefinitions(availableDir: string): Promise<string[]> {
  try {
    const files = await fsPromises.readdir(availableDir);
    return files.filter((file) => file.endsWith('.json')).map((file) => file.replace(/\.json$/, ''));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * Delete a heavy MCP definition file.
 *
 * @param availableDir - Directory containing available heavy MCPs
 * @param name - Name of the heavy MCP (without .json extension)
 */
export async function deleteHeavyMcpDefinition(availableDir: string, name: string): Promise<void> {
  const definitionPath = path.join(availableDir, `${name}.json`);
  await fsPromises.unlink(definitionPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  });
}
