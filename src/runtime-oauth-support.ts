import type { ServerDefinition } from './config.js';
import { analyzeConnectionError } from './error-classifier.js';
import type { Logger } from './logging.js';

export function maybeEnableOAuth(definition: ServerDefinition, logger: Logger): ServerDefinition | undefined {
  if (definition.auth === 'oauth') {
    return undefined;
  }
  if (definition.command.kind !== 'http') {
    return undefined;
  }
  // Allow users to opt out of auto-OAuth per server with `"autoOAuth": false`.
  if (definition.autoOAuth === false) {
    return undefined;
  }
  const sourceHint = definition.source
    ? ` (from ${definition.source.importKind ?? definition.source.kind}: ${definition.source.path})`
    : '';
  logger.info(`Detected OAuth requirement for '${definition.name}'${sourceHint}. Launching browser flow...`);
  return {
    ...definition,
    auth: 'oauth',
  };
}

export function isUnauthorizedError(error: unknown): boolean {
  const issue = analyzeConnectionError(error);
  return issue.kind === 'auth';
}
