import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { listConfigLayerPaths } from '../config/path-discovery.js';
import { withFileLock } from '../fs-json.js';
import { getDaemonMetadataPath, getDaemonSocketPath } from './paths.js';
import {
  DAEMON_PROTOCOL_VERSION,
  DaemonFrameDecoder,
  isDaemonProgressFrame,
  resolveProgressInterval,
} from './protocol.js';
import type {
  CallToolParams,
  CloseServerParams,
  DaemonRequest,
  DaemonRequestMethod,
  DaemonResponse,
  ListResourcesParams,
  ListToolsParams,
  ReadResourceParams,
  StatusResult,
} from './protocol.js';

export interface DaemonClientOptions {
  readonly configPath: string;
  readonly configExplicit?: boolean;
  readonly rootDir?: string;
}

const DEFAULT_DAEMON_TIMEOUT_MS = 30_000;
const MIN_DAEMON_STATUS_TIMEOUT_MS = 1_000;

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
}

type DaemonConfigState = 'missing' | 'fresh' | 'stale';

export function resolveDaemonPaths(configPath: string): DaemonPaths {
  const key = deriveConfigKey(configPath);
  return {
    key,
    socketPath: getDaemonSocketPath(key),
    metadataPath: getDaemonMetadataPath(key),
  };
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

  async status(): Promise<StatusResult | null> {
    return await this.readVerifiedStatus();
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

  private async invoke<T = unknown>(method: DaemonRequestMethod, params: unknown, timeoutMs?: number): Promise<T> {
    await this.ensureDaemon(timeoutMs);
    try {
      return (await this.sendRequest<T>(method, params, timeoutMs)) as T;
    } catch (error) {
      if (isTransportError(error)) {
        await this.restartDaemon();
        return (await this.sendRequest<T>(method, params, timeoutMs)) as T;
      }
      throw error;
    }
  }

  private async ensureDaemon(timeoutMs?: number): Promise<void> {
    const statusTimeoutMs = resolveDaemonStatusTimeout(timeoutMs);
    const metadata = await readDaemonMetadata(this.metadataPath);
    const configState = await this.checkConfigState(metadata);
    if (configState === 'stale') {
      await this.restartDaemon({ reason: 'stale-config', expectedPid: metadata?.pid });
      return;
    }
    if (configState === 'fresh') {
      if (await this.isResponsive(statusTimeoutMs)) {
        return;
      }
    }
    await this.startDaemon({ preflightTimeoutMs: statusTimeoutMs });
  }

  private async restartDaemon(options: { reason?: 'stale-config'; expectedPid?: number } = {}): Promise<void> {
    await this.startingWithLock(async () => {
      const currentStatus = await this.readVerifiedStatus();
      if (
        currentStatus &&
        options.expectedPid !== undefined &&
        currentStatus.pid !== options.expectedPid &&
        (await this.checkConfigState()) === 'fresh'
      ) {
        return;
      }
      if (options.reason === 'stale-config' && currentStatus && (await this.checkConfigState()) === 'fresh') {
        return;
      }
      await this.stop().catch(() => {});
      await this.waitForStopped();
      await this.launchDaemonAndWait();
    });
  }

  private async startDaemon(options: { preflightTimeoutMs?: number } = {}): Promise<void> {
    await this.startingWithLock(async () => {
      if (await this.isResponsive(options.preflightTimeoutMs)) {
        return;
      }
      await this.launchDaemonAndWait();
    });
  }

  private async startingWithLock(task: () => Promise<void>): Promise<void> {
    if (this.startingPromise) {
      await this.startingPromise;
      return;
    }
    this.startingPromise = withFileLock(this.metadataPath, async () => {
      await task();
    }).finally(() => {
      this.startingPromise = null;
    });
    await this.startingPromise;
  }

  private async launchDaemonAndWait(): Promise<void> {
    const { launchDaemonDetached } = await import('./launch.js');
    launchDaemonDetached({
      configPath: this.options.configPath,
      configExplicit: this.options.configExplicit,
      rootDir: this.options.rootDir,
      metadataPath: this.metadataPath,
      socketPath: this.socketPath,
    });
    await this.waitForReady();
  }

  private async waitForStopped(): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (!(await this.isResponsive())) {
        return;
      }
      await delay(100);
    }
    throw new Error('Daemon did not stop before restart could begin.');
  }

  private async waitForReady(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await this.isResponsive()) {
        return;
      }
      await delay(100);
    }
    throw new Error('Timeout while waiting for MCPorter daemon to start.');
  }

  private async isResponsive(timeoutMs?: number): Promise<boolean> {
    return (await this.readVerifiedStatus(timeoutMs)) !== null;
  }

  private async readVerifiedStatus(timeoutMs?: number): Promise<StatusResult | null> {
    const metadata = await readDaemonMetadata(this.metadataPath);
    if (!metadata || metadata.socketPath !== this.socketPath || !isProcessRunning(metadata.pid)) {
      return null;
    }
    try {
      const status = (await this.sendRequest<StatusResult>('status', {}, timeoutMs)) as StatusResult;
      if (status.pid !== metadata.pid || status.socketPath !== metadata.socketPath) {
        return null;
      }
      return status;
    } catch (error) {
      if (isTransportError(error)) {
        return null;
      }
      throw error;
    }
  }

  private async checkConfigState(metadata?: DaemonMetadata | null): Promise<DaemonConfigState> {
    metadata ??= await readDaemonMetadata(this.metadataPath);
    if (!metadata) {
      return 'missing';
    }
    if (metadata.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
      return 'stale';
    }
    const currentLayers = normalizeLayers(await collectConfigLayers(this.options));
    const metadataLayers = normalizeLayers(
      metadata.configLayers ?? [{ path: metadata.configPath, mtimeMs: metadata.configMtimeMs ?? null }]
    );
    if (currentLayers.length !== metadataLayers.length) {
      return 'stale';
    }
    for (let i = 0; i < currentLayers.length; i += 1) {
      const current = currentLayers[i];
      const previous = metadataLayers[i];
      if (!current || !previous || current.path !== previous.path || current.mtimeMs !== previous.mtimeMs) {
        return 'stale';
      }
    }
    return 'fresh';
  }

  private async sendRequest<T>(method: DaemonRequestMethod, params: unknown, timeoutOverrideMs?: number): Promise<T> {
    // This is an *idle* deadline, not an operation deadline: the daemon keeps
    // resetting it with progress frames for as long as it is working, so a
    // request survives any number of sequential phases (an OAuth code wait plus
    // however many `tools/list` pages a server returns). The daemon still owns
    // the operation deadline and answers with `operation_timeout` when a phase
    // exceeds it; the socket only gives up when the daemon goes silent.
    const idleTimeoutMs = resolveDaemonTimeout(timeoutOverrideMs);
    const request: DaemonRequest = {
      id: randomUUID(),
      method,
      params,
      // Tell the daemon how often this deadline needs proof of life, so a short
      // deadline cannot expire before the first frame arrives.
      progressIntervalMs: resolveProgressInterval(idleTimeoutMs),
    };
    const payload = JSON.stringify(request);
    const parsed = await new Promise<DaemonResponse<T>>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const decoder = new DaemonFrameDecoder();
      let response: DaemonResponse<T> | undefined;
      let settled = false;
      const finishReject = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };
      const finishResolve = (value: DaemonResponse<T>): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      socket.setTimeout(idleTimeoutMs);
      socket.on('timeout', () => {
        // The daemon stopped proving it is alive. Treat that as a transport error, destroy the
        // socket, and let invoke() restart the daemon so hung keep-alive servers get a fresh start.
        socket.destroy(transportError('Daemon request timed out.', 'ETIMEDOUT'));
      });
      const consume = (frames: ReturnType<DaemonFrameDecoder['push']>): void => {
        for (const frame of frames) {
          if (isDaemonProgressFrame(frame)) {
            // Proof of life from the daemon: restart the idle deadline.
            socket.setTimeout(idleTimeoutMs);
            continue;
          }
          response = frame as DaemonResponse<T>;
          // The answer is in hand; stop policing the socket while it closes.
          socket.setTimeout(0);
        }
      };
      socket.on('connect', () => {
        socket.write(payload, (error) => {
          if (error) {
            finishReject(error);
          }
          // Do not end the socket here; allow the server to respond and close.
        });
      });
      socket.on('data', (chunk) => {
        consume(decoder.push(chunk.toString()));
      });
      socket.on('end', () => {
        consume(decoder.flush());
        if (response) {
          finishResolve(response);
          return;
        }
        finishReject(
          decoder.malformed
            ? transportError('Failed to parse daemon response.', 'ECONNRESET')
            : transportError('Empty daemon response.', 'ECONNRESET')
        );
      });
      socket.on('error', (error) => {
        finishReject(error as Error);
      });
    });
    if (!parsed.ok) {
      const error = new Error(parsed.error?.message ?? 'Daemon error');
      (error as NodeJS.ErrnoException).code = parsed.error?.code;
      throw error;
    }
    return parsed.result as T;
  }
}

