import type { CallToolRequest, ListResourcesRequest, ReadResourceRequest } from '@modelcontextprotocol/sdk/types.js';
import { loadServerDefinitions, type ServerDefinition } from './config.js';
import { createPrefixedConsoleLogger, type Logger, type LogLevel, resolveLogLevelFromEnv } from './logging.js';
import type { OAuthSessionOptions } from './oauth.js';
import { closeTransportAndWait } from './runtime-process-utils.js';
import './sdk-patches.js';
import { shouldResetConnection } from './runtime/errors.js';
import { resolveOAuthTimeoutFromEnv } from './runtime/oauth.js';
import { resolveRecordingPath } from './runtime/record-transport.js';
import { ReplayTransport } from './runtime/replay-transport.js';
import { type ClientContext, createClientContext } from './runtime/transport.js';
import { normalizeTimeout, raceWithTimeout } from './runtime/utils.js';
import { filterTools, isToolAllowed, validateToolFilters } from './tool-filters.js';
import { MCPORTER_VERSION } from './version.js';

export { MCPORTER_VERSION } from './version.js';

const PACKAGE_NAME = 'mcporter';
const OAUTH_CODE_TIMEOUT_MS = resolveOAuthTimeoutFromEnv();

type CachedClientEntry = {
  readonly server: string;
  readonly promise: Promise<ClientContext>;
  readonly contextPromise?: Promise<ClientContext>;
  readonly allowCachedAuth: boolean | undefined;
  readonly disableOAuth: boolean;
};

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
  private readonly clients = new Map<string, CachedClientEntry>();
  private readonly activeClientKeys = new Map<string, string>();
  private readonly contextCacheKeys = new WeakMap<ClientContext, string>();
  private readonly contextCachePromises = new WeakMap<ClientContext, Promise<ClientContext>>();
  private readonly connectionSetupTails = new Map<string, Promise<void>>();
  private readonly serverGenerations = new Map<string, number>();
  private readonly retirementPromises = new Map<string, Set<Promise<void>>>();
  private readonly logger: RuntimeLogger;
  private readonly clientInfo: { name: string; version: string };
  private readonly oauthTimeoutMs?: number;
  private readonly recordPath?: string;
  private readonly replayPath?: string;

  constructor(servers: ServerDefinition[], options: RuntimeOptions = {}) {
    for (const server of servers) {
      validateToolFilters(server.name, server);
    }
    this.definitions = new Map(servers.map((entry) => [entry.name, entry]));
    this.logger = options.logger ?? createConsoleLogger();
    this.clientInfo = options.clientInfo ?? {
      name: PACKAGE_NAME,
      version: MCPORTER_VERSION,
    };
    this.oauthTimeoutMs = options.oauthTimeoutMs;
    const recordSession = process.env.MCPORTER_RECORD;
    const replaySession = process.env.MCPORTER_REPLAY;
    if (recordSession && replaySession) {
      this.logger.warn('Both MCPORTER_RECORD and MCPORTER_REPLAY are set; recording mode wins.');
    }
    this.recordPath = recordSession ? resolveRecordingPath(recordSession) : undefined;
    this.replayPath = !recordSession && replaySession ? resolveRecordingPath(replaySession) : undefined;
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
    this.bumpServerGeneration(definition.name);
    this.definitions.set(definition.name, definition);
    this.retireCachedEntriesForServer(definition.name);
  }

  async getInstructions(server: string): Promise<string | undefined> {
    const active = this.activeClientForServer(server);
    const fallbackEntries = active ? [] : this.cachedEntriesForServer(server);
    const cached = active ?? (fallbackEntries.length === 1 ? fallbackEntries[0] : undefined);
    if (!cached) {
      return undefined;
    }
    try {
      const context = await cached.promise;
      const instructions =
        typeof context.client.getInstructions === 'function' ? context.client.getInstructions() : undefined;
      if (typeof instructions !== 'string') {
        return undefined;
      }
      const trimmed = instructions.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    } catch {
      return undefined;
    }
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
    const tools: ServerToolInfo[] = [];
    try {
      let cursor: string | undefined;
      do {
        const response = await context.client.listTools(cursor ? { cursor } : undefined);
        tools.push(
          ...(response.tools ?? []).map((tool) => ({
            name: tool.name,
            description: tool.description ?? undefined,
            inputSchema: options.includeSchema ? tool.inputSchema : undefined,
            outputSchema: options.includeSchema ? tool.outputSchema : undefined,
          }))
        );
        cursor = response.nextCursor ?? undefined;
      } while (cursor);
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
      const resultPromise = client.callTool(params, undefined, {
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
      return await client.listResources(params as ListResourcesRequest['params']);
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
    if (requested !== undefined) {
      return requested;
    }
    const cached = this.cachedEntriesForServer(server);
    const active = this.activeClientForServer(server);
    if (active) {
      return active.disableOAuth;
    }
    if (cached.length === 0) {
      return undefined;
    }
    const [first] = cached;
    return cached.every((entry) => entry.disableOAuth === first?.disableOAuth) ? first?.disableOAuth : undefined;
  }

  private effectiveAllowCachedAuthForOperation(
    server: string,
    requested: boolean | undefined,
    disableOAuth: boolean | undefined,
    defaultValue: boolean | undefined
  ): boolean | undefined {
    if (requested !== undefined) {
      return requested;
    }
    if (disableOAuth !== true) {
      return defaultValue;
    }
    const active = this.activeClientForServer(server);
    if (active?.disableOAuth === true) {
      return active.allowCachedAuth;
    }
    const cached = this.cachedEntriesForServer(server).filter((entry) => entry.disableOAuth);
    return cached.length === 1 ? cached[0]?.allowCachedAuth : defaultValue;
  }

  private cachedEntriesForServer(server: string): CachedClientEntry[] {
    const normalized = server.trim();
    return [...this.clients.values()].filter((entry) => entry.server === normalized);
  }

  private retireCachedEntriesForServer(server: string): void {
    const normalized = server.trim();
    const retired: CachedClientEntry[] = [];
    for (const [key, cached] of this.clients.entries()) {
      if (cached.server === normalized) {
        this.clients.delete(key);
        retired.push(cached);
      }
    }
    this.activeClientKeys.delete(normalized);
    if (retired.length > 0) {
      const retirement = this.trackRetirement(normalized, this.closeCachedEntries(retired));
      void retirement.catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Failed to close retired '${normalized}' connection: ${detail}`);
      });
    }
  }

  private activeClientForServer(server: string): CachedClientEntry | undefined {
    const normalized = server.trim();
    const activeKey = this.activeClientKeys.get(normalized);
    if (!activeKey) {
      return undefined;
    }
    const active = this.clients.get(activeKey);
    return active?.server === normalized ? active : undefined;
  }

  private serverGeneration(server: string): number {
    return this.serverGenerations.get(server.trim()) ?? 0;
  }

  private bumpServerGeneration(server: string): void {
    const normalized = server.trim();
    this.serverGenerations.set(normalized, this.serverGeneration(normalized) + 1);
  }

  private bumpAllServerGenerations(): void {
    const servers = new Set<string>([
      ...this.definitions.keys(),
      ...[...this.clients.values()].map((entry) => entry.server),
      ...this.connectionSetupTails.keys(),
    ]);
    for (const server of servers) {
      this.bumpServerGeneration(server);
    }
  }

  // connect lazily instantiates a client context per server and memoizes it.
  async connect(server: string, options: ConnectOptions = {}): Promise<ClientContext> {
    // Reuse cached connections unless the caller explicitly opted out.
    const normalized = server.trim();
    let definition = this.definitions.get(normalized);
    if (!definition) {
      throw new Error(`Unknown MCP server '${normalized}'.`);
    }
    const generation = this.serverGeneration(normalized);

    // `maxOAuthAttempts: 0` keeps its legacy escape-the-cache contract.
    // `disableOAuth: true` is the cache-friendly OAuth-suppression knob:
    // it disables the interactive OAuth flow at the transport layer but
    // participates in caching (own slot, see the eviction rule below).
    const disableOAuth = options.disableOAuth === true;
    // Normalize: a caller asking for `disableOAuth: true` has no path to
    // OAuth, so cached-token application is the only auth they can ever
    // use — default `allowCachedAuth: true` when the caller didn't pick
    // a side. Without this, the documented headless setup
    // `connect(server, { disableOAuth: true })` stored
    // `allowCachedAuth: undefined`, and the next internal `callTool` /
    // `listTools` (which force `allowCachedAuth: true`) immediately
    // evicted and reopened the transport. Explicit `false` is honored
    // (header-only / anonymous callers).
    const effectiveAllowCachedAuth = options.allowCachedAuth ?? (disableOAuth ? true : undefined);
    const useCache = options.skipCache !== true && options.maxOAuthAttempts === undefined;
    let ignoresAuthCachePolicy = this.ignoresAuthCachePolicy(definition);
    let cacheAllowCachedAuth = ignoresAuthCachePolicy ? undefined : effectiveAllowCachedAuth;
    let cacheDisableOAuth = ignoresAuthCachePolicy ? false : disableOAuth;
    let cacheKey = this.cacheKey(normalized, cacheAllowCachedAuth, cacheDisableOAuth);

    if (useCache) {
      const existing = this.findCachedEntryForRequest(
        normalized,
        definition,
        ignoresAuthCachePolicy ? undefined : options.allowCachedAuth,
        cacheAllowCachedAuth,
        cacheDisableOAuth
      );
      if (existing) {
        const [existingKey, cached] = existing;
        const activeEntry = ignoresAuthCachePolicy
          ? {
              ...cached,
              allowCachedAuth: effectiveAllowCachedAuth,
              disableOAuth,
            }
          : cached;
        if (activeEntry !== cached) {
          this.clients.set(existingKey, activeEntry);
        }
        this.activeClientKeys.set(normalized, existingKey);
        return activeEntry.promise;
      }
    }

    let releaseConnectionSetup: (() => void) | undefined;
    if (useCache && this.shouldSerializeConnectionSetup(definition, disableOAuth)) {
      releaseConnectionSetup = await this.enterConnectionSetup(normalized);
      try {
        if (this.serverGeneration(normalized) !== generation) {
          throw new Error(`Connection setup for MCP server '${normalized}' was superseded.`);
        }
        const refreshedDefinition = this.definitions.get(normalized);
        if (!refreshedDefinition) {
          throw new Error(`Unknown MCP server '${normalized}'.`);
        }
        definition = refreshedDefinition;
        ignoresAuthCachePolicy = this.ignoresAuthCachePolicy(definition);
        cacheAllowCachedAuth = ignoresAuthCachePolicy ? undefined : effectiveAllowCachedAuth;
        cacheDisableOAuth = ignoresAuthCachePolicy ? false : disableOAuth;
        cacheKey = this.cacheKey(normalized, cacheAllowCachedAuth, cacheDisableOAuth);
        const existing = this.findCachedEntryForRequest(
          normalized,
          definition,
          ignoresAuthCachePolicy ? undefined : options.allowCachedAuth,
          cacheAllowCachedAuth,
          cacheDisableOAuth
        );
        if (existing) {
          releaseConnectionSetup();
          releaseConnectionSetup = undefined;
          const [existingKey, cached] = existing;
          this.activeClientKeys.set(normalized, existingKey);
          return cached.promise;
        }
        await this.retireConflictingOAuthEntries(normalized, cacheKey);
        if (this.serverGeneration(normalized) !== generation) {
          throw new Error(`Connection setup for MCP server '${normalized}' was superseded.`);
        }
        const latestDefinition = this.definitions.get(normalized);
        if (!latestDefinition) {
          throw new Error(`Unknown MCP server '${normalized}'.`);
        }
        definition = latestDefinition;
      } catch (error) {
        releaseConnectionSetup?.();
        releaseConnectionSetup = undefined;
        throw error;
      }
    }

    let connectionDefinition = definition;
    let contextPromise = createClientContext(definition, this.logger, this.clientInfo, {
      maxOAuthAttempts: options.maxOAuthAttempts,
      oauthTimeoutMs: this.oauthTimeoutMs ?? OAUTH_CODE_TIMEOUT_MS,
      onDefinitionPromoted: (promoted) => {
        if (
          this.serverGeneration(normalized) === generation &&
          this.definitions.get(normalized) === connectionDefinition
        ) {
          this.definitions.set(promoted.name, promoted);
          connectionDefinition = promoted;
        }
      },
      allowCachedAuth: effectiveAllowCachedAuth,
      oauthSessionOptions: options.oauthSessionOptions,
      disableOAuth,
      recordPath: this.recordPath,
      replayPath: this.replayPath,
    });

    if (useCache) {
      const previousActiveKey = this.activeClientKeys.get(normalized);
      contextPromise = contextPromise.then((context) => {
        this.contextCacheKeys.set(context, cacheKey);
        this.contextCachePromises.set(context, contextPromise);
        return context;
      });
      let connection!: Promise<ClientContext>;
      connection = contextPromise.then((context) => {
        const stillCached = this.clients.get(cacheKey)?.promise === connection;
        if (this.serverGeneration(normalized) !== generation || !stillCached) {
          this.contextCacheKeys.delete(context);
          this.contextCachePromises.delete(context);
          throw new Error(`Connection setup for MCP server '${normalized}' was superseded.`);
        }
        return context;
      });
      this.activeClientKeys.set(normalized, cacheKey);
      this.clients.set(cacheKey, {
        server: normalized,
        promise: connection,
        contextPromise,
        allowCachedAuth: ignoresAuthCachePolicy ? effectiveAllowCachedAuth : cacheAllowCachedAuth,
        disableOAuth: ignoresAuthCachePolicy ? disableOAuth : cacheDisableOAuth,
      });
      try {
        return await connection;
      } catch (error) {
        const ownsCacheEntry = this.clients.get(cacheKey)?.promise === connection;
        if (ownsCacheEntry) {
          this.clients.delete(cacheKey);
          if (
            this.activeClientKeys.get(normalized) === cacheKey &&
            previousActiveKey &&
            this.clients.has(previousActiveKey)
          ) {
            this.activeClientKeys.set(normalized, previousActiveKey);
          } else if (
            this.activeClientKeys.get(normalized) === cacheKey ||
            this.cachedEntriesForServer(normalized).length === 0
          ) {
            this.activeClientKeys.delete(normalized);
          }
        }
        throw error;
      } finally {
        releaseConnectionSetup?.();
      }
    }

    releaseConnectionSetup?.();
    return contextPromise;
  }

  // close tears down transports (and OAuth sessions) for a single server or all servers.
  async close(server?: string): Promise<void> {
    if (server) {
      const normalized = server.trim();
      this.bumpServerGeneration(normalized);
      const entries = [...this.clients.entries()].filter(([, cached]) => cached.server === normalized);
      if (entries.length === 0) {
        this.activeClientKeys.delete(normalized);
      }
      for (const [key] of entries) {
        this.clients.delete(key);
      }
      this.activeClientKeys.delete(normalized);
      if (entries.length > 0) {
        void this.trackRetirement(normalized, this.closeCachedEntries(entries.map(([, cached]) => cached)));
      }
      await this.awaitRetirements(normalized);
      return;
    }

    this.bumpAllServerGenerations();
    const entries = [...this.clients.entries()];
    this.clients.clear();
    this.activeClientKeys.clear();
    const byServer = new Map<string, CachedClientEntry[]>();
    for (const [, cached] of entries) {
      const serverEntries = byServer.get(cached.server) ?? [];
      serverEntries.push(cached);
      byServer.set(cached.server, serverEntries);
    }
    for (const [serverName, serverEntries] of byServer) {
      void this.trackRetirement(serverName, this.closeCachedEntries(serverEntries));
    }
    await this.awaitRetirements();
  }

  private contextPromiseFor(cached: CachedClientEntry): Promise<ClientContext> {
    return cached.contextPromise ?? cached.promise;
  }

  private async closeCachedEntries(entries: CachedClientEntry[]): Promise<void> {
    const results = await Promise.allSettled(
      entries.map(async (cached) => {
        const context = await this.contextPromiseFor(cached);
        try {
          await this.closeContext(context);
        } finally {
          this.contextCacheKeys.delete(context);
          this.contextCachePromises.delete(context);
        }
      })
    );
    const firstFailure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (firstFailure) {
      throw firstFailure.reason;
    }
  }

  private async closeContext(context: ClientContext): Promise<void> {
    const propagateReplayCloseErrors = context.transport instanceof ReplayTransport;
    let closeError: unknown;

    try {
      await context.client.close();
    } catch (error) {
      if (propagateReplayCloseErrors) {
        closeError ??= error;
      }
    }

    try {
      await closeTransportAndWait(this.logger, context.transport, {
        throwOnCloseError: propagateReplayCloseErrors,
      });
    } catch (error) {
      if (propagateReplayCloseErrors) {
        closeError ??= error;
      }
    }

    await context.oauthSession?.close().catch(() => {});

    if (closeError) {
      throw closeError;
    }
  }

  private async resetConnectionOnError(server: string, error: unknown, failedContext?: ClientContext): Promise<void> {
    if (!shouldResetConnection(error)) {
      return;
    }
    const normalized = server.trim();
    if (!failedContext) {
      return;
    }
    try {
      const failedKey = this.contextCacheKeys.get(failedContext);
      const failedEntry = failedKey ? this.clients.get(failedKey) : undefined;
      const failedContextPromise = this.contextCachePromises.get(failedContext);
      if (
        !failedKey ||
        failedEntry?.server !== normalized ||
        !failedContextPromise ||
        this.contextPromiseFor(failedEntry) !== failedContextPromise
      ) {
        return;
      }
      if (this.clients.get(failedKey)?.promise !== failedEntry.promise) {
        return;
      }
      this.clients.delete(failedKey);
      if (this.activeClientKeys.get(normalized) === failedKey || this.cachedEntriesForServer(normalized).length === 0) {
        this.activeClientKeys.delete(normalized);
      }
      try {
        await this.closeContext(failedContext);
      } finally {
        this.contextCacheKeys.delete(failedContext);
        this.contextCachePromises.delete(failedContext);
      }
    } catch (closeError) {
      const detail = closeError instanceof Error ? closeError.message : String(closeError);
      this.logger.warn(`Failed to reset '${normalized}' after error: ${detail}`);
    }
  }

  private findCachedEntryForRequest(
    server: string,
    definition: ServerDefinition,
    requestedAllowCachedAuth: boolean | undefined,
    effectiveAllowCachedAuth: boolean | undefined,
    disableOAuth: boolean
  ): [string, CachedClientEntry] | undefined {
    const exactKey = this.cacheKey(server, effectiveAllowCachedAuth, disableOAuth);
    if (this.ignoresAuthCachePolicy(definition)) {
      const exact = this.clients.get(exactKey);
      return exact ? [exactKey, exact] : undefined;
    }
    if (requestedAllowCachedAuth !== undefined) {
      const exact = this.clients.get(exactKey);
      return exact ? [exactKey, exact] : undefined;
    }

    const activeKey = this.activeClientKeys.get(server);
    const active = activeKey ? this.clients.get(activeKey) : undefined;
    const policyMatches = (cached: CachedClientEntry) =>
      effectiveAllowCachedAuth === undefined || cached.allowCachedAuth === effectiveAllowCachedAuth;
    if (activeKey && active?.server === server && active.disableOAuth === disableOAuth && policyMatches(active)) {
      return [activeKey, active];
    }

    const matches = [...this.clients.entries()].filter(
      ([, cached]) => cached.server === server && cached.disableOAuth === disableOAuth && policyMatches(cached)
    );
    if (matches.length === 1) {
      return matches[0];
    }

    const exact = this.clients.get(exactKey);
    return exact ? [exactKey, exact] : undefined;
  }

  private async retireConflictingOAuthEntries(server: string, keepKey: string): Promise<void> {
    const conflicting = [...this.clients.entries()].filter(
      ([key, cached]) => key !== keepKey && cached.server === server && !cached.disableOAuth
    );
    if (conflicting.length === 0) {
      return;
    }
    for (const [key] of conflicting) {
      this.clients.delete(key);
      if (this.activeClientKeys.get(server) === key) {
        this.activeClientKeys.delete(server);
      }
    }
    await this.trackRetirement(server, this.closeCachedEntries(conflicting.map(([, cached]) => cached)));
  }

  private shouldSerializeConnectionSetup(definition: ServerDefinition, disableOAuth: boolean): boolean {
    return definition.command.kind === 'http' && !disableOAuth && !this.ignoresAuthCachePolicy(definition);
  }

  private ignoresAuthCachePolicy(definition: ServerDefinition): boolean {
    const replayServer = process.env.MCPORTER_REPLAY_SERVER;
    const replaysDefinition = Boolean(this.replayPath) && (!replayServer || replayServer === definition.name);
    return definition.command.kind === 'stdio' || replaysDefinition;
  }

  private trackRetirement(server: string, retirement: Promise<void>): Promise<void> {
    const pending = this.retirementPromises.get(server) ?? new Set<Promise<void>>();
    pending.add(retirement);
    this.retirementPromises.set(server, pending);
    const cleanup = () => {
      pending.delete(retirement);
      if (pending.size === 0) {
        this.retirementPromises.delete(server);
      }
    };
    retirement.then(cleanup, cleanup);
    return retirement;
  }

  private async awaitRetirements(server?: string): Promise<void> {
    const pending = server ? [...(this.retirementPromises.get(server) ?? [])] : [];
    if (!server) {
      for (const retirements of this.retirementPromises.values()) {
        pending.push(...retirements);
      }
    }
    const results = await Promise.allSettled(pending);
    const firstFailure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (firstFailure) {
      throw firstFailure.reason;
    }
  }

  private async enterConnectionSetup(server: string): Promise<() => void> {
    const previous = this.connectionSetupTails.get(server) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.catch(() => {}).then(() => current);
    this.connectionSetupTails.set(server, tail);
    await previous.catch(() => {});

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      releaseCurrent();
      void tail.finally(() => {
        if (this.connectionSetupTails.get(server) === tail) {
          this.connectionSetupTails.delete(server);
        }
      });
    };
  }

  private cacheKey(server: string, allowCachedAuth: boolean | undefined, disableOAuth: boolean): string {
    const cachedAuthKey =
      allowCachedAuth === true ? 'cached-auth-on' : allowCachedAuth === false ? 'cached-auth-off' : 'cached-auth-unset';
    return `${server}\u0000oauth-disabled:${disableOAuth ? '1' : '0'}\u0000${cachedAuthKey}`;
  }
}

// createConsoleLogger produces the default runtime logger honoring MCPORTER_LOG_LEVEL.
function createConsoleLogger(level: LogLevel = resolveLogLevelFromEnv()): RuntimeLogger {
  return createPrefixedConsoleLogger('mcporter', level);
}

export { readJsonFile, writeJsonFile } from './fs-json.js';
