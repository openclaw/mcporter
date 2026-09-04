import fs from 'node:fs/promises';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { withFileLock, writeJsonFile } from '../fs-json.js';
import { DaemonBroker, BrokerError } from './broker.js';
import { canonicalUserConfiguration } from './browser-owner.js';
import { assertLegacyDrained } from './migration.js';
import { ProcessObservationError } from './process-retirement.js';
import { secureDaemonDirectory } from './paths.js';
import { authenticateServer, daemonKey, requestDaemon, SocketFrames } from './socket-rpc.js';
import { createLogContext, disposeLogContext, logEvent } from './log-context.js';
import { DAEMON_PROTOCOL_VERSION, resolveProgressInterval, type DaemonRequest, type StatusResult } from './protocol.js';

export interface DaemonHostOptions {
  readonly socketPath: string;
  readonly metadataPath: string;
  readonly configPath: string;
  readonly configExplicit?: boolean;
  readonly rootDir?: string;
  readonly logPath?: string;
  readonly logServers?: Set<string>;
  readonly logAllServers?: boolean;
}
export interface DaemonHostHandle {
  close(): Promise<void>;
  status(): StatusResult;
}

export async function runDaemonHost(options: DaemonHostOptions): Promise<DaemonHostHandle> {
  await secureDaemonDirectory();
  await assertLegacyDrained();
  const key = await daemonKey();
  const canonical = await canonicalUserConfiguration();
  const broker = new DaemonBroker(canonical.definitions);
  const log = createLogContext({
    enabled: Boolean(options.logPath),
    logPath: options.logPath,
    logAllServers: options.logAllServers ?? false,
    servers: options.logServers ?? new Set(),
  });
  const startedAt = Date.now();
  const status = (): StatusResult => ({
    pid: process.pid,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    startedAt,
    configPath: '',
    socketPath: options.socketPath,
    logPath: options.logPath,
    ...broker.status(),
    idleTimeoutMs: canonical.idleTimeoutMs,
    idleShutdownBlocked: !broker.canIdleShutdown(),
  });
  let shuttingDown = false;
  let closing: Promise<void> | undefined;
  let lastActivity = Date.now();
  let idleTimer: NodeJS.Timeout | undefined;
  const onSignal = () => {
    void close().catch(() => {});
  };
  const close = (): Promise<void> => {
    closing ??= (async () => {
      await broker.close();
      shuttingDown = true;
      clearTimeout(idleTimer);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      server.close();
      await cleanupDaemonArtifactsIfOwned(options, process.pid);
      await disposeLogContext(log);
      key.fill(0);
    })().catch((error: unknown) => {
      closing = undefined;
      throw error;
    });
    return closing;
  };
  const server = net.createServer((socket) => {
    const frames = new SocketFrames(socket);
    socket.setTimeout(30_000, () => socket.destroy());
    void (async () => {
      try {
        await authenticateServer(frames, key);
      } catch {
        socket.destroy();
        return;
      }
      let timer: NodeJS.Timeout | undefined;
      let id = 'invalid';
      try {
        const request = (await frames.read()) as DaemonRequest;
        id = typeof request?.id === 'string' && request.id.length <= 256 ? request.id : 'invalid';
        if (id === 'invalid' || !request || typeof request.params !== 'object' || !request.params)
          throw new BrokerError('invalid_request', 'Invalid daemon request.');
        if (request.protocolVersion !== DAEMON_PROTOCOL_VERSION)
          throw new BrokerError('incompatible_daemon', 'Upgrade all invoking clients before cutover.');
        socket.setTimeout(0);
        lastActivity = Date.now();
        if (typeof request.progressIntervalMs === 'number' && Number.isFinite(request.progressIntervalMs))
          timer = setInterval(() => {
            if (!socket.destroyed) frames.write({ type: 'progress', id });
          }, resolveProgressInterval(request.progressIntervalMs));
        let result: unknown;
        let notices: string[] = [];
        switch (request.method) {
          case 'status':
            result = status();
            break;
          case 'registerView':
            result = broker.register(request.params);
            break;
          case 'releaseView':
            broker.release(request);
            result = true;
            break;
          case 'stop':
            await close();
            result = true;
            break;
          default:
            logEvent(log, `${request.method} start`);
            ({ result, notices } = await broker.invokeWithNotices(request));
            logEvent(log, `${request.method} success`);
        }
        frames.write({ id, ok: true, result, notices });
        socket.end();
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'runtime_error';
        const message =
          error instanceof BrokerError || error instanceof ProcessObservationError || code === 'browser_owner_conflict'
            ? (error as Error).message
            : `MCP operation failed (${code}); the request was not replayed.`;
        frames.write({ id, ok: false, error: { code, message } });
        socket.end();
      } finally {
        lastActivity = Date.now();
        if (timer) clearInterval(timer);
      }
    })().catch(() => socket.destroy());
  });
  let claimed = false;
  await withFileLock(options.metadataPath, async () => {
    let live: StatusResult | undefined;
    try {
      const response = await requestDaemon<StatusResult>(
        options.socketPath,
        { id: randomUUID(), method: 'status', params: {}, protocolVersion: DAEMON_PROTOCOL_VERSION },
        1000
      );
      if (!response.ok || response.result?.protocolVersion !== DAEMON_PROTOCOL_VERSION)
        throw new Error('Incompatible daemon owns the socket.');
      live = response.result;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error;
    }
    if (live) {
      await writeJsonFile(options.metadataPath, live);
      return;
    }
    const metadata = await fs
      .readFile(options.metadataPath, 'utf8')
      .then((value) => JSON.parse(value) as { pid: number })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
    if (metadata)
      throw new BrokerError(
        'daemon_unresponsive',
        'Previous daemon retirement is unverified; inspect its transports before deliberate recovery.'
      );
    if (process.platform !== 'win32')
      await fs.unlink(options.socketPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (process.platform !== 'win32') await fs.chmod(options.socketPath, 0o600);
    await writeJsonFile(options.metadataPath, status());
    claimed = true;
  });
  if (!claimed) {
    server.close();
    await disposeLogContext(log);
    key.fill(0);
    return { close: async () => {}, status };
  }
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  if (canonical.idleTimeoutMs) {
    const timeout = canonical.idleTimeoutMs;
    const checkIdle = () => {
      if (shuttingDown) return;
      if (Date.now() - lastActivity >= timeout && broker.canIdleShutdown()) {
        void close().catch(() => logEvent(log, 'idle shutdown blocked: transport retirement failed'));
        return;
      }
      idleTimer = setTimeout(checkIdle, timeout);
      idleTimer.unref();
    };
    idleTimer = setTimeout(checkIdle, timeout);
    idleTimer.unref();
  }
  return { close, status };
}

export async function cleanupDaemonArtifactsIfOwned(
  paths: Pick<DaemonHostOptions, 'metadataPath' | 'socketPath'>,
  ownerPid: number
): Promise<void> {
  const metadata = await fs
    .readFile(paths.metadataPath, 'utf8')
    .then((raw) => JSON.parse(raw) as { pid: number; socketPath: string })
    .catch(() => undefined);
  if (metadata?.pid !== ownerPid || metadata.socketPath !== paths.socketPath) return;
  if (process.platform !== 'win32')
    await fs.unlink(paths.socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  await fs.unlink(paths.metadataPath);
}
