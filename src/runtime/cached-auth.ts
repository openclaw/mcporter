import type { ServerDefinition } from '../config.js';
import type { Logger } from '../logging.js';
import { readCachedAccessToken } from '../oauth-persistence.js';
import { VaultEncryptionError } from '../oauth-vault-encryption.js';
import { materializeHeaders } from '../runtime-header-utils.js';

const BEARER_AUTHORIZATION = /^bearer(?:\s+|$)(.*)$/i;

function isAuthorizationHeaderName(name: string): boolean {
  return name.toLowerCase() === 'authorization';
}

// A scheme-only Bearer value has no credential. Other non-empty schemes stay configured.
function hasUsableAuthorizationCredential(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const bearer = BEARER_AUTHORIZATION.exec(trimmed);
  if (!bearer) return true;
  return (bearer[1] ?? '').trim().length > 0;
}

function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  return Boolean(headers && Object.keys(headers).some((key) => isAuthorizationHeaderName(key)));
}

// Resolve with the same header environment semantics as HTTP transport. Key presence
// alone is not a credential: list does not establish OAuth, so an empty resolved
// Authorization would otherwise be sent instead of the cached token.
function hasUsableStaticAuthorization(definition: ServerDefinition): boolean {
  if (definition.command.kind !== 'http' || !hasAuthorizationHeader(definition.command.headers)) return false;
  const resolved = materializeHeaders(definition.command.headers, definition.name, definition.env);
  return Object.entries(resolved ?? {}).some(
    ([key, value]) => isAuthorizationHeaderName(key) && hasUsableAuthorizationCredential(value)
  );
}

function omitAuthorizationHeaders(headers: Record<string, string>): Record<string, string> {
  const retained: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!isAuthorizationHeaderName(key)) retained[key] = value;
  }
  return retained;
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
  if (definition.command.kind === 'http' && hasUsableStaticAuthorization(definition)) {
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
    logger.debug?.(`Using cached OAuth access token for '${definition.name}' (non-interactive).`);
    return {
      ...definition,
      command: {
        ...definition.command,
        headers: {
          ...omitAuthorizationHeaders(existingHeaders),
          Authorization: `Bearer ${cached}`,
        },
      },
    };
  } catch (error) {
    // Vault refusals are configuration errors the operator must see; swallowing
    // them would start an interactive auth flow a headless caller cannot finish.
    if (definition.auth === 'refreshable_bearer' || error instanceof VaultEncryptionError) {
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
