export interface ToolFilterConfig {
  readonly allowedTools?: readonly string[];
  readonly blockedTools?: readonly string[];
}

export function validateToolFilters(name: string, filter: ToolFilterConfig): void {
  if (filter.allowedTools !== undefined && filter.blockedTools !== undefined) {
    throw new Error(`Server '${name}' cannot specify both allowedTools and blockedTools.`);
  }
}

export function isToolAllowed(toolName: string, filter: ToolFilterConfig | undefined): boolean {
  if (!filter) {
    return true;
  }
  if (filter.allowedTools !== undefined) {
    return filter.allowedTools.includes(toolName);
  }
  if (filter.blockedTools !== undefined) {
    return !filter.blockedTools.includes(toolName);
  }
  return true;
}

export function filterTools<T extends { readonly name: string }>(
  tools: readonly T[],
  filter: ToolFilterConfig | undefined
): T[] {
  return tools.filter((tool) => isToolAllowed(tool.name, filter));
}
