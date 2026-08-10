import {
  auth as sdkAuth,
  type Client,
  IssuerMismatchError,
  type OAuthTokens,
  type Transport,
} from '@modelcontextprotocol/client';
import type { Logger } from '../logging.js';
import { type OAuthAuthorizationResponse, OAuthRedirectUriMismatchError, type OAuthSession } from '../oauth.js';
import { isUnauthorizedError } from '../runtime-oauth-support.js';

export const DEFAULT_OAUTH_CODE_TIMEOUT_MS = 300_000;
const OAUTH_FLOW_ERROR = Symbol('oauth-flow-error');
const POST_AUTH_CONNECT_ERROR = Symbol('post-auth-connect-error');
const MAX_OAUTH_ERROR_DETAIL_LENGTH = 1_200;
const PROACTIVE_TOKEN_SKEW_SECONDS = 60;

export interface OAuthCapableTransport extends Transport {
  close(): Promise<void>;
  finishAuth?: (authorizationCode: string, iss?: string) => Promise<void>;
}

export interface ConnectWithAuthOptions {
  serverName?: string;
  maxAttempts?: number;
  oauthTimeoutMs?: number;
  recreateTransport?: (transport: OAuthCapableTransport) => Promise<OAuthCapableTransport>;
  serverUrl?: string | URL;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}

interface OAuthConnectState {
  activeTransport: OAuthCapableTransport;
  attempt: number;
  hasCompletedAuthFlow: boolean;
  repairedRedirectMismatch: boolean;
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
    const causeMessage = formatOAuthErrorDetail(cause);
    const detail = causeMessage ? ` Last error: ${causeMessage}` : '';
    super(
      `OAuth authorization for '${serverName}' did not produce an authorization URL; aborting instead of waiting for a browser callback.${detail}`
    );
    this.name = 'OAuthAuthorizationNotStartedError';
    this.serverName = serverName;
  }
}

function formatOAuthErrorDetail(cause: unknown): string {
  if (!(cause instanceof Error) || !cause.message) {
    return '';
  }
  return truncateOAuthErrorDetail(cause.message);
}

