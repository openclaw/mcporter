export interface ToolSelectionValidationContext {
  readonly mutuallyExclusiveMessage: string;
}

export function validateToolSelection(
  includeTools: readonly string[] | undefined,
  excludeTools: readonly string[] | undefined,
  context: ToolSelectionValidationContext
): void {
  if (includeTools && excludeTools) {
    throw new Error(context.mutuallyExclusiveMessage);
  }
  if (includeTools && includeTools.length === 0) {
    throw new Error('--include-tools requires at least one tool name.');
  }
  if (excludeTools && excludeTools.length === 0) {
    throw new Error('--exclude-tools requires at least one tool name.');
  }
}
