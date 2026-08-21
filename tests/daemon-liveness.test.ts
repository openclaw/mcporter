import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { DaemonClient } from '../src/daemon/client.js';
import { __testHandleSocketRequest } from '../src/daemon/host.js';
import {
  DAEMON_PROTOCOL_VERSION,
  DaemonFrameDecoder,
  encodeDaemonFrame,
  resolveProgressTiming,
  type DaemonRequest,
} from '../src/daemon/protocol.js';
import type { Runtime } from '../src/runtime.js';
import { makeShortTempDir } from './fixtures/test-helpers.js';

const describeUnixSocket = process.platform === 'win32' ? describe.skip : describe;

describe('daemon frame protocol', () => {
  it('bounds progress frequency for short and long idle budgets', () => {
    expect(resolveProgressTiming(1)).toEqual({ progressIntervalMs: 25, idleTimeoutMs: 100 });
    expect(resolveProgressTiming(60)).toEqual({ progressIntervalMs: 25, idleTimeoutMs: 100 });
    expect(resolveProgressTiming(900)).toEqual({ progressIntervalMs: 250, idleTimeoutMs: 900 });
  });

  it('decodes split and coalesced frames and reports malformed lines', () => {
    const decoder = new DaemonFrameDecoder();
    const progress = encodeDaemonFrame({ type: 'progress', id: 'one' });
    const response = encodeDaemonFrame({ id: 'one', ok: true, result: ['done'] });

    expect(decoder.push(progress.slice(0, 8))).toEqual([]);
    expect(decoder.push(`${progress.slice(8)}not-json\n${response.slice(0, -1)}`)).toEqual([
      { type: 'progress', id: 'one' },
    ]);
    expect(decoder.flush()).toEqual([{ id: 'one', ok: true, result: ['done'] }]);
    expect(decoder.malformed).toBe(true);
  });
});

describeUnixSocket('daemon socket liveness', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('keeps a request alive past its flat deadline while progress arrives', async () => {
    const idleTimeoutMs = 60;
    const operationMs = 240;
    const listTools = vi.fn(async () => {
      await delay(operationMs);
      return [{ name: 'authorized' }];
    });
    const served = await serveSocket(async (socket, request) => {
      await __testHandleSocketRequest(
        socket,
        request,
        { listTools } as unknown as Runtime,
        managedServers(),
        metadata(served.socketPath)
      );
    });
    cleanups.push(served.close);
    const client = clientForSocket(served.socketPath);

    const startedAt = Date.now();
    const result = await sendRequest(client, 'listTools', { server: 'oauth' }, idleTimeoutMs);

    expect(result).toEqual([{ name: 'authorized' }]);
    expect(Date.now() - startedAt).toBeGreaterThan(idleTimeoutMs * 3);
    expect(listTools).toHaveBeenCalledTimes(1);
  });

  it('keeps a tiny-timeout request alive at the minimum progress cadence', async () => {
    const listTools = vi.fn(async () => {
      await delay(180);
      return [{ name: 'tiny-timeout' }];
    });
    const served = await serveSocket(async (socket, request) => {
      await __testHandleSocketRequest(
        socket,
        request,
        { listTools } as unknown as Runtime,
        managedServers(),
        metadata(served.socketPath)
      );
    });
    cleanups.push(served.close);
    const client = clientForSocket(served.socketPath);

    await expect(sendRequest(client, 'listTools', { server: 'oauth' }, 1)).resolves.toEqual([{ name: 'tiny-timeout' }]);
    expect(listTools).toHaveBeenCalledTimes(1);
  });

  it('destroys a genuinely silent daemon socket at the idle deadline', async () => {
    let observedClose!: () => void;
    const closed = new Promise<void>((resolve) => {
      observedClose = resolve;
    });
    const served = await serveSocket(async (socket) => {
      socket.once('close', () => observedClose());
    });
    cleanups.push(served.close);
    const client = clientForSocket(served.socketPath);

    await expect(
      Promise.race([
        sendRequest(client, 'listTools', { server: 'oauth' }, 1),
        delay(300).then(() => {
          throw new Error('silent daemon socket was not torn down');
        }),
      ])
    ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    await expect(Promise.race([closed, delay(300).then(() => 'still-open')])).resolves.toBeUndefined();
  });

  it('accepts a bare v1 response and retains the flat fallback deadline', async () => {
    let receivedRequest: DaemonRequest | undefined;
    const served = await serveSocket(async (socket, request) => {
      receivedRequest = request;
      await delay(30);
      socket.end(JSON.stringify({ id: request.id, ok: true, result: 'legacy' }));
    });
    cleanups.push(served.close);
    const client = clientForSocket(served.socketPath);

    await expect(sendRequest(client, 'status', {}, 100)).resolves.toBe('legacy');
    expect(receivedRequest).toMatchObject({
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      progressIntervalMs: expect.any(Number),
    });
  });

  it('sends one old-parser-safe response when a v1 client does not opt into progress', async () => {
    const served = await serveSocket(async (socket, request) => {
      await __testHandleSocketRequest(
        socket,
        request,
        { listTools: vi.fn().mockResolvedValue([{ name: 'legacy-client' }]) } as unknown as Runtime,
        managedServers(),
        metadata(served.socketPath)
      );
    });
    cleanups.push(served.close);

    const payload = await rawRequest(served.socketPath, {
      id: 'v1-client',
      method: 'listTools',
      params: { server: 'oauth' },
    });

    expect(JSON.parse(payload.trim())).toEqual({
      id: 'v1-client',
      ok: true,
      result: [{ name: 'legacy-client' }],
    });
    expect(payload.trim().split('\n')).toHaveLength(1);
  });

  it('clamps a raw client progress interval before starting the frame timer', async () => {
    const served = await serveSocket(async (socket, request) => {
      await __testHandleSocketRequest(
        socket,
        request,
        {
          listTools: async () => {
            await delay(80);
            return [{ name: 'bounded' }];
          },
        } as unknown as Runtime,
        managedServers(),
        metadata(served.socketPath)
      );
    });
    cleanups.push(served.close);

    const payload = await rawRequest(served.socketPath, {
      id: 'bounded-progress',
      method: 'listTools',
      params: { server: 'oauth' },
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      progressIntervalMs: 1,
    });
    const frames = payload
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(frames.filter((frame) => frame.type === 'progress').length).toBeLessThanOrEqual(5);
    expect(frames.at(-1)).toMatchObject({ id: 'bounded-progress', ok: true });
  });
});

