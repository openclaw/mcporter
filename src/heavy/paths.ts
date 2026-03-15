/**
 * Path resolution for heavy MCP management.
 *
 * Heavy MCPs are servers with large tool schemas that consume significant
 * context tokens. This module provides path resolution for managing them.
 */

import os from 'node:os';
import path from 'node:path';

export interface HeavyPaths {
  /** Base directory for heavy MCP management (~/.mcporter/heavy) */
  heavyDir: string;
  /** Directory containing available heavy MCP definitions */
  availableDir: string;
  /** Directory tracking active heavy MCPs */
  activeDir: string;
}

/**
 * Get the default heavy paths based on home directory.
 */
export function getDefaultHeavyPaths(): HeavyPaths {
  const homeDir = os.homedir();
  const mcporterDir = path.join(homeDir, '.mcporter');

  return {
    heavyDir: path.join(mcporterDir, 'heavy'),
    availableDir: path.join(mcporterDir, 'heavy', 'available'),
    activeDir: path.join(mcporterDir, 'heavy', 'active'),
  };
}

/**
 * Resolve paths for heavy MCP management based on config path.
 *
 * @param configPath - Path to the main mcporter.json file
 * @returns HeavyPaths object with resolved paths
 */
export function resolveHeavyPaths(configPath: string): HeavyPaths {
  // Determine the mcporter directory from config path
  const mcporterDir = path.dirname(configPath);

  return {
    heavyDir: path.join(mcporterDir, 'heavy'),
    availableDir: path.join(mcporterDir, 'heavy', 'available'),
    activeDir: path.join(mcporterDir, 'heavy', 'active'),
  };
}
