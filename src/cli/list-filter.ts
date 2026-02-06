import { minimatch } from 'minimatch';

/**
 * Filter tools by a glob pattern matching tool names.
 * @param tools Array of items with a `name` property
 * @param pattern Glob pattern to match against tool names
 * @returns Filtered array of tools matching the pattern
 */
export function filterToolsByPattern<T extends { name: string }>(tools: T[], pattern: string): T[] {
  return tools.filter((tool) => minimatch(tool.name, pattern, { nocase: true }));
}

/**
 * Check if a pattern contains glob special characters.
 */
export function isGlobPattern(pattern: string): boolean {
  return /[*?[\]{}!]/.test(pattern);
}
