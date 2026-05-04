import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { listConfigLayerPaths } from '../config.js';
import { launchDaemonDetached } from './launch.js';
import { getDaemonMetadataPath, getDaemonSocketPath } from './paths.js';
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

export interface DaemonPaths {
  readonly key: string;
  readonly socketPath: string;
  readonly metadataPath: string;
}

interface DaemonMetadata {
  readonly pid: number;
  readonly socketPath: string;
  readonly configPath: string;
  readonly configMtimeMs?: number | null;
  readonly configLayers?: Array<{ path: string; mtimeMs: number | null }>;
  readonly startedAt: number;
  readonly logPath?: string | null;
}

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
    return this.invoke('listTools', params);
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
    try {
      return (await this.sendRequest<StatusResult>('status', {})) as StatusResult;
    } catch (error) {
      if (isTransportError(error)) {
        return null;
      }
      throw error;
    }
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
    await this.ensureDaemon();
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

  private async ensureDaemon(): Promise<void> {
    if (await this.isConfigStale()) {
      await this.stop().catch(() => {});
      await this.restartDaemon();
      return;
    }
    const available = await this.isResponsive();
    if (available) {
      return;
    }
    await this.startDaemon();
    await this.waitForReady();
  }

  private async restartDaemon(): Promise<void> {
    await this.startDaemon();
    await this.waitForReady();
  }

  private async startDaemon(): Promise<void> {
    if (this.startingPromise) {
      await this.startingPromise;
      return;
    }
    this.startingPromise = Promise.resolve()
      .then(() => {
        launchDaemonDetached({
          configPath: this.options.configPath,
          configExplicit: this.options.configExplicit,
          rootDir: this.options.rootDir,
          metadataPath: this.metadataPath,
          socketPath: this.socketPath,
        });
      })
      .finally(() => {
        this.startingPromise = null;
      });
    await this.startingPromise;
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

  private async isResponsive(): Promise<boolean> {
    try {
      await this.sendRequest('status', {});
      return true;
    } catch (error) {
      if (isTransportError(error)) {
        return false;
      }
      throw error;
    }
  }

  private async isConfigStale(): Promise<boolean> {
    const metadata = await readDaemonMetadata(this.metadataPath);
    if (!metadata) {
      return false;
    }
    const currentLayers = normalizeLayers(await collectConfigLayers(this.options));
    const metadataLayers = normalizeLayers(
      metadata.configLayers ?? [{ path: metadata.configPath, mtimeMs: metadata.configMtimeMs ?? null }]
    );
    if (currentLayers.length !== metadataLayers.length) {
      return true;
    }
    for (let i = 0; i < currentLayers.length; i += 1) {
      const current = currentLayers[i];
      const previous = metadataLayers[i];
      if (!current || !previous || current.path !== previous.path || current.mtimeMs !== previous.mtimeMs) {
        return true;
      }
    }
    return false;
  }

  private async sendRequest<T>(method: DaemonRequestMethod, params: unknown, timeoutOverrideMs?: number): Promise<T> {
    const request: DaemonRequest = {
      id: randomUUID(),
      method,
      params,
    };
    const payload = JSON.stringify(request);
    const timeoutMs = resolveDaemonTimeout(timeoutOverrideMs);
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let settled = false;
      const finishReject = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };
      const finishResolve = (value: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      socket.setTimeout(timeoutMs, () => {
        // If the daemon doesn't answer in time we treat it as a transport error, destroy the socket,
        // and let invoke() restart the daemon so hung keep-alive servers get a fresh start.
        socket.destroy(
          Object.assign(new Error('Daemon request timed out.'), {
            code: 'ETIMEDOUT',
          })
        );
      });
      let buffer = '';
      socket.on('connect', () => {
        socket.write(payload, (error) => {
          if (error) {
            finishReject(error);
          }
          // Do not end the socket here; allow the server to respond and close.
        });
      });
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
      });
      socket.on('end', () => finishResolve(buffer));
      socket.on('error', (error) => {
        finishReject(error as Error);
      });
    });
    const trimmed = response.trim();
    if (!trimmed) {
      const error = new Error('Empty daemon response.');
      (error as NodeJS.ErrnoException).code = 'ECONNRESET';
      throw error;
    }
    let parsed: DaemonResponse<T>;
    try {
      parsed = JSON.parse(trimmed) as DaemonResponse<T>;
    } catch {
      const parseError = new Error('Failed to parse daemon response.');
      (parseError as NodeJS.ErrnoException).code = 'ECONNRESET';
      throw parseError;
    }
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
  return layers
    .map((entry) => ({ path: path.resolve(entry.path), mtimeMs: entry.mtimeMs ?? null }))
    .toSorted((a, b) => a.path.localeCompare(b.path));
}