async function serveSocket(
  handler: (socket: net.Socket, request: DaemonRequest) => Promise<void>
): Promise<{ socketPath: string; close: () => Promise<void> }> {
  const tmpDir = await makeShortTempDir('daemon-live');
  const socketPath = path.join(tmpDir, 'd.sock');
  const openSockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    openSockets.add(socket);
    socket.once('close', () => openSockets.delete(socket));
    socket.once('error', () => {});
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      try {
        const request = JSON.parse(buffer) as DaemonRequest;
        socket.removeAllListeners('data');
        void handler(socket, request).catch((error) => socket.destroy(error as Error));
      } catch {
        // Wait for the rest of the request.
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    socketPath,
    close: async () => {
      for (const socket of openSockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(tmpDir, { recursive: true, force: true });
    },
  };
}

function clientForSocket(socketPath: string): DaemonClient {
  const client = new DaemonClient({ configPath: '/unused/config.json', configExplicit: true });
  (client as unknown as { socketPath: string }).socketPath = socketPath;
  return client;
}

function sendRequest(
  client: DaemonClient,
  method: 'listTools' | 'status',
  params: unknown,
  timeoutMs: number
): Promise<unknown> {
  return (
    client as unknown as {
      sendRequest(method: 'listTools' | 'status', params: unknown, timeoutMs: number): Promise<unknown>;
    }
  ).sendRequest(method, params, timeoutMs);
}

function rawRequest(socketPath: string, request: DaemonRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = '';
    socket.once('connect', () => socket.write(JSON.stringify(request)));
    socket.on('data', (chunk) => (response += chunk.toString()));
    socket.once('end', () => resolve(response));
    socket.once('error', reject);
  });
}

function managedServers(): Map<string, ServerDefinition> {
  return new Map([
    [
      'oauth',
      {
        name: 'oauth',
        command: { kind: 'http', url: new URL('https://example.test/mcp') },
      } as ServerDefinition,
    ],
  ]);
}

function metadata(socketPath: string) {
  return {
    configPath: '/tmp/config.json',
    configLayers: [],
    configMtimeMs: null,
    socketPath,
    startedAt: Date.now(),
    logPath: null,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
