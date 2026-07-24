import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { loadDaemonConfig, type ServerDefinition } from '../config.js';
import { readJsonFile, withFileLock, writeJsonFile } from '../fs-json.js';
import { isKeepAliveServer } from '../lifecycle.js';
import { createRuntime, type Runtime } from '../runtime.js';
import { collectConfigLayers, statConfigMtime } from './config-layers.js';
import { hashDaemonDefinitions } from './definition-hash.js';
import {
  createLogContext,
  disposeLogContext,
  formatError,
  type LogContext,
  logEvent,
  shouldLogServer,
} from './log-context.js';
import {
  DAEMON_PROTOCOL_VERSION,
  type CallToolParams,
  type CloseServerParams,
  type DaemonRequest,
  type DaemonResponse,
  type ListResourcesParams,
  type ListToolsParams,
  type ReadResourceParams,
  type StatusResult,
} from './protocol.js';
import {
  buildErrorResponse,
  daemonIdleWatcherInterval,
  ensureManaged,
  evictIdleServers,
  markActivity,
  shouldShutdownDaemonForIdle,
  type ServerActivity,
} from './request-utils.js';

interface DaemonHostOptions {
  readonly socketPath: string;
  readonly metadataPath: string;
  readonly configPath: string;
  readonly configExplicit?: boolean;
  readonly rootDir?: string;
  readonly logPath?: string;
  readonly logServers?: Set<string>;
  readonly logAllServers?: boolean;
}

export async function runDaemonHost(options: DaemonHostOptions): Promise<void> {
  const configLayers = await collectConfigLayers({
    configPath: options.configExplicit ? options.configPath : undefined,
    rootDir: options.rootDir,
  });
  const daemonConfig = await loadDaemonConfig({
    configPath: options.configExplicit ? options.configPath : undefined,
    rootDir: options.rootDir,
  });
  const runtime = await createRuntime({
    configPath: options.configExplicit ? options.configPath : undefined,
    rootDir: options.rootDir,
  });
  const keepAliveDefinitions = runtime.getDefinitions().filter(isKeepAliveServer);
  const definitionHash = hashDaemonDefinitions(keepAliveDefinitions);
  if (keepAliveDefinitions.length === 0) {
    throw new Error('No MCP servers require keep-alive; daemon will not start.');
  }
  const managedServers = new Map<string, ServerDefinition>();
  for (const definition of keepAliveDefinitions) {
    managedServers.set(definition.name, definition);
  }
  const serverLoggingOverrides = new Set<string>();
  for (const definition of keepAliveDefinitions) {
    if (definition.logging?.daemon?.enabled) {
      serverLoggingOverrides.add(definition.name);
    }
  }
  const combinedServerLogs = new Set<string>([
    ...serverLoggingOverrides,
    ...(options.logServers ? Array.from(options.logServers) : []),
  ]);
  const logContext = createLogContext({
    enabled: Boolean(options.logPath),
    logAllServers: options.logAllServers ?? false,
    servers: combinedServerLogs,
    logPath: options.logPath,
  });

  await fs.mkdir(path.dirname(options.metadataPath), { recursive: true });
  const configMtimeMs = await statConfigMtime(options.configPath);

  const activity = new Map<string, ServerActivity>();
  for (const definition of keepAliveDefinitions) {
    activity.set(definition.name, { connected: false });
  }

  let shuttingDown = false;
  let idleWatcher: NodeJS.Timeout | undefined;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logEvent(logContext, 'Shutting down daemon host.');
    if (idleWatcher) {
      clearInterval(idleWatcher);
    }
    server.close();
    await runtime.close().catch(() => {});
    await disposeLogContext(logContext).catch(() => {});
    await cleanupArtifacts(options);
    process.exit(0);
  };

  let lastDaemonActivityAt = Date.now();
  let activeDaemonRequests = 0;
  idleWatcher = setInterval(() => {
    void (async () => {
      await evictIdleServers(runtime, managedServers, activity);
      if (
        shouldShutdownDaemonForIdle(lastDaemonActivityAt, Date.now(), daemonConfig.idleTimeoutMs, activeDaemonRequests)
      ) {
        logEvent(logContext, 'Daemon idle timeout reached.');
        await shutdown();
      }
    })();
  }, daemonIdleWatcherInterval(daemonConfig.idleTimeoutMs));
  idleWatcher.unref();

  logEvent(logContext, 'Daemon host started.');

  const startedAt = Date.now();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let handled = false;
    const tryHandle = () => {
      if (handled) {
        return;
      }
      const trimmed = buffer.trim();
      if (trimmed.length === 0) {
        return;
      }
      // Attempt to parse immediately; if it parses, handle the request now.
      let parsedRequest: DaemonRequest;
      try {
        parsedRequest = JSON.parse(trimmed) as DaemonRequest;
      } catch {
        // Not a complete JSON yet; wait for more data or 'end'
        return;
      }
      handled = true;
      lastDaemonActivityAt = Date.now();
      activeDaemonRequests += 1;
      void handleSocketRequest(
        trimmed,
        socket,
        runtime,
        managedServers,
        activity,
        {
          configPath: options.configPath,
          configLayers,
          socketPath: options.socketPath,
          protocolVersion: DAEMON_PROTOCOL_VERSION,
          startedAt,
          logPath: options.logPath ?? null,
          configMtimeMs,
          definitionHash,
        },
        logContext,
        shutdown,
        parsedRequest
      ).finally(() => {
        activeDaemonRequests -= 1;
        lastDaemonActivityAt = Date.now();
      });
    };
    socket.on('data', (chunk) => {
      buffer += chunk;
      tryHandle();
    });
    socket.on('end', () => {
      // Fallback: if we haven't handled yet, try now (for compatibility)
      if (!handled) {
        tryHandle();
      }
    });
    socket.on('error', () => {
      socket.destroy();
    });
  });

  let claimed = false;
  await withFileLock(`${options.metadataPath}.bind`, async () => {
    const live = await probeLiveDaemon(options.socketPath);
    if (live) {
      if (daemonConfigMatches(live, configLayers, options.configPath, configMtimeMs, definitionHash)) {
        if (!(await metadataMatches(options.metadataPath, live))) {
          await writeJsonFile(options.metadataPath, metadataFromStatus(live, configLayers));
        }
        return;
      }
      await stopLiveDaemon(options.socketPath, live.pid);
    }
    await prepareSocket(options.socketPath);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    await writeJsonFile(options.metadataPath, {
      pid: process.pid,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      socketPath: options.socketPath,
      configPath: options.configPath,
      configLayers,
      startedAt: Date.now(),
      logPath: options.logPath ?? null,
      configMtimeMs,
      definitionHash,
    });
    claimed = true;
  });

  if (!claimed) {
    logEvent(logContext, 'Daemon already running for this config; exiting without rebinding.');
    server.close();
    await runtime.close().catch(() => {});
    await disposeLogContext(logContext).catch(() => {});
    process.exit(0);
  }

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('SIGQUIT', shutdown);
}

