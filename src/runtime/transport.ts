import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ServerDefinition } from '../config.js';
import { resolveEnvValue, withEnvOverrides } from '../env.js';
import type { Logger } from '../logging.js';
import { createManualOAuthSession } from '../oauth-manual.js';
import { createOAuthSession, type OAuthSession } from '../oauth.js';
import { readCachedAccessToken } from '../oauth-persistence.js';
import { materializeHeaders } from '../runtime-header-utils.js';
import { isUnauthorizedError, maybeEnableOAuth } from '../runtime-oauth-support.js';
import { closeTransportAndWait } from '../runtime-process-utils.js';
import { connectWithAuth, MANUAL_OAUTH_TIMEOUT_MS, OAuthTimeoutError } from './oauth.js';
import { resolveCommandArgument, resolveCommandArguments } from './utils.js';

const STDIO_TRACE_ENABLED = process.env.MCPORTER_STDIO_TRACE === '1';

function attachStdioTraceLogging(_transport: StdioClientTransport, _label?: string): void {
  // STDIO instrumentation is handled via sdk-patches side effects. This helper remains
  // so runtime callers can opt-in without sprinkling conditional checks everywhere.
}

export interface ClientContext {
  readonly client: Client;
  readonly transport: Transport & { close(): Promise<void> };
  readonly definition: ServerDefinition;
  readonly oauthSession?: OAuthSession;
}

export interface CreateClientContextOptions {
  readonly maxOAuthAttempts?: number;
  readonly oauthTimeoutMs?: number;
  readonly manual?: boolean;
  readonly onDefinitionPromoted?: (definition: ServerDefinition) => void;
  readonly allowCachedAuth?: boolean;
}

