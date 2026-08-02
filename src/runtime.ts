import {
  type CallToolRequest,
  type ListResourcesRequest,
  type ReadResourceRequest,
  SdkError,
  SdkErrorCode,
  specTypeSchemas,
  UrlElicitationRequiredError,
  type ProtocolEra,
} from '@modelcontextprotocol/client';
import { loadServerDefinitions, type ServerDefinition } from './config.js';
import { createPrefixedConsoleLogger, type Logger, type LogLevel, resolveLogLevelFromEnv } from './logging.js';
import type { OAuthSessionOptions } from './oauth.js';
import { RuntimeConnectionCache } from './runtime/connection-cache.js';
import { resolveOAuthTimeoutFromEnv } from './runtime/oauth.js';
import { resolveRecordingPath } from './runtime/record-transport.js';
import type { ClientContext } from './runtime/transport.js';
import { normalizeTimeout, raceWithTimeout } from './runtime/utils.js';
import { filterTools, isToolAllowed, validateToolFilters } from './tool-filters.js';
import { MCPORTER_VERSION } from './version.js';

export { MCPORTER_VERSION } from './version.js';

const PACKAGE_NAME = 'mcporter';
const OAUTH_CODE_TIMEOUT_MS = resolveOAuthTimeoutFromEnv();
const MAX_RESOURCE_LIST_PAGES = 100;
const MRTR_UNSUPPORTED_MESSAGE =
  'Tool requires interactive input (MRTR); mcporter does not support this yet — coming in a follow-up';

export interface RuntimeOptions {
  readonly configPath?: string;
  readonly servers?: ServerDefinition[];
  readonly rootDir?: string;
  readonly clientInfo?: {
    name: string;
    version: string;
  };
  readonly logger?: RuntimeLogger;
  readonly oauthTimeoutMs?: number;
}

export type RuntimeLogger = Logger;

export interface ConnectionInfo {
  readonly protocolVersion?: string;
  readonly era?: ProtocolEra;
}

export interface CallOptions {
  readonly args?: CallToolRequest['params']['arguments'];
  readonly timeoutMs?: number;
  /**
   * Suppress interactive OAuth for this call while still allowing cached
   * bearer tokens to be applied. Intended for headless callers.
   */
  readonly disableOAuth?: boolean;
}

export interface ListToolsOptions {
  readonly includeSchema?: boolean;
  readonly autoAuthorize?: boolean;
  readonly allowCachedAuth?: boolean;
  readonly oauthSessionOptions?: OAuthSessionOptions;
  /**
   * Suppress interactive OAuth for this listing while keeping the connection
   * cache available. Prefer this over `autoAuthorize: false` for long-running
   * headless callers that need cached-token-only behavior.
   */
  readonly disableOAuth?: boolean;
}

export type ListResourcesOptions = Partial<ListResourcesRequest['params']> & {
  readonly allowCachedAuth?: boolean;
  readonly oauthSessionOptions?: OAuthSessionOptions;
  readonly disableOAuth?: boolean;
};

export interface ReadResourceOptions {
  readonly allowCachedAuth?: boolean;
  readonly oauthSessionOptions?: OAuthSessionOptions;
  readonly disableOAuth?: boolean;
}

export interface ConnectOptions {
  readonly maxOAuthAttempts?: number;
  readonly skipCache?: boolean;
  readonly allowCachedAuth?: boolean;
  readonly oauthSessionOptions?: OAuthSessionOptions;
  /**
   * When `true`, never start an OAuth flow for this server — equivalent
   * to `maxOAuthAttempts: 0` for the purpose of avoiding interactive
   * authorization. Unlike `maxOAuthAttempts: 0`, callers passing
   * `disableOAuth: true` participate in connection caching: repeated
   * `connect()` / `callTool()` / `listTools()` calls reuse the same
   * `ClientContext`, and `close()` reaps it.
   *
   * Intended for long-running headless callers (daemons, scheduled jobs,
   * CI workers) that have no browser and must rely on cached tokens.
   *
   * Cache identity: clients established with `disableOAuth: true` are
   * stored in their own cache slot — sharing with a connection that
   * could refresh into an OAuth flow would violate the no-browser-launch
   * guarantee. Switching the flag between calls keeps both variants cached
   * until the caller closes the server or runtime.
   */
  readonly disableOAuth?: boolean;
}

