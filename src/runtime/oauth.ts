import { auth as sdkAuth } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Logger } from '../logging.js';
import type { OAuthSession } from '../oauth.js';
import { isUnauthorizedError } from '../runtime-oauth-support.js';

export const DEFAULT_OAUTH_CODE_TIMEOUT_MS = 300_000;
const OAUTH_FLOW_ERROR = Symbol('oauth-flow-error');
const POST_AUTH_CONNECT_ERROR = Symbol('post-auth-connect-error');
const MAX_OAUTH_ERROR_DETAIL_LENGTH = 1_200;

export interface OAuthCapableTransport extends Transport {
  close(): Promise<void>;
  finishAuth?: (authorizationCode: string) => Promise<void>;
}

export interface ConnectWithAuthOptions {
  serverName?: string;
  maxAttempts?: number;
  oauthTimeoutMs?: number;
  recreateTransport?: (transport: OAuthCapableTransport) => Promise<OAuthCapableTransport>;
  serverUrl?: string | URL;
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
  };

  while (true) {
    try {
      await attemptTransportConnect(client, state);
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
  if (!options.serverUrl) {
    return;
  }
  try {
    const result = await sdkAuth(session.provider, {
      serverUrl: options.serverUrl,
      fetchFn: options.fetchFn,
    });
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
    const code = await waitForAuthorizationCodeWithTimeout(
      session,
      logger,
      options.serverName,
      options.oauthTimeoutMs ?? DEFAULT_OAUTH_CODE_TIMEOUT_MS
    );
    await transport.finishAuth(code);
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
