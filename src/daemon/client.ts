import { requestDaemon } from './socket-rpc.js';
import { writeJsonFile } from '../fs-json.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { loadServerDefinitions, type ServerDefinition } from '../config.js';
import { isKeepAliveServer } from '../lifecycle.js';
import { effectiveDefinition } from './connection-identity.js';
import { secureDaemonDirectory } from './paths.js';
import { assertLegacyDrained } from './migration.js';
import type { ChromeDevtoolsRelayIdentityOptions } from '../chrome-devtools-relay.js';
import { isProcessRunning } from '../process-utils.js';
import { getDaemonMetadataPath, getDaemonSocketPath } from './paths.js';
import { DAEMON_PROTOCOL_VERSION, resolveProgressTiming } from './protocol.js';
import { waitForDaemonReady } from './startup-readiness.js';
import type {
  CallToolParams,
  CloseServerParams,
  DaemonRequest,
  DaemonRequestMethod,
  ListResourcesParams,
  ListToolsParams,
  ServerMetadata,
  ReadResourceParams,
  StatusResult,
} from './protocol.js';

export interface DaemonClientOptions {
  readonly configPath: string;
  readonly configExplicit?: boolean;
  readonly rootDir?: string;
  readonly chromeDevtoolsRelayIdentity?: ChromeDevtoolsRelayIdentityOptions;
}

const DEFAULT_DAEMON_TIMEOUT_MS = 30_000;

export interface DaemonPaths {
  readonly key: string;
  readonly socketPath: string;
  readonly metadataPath: string;
}

interface DaemonMetadata {
  readonly pid: number;
  readonly protocolVersion?: number;
  readonly socketPath: string;
  readonly configPath: string;
  readonly configMtimeMs?: number | null;
  readonly configLayers?: Array<{ path: string; mtimeMs: number | null }>;
  readonly startedAt: number;
  readonly logPath?: string | null;
  readonly relayRuntimeIdentityVersion?: number;
  readonly relayRuntimeIdentity?: string;
  readonly relayEnvironmentKeys?: string[];
  readonly oauthNoBrowser?: boolean;
}

export function resolveDaemonPaths(configPath: string): DaemonPaths {
  const key = 'user';
  void configPath;
  return {
    key,
    socketPath: getDaemonSocketPath(key),
    metadataPath: getDaemonMetadataPath(key),
  };
}

interface ViewEpoch {
  readonly definitions?: ServerDefinition[];
  readonly clientInfo?: { name: string; version: string };
  registration?: Promise<{ view: string; generation: string }>;
  active: number;
  drained?: () => void;
  release?: Promise<void>;
}

export class DaemonClient {
  private readonly socketPath: string;
  private readonly metadataPath: string;
  private startingPromise: Promise<void> | null = null;

  constructor(private readonly options: DaemonClientOptions) {
    const paths = resolveDaemonPaths(options.configPath);
    this.socketPath = paths.socketPath;
    this.metadataPath = paths.metadataPath;
  }

  async callTool(params: CallToolParams): Promise<unknown> {
    return this.invoke('callTool', params, params.timeoutMs);
  }

  async listTools(params: ListToolsParams): Promise<unknown> {
    return this.invoke('listTools', params, params.timeoutMs);
  }

  async listResources(params: ListResourcesParams): Promise<unknown> {
    return this.invoke('listResources', params);
  }

  async readResource(params: ReadResourceParams): Promise<unknown> {
    return this.invoke('readResource', params);
  }

  async closeServer(params: CloseServerParams): Promise<void> {
    await this.invoke('closeServer', params);
  }

  async status(timeoutMs?: number): Promise<StatusResult | null> {
    return await this.readVerifiedStatus(timeoutMs);
  }

  async stop(): Promise<void> {
    try {
      await this.sendRequest('stop', {});
    } catch (error) {
      if (isTransportError(error)) {
        return;
      }
      throw error;
    }
  }

  private epoch?: ViewEpoch;
  private readonly retiring = new Set<Promise<void>>();
  private definitions?: ServerDefinition[];
  private clientInfo?: { name: string; version: string };

  setDefinitions(definitions: readonly ServerDefinition[], clientInfo?: { name: string; version: string }): void {
    this.definitions = definitions.map(({ command, ...definition }) => ({
      ...structuredClone(definition),
      command:
        command.kind === 'http'
          ? { ...structuredClone({ ...command, url: undefined }), url: new URL(command.url) }
          : structuredClone(command),
    }));
    this.clientInfo = clientInfo ? { ...clientInfo } : undefined;
    if (this.epoch) void this.retire(this.epoch).catch(() => {});
  }

  private retire(epoch: ViewEpoch): Promise<void> {
    if (this.epoch === epoch) this.epoch = undefined;
    if (!epoch.release) {
      epoch.release = (async () => {
        if (epoch.active)
          await new Promise<void>((resolve) => {
            epoch.drained = resolve;
          });
        // Failed registration has no handle to release; its callers retain the original error.
        const handle = await epoch.registration?.catch(() => undefined);
        if (handle) await this.sendRequest('releaseView', {}, undefined, handle);
      })();
      this.retiring.add(epoch.release);
      void epoch.release.finally(() => this.retiring.delete(epoch.release!)).catch(() => {});
    }
    return epoch.release;
  }

