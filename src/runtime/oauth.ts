import { auth as sdkAuth } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Logger } from '../logging.js';
import type { OAuthSession } from '../oauth.js';
import { isUnauthorizedError } from '../runtime-oauth-support.js';

export const DEFAULT_OAUTH_CODE_TIMEOUT_MS = 60_000;
const OAUTH_FLOW_ERROR = Symbol('oauth-flow-error');
const POST_AUTH_CONNECT_ERROR = Symbol('post-auth-connect-error');

export interface OAuthCapableTransport extends Transport {
  close(): Promise<void>;
  finishAuth?: (authorizationCode: string) => Promise<void>;
}

export interface ConnectWithAuthOptions {
  serverName?: string;
  maxAttempts?: number;
  oauthTimeoutMs?: number;
  recreateTransport?: (transport: OAuthCapableTransport) => Promise<OAuthCapableTransport>;
  /** Server URL used for proactive OAuth discovery when no 401 challenge is received. */
  serverUrl?: string | URL;
  /** Optional fetch function override for OAuth metadata discovery. */
  fetchFn?: typeof fetch;
}

interface OAuthConnectState {
  activeTransport: OAuthCapableTransport;
  attempt: number;
  hasCompletedAuthFlow: boolean;
}

export class OAuthTimeoutError extends Error {
  public readonly timeoutMs: number;
  public readonly serverName: string;

  constructor(serverName: string, timeoutMs: number) {
    const seconds = Math.round(timeoutMs / 1000);
    super(`OAuth authorization for '${serverName}' timed out after ${seconds}s; aborting.`);
    this.name = 'OAuthTimeoutError';
    this.timeoutMs = timeoutMs;
    this.serverName = serverName;
  }
}

export class OAuthAuthorizationNotStartedError extends Error {
  public readonly serverName: string;

  constructor(serverName: string, cause?: unknown) {
    const detail = cause instanceof Error && cause.message ? ` Last error: ${cause.message}` : '';
    super(
      `OAuth authorization for '${serverName}' did not produce an authorization URL; aborting instead of waiting for a browser callback.${detail}`
    );
    this.name = 'OAuthAuthorizationNotStartedError';
    this.serverName = serverName;
  }
}

export function markOAuthFlowError(error: unknown): unknown {
  return markError(error, OAUTH_FLOW_ERROR);
}

export function isOAuthFlowError(error: unknown): boolean {
  return hasErrorMarker(error, OAUTH_FLOW_ERROR);
}

export function markPostAuthConnectError(error: unknown): unknown {
  return markError(error, POST_AUTH_CONNECT_ERROR);
}

export function isPostAuthConnectError(error: unknown): boolean {
  return hasErrorMarker(error, POST_AUTH_CONNECT_ERROR);
}

function markError(error: unknown, marker: symbol): unknown {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) {
    return error;
  }
  Object.defineProperty(error, marker, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return error;
}

function hasErrorMarker(error: unknown, marker: symbol): boolean {
  return (
    !!error &&
    (typeof error === 'object' || typeof error === 'function') &&
    marker in error &&
    Boolean((error as Record<PropertyKey, unknown>)[marker])
  );
}

export async function connectWithAuth(
  client: Client,
  transport: OAuthCapableTransport,
  session: OAuthSession | undefined,
  logger: Logger,
  options: ConnectWithAuthOptions = {}
): Promise<OAuthCapableTransport> {
  const { serverName, maxAttempts = 3, oauthTimeoutMs = DEFAULT_OAUTH_CODE_TIMEOUT_MS, recreateTransport, serverUrl } = options;
  const state: OAuthConnectState = {
    activeTransport: transport,
    attempt: 0,
    hasCompletedAuthFlow: false,
  };

  while (true) {
    try {
      await attemptTransportConnect(client, state);
      // Connection succeeded without an auth challenge. If OAuth is configured but
      // the auth flow never ran (server allows unauthenticated listTools), proactively
      // obtain tokens so subsequent calls (callTool, etc.) are authenticated.
      if (session && !state.hasCompletedAuthFlow && serverUrl) {
        await completeProactiveOAuth(state.activeTransport, session, logger, serverName, oauthTimeoutMs, serverUrl, options.fetchFn);
        state.hasCompletedAuthFlow = true;
      }
      return state.activeTransport;
    } catch (error) {
      const unauthorized = isUnauthorizedError(error);
      if (!shouldRetryAuthorization(state, unauthorized, session)) {
        await closeReplacementTransport(transport, state.activeTransport);
        throw state.hasCompletedAuthFlow && !unauthorized ? markPostAuthConnectError(error) : error;
      }
      state.attempt += 1;
      if (state.attempt > maxAttempts) {
        await closeReplacementTransport(transport, state.activeTransport);
        throw state.hasCompletedAuthFlow ? markPostAuthConnectError(error) : error;
      }
      if (session.hasAuthorizationRedirectStarted?.() !== false) {
        logger.warn(`OAuth authorization required for '${serverName ?? 'unknown'}'. Waiting for browser approval...`);
      }
      try {
        state.activeTransport = await completeAuthorizationChallenge(state.activeTransport, session, logger, error, {
          serverName,
          oauthTimeoutMs,
          recreateTransport,
        });
        state.hasCompletedAuthFlow = true;
        logger.info('Authorization code accepted. Retrying connection...');
      } catch (authError) {
        const message =
          authError instanceof OAuthAuthorizationNotStartedError
            ? 'OAuth authorization could not start.'
            : 'OAuth authorization failed while waiting for callback.';
        logger.error(message, authError);
        await closeReplacementTransport(transport, state.activeTransport);
        throw markOAuthFlowError(authError);
      }
    }
  }
}

