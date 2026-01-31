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
  // Allow OAuth promotion for any HTTP server that returns 401,
  // not just ad-hoc servers (fixes issue #38)
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
