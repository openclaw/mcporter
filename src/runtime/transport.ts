import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ServerDefinition } from '../config.js';
import { resolveEnvValue, withEnvOverrides } from '../env.js';
import type { Logger } from '../logging.js';
import { createOAuthSession, type OAuthSession } from '../oauth.js';
import { readCachedAccessToken } from '../oauth-persistence.js';
import { tryRefreshTokens } from '../oauth-refresh.js';
import { materializeHeaders } from '../runtime-header-utils.js';
import { isUnauthorizedError, maybeEnableOAuth } from '../runtime-oauth-support.js';
import { closeTransportAndWait } from '../runtime-process-utils.js';
import { connectWithAuth, OAuthTimeoutError } from './oauth.js';
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

    // Track whether we've already attempted token refresh to avoid infinite loops
    let refreshAttempted = false;

    while (true) {
      const command = activeDefinition.command;
      if (command.kind !== 'http') {
        throw new Error(`Server '${activeDefinition.name}' is not configured for HTTP transport.`);
      }

      const resolvedHeaders = materializeHeaders(command.headers, activeDefinition.name);
      const requestInit: RequestInit | undefined = resolvedHeaders
        ? { headers: resolvedHeaders as HeadersInit }
        : undefined;

      // First, try to connect WITHOUT an OAuth session to detect expired tokens
      // This allows us to try token refresh before falling back to browser OAuth
      const shouldTryRefreshFirst = activeDefinition.auth === 'oauth' && !refreshAttempted;
      
      if (shouldTryRefreshFirst) {
        const baseOptionsNoAuth = { requestInit };
        const streamableTransport = new StreamableHTTPClientTransport(command.url, baseOptionsNoAuth);
        try {
          // Try connecting without OAuth session - if token is valid, this succeeds
          // If token is expired, we get a 401 that we can handle with refresh
          await connectWithAuth(client, streamableTransport, undefined, logger, {
            serverName: activeDefinition.name,
            maxAttempts: 0, // Don't retry with OAuth here
          });
          return {
            client,
            transport: streamableTransport,
            definition: activeDefinition,
            oauthSession: undefined,
          } as ClientContext;
        } catch (initialError) {
          await closeTransportAndWait(logger, streamableTransport).catch(() => {});
          
          if (isUnauthorizedError(initialError)) {
            // Token is expired or invalid - try to refresh before browser OAuth
            logger.info(`Token expired for '${activeDefinition.name}', attempting refresh...`);
            refreshAttempted = true;
            
            const refreshedToken = await tryRefreshTokens(activeDefinition, logger);
            if (refreshedToken) {
              // Update the definition with the new token and retry
              const existingHeaders = activeDefinition.command.kind === 'http' 
                ? activeDefinition.command.headers ?? {} 
                : {};
              activeDefinition = {
                ...activeDefinition,
                command: {
                  ...activeDefinition.command,
                  headers: {
                    ...existingHeaders,
                    Authorization: `Bearer ${refreshedToken}`,
                  },
                },
              } as ServerDefinition;
              options.onDefinitionPromoted?.(activeDefinition);
              logger.info(`Token refreshed successfully for '${activeDefinition.name}', retrying connection...`);
              continue; // Retry with the refreshed token
            }
            logger.info(`Token refresh failed for '${activeDefinition.name}', falling back to OAuth flow...`);
            // Fall through to full OAuth flow below
          } else {
            // Not an auth error - might need to try SSE transport
            // Fall through to the full connection logic
          }
        }
      }

      // Full connection attempt with OAuth session if needed
      let oauthSession: OAuthSession | undefined;
      const shouldEstablishOAuth = activeDefinition.auth === 'oauth' && options.maxOAuthAttempts !== 0;
      if (shouldEstablishOAuth) {
        oauthSession = await createOAuthSession(activeDefinition, logger);
      }

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
            oauthTimeoutMs: options.oauthTimeoutMs,
          });
          return {
            client,
            transport: streamableTransport,
            definition: activeDefinition,
            oauthSession,
          } as ClientContext;
        } catch (error) {
          await closeTransportAndWait(logger, streamableTransport).catch(() => {});
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
            oauthTimeoutMs: options.oauthTimeoutMs,
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
