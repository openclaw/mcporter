import type { ServerDefinition } from '../config.js';
import type { Logger } from '../logging.js';
import { readCachedAccessToken } from '../oauth-persistence.js';

function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  return Boolean(headers && Object.keys(headers).some((key) => key.toLowerCase() === 'authorization'));
}

export async function applyCachedAuthIfAvailable(
  definition: ServerDefinition,
  logger: Logger,
  allowCachedAuth: boolean | undefined
): Promise<ServerDefinition> {
  if (!allowCachedAuth && definition.auth !== 'refreshable_bearer') {
    return definition;
  }
  if (
    definition.auth === 'refreshable_bearer' &&
    definition.command.kind === 'stdio' &&
    !definition.refresh?.accessTokenEnv
  ) {
    throw new Error(
      `Server '${definition.name}' uses refreshable_bearer stdio auth but is missing refresh.accessTokenEnv.`
    );
  }
  if (definition.command.kind === 'http' && hasAuthorizationHeader(definition.command.headers)) {
    return definition;
  }
  try {
    const cached = await readCachedAccessToken(definition, logger);
    if (!cached) {
      if (definition.auth === 'refreshable_bearer') {
        throw new Error(`Server '${definition.name}' uses refreshable_bearer auth but has no cached access token.`);
      }
      return definition;
    }
    if (definition.command.kind === 'stdio') {
      if (definition.auth !== 'refreshable_bearer') {
        return definition;
      }
      const accessTokenEnv = definition.refresh?.accessTokenEnv;
      if (!accessTokenEnv) {
        throw new Error(
          `Server '${definition.name}' uses refreshable_bearer stdio auth but is missing refresh.accessTokenEnv.`
        );
      }
      logger.debug?.(`Using cached bearer access token for '${definition.name}' stdio env.`);
      return {
        ...definition,
        env: {
          ...definition.env,
          [accessTokenEnv]: cached,
        },
      };
    }
    const existingHeaders = definition.command.headers ?? {};
    if (hasAuthorizationHeader(existingHeaders)) {
      return definition;
    }
    logger.debug?.(`Using cached OAuth access token for '${definition.name}' (non-interactive).`);
    return {
      ...definition,
      command: {
        ...definition.command,
        headers: {
          ...existingHeaders,
          Authorization: `Bearer ${cached}`,
        },
      },
    };
  } catch (error) {
    if (definition.auth === 'refreshable_bearer') {
      throw error;
    }
    logger.debug?.(
      `Failed to read cached OAuth token for '${definition.name}': ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return definition;
  }
}