export async function createClientContext(
  definition: ServerDefinition,
  logger: Logger,
  clientInfo: { name: string; version: string },
  options: CreateClientContextOptions = {}
): Promise<ClientContext> {
  const client = new Client(clientInfo);
  let activeDefinition = definition;

  if (options.allowCachedAuth && activeDefinition.auth === 'oauth' && activeDefinition.command.kind === 'http') {
    try {
      const cached = await readCachedAccessToken(activeDefinition, logger);
      if (cached) {
        const existingHeaders = activeDefinition.command.headers ?? {};
        if (!('Authorization' in existingHeaders)) {
          activeDefinition = {
            ...activeDefinition,
            command: {
              ...activeDefinition.command,
              headers: {
                ...existingHeaders,
                Authorization: `Bearer ${cached}`,
              },
            },
          };
          logger.debug?.(`Using cached OAuth access token for '${activeDefinition.name}' (non-interactive).`);
        }
      }
    } catch (error) {
      logger.debug?.(
        `Failed to read cached OAuth token for '${activeDefinition.name}': ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return withEnvOverrides(activeDefinition.env, async () => {
    if (activeDefinition.command.kind === 'stdio') {
      const resolvedEnvOverrides =
        activeDefinition.env && Object.keys(activeDefinition.env).length > 0
          ? Object.fromEntries(
              Object.entries(activeDefinition.env)
                .map(([key, raw]) => [key, resolveEnvValue(raw)])
                .filter(([, value]) => value !== '')
            )
          : undefined;
      const mergedEnv =
        resolvedEnvOverrides && Object.keys(resolvedEnvOverrides).length > 0
          ? { ...process.env, ...resolvedEnvOverrides }
          : { ...process.env };
      const transport = new StdioClientTransport({
        command: resolveCommandArgument(activeDefinition.command.command),
        args: resolveCommandArguments(activeDefinition.command.args),
        cwd: activeDefinition.command.cwd,
        env: mergedEnv,
      });
      if (STDIO_TRACE_ENABLED) {
        attachStdioTraceLogging(transport, activeDefinition.name ?? activeDefinition.command.command);
      }
      try {
        await client.connect(transport);
      } catch (error) {
        await closeTransportAndWait(logger, transport).catch(() => {});
        throw error;
      }
      return { client, transport, definition: activeDefinition, oauthSession: undefined };
    }

    while (true) {
      const command = activeDefinition.command;
      if (command.kind !== 'http') {
        throw new Error(`Server '${activeDefinition.name}' is not configured for HTTP transport.`);
      }
      let oauthSession: OAuthSession | undefined;
      const shouldEstablishOAuth = activeDefinition.auth === 'oauth' && options.maxOAuthAttempts !== 0;
      const isManual = options.manual || activeDefinition.manual;
      if (shouldEstablishOAuth) {
        oauthSession = isManual
          ? await createManualOAuthSession(activeDefinition, logger)
          : await createOAuthSession(activeDefinition, logger);
      }

      const resolvedHeaders = materializeHeaders(command.headers, activeDefinition.name);
      const requestInit: RequestInit | undefined = resolvedHeaders
        ? { headers: resolvedHeaders as HeadersInit }
        : undefined;
      const baseOptions = {
        requestInit,
        authProvider: oauthSession?.provider,
      };

      const attemptConnect = async () => {
        const streamableTransport = new StreamableHTTPClientTransport(command.url, baseOptions);
        try {
          await connectWithAuth(client, streamableTransport, oauthSession, logger, {
            serverName: activeDefinition.name,
            maxAttempts: options.maxOAuthAttempts,
            oauthTimeoutMs: isManual
              ? (options.oauthTimeoutMs ?? MANUAL_OAUTH_TIMEOUT_MS)
              : options.oauthTimeoutMs,
          });
          return {
            client,
            transport: streamableTransport,
            definition: activeDefinition,
            oauthSession,
          } as ClientContext;
        } catch (error) {
          await closeTransportAndWait(logger, streamableTransport).catch(() => {});
          // StreamableHTTPClientTransport.start() cannot be called twice on the same instance,
          // so connectWithAuth's post-finishAuth retry always fails with a non-auth error.
          // If tokens are now present (auth just completed), reconnect with a fresh transport.
          if (!isUnauthorizedError(error) && !(error instanceof OAuthTimeoutError) && oauthSession) {
            const freshTokens = await Promise.resolve(oauthSession.provider.tokens()).catch(() => undefined);
            if (freshTokens?.access_token) {
              const freshTransport = new StreamableHTTPClientTransport(command.url, baseOptions);
              try {
                await client.connect(freshTransport);
                return { client, transport: freshTransport, definition: activeDefinition, oauthSession } as ClientContext;
              } catch (freshError) {
                await closeTransportAndWait(logger, freshTransport).catch(() => {});
                throw freshError;
              }
            }
          }
          throw error;
        }
      };

      try {
        return await attemptConnect();
      } catch (primaryError) {
        if (isUnauthorizedError(primaryError)) {
          await oauthSession?.close().catch(() => {});
          oauthSession = undefined;
          if (options.maxOAuthAttempts !== 0) {
            const promoted = maybeEnableOAuth(activeDefinition, logger);
            if (promoted) {
              activeDefinition = promoted;
              options.onDefinitionPromoted?.(promoted);
              continue;
            }
          }
        }
        if (primaryError instanceof OAuthTimeoutError) {
          await oauthSession?.close().catch(() => {});
          throw primaryError;
        }
        // OAuth token exchange errors (e.g. InvalidGrantError) mean the authorization
        // server rejected the grant — not a transport-level failure. SSE fallback
        // would reuse the same (already-resolved) auth session and replay the same
        // bad code, so propagate immediately instead.
        if (primaryError instanceof OAuthError) {
          await oauthSession?.close().catch(() => {});
          throw primaryError;
        }
        if (primaryError instanceof Error) {
          logger.info(`Falling back to SSE transport for '${activeDefinition.name}': ${primaryError.message}`);
        }
        const sseTransport = new SSEClientTransport(command.url, {
          ...baseOptions,
        });
        try {
          await connectWithAuth(client, sseTransport, oauthSession, logger, {
            serverName: activeDefinition.name,
            maxAttempts: options.maxOAuthAttempts,
            oauthTimeoutMs: isManual
              ? (options.oauthTimeoutMs ?? MANUAL_OAUTH_TIMEOUT_MS)
              : options.oauthTimeoutMs,
          });
          return { client, transport: sseTransport, definition: activeDefinition, oauthSession };
        } catch (sseError) {
          await closeTransportAndWait(logger, sseTransport).catch(() => {});
          await oauthSession?.close().catch(() => {});
          if (sseError instanceof OAuthTimeoutError) {
            throw sseError;
          }
          if (isUnauthorizedError(sseError) && options.maxOAuthAttempts !== 0) {
            const promoted = maybeEnableOAuth(activeDefinition, logger);
            if (promoted) {
              activeDefinition = promoted;
              options.onDefinitionPromoted?.(promoted);
              continue;
            }
          }
          throw sseError;
        }
      }
    }
  });
}
