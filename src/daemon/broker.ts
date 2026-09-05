import { idleTimerDelay } from './idle-timer.js';
import {
  ownedProcessTree,
  awaitRetirement,
  ProcessObservationError,
  type ProcessIdentity,
} from './process-retirement.js';
import { MCPORTER_VERSION } from '../version.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { SdkErrorCode } from '@modelcontextprotocol/client';
import type { ServerDefinition } from '../config.js';
import { createRuntime, type Runtime } from '../runtime.js';
import type { ClientContext } from '../runtime/transport-types.js';
import { withRuntimeEnvironment } from '../runtime/environment.js';
import { createNonInteractiveElicitationResponder, NON_INTERACTIVE_ELICITATION_HINT } from '../runtime/elicitation.js';
import { isOAuthFlowError, resolveOAuthTimeoutFromEnv } from '../runtime/oauth.js';
import { filterTools, isToolAllowed } from '../tool-filters.js';
import { getChromeDevtoolsRelayDecision } from '../chrome-devtools-relay.js';
import { BrowserOwner } from './browser-owner.js';
import { connectionIdentity, isChromeDefinition, type ResolvedServerDefinition } from './connection-identity.js';
import type { CallToolParams, DaemonRequest, ListToolsParams, StatusResult } from './protocol.js';
import { decodeView } from './view-codec.js';
import { authorizeBrokerDefinition } from './transport-authority.js';

interface View {
  definitions: Map<string, ResolvedServerDefinition>;
  lastUsed: number;
  active: number;
  clientInfo: { name: string; version: string };
}
interface Entry {
  id: string;
  definition: ServerDefinition;
  runtime: Promise<Runtime>;
  active: number;
  lastUsed: number;
  state: 'pending' | 'connected' | 'disconnected' | 'idle' | 'retirement-failed';
  chrome: boolean;
  connection?: Promise<ClientContext>;
  processes?: ProcessIdentity[];
  serial: Promise<unknown>;
  generation: number;
  clientInfo: { name: string; version: string };
  policy: { allowCachedAuth: boolean; disableOAuth: boolean };
  idleTimer?: NodeJS.Timeout;
  uncertain?: boolean;
}
const notices = new AsyncLocalStorage<Set<string>>();
export class BrokerError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export class DaemonBroker {
  readonly generation = randomUUID();
  private readonly views = new Map<string, View>();
  private readonly entries = new Map<string, Entry>();
  private readonly owner: BrowserOwner;
  private draining = false;
  private activeRequests = 0;
  constructor(canonical: readonly ServerDefinition[] = []) {
    this.owner = new BrowserOwner(canonical);
  }