export interface Runtime {
  listServers(): string[];
  getDefinitions(): ServerDefinition[];
  getDefinition(server: string): ServerDefinition;
  registerDefinition(definition: ServerDefinition, options?: { overwrite?: boolean }): void;
  getInstructions?(server: string): Promise<string | undefined>;
  getConnectionInfo?(server: string): Promise<ConnectionInfo | undefined>;
  listTools(server: string, options?: ListToolsOptions): Promise<ServerToolInfo[]>;
  callTool(server: string, toolName: string, options?: CallOptions): Promise<unknown>;
  listResources(server: string, options?: ListResourcesOptions): Promise<unknown>;
  readResource(server: string, uri: string, options?: ReadResourceOptions): Promise<unknown>;
  connect(server: string, options?: ConnectOptions): Promise<ClientContext>;
  close(server?: string): Promise<void>;
}

export interface ServerToolInfo {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
}

// createRuntime spins up a pooled MCP runtime from config JSON or provided definitions.
export async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  // Build the runtime with either the provided server list or the config file contents.
  const servers =
    options.servers ??
    (await loadServerDefinitions({
      configPath: options.configPath,
      rootDir: options.rootDir,
    }));

  const runtime = new McpRuntime(servers, options);
  return runtime;
}

// callOnce connects to a server, invokes a single tool, and disposes the connection immediately.
export async function callOnce(params: {
  server: string;
  toolName: string;
  args?: Record<string, unknown>;
  configPath?: string;
  disableOAuth?: boolean;
}): Promise<unknown> {
  const runtime = await createRuntime({ configPath: params.configPath });
  try {
    return await runtime.callTool(params.server, params.toolName, {
      args: params.args,
      disableOAuth: params.disableOAuth,
    });
  } finally {
    await runtime.close(params.server);
  }
}

class McpRuntime implements Runtime {
  private readonly definitions: Map<string, ServerDefinition>;
  private readonly connectionCache: RuntimeConnectionCache;
  private readonly logger: RuntimeLogger;

  constructor(servers: ServerDefinition[], options: RuntimeOptions = {}) {
    for (const server of servers) {
      validateToolFilters(server.name, server);
    }
    this.definitions = new Map(servers.map((entry) => [entry.name, entry]));
    this.logger = options.logger ?? createConsoleLogger();
    const clientInfo = options.clientInfo ?? {
      name: PACKAGE_NAME,
      version: MCPORTER_VERSION,
    };
    const recordSession = process.env.MCPORTER_RECORD;
    const replaySession = process.env.MCPORTER_REPLAY;
    if (recordSession && replaySession) {
      this.logger.warn('Both MCPORTER_RECORD and MCPORTER_REPLAY are set; recording mode wins.');
    }
    const recordPath = recordSession ? resolveRecordingPath(recordSession) : undefined;
    const replayPath = !recordSession && replaySession ? resolveRecordingPath(replaySession) : undefined;
    this.connectionCache = new RuntimeConnectionCache(this.definitions, {
      logger: this.logger,
      clientInfo,
      oauthTimeoutMs: options.oauthTimeoutMs ?? OAUTH_CODE_TIMEOUT_MS,
      recordPath,
      replayPath,
    });
  }

  // Legacy test probes resolve through accessors while the cache remains the sole state owner.
  private get clients(): RuntimeConnectionCache['clients'] {
    return this.connectionCache.clients;
  }

  private get activeClientKeys(): RuntimeConnectionCache['activeClientKeys'] {
    return this.connectionCache.activeClientKeys;
  }

  private get contextCacheKeys(): RuntimeConnectionCache['contextCacheKeys'] {
    return this.connectionCache.contextCacheKeys;
  }

  private get contextCachePromises(): RuntimeConnectionCache['contextCachePromises'] {
    return this.connectionCache.contextCachePromises;
  }

  // listServers returns configured names sorted alphabetically for stable CLI output.
  listServers(): string[] {
    return [...this.definitions.keys()].toSorted((a, b) => a.localeCompare(b));
  }

  // getDefinitions exposes raw server metadata to consumers such as the CLI.
  getDefinitions(): ServerDefinition[] {
    return [...this.definitions.values()];
  }

  // getDefinition throws when the caller requests an unknown server name.
  getDefinition(server: string): ServerDefinition {
    const definition = this.definitions.get(server);
    if (!definition) {
      throw new Error(`Unknown MCP server '${server}'.`);
    }
    return definition;
  }

