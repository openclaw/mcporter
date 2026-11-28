import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { expandHome } from '../env.js';
import { randomUUID } from 'node:crypto';
import { withFileLock } from '../fs-json.js';
import { authenticateServer, daemonKey, requestDaemon, SocketFrames } from './socket-rpc.js';
import { DAEMON_PROTOCOL_VERSION, type DaemonRequest } from './protocol.js';
import { readLifecycle } from './lifecycle-state.js';

export function decodeBootstrapEnvironment(value: unknown): NodeJS.ProcessEnv {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid daemon bootstrap environment.');
  const entries = Object.entries(value);
  if (
    entries.length > 4096 ||
    entries.some(([name, item]) => !/^[^=\0]+$/.test(name) || typeof item !== 'string' || item.includes('\0'))
  )
    throw new Error('Invalid daemon bootstrap environment.');
  return Object.fromEntries(entries) as NodeJS.ProcessEnv;
}
export async function sendBootstrap(socketPath: string, generation: string): Promise<void> {
  const result = await requestDaemon(
    socketPath,
    {
      id: randomUUID(),
      method: 'bootstrap',
      generation,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      params: {
        environment: {
          ...process.env,
          ...(process.env.MCPORTER_DAEMON_LOG_PATH
            ? { MCPORTER_DAEMON_LOG_PATH: path.resolve(expandHome(process.env.MCPORTER_DAEMON_LOG_PATH)) }
            : {}),
        },
      },
    },
    2000,
    2000
  );
  if (!result.ok) throw new Error(result.error?.message ?? 'Daemon bootstrap rejected.');
}
/** Use the ordinary authenticated endpoint before loading configuration or opening any MCP transport. */
export async function receiveBootstrap(options: {
  socketPath: string;
  metadataPath: string;
  generation: string;
}): Promise<void> {
  const key = await daemonKey();
  let accepted = false;
  const environment = await new Promise<NodeJS.ProcessEnv>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Daemon bootstrap deadline exceeded.'));
    }, 20000);
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      const absolute = setTimeout(() => socket.destroy(), 2000);
      socket.once('close', () => {
        clearTimeout(absolute);
        sockets.delete(socket);
      });
      socket.setTimeout(2000, () => socket.destroy());
      const frames = new SocketFrames(socket);
      void (async () => {
        await authenticateServer(frames, key);
        const request = (await frames.read()) as DaemonRequest<'bootstrap', { environment: unknown }>;
        if (
          request.method !== 'bootstrap' ||
          request.protocolVersion !== DAEMON_PROTOCOL_VERSION ||
          request.generation !== options.generation ||
          accepted
        )
          throw new Error('Daemon is waiting for its generation bootstrap.');
        const env = decodeBootstrapEnvironment(request.params?.environment);
        await withFileLock(options.metadataPath, async () => {
          const state = await readLifecycle();
          if (accepted) throw new Error('Daemon bootstrap already accepted.');
          if (state.active?.generation !== options.generation || state.active.phase !== 'starting')
            throw new Error('Daemon launch reservation expired.');
          accepted = true;
        });
        clearTimeout(timer);
        frames.write({ id: request.id, ok: true, result: true });
        socket.end();
        for (const pending of sockets) if (pending !== socket) pending.destroy();
        server.close(() => resolve(env));
      })().catch(() => socket.destroy());
    });
    server.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    void (async () => {
      // A delayed launch may not unlink the endpoint of a successor.
      await withFileLock(options.metadataPath, async () => {
        const state = await readLifecycle();
        if (state.active?.generation !== options.generation || state.active.phase !== 'starting')
          throw new Error('Daemon launch reservation expired.');
        if (process.platform !== 'win32')
          await fs.unlink(options.socketPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
        await new Promise<void>((ready, fail) => {
          server.once('error', fail);
          server.listen(options.socketPath, ready);
        });
        if (process.platform !== 'win32') await fs.chmod(options.socketPath, 0o600);
      });
    })().catch((error) => {
      clearTimeout(timer);
      server.close();
      reject(error);
    });
  }).finally(() => key.fill(0));
  const internal = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      /^MCPORTER_DAEMON_(DIR|CHILD|WORKER|GENERATION|SOCKET|METADATA)$/.test(name)
    )
  );
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, environment, internal, { MCPORTER_DISABLE_AUTORUN: '0' });
}