  async release(): Promise<void> {
    if (this.epoch) void this.retire(this.epoch).catch(() => {});
    await Promise.all(this.retiring);
  }

  async getServerMetadata(params: ListToolsParams): Promise<ServerMetadata> {
    return this.invoke('getServerMetadata', params, params.timeoutMs);
  }

  private async invoke<T = unknown>(method: DaemonRequestMethod, params: unknown, timeoutMs?: number): Promise<T> {
    const epoch = (this.epoch ??= { definitions: this.definitions, clientInfo: this.clientInfo, active: 0 });
    // Retain before registration or authenticated RPC establishment can yield to a replacement/close.
    epoch.active++;
    try {
      epoch.registration ??= (async () => {
        await this.ensureDaemon(timeoutMs);
        const definitions =
          epoch.definitions ??
          (await loadServerDefinitions({
            configPath: this.options.configExplicit ? this.options.configPath : undefined,
            rootDir: this.options.rootDir,
          }));
        const effective = await Promise.all(
          definitions
            .filter(isKeepAliveServer)
            .map((definition) => effectiveDefinition(definition, process.env, 'view'))
        );
        return this.sendRequest<{ view: string; generation: string }>('registerView', {
          definitions: effective,
          clientInfo: epoch.clientInfo,
        });
      })();
      let handle: { view: string; generation: string };
      try {
        handle = await epoch.registration;
      } catch (error) {
        void this.retire(epoch).catch(() => {});
        throw error;
      }
      return await this.sendRequest<T>(method, params, timeoutMs, handle);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'daemon_generation_changed' || code === 'view_expired' || isTransportError(error))
        void this.retire(epoch).catch(() => {});
      throw error;
    } finally {
      epoch.active--;
      if (!epoch.active) epoch.drained?.();
    }
  }

  async ensureDaemon(timeoutMs?: number): Promise<void> {
    await secureDaemonDirectory();
    await assertLegacyDrained();
    if (await this.readVerifiedStatus(timeoutMs)) return;
    const previous = await readDaemonMetadata(this.metadataPath);
    if (previous && !isProcessRunning(previous.pid))
      throw new Error(
        'Previous daemon exited unexpectedly; verify retirement of its transports before deliberate recovery. No replacement was launched.'
      );
    this.startingPromise ??= (async () => {
      const { launchDaemonDetached } = await import('./launch.js');
      launchDaemonDetached({
        configPath: this.options.configPath,
        metadataPath: this.metadataPath,
        socketPath: this.socketPath,
      });
      await waitForDaemonReady((timeout) => this.readVerifiedStatus(timeout));
    })().finally(() => {
      this.startingPromise = null;
    });
    await this.startingPromise;
  }

  private async readVerifiedStatus(timeoutMs?: number): Promise<StatusResult | null> {
    const metadata = await readDaemonMetadata(this.metadataPath);
    if (metadata && metadata.protocolVersion !== DAEMON_PROTOCOL_VERSION && isProcessRunning(metadata.pid))
      throw new Error('Incompatible daemon: upgrade clients and use deliberate daemon cutover.');
    let result: StatusResult;
    try {
      result = await this.sendRequest<StatusResult>('status', {}, timeoutMs);
    } catch (error) {
      if (isTransportError(error) && (!metadata || !isProcessRunning(metadata.pid))) return null;
      throw error;
    }
    if (
      result.socketPath !== this.socketPath ||
      result.protocolVersion !== DAEMON_PROTOCOL_VERSION ||
      !result.generation ||
      !isProcessRunning(result.pid)
    )
      throw new Error('Incompatible or unverified daemon; no restart attempted.');
    if (!metadata || metadata.pid !== result.pid) await writeJsonFile(this.metadataPath, result);
    return result;
  }

  private async sendRequest<T>(
    method: DaemonRequestMethod,
    params: unknown,
    timeoutOverrideMs?: number,
    handle?: { view: string; generation: string }
  ): Promise<T> {
    const progressTiming = resolveProgressTiming(resolveDaemonTimeout(timeoutOverrideMs));
    const request: DaemonRequest = {
      id: randomUUID(),
      ...handle,
      method,
      params,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      progressIntervalMs: progressTiming.progressIntervalMs,
    };
    const parsed = await requestDaemon<T>(this.socketPath, request, progressTiming.idleTimeoutMs);
    for (const notice of parsed.notices ?? []) {
      console.warn(`[mcporter] ${notice}`);
    }
    if (!parsed.ok) {
      const error = new Error(parsed.error?.message ?? 'Daemon error');
      (error as NodeJS.ErrnoException).code = parsed.error?.code;
      throw error;
    }
    return parsed.result as T;
  }
}

function isTransportError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ECONNREFUSED' || code === 'ENOENT' || code === 'ETIMEDOUT' || code === 'ECONNRESET';
}

function resolveDaemonTimeout(override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return override;
  }
  const raw = process.env.MCPORTER_DAEMON_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_DAEMON_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_DAEMON_TIMEOUT_MS;
  }
  return parsed;
}

async function readDaemonMetadata(metadataPath: string): Promise<DaemonMetadata | null> {
  try {
    const raw = await fs.readFile(metadataPath, 'utf8');
    return JSON.parse(raw) as DaemonMetadata;
  } catch {
    return null;
  }
}
