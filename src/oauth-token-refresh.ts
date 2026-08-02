import { Buffer } from 'node:buffer';
import type {
  OAuthClientInformationMixed,
  OAuthProtectedResourceMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/client';
import {
  checkResourceAllowed,
  discoverOAuthServerInfo,
  refreshAuthorization,
  resourceUrlFromServerUrl,
} from '@modelcontextprotocol/client';
import type { ServerDefinition } from './config.js';
import type { Logger } from './logging.js';
import { buildStaticClientInformation, resolveOAuthClientSecret } from './oauth-client-info.js';
import { clearLegacyOAuthArtifacts } from './oauth-persistence-stores.js';
import type { OAuthPersistence } from './oauth-persistence.js';
import { sameOAuthTokenGeneration } from './oauth-token-generation.js';

type StoredOAuthTokens = OAuthTokens & {
  expires_at?: number;
  expiresAt?: number;
};

const TOKEN_EXPIRY_SKEW_SECONDS = 60;

function tokenExpirySeconds(tokens: OAuthTokens): number | undefined {
  const stored = tokens as StoredOAuthTokens;
  for (const candidate of [stored.expires_at, stored.expiresAt]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function cachedTokensChanged(original: OAuthTokens, current: OAuthTokens | undefined): boolean {
  if (!current || typeof current.access_token !== 'string' || current.access_token.trim().length === 0) {
    return false;
  }
  return !sameOAuthTokenGeneration(current, original);
}

function shouldRefreshCachedToken(tokens: OAuthTokens, skewSeconds = TOKEN_EXPIRY_SKEW_SECONDS): boolean {
  const expiresAt = tokenExpirySeconds(tokens);
  if (expiresAt !== undefined) {
    return expiresAt <= Math.floor(Date.now() / 1000) + skewSeconds;
  }
  return typeof tokens.expires_in === 'number' && typeof tokens.refresh_token === 'string';
}

function resourceForRefresh(
  serverUrl: URL,
  resourceMetadata: OAuthProtectedResourceMetadata | undefined
): URL | undefined {
  if (!resourceMetadata) {
    return undefined;
  }
  const defaultResource = resourceUrlFromServerUrl(serverUrl);
  if (!checkResourceAllowed({ requestedResource: defaultResource, configuredResource: resourceMetadata.resource })) {
    throw new Error(
      `Protected resource ${resourceMetadata.resource} does not match expected ${defaultResource} (or origin)`
    );
  }
  return new URL(resourceMetadata.resource);
}

function unrecoverableOAuthRefreshCode(error: unknown): string | undefined {
  const errorCode = oauthErrorCode(error);
  if (errorCode && ['invalid_client', 'invalid_grant', 'unauthorized_client'].includes(errorCode)) {
    return errorCode;
  }
  return undefined;
}

async function oauthErrorCodeFromResponse(response: Response): Promise<string | undefined> {
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (payload && typeof payload.error === 'string' && payload.error.length > 0) {
      return payload.error.toLowerCase();
    }
  } catch {
    // Non-JSON error body; leave the error unclassified.
  }
  return undefined;
}

function oauthErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const { errorCode, name } = error as { errorCode?: unknown; name?: unknown };
  if (typeof errorCode === 'string' && errorCode.length > 0) {
    return errorCode.toLowerCase();
  }
  if (typeof name === 'string') {
    const normalized = name.toLowerCase();
    if (normalized === 'invalidclienterror') {
      return 'invalid_client';
    }
    if (normalized === 'invalidgranterror') {
      return 'invalid_grant';
    }
    if (normalized === 'unauthorizedclienterror') {
      return 'unauthorized_client';
    }
  }
  return undefined;
}

export async function readCachedAccessTokenWithPersistence(
  definition: ServerDefinition,
  persistence: OAuthPersistence,
  logger?: Logger
): Promise<string | undefined> {
  const tokens = await persistence.readTokens();
  if (!tokens || typeof tokens.access_token !== 'string' || tokens.access_token.trim().length === 0) {
    return undefined;
  }
  if (definition.auth === 'refreshable_bearer') {
    return await readExplicitRefreshableBearerToken(definition, persistence, tokens, logger);
  }
  if (!shouldRefreshCachedToken(tokens)) {
    return tokens.access_token;
  }
  if (typeof tokens.refresh_token !== 'string' || tokens.refresh_token.trim().length === 0) {
    return tokens.access_token;
  }
  let persistedClientInformation: OAuthClientInformationMixed | undefined;
  try {
    const staticClientInformation = buildStaticClientInformation(definition);
    persistedClientInformation = staticClientInformation ? undefined : await persistence.readClientInfo();
    const clientInformation = staticClientInformation ?? persistedClientInformation;
    if (!clientInformation) {
      logger?.debug?.(
        `Cached OAuth token for '${definition.name}' is expired, but no client information is available.`
      );
      return tokens.access_token;
    }
    if (definition.command.kind !== 'http') {
      return tokens.access_token;
    }
    const serverInfo = await discoverOAuthServerInfo(definition.command.url);
    const resource = resourceForRefresh(definition.command.url, serverInfo.resourceMetadata);
    const refreshed = await refreshAuthorization(serverInfo.authorizationServerUrl, {
      metadata: serverInfo.authorizationServerMetadata,
      clientInformation,
      refreshToken: tokens.refresh_token,
      ...(resource ? { resource } : {}),
    });
    await persistence.saveTokens(refreshed);
    logger?.debug?.(`Refreshed cached OAuth access token for '${definition.name}' (non-interactive).`);
    return refreshed.access_token;
  } catch (error) {
    logger?.debug?.(
      `Failed to refresh cached OAuth token for '${definition.name}' non-interactively: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    const unrecoverableCode = unrecoverableOAuthRefreshCode(error);
    if (unrecoverableCode) {
      return await recoverFromUnrecoverableRefresh(
        definition,
        persistence,
        tokens,
        unrecoverableCode,
        'OAuth',
        logger,
        persistedClientInformation
      );
    }
    return tokens.access_token;
  }
}

/**
 * After a refresh fails with an unrecoverable OAuth error code, adopt the
 * tokens a concurrent refresh persisted first, or clear the dead credentials
 * so the rejected refresh token is never replayed (providers that rotate
 * refresh tokens treat replays as stolen-token signals and revoke the grant).
 * Returns the concurrent winner's access token, or undefined after clearing.
 *
 * The rejected token and the specific dynamic client registration used by the
 * refresh are compare-and-cleared under each store's lock. State and PKCE
 * verifier data belong to interactive auth and are never removed here. There
 * is no later unconditional live-store sweep, so any different generation is
 * preserved and adopted.
 */
async function recoverFromUnrecoverableRefresh(
  definition: ServerDefinition,
  persistence: OAuthPersistence,
  tokens: OAuthTokens,
  unrecoverableCode: string,
  tokenKind: 'OAuth' | 'bearer',
  logger?: Logger,
  rejectedClientInformation?: OAuthClientInformationMixed
): Promise<string | undefined> {
  const clientToClear = unrecoverableCode === 'invalid_grant' ? undefined : rejectedClientInformation;
  await persistence.clearRejectedCredentials(tokens, clientToClear);
  // Legacy artifacts are not live refresh destinations, so this sweep cannot
  // race a winner. Live stores were handled only by guarded mutations above.
  await clearLegacyOAuthArtifacts(definition, logger, unrecoverableCode === 'invalid_grant' ? 'tokens' : 'all');
  const latestTokens = await persistence.readTokens();
  if (latestTokens && cachedTokensChanged(tokens, latestTokens)) {
    logger?.debug?.(
      `Kept cached ${tokenKind} token for '${definition.name}' because another refresh updated it first.`
    );
    return latestTokens.access_token;
  }
  logger?.debug?.(
    `Cleared cached ${tokenKind} ${unrecoverableCode === 'invalid_grant' ? 'token' : 'credentials'} for '${
      definition.name
    }' after unrecoverable refresh failure.`
  );
  return undefined;
}

async function readExplicitRefreshableBearerToken(
  definition: ServerDefinition,
  persistence: OAuthPersistence,
  tokens: OAuthTokens,
  logger?: Logger
): Promise<string> {
  const refresh = definition.refresh;
  const skewSeconds = refresh?.refreshSkewSeconds ?? TOKEN_EXPIRY_SKEW_SECONDS;
  if (!shouldRefreshCachedToken(tokens, skewSeconds)) {
    return tokens.access_token;
  }
  if (!refresh) {
    throw new Error(`Cached bearer token for '${definition.name}' is expired, but refresh is not configured.`);
  }
  if (typeof tokens.refresh_token !== 'string' || tokens.refresh_token.trim().length === 0) {
    throw new Error(`Cached bearer token for '${definition.name}' is expired, but no refresh_token is available.`);
  }
  try {
    const refreshed = await refreshBearerToken(definition, tokens.refresh_token);
    await persistence.saveTokens(refreshed);
    logger?.debug?.(`Refreshed bearer access token for '${definition.name}' (non-interactive).`);
    return refreshed.access_token;
  } catch (error) {
    logger?.debug?.(
      `Failed to refresh bearer token for '${definition.name}' non-interactively: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    const unrecoverableCode = unrecoverableOAuthRefreshCode(error);
    if (unrecoverableCode) {
      const winnerToken = await recoverFromUnrecoverableRefresh(
        definition,
        persistence,
        tokens,
        unrecoverableCode,
        'bearer',
        logger
      );
      if (winnerToken) {
        return winnerToken;
      }
    }
    throw new Error(
      `Failed to refresh cached bearer token for '${definition.name}': ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }
}

async function refreshBearerToken(definition: ServerDefinition, refreshToken: string): Promise<OAuthTokens> {
  const refresh = definition.refresh;
  if (!refresh) {
    throw new Error('Missing refresh configuration.');
  }
  const clientId = readEnvOrConfig(refresh.clientIdEnv, definition.oauthClientId);
  const method = refresh.clientAuthMethod ?? definition.oauthTokenEndpointAuthMethod ?? 'client_secret_basic';
  const clientSecret = method === 'none' ? undefined : readClientSecret(definition, refresh.clientSecretEnv);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
  };

  if (method === 'client_secret_post') {
    if (clientId) {
      body.set('client_id', clientId);
    }
    if (clientSecret) {
      body.set('client_secret', clientSecret);
    }
  } else if (method === 'none') {
    if (clientId) {
      body.set('client_id', clientId);
    }
  } else {
    if (!clientId || !clientSecret) {
      throw new Error(`Refresh client credentials are required for '${method}'.`);
    }
    headers.authorization = `Basic ${Buffer.from(
      `${formEncodeCredential(clientId)}:${formEncodeCredential(clientSecret)}`
    ).toString('base64')}`;
  }

  const response = await fetch(refresh.tokenEndpoint, {
    method: 'POST',
    headers,
    body,
  });
  if (!response.ok) {
    const errorCode = await oauthErrorCodeFromResponse(response);
    throw Object.assign(
      new Error(`Token endpoint returned HTTP ${response.status}${errorCode ? ` (${errorCode})` : ''}.`),
      errorCode ? { errorCode } : {}
    );
  }
  const payload = normalizeBearerTokenResponse(await response.json());
  return {
    ...payload,
    ...(payload.refresh_token ? {} : { refresh_token: refreshToken }),
  };
}

function normalizeBearerTokenResponse(value: unknown): OAuthTokens {
  if (!value || typeof value !== 'object') {
    throw new Error('Token endpoint did not return a JSON object.');
  }
  const payload = value as Record<string, unknown>;
  if (typeof payload.access_token !== 'string' || payload.access_token.trim().length === 0) {
    throw new Error('Token endpoint did not return an access_token.');
  }
  return {
    access_token: payload.access_token,
    token_type: typeof payload.token_type === 'string' && payload.token_type ? payload.token_type : 'Bearer',
    ...(typeof payload.id_token === 'string' ? { id_token: payload.id_token } : {}),
    ...(typeof payload.scope === 'string' ? { scope: payload.scope } : {}),
    ...(typeof payload.refresh_token === 'string' && payload.refresh_token
      ? { refresh_token: payload.refresh_token }
      : {}),
    ...coerceExpiresIn(payload.expires_in),
  };
}

function coerceExpiresIn(value: unknown): Pick<OAuthTokens, 'expires_in'> {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { expires_in: value };
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return { expires_in: parsed };
    }
  }
  return {};
}

function readEnvOrConfig(envName: string | undefined, fallback: string | undefined): string | undefined {
  if (!envName) {
    return fallback;
  }
  const value = process.env[envName];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Environment variable '${envName}' is required for bearer token refresh.`);
  }
  return value;
}

function formEncodeCredential(value: string): string {
  return new URLSearchParams([['', value]]).toString().slice(1);
}

function readClientSecret(
  definition: ServerDefinition,
  refreshClientSecretEnv: string | undefined
): string | undefined {
  if (refreshClientSecretEnv) {
    return readEnvOrConfig(refreshClientSecretEnv, undefined);
  }
  return resolveOAuthClientSecret(definition, { rejectBlank: true });
}