function truncateOAuthErrorDetail(message: string): string {
  if (message.length <= MAX_OAUTH_ERROR_DETAIL_LENGTH) {
    return message;
  }
  const truncated = message.length - MAX_OAUTH_ERROR_DETAIL_LENGTH;
  return `${message.slice(0, MAX_OAUTH_ERROR_DETAIL_LENGTH)}... [truncated ${truncated} chars]`;
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

function hasUsableCachedAccessToken(tokens: OAuthTokens | undefined): boolean {
  if (!tokens || typeof tokens.access_token !== 'string' || tokens.access_token.trim().length === 0) {
    return false;
  }
  const stored = tokens as OAuthTokens & { expires_at?: number; expiresAt?: number };
  const expiresAt = typeof stored.expires_at === 'number' ? stored.expires_at : stored.expiresAt;
  return typeof expiresAt === 'number' && expiresAt > Math.floor(Date.now() / 1000) + PROACTIVE_TOKEN_SKEW_SECONDS;
}

export async function connectWithAuth(
  client: Client,
  transport: OAuthCapableTransport,
  session: OAuthSession | undefined,
  logger: Logger,
  options: ConnectWithAuthOptions = {}
): Promise<OAuthCapableTransport> {
  const { serverName, maxAttempts = 3, oauthTimeoutMs = DEFAULT_OAUTH_CODE_TIMEOUT_MS, recreateTransport } = options;
  const state: OAuthConnectState = {
    activeTransport: transport,
    attempt: 0,
    hasCompletedAuthFlow: false,
    repairedRedirectMismatch: false,
  };

  while (true) {
    try {
      await attemptTransportConnect(client, state, options.signal);
      if (session && !state.hasCompletedAuthFlow && options.serverUrl) {
        await completeProactiveAuthorization(state.activeTransport, session, logger, {
          serverName,
          oauthTimeoutMs,
          serverUrl: options.serverUrl,
          fetchFn: options.fetchFn,
        });
        state.hasCompletedAuthFlow = true;
      }
      if (session && state.hasCompletedAuthFlow) {
        await session.close().catch(() => {});
      }
      return state.activeTransport;
    } catch (error) {
      if (error instanceof OAuthRedirectUriMismatchError) {
        if (state.repairedRedirectMismatch || !recreateTransport) {
          await closeReplacementTransport(transport, state.activeTransport);
          throw markOAuthFlowError(error);
        }
        state.repairedRedirectMismatch = true;
        state.activeTransport = await recreateOAuthTransport(state.activeTransport, recreateTransport);
        continue;
      }
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

async function attemptTransportConnect(
  client: Client,
  state: OAuthConnectState,
  signal?: AbortSignal
): Promise<OAuthCapableTransport> {
  if (signal) {
    await client.connect(state.activeTransport, { signal });
  } else {
    await client.connect(state.activeTransport);
  }
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

async function recreateOAuthTransport(
  activeTransport: OAuthCapableTransport,
  recreateTransport: (transport: OAuthCapableTransport) => Promise<OAuthCapableTransport>
): Promise<OAuthCapableTransport> {
  const replacement = await recreateTransport(activeTransport);
  await activeTransport.close().catch(() => {});
  return replacement;
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
  const response = await waitForAuthorizationResponseWithTimeout(
    session,
    logger,
    options.serverName,
    options.oauthTimeoutMs ?? DEFAULT_OAUTH_CODE_TIMEOUT_MS
  );
  if (typeof transport.finishAuth !== 'function') {
    logger.warn('Transport does not support finishAuth; cannot complete OAuth flow automatically.');
    throw connectError;
  }
  await finishAuthorization(transport, response, options.serverName);
  if (!options.recreateTransport) {
    return transport;
  }
  const nextTransport = await options.recreateTransport(transport);
  await transport.close().catch(() => {});
  return nextTransport;
}

async function completeProactiveAuthorization(
  transport: OAuthCapableTransport,
  session: OAuthSession,
  logger: Logger,
  options: Pick<ConnectWithAuthOptions, 'serverName' | 'oauthTimeoutMs' | 'serverUrl' | 'fetchFn'>
): Promise<void> {
  const serverUrl = options.serverUrl;
  if (!serverUrl) {
    return;
  }
  try {
    const cachedTokens = await session.provider.tokens?.();
    if (hasUsableCachedAccessToken(cachedTokens)) {
      return;
    }
    const runAuth = () =>
      sdkAuth(session.provider, {
        serverUrl,
        fetchFn: options.fetchFn,
      });
    let result;
    try {
      result = await runAuth();
    } catch (error) {
      if (!(error instanceof OAuthRedirectUriMismatchError)) {
        throw error;
      }
      result = await runAuth();
    }
    if (result !== 'REDIRECT') {
      await session.close().catch(() => {});
      return;
    }
    if (session.hasAuthorizationRedirectStarted?.() === false) {
      throw new OAuthAuthorizationNotStartedError(options.serverName ?? 'unknown');
    }
    logger.warn(
      `OAuth authorization required for '${options.serverName ?? 'unknown'}'. Waiting for browser approval...`
    );
    if (typeof transport.finishAuth !== 'function') {
      throw new Error('Transport does not support finishAuth; cannot complete OAuth flow automatically.');
    }
    const response = await waitForAuthorizationResponseWithTimeout(
      session,
      logger,
      options.serverName,
      options.oauthTimeoutMs ?? DEFAULT_OAUTH_CODE_TIMEOUT_MS
    );
    await finishAuthorization(transport, response, options.serverName);
    await session.close().catch(() => {});
  } catch (error) {
    throw markOAuthFlowError(error);
  }
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

export function waitForAuthorizationResponseWithTimeout(
  session: OAuthSession,
  logger: Logger,
  serverName?: string,
  timeoutMs = DEFAULT_OAUTH_CODE_TIMEOUT_MS
): Promise<OAuthAuthorizationResponse> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return readAuthorizationResponse(session);
  }
  const displayName = serverName ?? 'unknown';
  return new Promise<OAuthAuthorizationResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new OAuthTimeoutError(displayName, timeoutMs);
      logger.warn(error.message);
      reject(error);
    }, timeoutMs);
    readAuthorizationResponse(session).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function readAuthorizationResponse(session: OAuthSession): Promise<OAuthAuthorizationResponse> {
  if (session.waitForAuthorizationResponse) return session.waitForAuthorizationResponse();
  return { code: await session.waitForAuthorizationCode() };
}

async function finishAuthorization(
  transport: OAuthCapableTransport,
  response: OAuthAuthorizationResponse,
  serverName?: string
): Promise<void> {
  try {
    await transport.finishAuth?.(response.code, response.iss);
  } catch (error) {
    if (error instanceof IssuerMismatchError && error.kind === 'authorization_response') {
      throw new Error(
        `OAuth issuer validation failed for '${serverName ?? 'unknown'}': expected ${JSON.stringify(error.expected)}, got ${JSON.stringify(error.received)}; the authorization code was not redeemed.`,
        { cause: error }
      );
    }
    throw error;
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