const DAEMON_PROBE_TIMEOUT_MS = 2_000;

export async function isDaemonResponding(socketPath: string): Promise<boolean> {
  return (await probeLiveDaemon(socketPath)) !== null;
}

async function probeLiveDaemon(socketPath: string): Promise<StatusResult | null> {
  const status = await probeDaemonStatus(socketPath);
  if (!status || status.socketPath !== socketPath || !isProcessAlive(status.pid)) {
    return null;
  }
  return status;
}

export async function metadataMatches(
  metadataPath: string,
  live: Pick<StatusResult, 'pid' | 'socketPath'>
): Promise<boolean> {
  try {
    const existing = await readJsonFile<{ pid?: number; socketPath?: string }>(metadataPath);
    return existing?.pid === live.pid && existing?.socketPath === live.socketPath;
  } catch {
    return false;
  }
}

function metadataFromStatus(
  status: StatusResult,
  fallbackConfigLayers: Array<{ path: string; mtimeMs: number | null }>
): {
  pid: number;
  protocolVersion: number;
  socketPath: string;
  configPath: string;
  configLayers?: StatusResult['configLayers'];
  startedAt: number;
  logPath: string | null;
  configMtimeMs: number | null;
  definitionHash?: string;
} {
  return {
    pid: status.pid,
    protocolVersion: status.protocolVersion,
    socketPath: status.socketPath,
    configPath: status.configPath,
    configLayers: status.configLayers && status.configLayers.length > 0 ? status.configLayers : fallbackConfigLayers,
    startedAt: status.startedAt,
    logPath: status.logPath ?? null,
    configMtimeMs: status.configMtimeMs ?? null,
    definitionHash: status.definitionHash,
  };
}