async function attemptTransportConnect(client: Client, state: OAuthConnectState): Promise<OAuthCapableTransport> {
  await client.connect(state.activeTransport);
  return state.activeTransport;
}

function shouldRetryAuthorization(
  _state: OAuthConnectState,
  unauthorized: boolean,
  session: OAuthSession | undefined
): session is OAuthSession {
  if (!session || !unauthorized) {
    return false;
  }
  return true;
}

async function closeReplacementTransport(
  originalTransport: OAuthCapableTransport,
  activeTransport: OAuthCapableTransport
): Promise<void> {
  if (activeTransport === originalTransport) {
    return;
  }
  await activeTransport.close().catch(() => {});
}

async function completeAuthorizationChallenge(
  transport: OAuthCapableTransport,
  session: OAuthSession,
  logger: Logger,
  connectError: unknown,
  options: Pick<ConnectWithAuthOptions, 'serverName' | 'oauthTimeoutMs' | 'recreateTransport'>
): Promise<OAuthCapableTransport> {
  if (session.hasAuthorizationRedirectStarted?.() === false) {
    throw new OAuthAuthorizationNotStartedError(options.serverName ?? 'unknown', connectError);
  }
  const code = await waitForAuthorizationCodeWithTimeout(
    session,
    logger,
    options.serverName,
    options.oauthTimeoutMs ?? DEFAULT_OAUTH_CODE_TIMEOUT_MS
  );
  if (typeof transport.finishAuth !== 'function') {
    logger.warn('Transport does not support finishAuth; cannot complete OAuth flow automatically.');
    throw connectError;
  }
  await transport.finishAuth(code);
  // The OAuth handshake is complete; close the callback server so the event loop
  // doesn't keep the process alive.
  await session.close().catch(() => {});
  if (!options.recreateTransport) {
    return transport;
  }
  const nextTransport = await options.recreateTransport(transport);
  await transport.close().catch(() => {});
  return nextTransport;
}

// Race the pending OAuth browser handshake so the runtime can't sit on an unresolved promise forever.
export function waitForAuthorizationCodeWithTimeout(
  session: OAuthSession,
  logger: Logger,
  serverName?: string,
  timeoutMs = DEFAULT_OAUTH_CODE_TIMEOUT_MS
): Promise<string> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return session.waitForAuthorizationCode();
  }
  const displayName = serverName ?? 'unknown';
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new OAuthTimeoutError(displayName, timeoutMs);
      logger.warn(error.message);
      reject(error);
    }, timeoutMs);
    session.waitForAuthorizationCode().then(
      (code) => {
        clearTimeout(timer);
        resolve(code);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Proactively completes OAuth for servers configured with `auth: 'oauth'`,
 * even when the initial connection succeeds without a 401 challenge.
 *
 * This handles the case where a server allows unauthenticated `initialize`
 * and `listTools` but requires auth for `callTool`. By proactively obtaining
 * tokens during connect, subsequent calls are already authenticated.
 */
async function completeProactiveOAuth(
  transport: OAuthCapableTransport,
  session: OAuthSession,
  logger: Logger,
  serverName: string | undefined,
  oauthTimeoutMs: number,
  serverUrl: string | URL,
  fetchFn?: typeof fetch
): Promise<void> {
  const displayName = serverName ?? 'unknown';

  try {
    if (typeof transport.finishAuth !== 'function') {
      logger.warn('Transport does not support finishAuth; cannot complete OAuth flow.');
      return;
    }

    logger.info(`Initiating OAuth flow for '${displayName}'...`);

    const result = await sdkAuth(session.provider, {
      serverUrl,
      fetchFn: fetchFn ?? globalThis.fetch,
    });

    if (result === 'REDIRECT') {
      logger.warn(`OAuth authorization required for '${displayName}'. Waiting for browser approval...`);
      const code = await waitForAuthorizationCodeWithTimeout(session, logger, serverName, oauthTimeoutMs);
      await transport.finishAuth(code);
      logger.info(`Authorization complete for '${displayName}'.`);
    } else if (result === 'AUTHORIZED') {
      logger.info(`Existing OAuth tokens found for '${displayName}'.`);
    }
  } catch (error) {
    if (error instanceof OAuthTimeoutError || error instanceof OAuthAuthorizationNotStartedError) {
      throw error;
    }
    // Proactive OAuth is best-effort: the connection is already established, so
    // server may not require auth. Log a warning and continue.
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Proactive OAuth flow for '${displayName}' did not complete: ${message}`);
  } finally {
    // Close the callback HTTP server so the event loop doesn't keep the process alive.
    await session.close().catch(() => {});
  }
}

export function parseOAuthTimeout(raw: string | undefined): number {
  if (!raw) {
    return DEFAULT_OAUTH_CODE_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_OAUTH_CODE_TIMEOUT_MS;
  }
  return parsed;
}

export function resolveOAuthTimeoutFromEnv(): number {
  return parseOAuthTimeout(process.env.MCPORTER_OAUTH_TIMEOUT_MS ?? process.env.MCPORTER_OAUTH_TIMEOUT);
}
