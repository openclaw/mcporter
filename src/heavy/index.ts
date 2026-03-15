/**
 * Heavy MCP management module.
 *
 * Provides on-demand loading for large MCP servers that consume significant
 * context tokens when loaded.
 */

export {
  deleteHeavyMcpDefinition,
  type HeavyMcpDefinition,
  listHeavyMcpDefinitions,
  readHeavyMcpDefinition,
  writeHeavyMcpDefinition,
} from './definition.js';
export { getDefaultHeavyPaths, type HeavyPaths, resolveHeavyPaths } from './paths.js';