function daemonConfigMatches(
  live: StatusResult,
  currentLayers: Array<{ path: string; mtimeMs: number | null }>,
  currentConfigPath: string,
  currentConfigMtimeMs: number | null,
  currentDefinitionHash: string
): boolean {
  if (live.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
    return false;
  }
  if (live.definitionHash !== currentDefinitionHash) {
    return false;
  }
  const liveLayers = normalizeLayers(
    live.configLayers && live.configLayers.length > 0
      ? live.configLayers
      : [{ path: live.configPath, mtimeMs: live.configMtimeMs ?? null }]
  );
  const expectedLayers = normalizeLayers(
    currentLayers.length > 0 ? currentLayers : [{ path: currentConfigPath, mtimeMs: currentConfigMtimeMs }]
  );
  if (liveLayers.length !== expectedLayers.length) {
    return false;
  }
  return liveLayers.every((entry, index) => {
    const expected = expectedLayers[index];
    return Boolean(expected && entry.path === expected.path && entry.mtimeMs === expected.mtimeMs);
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

async function stopLiveDaemon(socketPath: string, livePid: number): Promise<void> {
  const stopped = await sendDaemonStop(socketPath);
  if (!stopped) {
    throw new Error('Live daemon did not accept stop before rebinding.');
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(livePid)) {
      return;
    }
    await delay(100);
  }
  throw new Error('Live daemon did not stop before rebinding.');
}

async function sendDaemonStop(socketPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const request: DaemonRequest<'stop', Record<string, never>> = {
      id: randomUUID(),
      method: 'stop',
      params: {},
    };
    const socket = net.createConnection(socketPath);
    let buffer = '';
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(DAEMON_PROBE_TIMEOUT_MS, () => finish(false));
    socket.once('connect', () => {
      socket.write(JSON.stringify(request));
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
    });
    socket.once('end', () => {
      try {
        const response = JSON.parse(buffer.trim()) as DaemonResponse<boolean>;
        finish(response.ok);
      } catch {
        finish(false);
      }
    });
    socket.once('error', () => finish(false));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isProcessAlive(pid: number): boolean {
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

async function probeDaemonStatus(socketPath: string): Promise<StatusResult | null> {
  return await new Promise<StatusResult | null>((resolve) => {
    const probe = net.createConnection(socketPath);
    let buffer = '';
    let settled = false;
    const finish = (status: StatusResult | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      probe.removeAllListeners();
      probe.destroy();
      resolve(status);
    };
    const parse = (): StatusResult | null => {
      try {
        const response = JSON.parse(buffer.trim()) as DaemonResponse<StatusResult>;
        return response.ok && response.result ? response.result : null;
      } catch {
        return null;
      }
    };
    probe.setTimeout(DAEMON_PROBE_TIMEOUT_MS, () => finish(null));
    probe.once('connect', () => {
      probe.write(JSON.stringify({ id: randomUUID(), method: 'status', params: {} } satisfies DaemonRequest));
    });
    probe.on('data', (chunk) => {
      buffer += chunk.toString();
      const status = parse();
      if (status) {
        finish(status);
      }
    });
    probe.once('end', () => finish(parse()));
    probe.once('error', () => finish(null));
  });
}

async function prepareSocket(socketPath: string): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }
  try {
    await fs.unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  await fs.mkdir(path.dirname(socketPath), { recursive: true });
}

async function cleanupArtifacts(options: DaemonHostOptions): Promise<void> {
  await cleanupDaemonArtifactsIfOwned(options, process.pid);
}

export async function cleanupDaemonArtifactsIfOwned(
  paths: Pick<DaemonHostOptions, 'metadataPath' | 'socketPath'>,
  ownerPid: number
): Promise<void> {
  // A superseded daemon may finish shutting down after its replacement has
  // already rebound the same paths. Never let that old process unlink the
  // replacement daemon's live socket and metadata.
  const metadata = await readJsonFile<{ pid?: number; socketPath?: string }>(paths.metadataPath).catch(() => undefined);
  if (metadata?.pid !== ownerPid || metadata.socketPath !== paths.socketPath) {
    return;
  }
  if (process.platform !== 'win32') {
    await fs.unlink(paths.socketPath).catch(() => {});
  }
  await fs.unlink(paths.metadataPath).catch(() => {});
}

async function handleSocketRequest(
  rawPayload: string,
  socket: net.Socket,
  runtime: Runtime,
  managedServers: Map<string, ServerDefinition>,
  activity: Map<string, ServerActivity>,
  metadata: {
    configPath: string;
    configLayers: Array<{ path: string; mtimeMs: number | null }>;
    configMtimeMs: number | null;
    socketPath: string;
    protocolVersion: number;
    startedAt: number;
    logPath: string | null;
    definitionHash?: string;
  },
  logContext: LogContext,
  shutdown: () => Promise<void>,
  preParsedRequest?: DaemonRequest
): Promise<void> {
  const { response, shouldShutdown } = await processRequest(
    rawPayload,
    runtime,
    managedServers,
    activity,
    metadata,
    logContext,
    preParsedRequest
  );
  socket.write(JSON.stringify(response), () => {
    socket.end(() => {
      if (shouldShutdown) {
        void shutdown();
      }
    });
  });
}

function normalizeDaemonDisableOAuth(value: boolean | undefined): boolean {
  // Daemon messages are independent requests. Omission means the caller did
  // not request OAuth suppression, so a previous --no-oauth pooled transport
  // must not make later ordinary calls inherit the no-OAuth posture.
  return value === true;
}

async function processRequest(
  rawPayload: string,
  runtime: Runtime,
  managedServers: Map<string, ServerDefinition>,
  activity: Map<string, ServerActivity>,
  metadata: {
    configPath: string;
    configLayers: Array<{ path: string; mtimeMs: number | null }>;
    configMtimeMs: number | null;
    socketPath: string;
    protocolVersion: number;
    startedAt: number;
    logPath: string | null;
    definitionHash?: string;
  },
  logContext: LogContext,
  preParsedRequest?: DaemonRequest
): Promise<{ response: DaemonResponse; shouldShutdown: boolean }> {
  const trimmed = rawPayload.trim();
  if (!trimmed && !preParsedRequest) {
    return {
      response: buildErrorResponse('unknown', 'empty_request'),
      shouldShutdown: false,
    };
  }
  let request: DaemonRequest;
  if (preParsedRequest) {
    request = preParsedRequest;
  } else {
    try {
      request = JSON.parse(trimmed) as DaemonRequest;
    } catch (error) {
      return {
        response: buildErrorResponse('unknown', 'invalid_json', error),
        shouldShutdown: false,
      };
    }
  }
  const id = request.id ?? 'unknown';
  try {
    switch (request.method) {
      case 'callTool': {
        const params = request.params as CallToolParams;
        ensureManaged(params.server, managedServers);
        const loggable = shouldLogServer(logContext, params.server);
        if (loggable) {
          logEvent(logContext, `callTool start server=${params.server} tool=${params.tool}`);
        }
        try {
          const result = await runtime.callTool(params.server, params.tool, {
            args: params.args ?? {},
            timeoutMs: params.timeoutMs,
            disableOAuth: normalizeDaemonDisableOAuth(params.disableOAuth),
          });
          markActivity(params.server, activity);
          if (loggable) {
            logEvent(logContext, `callTool success server=${params.server} tool=${params.tool}`);
          }
          return { response: { id, ok: true, result }, shouldShutdown: false };
        } catch (error) {
          if (loggable) {
            const detail = formatError(error);
            logEvent(logContext, `callTool error server=${params.server} tool=${params.tool} err=${detail}`);
          }
          throw error;
        }
      }
      case 'listTools': {
        const params = request.params as ListToolsParams;
        ensureManaged(params.server, managedServers);
        const definition = managedServers.get(params.server)!;
        const loggable = shouldLogServer(logContext, params.server);
        if (loggable) {
          logEvent(logContext, `listTools start server=${params.server}`);
        }
        try {
          const result = await runtime.listTools(params.server, {
            includeSchema: params.includeSchema,
            autoAuthorize: resolveDaemonListToolsAutoAuthorize(params, definition),
            allowCachedAuth: params.allowCachedAuth ?? true,
            disableOAuth: normalizeDaemonDisableOAuth(params.disableOAuth),
            timeoutMs: params.timeoutMs,
          });
          markActivity(params.server, activity);
          if (loggable) {
            logEvent(logContext, `listTools success server=${params.server}`);
          }
          return { response: { id, ok: true, result }, shouldShutdown: false };
        } catch (error) {
          if (loggable) {
            const detail = formatError(error);
            logEvent(logContext, `listTools error server=${params.server} err=${detail}`);
          }
          throw error;
        }
      }
      case 'listResources': {
        const params = request.params as ListResourcesParams;
        ensureManaged(params.server, managedServers);
        const loggable = shouldLogServer(logContext, params.server);
        if (loggable) {
          logEvent(logContext, `listResources start server=${params.server}`);
        }
        try {
          const result = await runtime.listResources(params.server, {
            ...params.params,
            allowCachedAuth: params.allowCachedAuth,
            disableOAuth: normalizeDaemonDisableOAuth(params.disableOAuth),
          });
          markActivity(params.server, activity);
          if (loggable) {
            logEvent(logContext, `listResources success server=${params.server}`);
          }
          return { response: { id, ok: true, result }, shouldShutdown: false };
        } catch (error) {
          if (loggable) {
            const detail = formatError(error);
            logEvent(logContext, `listResources error server=${params.server} err=${detail}`);
          }
          throw error;
        }
      }
      case 'readResource': {
        const params = request.params as ReadResourceParams;
        ensureManaged(params.server, managedServers);
        const loggable = shouldLogServer(logContext, params.server);
        if (loggable) {
          logEvent(logContext, `readResource start server=${params.server} uri=${params.uri}`);
        }
        try {
          const result = await runtime.readResource(params.server, params.uri, {
            allowCachedAuth: params.allowCachedAuth,
            disableOAuth: normalizeDaemonDisableOAuth(params.disableOAuth),
          });
          markActivity(params.server, activity);
          if (loggable) {
            logEvent(logContext, `readResource success server=${params.server}`);
          }
          return { response: { id, ok: true, result }, shouldShutdown: false };
        } catch (error) {
          if (loggable) {
            const detail = formatError(error);
            logEvent(logContext, `readResource error server=${params.server} err=${detail}`);
          }
          throw error;
        }
      }
      case 'closeServer': {
        const params = request.params as CloseServerParams;
        ensureManaged(params.server, managedServers);
        const loggable = shouldLogServer(logContext, params.server);
        if (loggable) {
          logEvent(logContext, `closeServer start server=${params.server}`);
        }
        try {
          await runtime.close(params.server);
          activity.set(params.server, { connected: false });
          if (loggable) {
            logEvent(logContext, `closeServer success server=${params.server}`);
          }
          return {
            response: { id, ok: true, result: true },
            shouldShutdown: false,
          };
        } catch (error) {
          if (loggable) {
            const detail = formatError(error);
            logEvent(logContext, `closeServer error server=${params.server} err=${detail}`);
          }
          throw error;
        }
      }
      case 'status': {
        const result: StatusResult = {
          pid: process.pid,
          protocolVersion: metadata.protocolVersion,
          startedAt: metadata.startedAt,
          configPath: metadata.configPath,
          configLayers: metadata.configLayers,
          configMtimeMs: metadata.configMtimeMs,
          definitionHash: metadata.definitionHash,
          socketPath: metadata.socketPath,
          logPath: metadata.logPath ?? undefined,
          servers: Array.from(managedServers.values()).map((def) => {
            const entry = activity.get(def.name);
            return {
              name: def.name,
              connected: Boolean(entry?.connected),
              lastUsedAt: entry?.lastUsedAt,
            };
          }),
        };
        return { response: { id, ok: true, result }, shouldShutdown: false };
      }
      case 'stop': {
        logEvent(logContext, 'Received stop request.');
        return {
          response: { id, ok: true, result: true },
          shouldShutdown: true,
        };
      }
      default:
        return {
          response: buildErrorResponse(id, 'unknown_method'),
          shouldShutdown: false,
        };
    }
  } catch (error) {
    return {
      response: buildErrorResponse(id, 'runtime_error', error),
      shouldShutdown: false,
    };
  }
}

function resolveDaemonListToolsAutoAuthorize(
  params: ListToolsParams,
  definition: ServerDefinition
): boolean | undefined {
  if (params.autoAuthorize === false && definition.command.kind === 'stdio') {
    return undefined;
  }
  return params.autoAuthorize;
}

export async function __testProcessRequest(
  rawPayload: string,
  runtime: Runtime,
  managedServers: Map<string, ServerDefinition>,
  activity: Map<string, ServerActivity>,
  metadata: {
    configPath: string;
    configLayers: Array<{ path: string; mtimeMs: number | null }>;
    configMtimeMs: number | null;
    socketPath: string;
    protocolVersion?: number;
    startedAt: number;
    logPath: string | null;
    definitionHash?: string;
  },
  logContext: LogContext,
  preParsedRequest?: DaemonRequest
): Promise<{ response: DaemonResponse; shouldShutdown: boolean }> {
  return await processRequest(
    rawPayload,
    runtime,
    managedServers,
    activity,
    { ...metadata, protocolVersion: metadata.protocolVersion ?? DAEMON_PROTOCOL_VERSION },
    logContext,
    preParsedRequest
  );
}
