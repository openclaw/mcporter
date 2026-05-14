import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { applyChromeDevtoolsCompat } from '../chrome-devtools-compat.js';
import type { ServerDefinition } from '../config.js';
import { resolveEnvValue, withEnvOverrides } from '../env.js';
import { analyzeConnectionError } from '../error-classifier.js';
import type { Logger } from '../logging.js';
import { createOAuthSession, type OAuthSession, type OAuthSessionOptions } from '../oauth.js';
import { readCachedAccessToken } from '../oauth-persistence.js';
import { materializeHeaders } from '../runtime-header-utils.js';
import { isUnauthorizedError, maybeEnableOAuth } from '../runtime-oauth-support.js';
import { closeTransportAndWait } from '../runtime-process-utils.js';
import { nodeHttp1Fetch } from './node-http-fetch.js';
import {
  connectWithAuth,
  isOAuthFlowError,
  isPostAuthConnectError,
  type OAuthCapableTransport,
  OAuthTimeoutError,
} from './oauth.js';
import { resolveCommandArgument, resolveCommandArguments } from './utils.js';

const STDIO_TRACE_ENABLED = process.env.MCPORTER_STDIO_TRACE === '1';

function extractTransportStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  for (const candidate of [record.code, record.status, record.statusCode]) {
    if (typeof candidate === 'number') {
      return candidate;
    }
    if (typeof candidate === 'string') {
      const parsed = Number.parseInt(candidate, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function isLegacySseTransportMismatch(error: unknown): boolean {
  if (error instanceof StreamableHTTPError) {
    return error.code === 404 || error.code === 405;
  }
  const directStatusCode = extractTransportStatusCode(error);
  if (directStatusCode === 404 || directStatusCode === 405) {
    return true;
  }
  const issue = analyzeConnectionError(error);
  return issue.kind === 'http' && (issue.statusCode === 404 || issue.statusCode === 405);
}

interface ResolvedHttpTransportOptions {
  requestInit?: RequestInit;
  authProvider?: OAuthSession['provider'];
  fetch?: typeof nodeHttp1Fetch;
}

type HttpClientContextAttempt =
  | { context: ClientContext; nextDefinition?: undefined }
  | { context?: undefined; nextDefinition: ServerDefinition };

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
  readonly oauthSessionOptions?: OAuthSessionOptions;
}

function removeAuthorizationHeader(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'authorization') {
      delete headers[key];
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function createHttpTransportOptions(
  definition: ServerDefinition,
  oauthSession: OAuthSession | undefined,
  shouldEstablishOAuth: boolean
): ResolvedHttpTransportOptions {
  const command = definition.command;
  if (command.kind !== 'http') {
    throw new Error(`Server '${definition.name}' is not configured for HTTP transport.`);
  }
  const resolvedHeaders = materializeHeaders(command.headers, definition.name);
  const effectiveHeaders = shouldEstablishOAuth ? removeAuthorizationHeader(resolvedHeaders) : resolvedHeaders;
  return {
    requestInit: effectiveHeaders ? { headers: effectiveHeaders as HeadersInit } : undefined,
    authProvider: oauthSession?.provider,
    fetch: resolveHttpFetchOverride(definition),
  };
}

function resolveHttpFetchOverride(definition: ServerDefinition): typeof nodeHttp1Fetch | undefined {
  if (definition.command.kind !== 'http') {
    return undefined;
  }
  if (definition.httpFetch === 'default') {
    return undefined;
  }
  if (definition.httpFetch === 'node-http1') {
    return nodeHttp1Fetch;
  }
  if (definition.command.url.hostname.toLowerCase() === 'api.sunsama.com') {
    return nodeHttp1Fetch;
  }
  return undefined;
}

async function closeOAuthSession(oauthSession?: OAuthSession): Promise<void> {
  await oauthSession?.close().catch(() => {});
}

function shouldAbortSseFallback(error: unknown): boolean {
  if (isPostAuthConnectError(error)) {
    return !isLegacySseTransportMismatch(error);
  }
  return isOAuthFlowError(error) || error instanceof OAuthTimeoutError;
}

function maybePromoteHttpDefinition(
  definition: ServerDefinition,
  logger: Logger,
  options: CreateClientContextOptions
): ServerDefinition | undefined {
  if (options.maxOAuthAttempts === 0) {
    return undefined;
  }
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

async function applyCachedOAuthHeaderIfAvailable(
  definition: ServerDefinition,
  logger: Logger,
  allowCachedAuth: boolean | undefined
): Promise<ServerDefinition> {
  if (!allowCachedAuth || definition.command.kind !== 'http') {
    return definition;
  }
  try {
    const cached = await readCachedAccessToken(definition, logger);
    if (!cached) {
      return definition;
    }
    const existingHeaders = definition.command.headers ?? {};
    if ('Authorization' in existingHeaders) {
      return definition;
    }
    logger.debug?.(`Using cached OAuth access token for '${definition.name}' (non-interactive).`);
    return {
      ...definition,
      command: {
        ...definition.command,
        headers: {
          ...existingHeaders,
          Authorization: `Bearer ${cached}`,
        },
      },
    };
  } catch (error) {
    logger.debug?.(
      `Failed to read cached OAuth token for '${definition.name}': ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return definition;
  }
}

async function createStdioClientContext(
  client: Client,
  definition: ServerDefinition & { command: Extract<ServerDefinition['command'], { kind: 'stdio' }> },
  logger: Logger
): Promise<ClientContext> {
  const resolvedEnvOverrides =
    definition.env && Object.keys(definition.env).length > 0
      ? Object.fromEntries(
          Object.entries(definition.env)
            .map(([key, raw]) => [key, resolveEnvValue(raw)])
            .filter(([, value]) => value !== '')
        )
      : undefined;
  const mergedEnv =
    resolvedEnvOverrides && Object.keys(resolvedEnvOverrides).length > 0
      ? { ...process.env, ...resolvedEnvOverrides }
      : { ...process.env };
  const command = resolveCommandArgument(definition.command.command);
  const commandArgs = resolveCommandArguments(definition.command.args);
  const compat = applyChromeDevtoolsCompat(mergedEnv as Record<string, string>, command, commandArgs);
  if (compat.applied) {
    logger.info(`Injecting chrome-devtools-mcp --autoConnect compatibility patch from ${compat.patchPath}.`);
  }
  const transport = new StdioClientTransport({
    command,
    args: commandArgs,
    cwd: definition.command.cwd,
    env: compat.env,
  });
  if (STDIO_TRACE_ENABLED) {
    attachStdioTraceLogging(transport, definition.name ?? definition.command.command);
  }
  try {
    await client.connect(transport);
  } catch (error) {
    await closeTransportAndWait(logger, transport).catch(() => {});
    throw error;
  }
  return { client, transport, definition, oauthSession: undefined };
}

async function retryHttpTransportWithFallback(
  client: Client,
  definition: ServerDefinition,
  logger: Logger,
  options: CreateClientContextOptions
): Promise<ClientContext> {
  let activeDefinition = definition;
  while (true) {
    const attempt = await attemptHttpClientContext(client, activeDefinition, logger, options);
    if (!attempt.nextDefinition) {
      return attempt.context;
    }
    activeDefinition = attempt.nextDefinition;
    options.onDefinitionPromoted?.(activeDefinition);
  }
}

async function attemptHttpClientContext(
  client: Client,
  activeDefinition: ServerDefinition,
  logger: Logger,
  options: CreateClientContextOptions
): Promise<HttpClientContextAttempt> {
  const command = activeDefinition.command;
  if (command.kind !== 'http') {
    throw new Error(`Server '${activeDefinition.name}' is not configured for HTTP transport.`);
  }
  let oauthSession: OAuthSession | undefined;
  const shouldEstablishOAuth = activeDefinition.auth === 'oauth' && options.maxOAuthAttempts !== 0;
  if (shouldEstablishOAuth) {
    oauthSession = await createOAuthSession(activeDefinition, logger, options.oauthSessionOptions);
  }
  const transportOptions = createHttpTransportOptions(activeDefinition, oauthSession, shouldEstablishOAuth);

  try {
    const context = await connectPrimaryHttpTransport(
      client,
      activeDefinition,
      command,
      transportOptions,
      oauthSession,
      logger,
      options
    );
    return { context };
  } catch (primaryError) {
    if (shouldAbortSseFallback(primaryError)) {
      await closeOAuthSession(oauthSession);
      throw primaryError;
    }
    if (isUnauthorizedError(primaryError)) {
      await closeOAuthSession(oauthSession);
      const promoted = maybePromoteHttpDefinition(activeDefinition, logger, options);
      if (promoted) {
        return { nextDefinition: promoted };
      }
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
        options
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
  options: CreateClientContextOptions
): Promise<ClientContext> {
  const createStreamableTransport = () => new StreamableHTTPClientTransport(command.url, transportOptions);
  const transport = await connectHttpTransport(client, createStreamableTransport(), oauthSession, logger, {
    serverName: definition.name,
    serverUrl: command.url,
    maxAttempts: options.maxOAuthAttempts,
    oauthTimeoutMs: options.oauthTimeoutMs,
    recreateTransport: async () => createStreamableTransport(),
  });
  return {
    client,
    transport,
    definition,
    oauthSession,
  };
}

async function connectSseFallbackTransport(
  client: Client,
  definition: ServerDefinition,
  command: Extract<ServerDefinition['command'], { kind: 'http' }>,
  transportOptions: ResolvedHttpTransportOptions,
  oauthSession: OAuthSession | undefined,
  logger: Logger,
  options: CreateClientContextOptions
): Promise<ClientContext> {
  try {
    const transport = await connectHttpTransport(
      client,
      new SSEClientTransport(command.url, transportOptions),
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
    if (sseError instanceof OAuthTimeoutError) {
      throw sseError;
    }
    if (isUnauthorizedError(sseError)) {
      const promoted = maybePromoteHttpDefinition(definition, logger, options);
      if (promoted) {
        options.onDefinitionPromoted?.(promoted);
        return retryHttpTransportWithFallback(client, promoted, logger, options);
      }
    }
    throw sseError;
  }
}

export async function createClientContext(
  definition: ServerDefinition,
  logger: Logger,
  clientInfo: { name: string; version: string },
  options: CreateClientContextOptions = {}
): Promise<ClientContext> {
  const client = new Client(clientInfo);
  const activeDefinition = await applyCachedOAuthHeaderIfAvailable(definition, logger, options.allowCachedAuth);

  return withEnvOverrides(activeDefinition.env, async () => {
    if (activeDefinition.command.kind === 'stdio') {
      return createStdioClientContext(
        client,
        activeDefinition as ServerDefinition & { command: Extract<ServerDefinition['command'], { kind: 'stdio' }> },
        logger
      );
    }
    return retryHttpTransportWithFallback(client, activeDefinition, logger, options);
  });
}
