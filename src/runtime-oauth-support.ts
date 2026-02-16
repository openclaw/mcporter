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
  // Allow OAuth auto-promotion for any HTTP server, not just ad-hoc sources.
  // Config-defined servers behind OAuth (e.g. Backstage MCP) also need auto-promotion
  // when they return 401 with WWW-Authenticate headers.
  logger.info(`Detected OAuth requirement for '${definition.name}'. Launching browser flow...`);
  return {
    ...definition,
    auth: 'oauth',
  };
}

export function isUnauthorizedError(error: unknown): boolean {
  const issue = analyzeConnectionError(error);
  return issue.kind === 'auth';
}
