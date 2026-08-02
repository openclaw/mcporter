import type { ServerDefinition } from '../config.js';
import type { ConnectionInfo, RuntimeLogger, ConnectOptions } from '../runtime.js';
import { closeTransportAndWait } from '../runtime-process-utils.js';
import { shouldResetConnection } from './errors.js';
import type { ElicitationHandler } from './elicitation.js';
import { ReplayTransport } from './replay-transport.js';
import { type ClientContext, createClientContext } from './transport.js';

type CachedClientEntry = {
  readonly server: string;
  readonly promise: Promise<ClientContext>;
  readonly contextPromise?: Promise<ClientContext>;
  readonly allowCachedAuth: boolean | undefined;
  readonly disableOAuth: boolean;
  readonly abortController?: AbortController;
  readonly transportRef?: { current?: ClientContext['transport'] };
  readonly contextRef?: { current?: ClientContext };
};

export interface RuntimeConnectionCacheOptions {
  readonly logger: RuntimeLogger;
  readonly clientInfo: { name: string; version: string };
  readonly oauthTimeoutMs: number;
  readonly recordPath?: string;
  readonly replayPath?: string;
  readonly elicitationHandler: ElicitationHandler;
}

export class RuntimeConnectionCache {
  public readonly clients = new Map<string, CachedClientEntry>();
  public readonly activeClientKeys = new Map<string, string>();
  public readonly contextCacheKeys = new WeakMap<ClientContext, string>();
  public readonly contextCachePromises = new WeakMap<ClientContext, Promise<ClientContext>>();
  private readonly connectionSetupTails = new Map<string, Promise<void>>();
  private readonly serverGenerations = new Map<string, number>();
  private readonly retirementPromises = new Map<string, Set<Promise<void>>>();
  private readonly lastConnectionInfo = new Map<string, ConnectionInfo>();

  public constructor(
    private readonly definitions: Map<string, ServerDefinition>,
    private readonly options: RuntimeConnectionCacheOptions
  ) {}

  private get logger(): RuntimeLogger {
    return this.options.logger;
  }

  private get clientInfo(): { name: string; version: string } {
    return this.options.clientInfo;
  }

  private get oauthTimeoutMs(): number {
    return this.options.oauthTimeoutMs;
  }

  private get recordPath(): string | undefined {
    return this.options.recordPath;
  }

  private get replayPath(): string | undefined {
    return this.options.replayPath;
  }

  public supersedeDefinition(server: string, replace: () => void): void {
    this.bumpServerGeneration(server);
    this.lastConnectionInfo.delete(server.trim());
    replace();
    this.retireCachedEntriesForServer(server);
  }

  public async getInstructions(server: string): Promise<string | undefined> {
    const active = this.activeClientForServer(server);
    const fallbackEntries = active ? [] : this.cachedEntriesForServer(server);
    const cached = active ?? (fallbackEntries.length === 1 ? fallbackEntries[0] : undefined);
    if (!cached) return undefined;
    try {
      const context = await cached.promise;
      const instructions =
        typeof context.client.getInstructions === 'function' ? context.client.getInstructions() : undefined;
      if (typeof instructions !== 'string') return undefined;
      const trimmed = instructions.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    } catch {
      return undefined;
    }
  }

  public async getConnectionInfo(server: string): Promise<ConnectionInfo | undefined> {
    const normalized = server.trim();
    const active = this.activeClientForServer(server);
    const fallbackEntries = active ? [] : this.cachedEntriesForServer(server);
    const cached = active ?? (fallbackEntries.length === 1 ? fallbackEntries[0] : undefined);
    if (!cached) return this.lastConnectionInfo.get(normalized);
    try {
      const { client } = await cached.promise;
      const info = connectionInfoFromClient(client);
      this.lastConnectionInfo.set(normalized, info);
      return info;
    } catch {
      return this.lastConnectionInfo.get(normalized);
    }
  }

  public effectiveDisableOAuthForOperation(server: string, requested: boolean | undefined): boolean | undefined {
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

  public effectiveAllowCachedAuthForOperation(
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
    const abortController = new AbortController();
    const transportRef: { current?: ClientContext['transport'] } = {};
    const contextRef: { current?: ClientContext } = {};
    let contextPromise = createClientContext(definition, this.logger, this.clientInfo, {
      maxOAuthAttempts: options.maxOAuthAttempts,
      oauthTimeoutMs: this.oauthTimeoutMs,
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
      elicitationHandler: this.options.elicitationHandler,
      signal: abortController.signal,
      onTransportCreated: (transport) => {
        transportRef.current = transport;
      },
    }).then((context) => {
      contextRef.current = context;
      this.lastConnectionInfo.set(normalized, connectionInfoFromClient(context.client));
      return context;
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
        abortController,
        transportRef,
        contextRef,
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
    for (const cached of entries) {
      cached.abortController?.abort();
    }
    const results = await Promise.allSettled(
      entries.map(async (cached) => {
        const readyContext = cached.contextRef?.current;
        if (readyContext) {
          try {
            await this.closeContext(readyContext);
          } finally {
            this.contextCacheKeys.delete(readyContext);
            this.contextCachePromises.delete(readyContext);
          }
          return;
        }

        const pendingContext = this.contextPromiseFor(cached);
        const pendingTransport = cached.transportRef?.current;
        if (pendingTransport) {
          await closeTransportAndWait(this.logger, pendingTransport);
          void pendingContext.then(
            async (context) => {
              await context.client.close().catch(() => {});
              await context.oauthSession?.close().catch(() => {});
              this.contextCacheKeys.delete(context);
              this.contextCachePromises.delete(context);
            },
            () => {}
          );
          return;
        }

        try {
          const context = await pendingContext;
          await this.closeContext(context);
          this.contextCacheKeys.delete(context);
          this.contextCachePromises.delete(context);
        } catch (error) {
          if (!cached.abortController?.signal.aborted) {
            throw error;
          }
        }
      })
    );
    const firstFailure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (firstFailure) {
      throw firstFailure.reason;
    }
  }

  public async closeContext(context: ClientContext): Promise<void> {
    const propagateReplayCloseErrors = context.transport instanceof ReplayTransport;
    let closeError: unknown;

    try {
      await closeTransportAndWait(this.logger, context.transport, {
        throwOnCloseError: propagateReplayCloseErrors,
        close: async () => {
          let firstError: unknown;
          const clientClose = (context.client as { close?: () => Promise<void> }).close;
          if (clientClose) {
            try {
              await clientClose.call(context.client);
            } catch (error) {
              firstError = error;
            }
          }
          try {
            await context.transport.close();
          } catch (error) {
            firstError ??= error;
          }
          if (firstError) {
            throw firstError;
          }
        },
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

  public async resetConnectionOnError(server: string, error: unknown, failedContext?: ClientContext): Promise<void> {
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

function connectionInfoFromClient(client: ClientContext['client']): ConnectionInfo {
  return {
    protocolVersion:
      typeof client.getNegotiatedProtocolVersion === 'function' ? client.getNegotiatedProtocolVersion() : undefined,
    era: typeof client.getProtocolEra === 'function' ? client.getProtocolEra() : undefined,
  };
}