  registerDefinition(definition: ServerDefinition, options: { overwrite?: boolean } = {}): void {
    validateToolFilters(definition.name, definition);
    if (!options.overwrite && this.definitions.has(definition.name)) {
      throw new Error(`MCP server '${definition.name}' already exists.`);
    }
    this.connectionCache.supersedeDefinition(definition.name, () => {
      this.definitions.set(definition.name, definition);
    });
  }

  async getInstructions(server: string): Promise<string | undefined> {
    return this.connectionCache.getInstructions(server);
  }

  async getConnectionInfo(server: string): Promise<ConnectionInfo | undefined> {
    return this.connectionCache.getConnectionInfo(server);
  }

  // listTools queries tool metadata and optionally includes schemas when requested.
  async listTools(server: string, options: ListToolsOptions = {}): Promise<ServerToolInfo[]> {
    // Toggle auto authorization so list can run without forcing OAuth flows.
    // `disableOAuth` is the cache-friendly suppression path; when present it
    // supersedes the legacy `autoAuthorize: false` uncached behavior.
    const autoAuthorize = options.autoAuthorize !== false;
    const disableOAuth = this.effectiveDisableOAuthForOperation(server, options.disableOAuth);
    const allowCachedAuth = this.effectiveAllowCachedAuthForOperation(
      server,
      options.allowCachedAuth,
      disableOAuth,
      true
    );
    const useLegacyNoAuthorize = !autoAuthorize && disableOAuth !== true;
    const context = await this.connect(server, {
      maxOAuthAttempts: useLegacyNoAuthorize ? 0 : undefined,
      skipCache: useLegacyNoAuthorize,
      allowCachedAuth,
      oauthSessionOptions: options.oauthSessionOptions,
      disableOAuth,
    });
    let closeError: unknown;
    let tools: ServerToolInfo[] = [];
    try {
      const response = await context.client.listTools();
      tools = (response.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description ?? undefined,
        inputSchema: options.includeSchema ? tool.inputSchema : undefined,
        outputSchema: options.includeSchema ? tool.outputSchema : undefined,
      }));
    } catch (error) {
      // Keep-alive STDIO transports often die when Chrome closes; drop the cached client
      // so the next call spins up a fresh process instead of reusing the broken handle.
      await this.resetConnectionOnError(server, error, context);
      throw error;
    } finally {
      if (useLegacyNoAuthorize) {
        try {
          await this.closeContext(context);
        } catch (error) {
          closeError = error;
        }
      }
    }
    if (closeError !== undefined) {
      throw closeError;
    }

    return filterTools(tools, this.definitions.get(server.trim()));
  }

  // callTool executes a tool using the args provided by the caller.
  async callTool(server: string, toolName: string, options: CallOptions = {}): Promise<unknown> {
    const definition = this.definitions.get(server.trim());
    if (definition && !isToolAllowed(toolName, definition)) {
      throw new Error(
        `Tool '${toolName}' is not accessible on server '${definition.name}' (blocked by configuration).`
      );
    }
    let context: ClientContext | undefined;
    try {
      const disableOAuth = this.effectiveDisableOAuthForOperation(server, options.disableOAuth);
      context = await this.connect(server, {
        allowCachedAuth: this.effectiveAllowCachedAuthForOperation(server, undefined, disableOAuth, true),
        disableOAuth,
      });
      const { client } = context;
      const params: CallToolRequest['params'] = {
        name: toolName,
        arguments: options.args ?? {},
      };
      // Forward the requested timeout to the MCP client so server-side requests don't hit the SDK's
      // default 60s cap. Keep our own outer race as a second guard.
      const timeoutMs = normalizeTimeout(options.timeoutMs);
      const resultPromise = client.callTool(params, {
        timeout: timeoutMs,
        // Long runs (e.g., GPT-5 Pro) emit progress/logging; allow that to refresh the timer.
        resetTimeoutOnProgress: true,
        maxTotalTimeout: timeoutMs,
      });
      if (!timeoutMs) {
        return await resultPromise;
      }
      return await raceWithTimeout(resultPromise, timeoutMs);
    } catch (error) {
      if (isUnsupportedMrtrError(error)) {
        throw new Error(MRTR_UNSUPPORTED_MESSAGE, { cause: error });
      }
      // Runtime timeouts and transport crashes should tear down the cached connection so
      // the daemon (or direct runtime) can relaunch the MCP server on the next attempt.
      await this.resetConnectionOnError(server, error, context);
      throw error;
    }
  }

  // listResources delegates to the MCP resources/list method with passthrough params.
  async listResources(server: string, options: ListResourcesOptions = {}): Promise<unknown> {
    const { allowCachedAuth, disableOAuth, oauthSessionOptions, ...params } = options;
    let context: ClientContext | undefined;
    try {
      const effectiveDisableOAuth = this.effectiveDisableOAuthForOperation(server, disableOAuth);
      context = await this.connect(server, {
        allowCachedAuth: this.effectiveAllowCachedAuthForOperation(
          server,
          allowCachedAuth,
          effectiveDisableOAuth,
          undefined
        ),
        oauthSessionOptions,
        disableOAuth: effectiveDisableOAuth,
      });
      const { client } = context;
      const requestParams = params as NonNullable<ListResourcesRequest['params']>;
      if (requestParams.cursor !== undefined) {
        return await client.listResources(requestParams);
      }

      // v2 auto-aggregation throws when listMaxPages is reached, while
      // mcporter's existing resource contract returns the bounded partial
      // result. Use the low-level typed request path to preserve that behavior.
      let response = await client.request(
        { method: 'resources/list', params: requestParams },
        specTypeSchemas.ListResourcesResult
      );
      const resources = [...response.resources];
      for (let page = 1; page < MAX_RESOURCE_LIST_PAGES && response.nextCursor; page += 1) {
        response = await client.request(
          { method: 'resources/list', params: { ...requestParams, cursor: response.nextCursor } },
          specTypeSchemas.ListResourcesResult
        );
        resources.push(...response.resources);
      }
      return { ...response, resources };
    } catch (error) {
      // Fatal listResources errors usually mean the underlying transport has gone away.
      await this.resetConnectionOnError(server, error, context);
      throw error;
    }
  }

  async readResource(server: string, uri: string, options: ReadResourceOptions = {}): Promise<unknown> {
    let context: ClientContext | undefined;
    try {
      const effectiveDisableOAuth = this.effectiveDisableOAuthForOperation(server, options.disableOAuth);
      context = await this.connect(server, {
        allowCachedAuth: this.effectiveAllowCachedAuthForOperation(
          server,
          options.allowCachedAuth,
          effectiveDisableOAuth,
          undefined
        ),
        oauthSessionOptions: options.oauthSessionOptions,
        disableOAuth: effectiveDisableOAuth,
      });
      const { client } = context;
      return await client.readResource({ uri } satisfies ReadResourceRequest['params']);
    } catch (error) {
      await this.resetConnectionOnError(server, error, context);
      throw error;
    }
  }

  private effectiveDisableOAuthForOperation(server: string, requested: boolean | undefined): boolean | undefined {
    return this.connectionCache.effectiveDisableOAuthForOperation(server, requested);
  }

  private effectiveAllowCachedAuthForOperation(
    server: string,
    requested: boolean | undefined,
    disableOAuth: boolean | undefined,
    defaultValue: boolean | undefined
  ): boolean | undefined {
    return this.connectionCache.effectiveAllowCachedAuthForOperation(server, requested, disableOAuth, defaultValue);
  }

  async connect(server: string, options: ConnectOptions = {}): Promise<ClientContext> {
    return this.connectionCache.connect(server, options);
  }

  async close(server?: string): Promise<void> {
    await this.connectionCache.close(server);
  }

  private async closeContext(context: ClientContext): Promise<void> {
    await this.connectionCache.closeContext(context);
  }

  private async resetConnectionOnError(server: string, error: unknown, context?: ClientContext): Promise<void> {
    await this.connectionCache.resetConnectionOnError(server, error, context);
  }
}

function isUnsupportedMrtrError(error: unknown): boolean {
  if (error instanceof UrlElicitationRequiredError) return true;
  if (!(error instanceof SdkError)) return false;
  if (error.code === SdkErrorCode.UnsupportedResultType) {
    return (error.data as { resultType?: unknown } | undefined)?.resultType === 'input_required';
  }
  return error.code === SdkErrorCode.CapabilityNotSupported && error.message.startsWith('Cannot fulfil input request');
}

// createConsoleLogger produces the default runtime logger honoring MCPORTER_LOG_LEVEL.
function createConsoleLogger(level: LogLevel = resolveLogLevelFromEnv()): RuntimeLogger {
  return createPrefixedConsoleLogger('mcporter', level);
}

export { readJsonFile, writeJsonFile } from './fs-json.js';