function deriveConfigKey(configPath: string): string {
  const absolute = path.resolve(configPath);
  return crypto.createHash('sha1').update(absolute).digest('hex').slice(0, 12);
}

function transportError(message: string, code: string): Error {
  const error = new Error(message);
  (error as NodeJS.ErrnoException).code = code;
  return error;
}

function isTransportError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ECONNREFUSED' || code === 'ENOENT' || code === 'ETIMEDOUT' || code === 'ECONNRESET';
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
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

function resolveDaemonStatusTimeout(override?: number): number | undefined {
  if (typeof override !== 'number' || !Number.isFinite(override) || override <= 0) {
    return undefined;
  }
  return Math.max(override, MIN_DAEMON_STATUS_TIMEOUT_MS);
}

async function statConfigMtime(configPath: string): Promise<number | null> {
  try {
    const stats = await fs.stat(configPath);
    return stats.mtimeMs;
  } catch {
    return null;
  }
}

async function collectConfigLayers(
  options: DaemonClientOptions
): Promise<Array<{ path: string; mtimeMs: number | null }>> {
  const layerPaths = await listConfigLayerPaths(
    options.configExplicit ? { configPath: options.configPath } : {},
    options.rootDir ?? process.cwd()
  );
  const layers: Array<{ path: string; mtimeMs: number | null }> = [];
  for (const layerPath of layerPaths) {
    layers.push({ path: layerPath, mtimeMs: await statConfigMtime(layerPath) });
  }
  // If no layers were found (e.g., missing defaults), fall back to the primary config path so
  // explicit single-file runs still record freshness.
  if (layers.length === 0) {
    layers.push({ path: path.resolve(options.configPath), mtimeMs: await statConfigMtime(options.configPath) });
  }
  return layers;
}

async function readDaemonMetadata(metadataPath: string): Promise<DaemonMetadata | null> {
  try {
    const raw = await fs.readFile(metadataPath, 'utf8');
    return JSON.parse(raw) as DaemonMetadata;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeLayers(
  layers: Array<{ path: string; mtimeMs: number | null }>
): Array<{ path: string; mtimeMs: number | null }> {
  const normalized = layers.map((entry) => ({
    path: path.isAbsolute(entry.path) ? entry.path : path.resolve(entry.path),
    mtimeMs: entry.mtimeMs ?? null,
  }));
  if (normalized.length < 2) {
    return normalized;
  }
  return normalized.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