  register(params: unknown): { view: string; generation: string } {
    this.expireViews();
    if (this.draining) throw new BrokerError('daemon_draining', 'Daemon is draining.');
    if (this.views.size >= 1024)
      throw new BrokerError('view_limit', 'Too many active config views; release abandoned clients.');
    const { definitions, clientInfo = { name: 'mcporter', version: MCPORTER_VERSION } } = decodeView(params);
    const view = randomUUID();
    this.views.set(view, {
      definitions: new Map(definitions.map((def) => [def.name, def])),
      lastUsed: Date.now(),
      active: 0,
      clientInfo,
    });
    return { view, generation: this.generation };
  }
  release(request: DaemonRequest): void {
    this.getView(request);
    this.views.delete(request.view!);
  }
  private getView(request: DaemonRequest): View {
    if (request.generation !== this.generation)
      throw new BrokerError(
        'daemon_generation_changed',
        'Daemon generation changed; register before a new operation. The request was not replayed.'
      );
    const view = this.views.get(request.view ?? '');
    if (!view) throw new BrokerError('view_expired', 'Config view expired; register before a new operation.');
    view.lastUsed = Date.now();
    return view;
  }
  async invokeWithNotices(request: DaemonRequest): Promise<{ result: unknown; notices: string[] }> {
    const messages = new Set<string>();
    const result = await notices.run(messages, () => this.invoke(request));
    return { result, notices: [...messages] };
  }
  private makeRuntime(definition: ServerDefinition, clientInfo: { name: string; version: string }): Promise<Runtime> {
    return withRuntimeEnvironment(definition.env ?? {}, () =>
      createRuntime({
        servers: [definition],
        clientInfo,
        logger: { info() {}, warn() {}, error() {} },
        oauthTimeoutMs: resolveOAuthTimeoutFromEnv(),
        elicitationHandler: createNonInteractiveElicitationResponder({
          onDecline: () => notices.getStore()?.add(NON_INTERACTIVE_ELICITATION_HINT),
        }).handler,
      })
    );
  }
  async invoke(request: DaemonRequest): Promise<unknown> {
    if (this.draining) throw new BrokerError('daemon_draining', 'Daemon is draining.');
    const view = this.getView(request);
    const params = request.params as CallToolParams &
      ListToolsParams & { uri?: string; params?: Record<string, unknown> };
    if (!params || typeof params.server !== 'string')
      throw new BrokerError('invalid_params', 'A view-local alias is required.');
    const viewDefinition = view.definitions.get(params.server);
    if (!viewDefinition) throw new BrokerError('server_not_in_view', 'Server is not authorized in this config view.');
    if (request.method === 'closeServer') return true;
    if (
      request.method === 'callTool' &&
      (typeof params.tool !== 'string' || !isToolAllowed(params.tool, viewDefinition))
    )
      throw new BrokerError(
        'tool_not_allowed',
        'Tool is not accessible in this config view (blocked by configuration).'
      );
    if (params.timeoutMs !== undefined && (!Number.isFinite(params.timeoutMs) || params.timeoutMs <= 0))
      throw new BrokerError('invalid_params', 'Invalid timeout.');
    const chrome = isChromeDefinition(viewDefinition);
    if (chrome && JSON.stringify(view.clientInfo) !== JSON.stringify({ name: 'mcporter', version: MCPORTER_VERSION }))
      throw new BrokerError('browser_owner_conflict', 'Existing Chrome requires the canonical MCP client identity.');
    const definition = this.owner.reserve(viewDefinition);
    const identity = connectionIdentity(definition);
    view.active++;
    this.activeRequests++;
    try {
      const relay = chrome ? await this.owner.resolveIdentity(definition) : '';
      const policy =
        definition.command.kind === 'stdio'
          ? { allowCachedAuth: true, disableOAuth: false }
          : {
              allowCachedAuth: params.allowCachedAuth ?? true,
              disableOAuth:
                params.disableOAuth === true ||
                ((request.method === 'listTools' || request.method === 'getServerMetadata') &&
                  params.autoAuthorize === false),
            };
      const key = `${identity}:${relay}:${JSON.stringify(policy)}:${JSON.stringify(view.clientInfo)}`;
      let entry = this.entries.get(key);
      if (!entry) {
        if (this.entries.size >= 256)
          throw new BrokerError(
            'transport_limit',
            'Transport capacity reached; drain unused transports with daemon stop.'
          );
        const pooled = { ...definition, allowedTools: undefined, blockedTools: undefined };
        authorizeBrokerDefinition(pooled, chrome ? () => this.owner.resolveIdentity(definition) : undefined);
        entry = {
          id: randomUUID(),
          definition: pooled,
          runtime: this.makeRuntime(pooled, view.clientInfo),
          active: 0,
          lastUsed: Date.now(),
          state: 'pending',
          chrome,
          serial: Promise.resolve(),
          generation: 1,
          policy,
          clientInfo: view.clientInfo,
        };
        this.entries.set(key, entry);
      }
      const target = entry;
      const run = () =>
        withRuntimeEnvironment(target.definition.env ?? {}, async () => {
          // Queued requests must still hold authority before any connection/recovery I/O.
          if (chrome) await this.owner.resolveIdentity(definition);
          // Reconnect is owned by this serialized generation, only after all old calls settle.
          if (target.state === 'retirement-failed')
            throw new BrokerError(
              'transport_retirement_failed',
              'Old transport retirement is unverified; no replacement was launched.'
            );
          if (target.state === 'disconnected' || target.state === 'idle') {
            try {
              if (target.state !== 'idle') await this.retire(target);
            } catch (error) {
              target.state = 'retirement-failed';
              throw error;
            }
            target.runtime = this.makeRuntime(target.definition, target.clientInfo);
            target.connection = undefined;
            target.processes = undefined;
            target.uncertain = false;
            target.generation++;
            target.state = 'pending';
          }
          const runtime = await target.runtime;
          if (!target.connection) {
            target.connection = runtime
              .connect(target.definition.name, policy)
              .then(async (context) => {
                const pid = (context.transport as { pid?: number }).pid;
                const generation = target.generation;
                const previous = context.client.onclose;
                context.client.onclose = () => {
                  if (target.generation === generation && target.state !== 'retirement-failed') {
                    target.state = 'disconnected';
                  }
                  previous?.();
                };
                target.state = 'connected';
                if (pid) {
                  try {
                    target.processes = await ownedProcessTree(pid);
                  } catch (error) {
                    throw new BrokerError(
                      'transport_retirement_failed',
                      error instanceof ProcessObservationError
                        ? error.message
                        : 'Transport ownership could not be verified; inspect it before recovery.'
                    );
                  }
                }
                return context;
              })
              .catch((error: unknown) => {
                target.connection = undefined;
                if (
                  error &&
                  typeof error === 'object' &&
                  'code' in error &&
                  error.code === 'transport_retirement_failed'
                )
                  target.state = 'retirement-failed';
                throw error;
              });
          }
          const context = await target.connection;
          // Runtime operations validate again after their own connect await, at SDK dispatch.
          const server = target.definition.name;
          try {
            switch (request.method) {
              case 'getServerMetadata': {
                if (chrome) await this.owner.resolveIdentity(definition);
                const info = context.client.getServerVersion();
                return {
                  instructions: context.client.getInstructions(),
                  serverInfo: info ? { name: info.name, version: info.version, title: info.title } : undefined,
                };
              }
              case 'callTool':
                return await runtime.callTool(server, params.tool, {
                  args: params.args,
                  timeoutMs: params.timeoutMs,
                  disableOAuth: policy.disableOAuth,
                });
              case 'listTools':
                return filterTools(
                  await runtime.listTools(server, {
                    includeSchema: params.includeSchema,
                    ...policy,
                    timeoutMs: params.timeoutMs,
                  }),
                  viewDefinition
                );
              case 'listResources':
                return await runtime.listResources(server, { ...params.params, ...policy });
              case 'readResource':
                if (typeof params.uri !== 'string') throw new BrokerError('invalid_params', 'Resource URI required.');
                return await runtime.readResource(server, params.uri, policy);
              default:
                throw new BrokerError('unknown_method', 'Unknown daemon operation.');
            }
          } catch (error) {
            const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
            if (code === SdkErrorCode.ConnectionClosed || code === SdkErrorCode.NotConnected) {
              target.state = 'disconnected';
            }
            if (code === SdkErrorCode.RequestTimeout || (error instanceof Error && error.message === 'Timeout')) {
              target.uncertain = true;
              throw new BrokerError(
                'operation_timeout',
                'Operation timed out; outcome unknown. It was not replayed and the connection was retained.'
              );
            }
            if (isOAuthFlowError(error))
              throw new BrokerError(
                'oauth_flow_error',
                'Authorization failed. Authenticate this server explicitly; the operation was not replayed.'
              );
            throw error;
          }
        });
      // Serialize individual calls, preserving the server's shared MCP session state.
      target.active++;
      clearTimeout(target.idleTimer);
      const operation = target.serial.then(run, run);
      target.serial = operation.catch(() => {});
      try {
        return await operation;
      } finally {
        target.active--;
        target.lastUsed = Date.now();
        this.scheduleIdle(target);
      }
    } finally {
      view.active--;
      this.activeRequests--;
    }
  }
  status(): Pick<StatusResult, 'generation' | 'views' | 'servers' | 'browserOwner'> {
    this.expireViews();
    const entries = [...this.entries.values()];
    const owner = entries.find((entry) => entry.chrome);
    return {
      generation: this.generation,
      views: this.views.size,
      servers: entries.map((entry) => ({
        name: entry.id,
        connectionId: entry.id,
        connectionGeneration: entry.generation,
        connected: entry.state === 'connected',
        activeCalls: entry.active,
        lastUsedAt: entry.lastUsed,
        idleTimeoutMs:
          entry.definition.lifecycle?.mode === 'keep-alive' ? entry.definition.lifecycle.idleTimeoutMs : undefined,
        idleBlocked: entry.chrome ? 'browser-owner' : entry.uncertain ? 'unknown-outcome' : undefined,
        chromeDevtoolsRelay: getChromeDevtoolsRelayDecision(entry.definition.name),
      })),
      browserOwner: owner ? { connectionId: owner.id, state: owner.state } : undefined,
    };
  }
  async close(): Promise<void> {
    this.draining = true;
    if (this.activeRequests > 0)
      throw new BrokerError('active_calls', 'Active calls are still running; wait for completion before stopping.');
    for (const entry of this.entries.values()) {
      clearTimeout(entry.idleTimer);
      await entry.serial;
      if (entry.state === 'retirement-failed' && !entry.processes)
        throw new BrokerError(
          'transport_retirement_failed',
          'Retirement is unverified; inspect the previous transport before stopping this owner.'
        );
      if (entry.state !== 'idle') await this.retire(entry);
    }
    this.entries.clear();
    this.views.clear();
  }
  canIdleShutdown(): boolean {
    return (
      !this.draining &&
      this.activeRequests === 0 &&
      !this.owner.reserved &&
      [...this.entries.values()].every(
        (entry) => !entry.active && !entry.uncertain && entry.state !== 'retirement-failed'
      )
    );
  }
  private async retire(entry: Entry): Promise<void> {
    await withRuntimeEnvironment(entry.definition.env ?? {}, async () => {
      await (await entry.runtime).close();
      if (entry.processes) await awaitRetirement(entry.processes);
    });
  }
  private scheduleIdle(entry: Entry): void {
    if (this.draining || entry.chrome || entry.active || entry.uncertain || entry.state === 'retirement-failed') return;
    const timeout =
      entry.definition.lifecycle?.mode === 'keep-alive' ? entry.definition.lifecycle.idleTimeoutMs : undefined;
    if (!timeout) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(
      () => {
        if (Date.now() - entry.lastUsed < timeout) {
          this.scheduleIdle(entry);
          return;
        }
        entry.serial = entry.serial.then(async () => {
          if (entry.active || this.draining) return;
          entry.state = 'disconnected';
          try {
            await this.retire(entry);
            entry.state = 'idle';
          } catch {
            entry.state = 'retirement-failed';
          }
        });
      },
      idleTimerDelay(timeout, entry.lastUsed)
    );
    entry.idleTimer.unref();
  }
  private expireViews(): void {
    const cutoff = Date.now() - 15 * 60_000;
    for (const [id, view] of this.views) if (!view.active && view.lastUsed < cutoff) this.views.delete(id);
  }
}
