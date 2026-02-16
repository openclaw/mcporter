import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Logger } from '../logging.js';
import type { OAuthSession } from '../oauth.js';
import { isUnauthorizedError } from '../runtime-oauth-support.js';

export const DEFAULT_OAUTH_CODE_TIMEOUT_MS = 60_000;

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

export async function connectWithAuth(
  client: Client,
  transport: Transport & {
    close(): Promise<void>;
    finishAuth?: (authorizationCode: string) => Promise<void>;
  },
  session: OAuthSession | undefined,
  logger: Logger,
  options: { serverName?: string; maxAttempts?: number; oauthTimeoutMs?: number } = {}
): Promise<void> {
  const { serverName, maxAttempts = 3, oauthTimeoutMs = DEFAULT_OAUTH_CODE_TIMEOUT_MS } = options;
  let attempt = 0;
  let authCompleted = false;
  while (true) {
    try {
      await client.connect(transport);
      return;
    } catch (error) {
      if (!isUnauthorizedError(error) || !session) {
        throw error;
      }
      // If we already completed auth (finishAuth succeeded) but reconnection still
      // fails with 401, don't wait for another browser approval — it won't come.
      // Throw so the outer loop in createClientContext can retry with a fresh transport
      // that will pick up the cached tokens.
      if (authCompleted) {
        logger.info('Auth tokens saved but transport reconnection failed. Will retry with fresh transport...');
        throw error;
      }
      attempt += 1;
      if (attempt > maxAttempts) {
        throw error;
      }
      logger.warn(`OAuth authorization required for '${serverName ?? 'unknown'}'. Waiting for browser approval...`);
      try {
        const code = await waitForAuthorizationCodeWithTimeout(
          session,
          logger,
          serverName,
          oauthTimeoutMs ?? DEFAULT_OAUTH_CODE_TIMEOUT_MS
        );
        if (typeof transport.finishAuth === 'function') {
          await transport.finishAuth(code);
          authCompleted = true;
          logger.info('Authorization code accepted. Retrying connection...');
        } else {
          logger.warn('Transport does not support finishAuth; cannot complete OAuth flow automatically.');
          throw error;
        }
      } catch (authError) {
        logger.error('OAuth authorization failed while waiting for callback.', authError);
        throw authError;
      }
    }
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
