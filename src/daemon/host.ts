import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { loadDaemonConfig, type ServerDefinition } from '../config.js';
import { withFileLock, writeJsonFile } from '../fs-json.js';
import { isKeepAliveServer } from '../lifecycle.js';
import { createRuntime, type Runtime } from '../runtime.js';
import { collectConfigLayers, statConfigMtime } from './config-layers.js';
import {
  createLogContext,
  disposeLogContext,
  formatError,
  type LogContext,
  logEvent,
  shouldLogServer,
} from './log-context.js';
import type {
  CallToolParams,
  CloseServerParams,
  DaemonRequest,
  DaemonResponse,
  ListResourcesParams,
  ListToolsParams,
  ReadResourceParams,
  StatusResult,
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
          startedAt,
          logPath: options.logPath ?? null,
          configMtimeMs,
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

  // Separate lock from the client's metadata lock so a client awaiting readiness can't deadlock the bind.
  let claimed = false;
  await withFileLock(`${options.metadataPath}.bind`, async () => {
    if (await isDaemonResponding(options.socketPath)) {
      return;
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
      socketPath: options.socketPath,
      configPath: options.configPath,
      configLayers,
      startedAt: Date.now(),
      logPath: options.logPath ?? null,
      configMtimeMs,
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

// Connect-only is not enough: a hung daemon still has its socket in listen(2), so the kernel accepts the
// connection. Require a status response that reports this socket and a live pid, matching the client's liveness
// contract, so a hung/dead/foreign listener falls through to rebind instead of stranding the caller.
export async function isDaemonResponding(socketPath: string): Promise<boolean> {
  const status = await probeDaemonStatus(socketPath);
  if (!status || status.socketPath !== socketPath) {
    return false;
  }
  return isProcessAlive(status.pid);
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
  if (process.platform !== 'win32') {
    try {
      await fs.unlink(options.socketPath);
    } catch {
      // ignore
    }
  }
  try {
    await fs.unlink(options.metadataPath);
  } catch {
    // ignore
  }
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
    startedAt: number;
    logPath: string | null;
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
    startedAt: number;
    logPath: string | null;
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
          const result = await runtime.listResources(params.server, params.params);
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
          const result = await runtime.readResource(params.server, params.uri);
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
          startedAt: metadata.startedAt,
          configPath: metadata.configPath,
          configLayers: metadata.configLayers,
          configMtimeMs: metadata.configMtimeMs,
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
    startedAt: number;
    logPath: string | null;
  },
  logContext: LogContext,
  preParsedRequest?: DaemonRequest
): Promise<{ response: DaemonResponse; shouldShutdown: boolean }> {
  return await processRequest(rawPayload, runtime, managedServers, activity, metadata, logContext, preParsedRequest);
}
