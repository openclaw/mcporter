import { Buffer } from 'node:buffer';
import type {
  OAuthClientInformationMixed,
  OAuthProtectedResourceMetadata,
  OAuthTokens,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import {
  checkResourceAllowed,
  discoverOAuthServerInfo,
  refreshAuthorization,
  resourceUrlFromServerUrl,
} from '@modelcontextprotocol/client';
import type { ServerDefinition } from './config.js';
import { isFileLockTimeoutError } from './fs-json.js';
import type { Logger } from './logging.js';
import { buildStaticClientInformation, resolveOAuthClientSecret } from './oauth-client-info.js';
import { clearLegacyOAuthArtifacts } from './oauth-persistence-stores.js';
import type { OAuthPersistence } from './oauth-persistence.js';
import { withRefreshLock } from './oauth-refresh-lock.js';
import { sameOAuthTokenGeneration } from './oauth-token-generation.js';

type CachedOAuthTokens = OAuthTokens & {
  expires_at?: number;
  expiresAt?: number;
};

const TOKEN_EXPIRY_SKEW_SECONDS = 60;

// Bounds how long a redemption can hold the refresh lock. A live-but-stalled
// holder is invisible to the lock's pid-based staleness check, so an unbounded
// request would starve every waiter for its full acquisition budget.
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

class OAuthIssuerMismatchError extends Error {}

/**
 * What the transaction should do after re-reading persisted tokens under the
 * refresh lock. Another process may have rotated the token while this caller
 * waited, in which case redeeming again would replay a spent refresh token.
 */
type LockedTokenDecision =
  | { kind: 'gone' }
  | { kind: 'use'; accessToken: string; adopted: boolean }
  | { kind: 'unrefreshable'; accessToken: string }
  | { kind: 'redeem'; tokens: OAuthTokens; refreshToken: string };

function decideUnderRefreshLock(
  original: OAuthTokens,
  latest: OAuthTokens | undefined,
  skewSeconds: number
): LockedTokenDecision {
  if (!latest || typeof latest.access_token !== 'string' || latest.access_token.trim().length === 0) {
    return { kind: 'gone' };
  }
  const adopted = cachedTokensChanged(original, latest);
  if (!shouldRefreshCachedToken(latest, skewSeconds)) {
    return { kind: 'use', accessToken: latest.access_token, adopted };
  }
  if (typeof latest.refresh_token !== 'string' || latest.refresh_token.trim().length === 0) {
    // A winner that carries no refresh token is still the best available token.
    return adopted
      ? { kind: 'use', accessToken: latest.access_token, adopted }
      : { kind: 'unrefreshable', accessToken: latest.access_token };
  }
  return { kind: 'redeem', tokens: latest, refreshToken: latest.refresh_token };
}

/**
 * Never redeem outside the lock: a waiter that gave up would be exactly the
 * concurrent redemption the lock exists to prevent. Returning a possibly
 * expired token degrades to a 401, which the debug line makes traceable.
 */
async function accessTokenAfterLockTimeout(
  definition: ServerDefinition,
  persistence: OAuthPersistence,
  tokenKind: 'OAuth' | 'bearer',
  logger?: Logger
): Promise<string | undefined> {
  const latest = await persistence.readTokens();
  const accessToken =
    typeof latest?.access_token === 'string' && latest.access_token.trim().length > 0 ? latest.access_token : undefined;
  logger?.debug?.(
    `Timed out waiting for the ${tokenKind} refresh lock for '${definition.name}'; ${
      accessToken
        ? 'returning the persisted access token, which may already be expired.'
        : 'no persisted access token remains.'
    }`
  );
  return accessToken;
}

function tokenExpirySeconds(tokens: OAuthTokens): number | undefined {
  const stored = tokens as CachedOAuthTokens;
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

/**
 * Whether a persisted token is close enough to expiry that a refresh is due.
 *
 * The OAuth provider needs this to enforce that it never hands the MCP SDK an
 * expired-but-refreshable token: the SDK would redeem it outside the refresh
 * lock, which is the replay this module exists to prevent.
 */
export function oauthAccessTokenNeedsRefresh(tokens: OAuthTokens): boolean {
  return shouldRefreshCachedToken(tokens);
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

function normalizedIssuer(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

async function assertRefreshIssuerBinding(
  definition: ServerDefinition,
  persistence: OAuthPersistence,
  tokens: StoredOAuthTokens,
  clientInformation: StoredOAuthClientInformation,
  receivedIssuer: string
): Promise<void> {
  const expectedIssuer = normalizedIssuer(tokens.issuer) ?? normalizedIssuer(clientInformation.issuer);
  if (!expectedIssuer || expectedIssuer === normalizedIssuer(receivedIssuer)) {
    return;
  }
  await Promise.all([persistence.clear('tokens'), persistence.clear('client')]);
  throw new OAuthIssuerMismatchError(
    `OAuth issuer changed for '${definition.name}': expected ${expectedIssuer}, received ${receivedIssuer}. ` +
      `Discarded cached credentials; run 'mcporter auth ${definition.name}' to reauthorize.`
  );
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
  // `code` is where the MCP SDK's OAuthError carries the OAuth error code, so
  // without it a real rejected grant would skip recovery and be replayed.
  // Unrelated codes (an errno such as ECONNREFUSED) fall out of the caller's
  // allowlist, which is what keeps a transport failure recoverable.
  const { errorCode, code, name } = error as { errorCode?: unknown; code?: unknown; name?: unknown };
  for (const candidate of [errorCode, code]) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate.toLowerCase();
    }
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
  if (definition.command.kind !== 'http') {
    return tokens.access_token;
  }
  try {
    return await withRefreshLock(
      definition,
      async () => await refreshCachedOAuthTokenUnderLock(definition, persistence, tokens, logger)
    );
  } catch (error) {
    if (isFileLockTimeoutError(error)) {
      return await accessTokenAfterLockTimeout(definition, persistence, 'OAuth', logger);
    }
    throw error;
  }
}

// Runs the whole transaction — re-read, redeem, persist — while holding the
// refresh lock, so a rotating refresh token is redeemed exactly once.
async function refreshCachedOAuthTokenUnderLock(
  definition: ServerDefinition,
  persistence: OAuthPersistence,
  original: OAuthTokens,
  logger?: Logger
): Promise<string | undefined> {
  const decision = decideUnderRefreshLock(original, await persistence.readTokens(), TOKEN_EXPIRY_SKEW_SECONDS);
  if (decision.kind === 'gone') {
    logger?.debug?.(`Cached OAuth token for '${definition.name}' was cleared before its refresh could run.`);
    return undefined;
  }
  if (decision.kind === 'unrefreshable') {
    return decision.accessToken;
  }
  if (decision.kind === 'use') {
    if (decision.adopted) {
      logger?.debug?.(`Adopted the OAuth access token another refresh persisted first for '${definition.name}'.`);
    }
    return decision.accessToken;
  }

  const tokens = decision.tokens;
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
    const serverInfo = await discoverOAuthServerInfo(definition.command.url, { fetchFn: boundedRefreshFetch });
    await assertRefreshIssuerBinding(
      definition,
      persistence,
      tokens as StoredOAuthTokens,
      clientInformation,
      serverInfo.authorizationServerUrl
    );
    const resource = resourceForRefresh(definition.command.url, serverInfo.resourceMetadata);
    const refreshed = await refreshAuthorization(serverInfo.authorizationServerUrl, {
      metadata: serverInfo.authorizationServerMetadata,
      clientInformation,
      refreshToken: decision.refreshToken,
      fetchFn: boundedRefreshFetch,
      ...(resource ? { resource } : {}),
    });
    await persistence.saveTokens({ ...refreshed, issuer: serverInfo.authorizationServerUrl });
    logger?.debug?.(`Refreshed cached OAuth access token for '${definition.name}' (non-interactive).`);
    return refreshed.access_token;
  } catch (error) {
    logger?.debug?.(
      `Failed to refresh cached OAuth token for '${definition.name}' non-interactively: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    if (error instanceof OAuthIssuerMismatchError) {
      throw error;
    }
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

// Every request issued while the refresh lock is held carries a deadline.
export function boundedRefreshFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS) });
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
    return await withRefreshLock(
      definition,
      async () => await refreshBearerTokenUnderLock(definition, persistence, tokens, skewSeconds, logger)
    );
  } catch (error) {
    if (!isFileLockTimeoutError(error)) {
      throw error;
    }
    const persisted = await accessTokenAfterLockTimeout(definition, persistence, 'bearer', logger);
    if (persisted) {
      return persisted;
    }
    throw new Error(
      `Failed to refresh cached bearer token for '${definition.name}': timed out waiting for the refresh lock.`,
      { cause: error }
    );
  }
}

async function refreshBearerTokenUnderLock(
  definition: ServerDefinition,
  persistence: OAuthPersistence,
  original: OAuthTokens,
  skewSeconds: number,
  logger?: Logger
): Promise<string> {
  const decision = decideUnderRefreshLock(original, await persistence.readTokens(), skewSeconds);
  if (decision.kind === 'gone') {
    throw new Error(`Cached bearer token for '${definition.name}' was cleared before its refresh could run.`);
  }
  if (decision.kind === 'unrefreshable') {
    throw new Error(`Cached bearer token for '${definition.name}' is expired, but no refresh_token is available.`);
  }
  if (decision.kind === 'use') {
    if (decision.adopted) {
      logger?.debug?.(`Adopted the bearer access token another refresh persisted first for '${definition.name}'.`);
    }
    return decision.accessToken;
  }

  const tokens = decision.tokens;
  try {
    const refreshed = await refreshBearerToken(definition, decision.refreshToken);
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

  const response = await boundedRefreshFetch(refresh.tokenEndpoint, {
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
