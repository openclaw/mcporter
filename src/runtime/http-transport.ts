import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ServerDefinition } from '../config.js';
import { analyzeConnectionError } from '../error-classifier.js';
import type { Logger } from '../logging.js';
import { createOAuthSession, type OAuthSession } from '../oauth.js';
import { materializeHeaders } from '../runtime-header-utils.js';
import { isUnauthorizedError, maybeEnableOAuth } from '../runtime-oauth-support.js';
import { closeTransportAndWait } from '../runtime-process-utils.js';
import { nodeHttp1Fetch, sseIsolatedFetch } from './node-http-fetch.js';
import {
  connectWithAuth,
  isOAuthFlowError,
  isPostAuthConnectError,
  type OAuthCapableTransport,
  OAuthTimeoutError,
} from './oauth.js';
import type { ClientContext, CreateClientContextOptions, WrapRecordTransport } from './transport-types.js';

interface ResolvedHttpTransportOptions {
  requestInit?: RequestInit;
  authProvider?: OAuthSession['provider'];
  fetch?: typeof nodeHttp1Fetch;
}

type HttpClientContextAttempt =
  | { context: ClientContext; nextDefinition?: undefined }
  | { context?: undefined; nextDefinition: ServerDefinition };

function extractTransportStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as Record<string, unknown>;
  for (const candidate of [record.code, record.status, record.statusCode]) {
    if (typeof candidate === 'number') return candidate;
    if (typeof candidate === 'string') {
      const parsed = Number.parseInt(candidate, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function isLegacySseTransportMismatch(error: unknown): boolean {
  if (error instanceof StreamableHTTPError) return error.code === 404 || error.code === 405;
  const directStatusCode = extractTransportStatusCode(error);
  if (directStatusCode === 404 || directStatusCode === 405) return true;
  const issue = analyzeConnectionError(error);
  return issue.kind === 'http' && (issue.statusCode === 404 || issue.statusCode === 405);
}

function removeAuthorizationHeader(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'authorization') delete headers[key];
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

const NODE_HTTP1_FETCH_HOSTS: ReadonlySet<string> = new Set(['api.sunsama.com']);

function resolveHttpFetchOverride(definition: ServerDefinition): typeof nodeHttp1Fetch | undefined {
  if (definition.command.kind !== 'http' || definition.httpFetch === 'default') return undefined;
  if (definition.httpFetch === 'node-http1') return nodeHttp1Fetch;
  if (NODE_HTTP1_FETCH_HOSTS.has(definition.command.url.hostname.toLowerCase())) return nodeHttp1Fetch;
  if ('bun' in process.versions) return undefined;
  return sseIsolatedFetch;
}

function createHttpTransportOptions(
  definition: ServerDefinition,
  oauthSession: OAuthSession | undefined,
  shouldEstablishOAuth: boolean
): ResolvedHttpTransportOptions {
  const command = definition.command;
  if (command.kind !== 'http') throw new Error(`Server '${definition.name}' is not configured for HTTP transport.`);
  const resolvedHeaders = materializeHeaders(command.headers, definition.name);
  const effectiveHeaders = shouldEstablishOAuth ? removeAuthorizationHeader(resolvedHeaders) : resolvedHeaders;
  return {
    requestInit: effectiveHeaders ? { headers: effectiveHeaders as HeadersInit } : undefined,
    authProvider: oauthSession?.provider,
    fetch: resolveHttpFetchOverride(definition),
  };
}

async function closeOAuthSession(oauthSession?: OAuthSession): Promise<void> {
  await oauthSession?.close().catch(() => {});
}

function shouldAbortSseFallback(error: unknown): boolean {
  if (isPostAuthConnectError(error)) return !isLegacySseTransportMismatch(error);
  return isOAuthFlowError(error) || error instanceof OAuthTimeoutError;
}

function maybePromoteHttpDefinition(
  definition: ServerDefinition,
  logger: Logger,
  options: CreateClientContextOptions
): ServerDefinition | undefined {
  if (options.maxOAuthAttempts === 0 || options.disableOAuth === true) return undefined;
  return maybeEnableOAuth(definition, logger);
}

async function connectHttpTransport<TTransport extends OAuthCapableTransport>(
  client: Client,
  transport: TTransport,
  oauthSession: OAuthSession | undefined,
  logger: Logger,
  connectOptions: Parameters<typeof connectWithAuth>[4]
): Promise<TTransport> {
  try {
    return (await connectWithAuth(client, transport, oauthSession, logger, connectOptions)) as TTransport;
  } catch (error) {
    await closeTransportAndWait(logger, transport).catch(() => {});
    throw error;
  }
}

export async function createHttpClientContext(
  client: Client,
  definition: ServerDefinition,
  logger: Logger,
  options: CreateClientContextOptions,
  wrapRecordTransport: WrapRecordTransport
): Promise<ClientContext> {
  let activeDefinition = definition;
  while (true) {
    const attempt = await attemptHttpClientContext(client, activeDefinition, logger, options, wrapRecordTransport);
    if (!attempt.nextDefinition) return attempt.context;
    activeDefinition = attempt.nextDefinition;
    options.onDefinitionPromoted?.(activeDefinition);
  }
}

async function attemptHttpClientContext(
  client: Client,
  activeDefinition: ServerDefinition,
  logger: Logger,
  options: CreateClientContextOptions,
  wrapRecordTransport: WrapRecordTransport
): Promise<HttpClientContextAttempt> {
  const command = activeDefinition.command;
  if (command.kind !== 'http')
    throw new Error(`Server '${activeDefinition.name}' is not configured for HTTP transport.`);
  let oauthSession: OAuthSession | undefined;
  const shouldEstablishOAuth =
    activeDefinition.auth === 'oauth' && options.maxOAuthAttempts !== 0 && options.disableOAuth !== true;
  if (shouldEstablishOAuth)
    oauthSession = await createOAuthSession(activeDefinition, logger, options.oauthSessionOptions);
  const transportOptions = createHttpTransportOptions(activeDefinition, oauthSession, shouldEstablishOAuth);
  try {
    return {
      context: await connectPrimaryHttpTransport(
        client,
        activeDefinition,
        command,
        transportOptions,
        oauthSession,
        logger,
        options,
        wrapRecordTransport
      ),
    };
  } catch (primaryError) {
    if (shouldAbortSseFallback(primaryError)) {
      await closeOAuthSession(oauthSession);
      throw primaryError;
    }
    if (isUnauthorizedError(primaryError)) {
      await closeOAuthSession(oauthSession);
      const promoted = maybePromoteHttpDefinition(activeDefinition, logger, options);
      if (promoted) return { nextDefinition: promoted };
      if (activeDefinition.auth) throw primaryError;
      oauthSession = undefined;
    }
    if (primaryError instanceof Error) {
      logger.info(`Falling back to SSE transport for '${activeDefinition.name}': ${primaryError.message}`);
    }
    return {
      context: await connectSseFallbackTransport(
        client,
        activeDefinition,
        command,
        transportOptions,
        oauthSession,
        logger,
        options,
        wrapRecordTransport
      ),
    };
  }
}

async function connectPrimaryHttpTransport(
  client: Client,
  definition: ServerDefinition,
  command: Extract<ServerDefinition['command'], { kind: 'http' }>,
  transportOptions: ResolvedHttpTransportOptions,
  oauthSession: OAuthSession | undefined,
  logger: Logger,
  options: CreateClientContextOptions,
  wrapRecordTransport: WrapRecordTransport
): Promise<ClientContext> {
  const createStreamableTransport = () =>
    wrapRecordTransport(new StreamableHTTPClientTransport(command.url, transportOptions), definition, options);
  const transport = await connectHttpTransport(client, createStreamableTransport(), oauthSession, logger, {
    serverName: definition.name,
    serverUrl: command.url,
    maxAttempts: options.maxOAuthAttempts,
    oauthTimeoutMs: options.oauthTimeoutMs,
    recreateTransport: async () => createStreamableTransport(),
  });
  return { client, transport, definition, oauthSession };
}

async function connectSseFallbackTransport(
  client: Client,
  definition: ServerDefinition,
  command: Extract<ServerDefinition['command'], { kind: 'http' }>,
  transportOptions: ResolvedHttpTransportOptions,
  oauthSession: OAuthSession | undefined,
  logger: Logger,
  options: CreateClientContextOptions,
  wrapRecordTransport: WrapRecordTransport
): Promise<ClientContext> {
  try {
    const transport = await connectHttpTransport(
      client,
      wrapRecordTransport(new SSEClientTransport(command.url, transportOptions), definition, options),
      oauthSession,
      logger,
      {
        serverName: definition.name,
        serverUrl: command.url,
        maxAttempts: options.maxOAuthAttempts,
        oauthTimeoutMs: options.oauthTimeoutMs,
      }
    );
    return { client, transport, definition, oauthSession };
  } catch (sseError) {
    await closeOAuthSession(oauthSession);
    if (sseError instanceof OAuthTimeoutError) throw sseError;
    if (isUnauthorizedError(sseError)) {
      const promoted = maybePromoteHttpDefinition(definition, logger, options);
      if (promoted) {
        options.onDefinitionPromoted?.(promoted);
        return createHttpClientContext(client, promoted, logger, options, wrapRecordTransport);
      }
      if (definition.auth) throw sseError;
    }
    throw sseError;
  }
}
