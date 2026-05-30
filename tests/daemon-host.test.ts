import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { __testProcessRequest, isDaemonResponding } from '../src/daemon/host.js';
import type { DaemonRequest } from '../src/daemon/protocol.js';
import type { Runtime } from '../src/runtime.js';

describe('daemon host request handling', () => {
  const metadata = {
    configPath: '/tmp/config.json',
    configLayers: [],
    configMtimeMs: Date.now(),
    socketPath: '/tmp/socket',
    startedAt: Date.now(),
    logPath: null,
  };
  const logContext = { enabled: false, logAllServers: false, servers: new Set<string>() };

  it('reuses pre-parsed requests without reparsing payloads', async () => {
    const parsedRequest: DaemonRequest = { id: '1', method: 'status', params: {} };
    const result = await __testProcessRequest(
      '!!!invalid-json!!!',
      {} as Runtime,
      new Map<string, ServerDefinition>(),
      new Map(),
      metadata,
      logContext,
      parsedRequest
    );

    expect(result.response.ok).toBe(true);
    expect(result.shouldShutdown).toBe(false);
  });

  it('defaults daemon callTool and listTools requests to cached auth', async () => {
    const runtime = createRuntimeDouble();
    const managedServers = createManagedServers();

    await __testProcessRequest('', runtime as unknown as Runtime, managedServers, new Map(), metadata, logContext, {
      id: 'call',
      method: 'callTool',
      params: { server: 'oauth', tool: 'ping' },
    });

    expect(runtime.callTool).toHaveBeenCalledWith('oauth', 'ping', {
      args: {},
      timeoutMs: undefined,
    });

    await __testProcessRequest('', runtime as unknown as Runtime, managedServers, new Map(), metadata, logContext, {
      id: 'list',
      method: 'listTools',
      params: { server: 'oauth', includeSchema: true },
    });

    expect(runtime.listTools).toHaveBeenCalledWith('oauth', {
      includeSchema: true,
      autoAuthorize: undefined,
      allowCachedAuth: true,
    });
  });

  it('keeps stdio keep-alive listTools requests reusable when callers disable auto auth', async () => {
    const runtime = createRuntimeDouble();
    const managedServers = createManagedServers();

    await __testProcessRequest('', runtime as unknown as Runtime, managedServers, new Map(), metadata, logContext, {
      id: 'list',
      method: 'listTools',
      params: { server: 'local', includeSchema: true, autoAuthorize: false, allowCachedAuth: true },
    });

    expect(runtime.listTools).toHaveBeenCalledWith('local', {
      includeSchema: true,
      autoAuthorize: undefined,
      allowCachedAuth: true,
    });
  });

  it('preserves HTTP listTools auto-auth opt out on daemon requests', async () => {
    const runtime = createRuntimeDouble();
    const managedServers = createManagedServers();

    await __testProcessRequest('', runtime as unknown as Runtime, managedServers, new Map(), metadata, logContext, {
      id: 'list',
      method: 'listTools',
      params: { server: 'oauth', includeSchema: true, autoAuthorize: false, allowCachedAuth: true },
    });

    expect(runtime.listTools).toHaveBeenCalledWith('oauth', {
      includeSchema: true,
      autoAuthorize: false,
      allowCachedAuth: true,
    });
  });

  it('preserves explicit listTools cached-auth opt out on daemon requests', async () => {
    const runtime = createRuntimeDouble();
    const managedServers = createManagedServers();

    await __testProcessRequest('', runtime as unknown as Runtime, managedServers, new Map(), metadata, logContext, {
      id: 'list',
      method: 'listTools',
      params: { server: 'oauth', allowCachedAuth: false },
    });

    expect(runtime.listTools).toHaveBeenCalledWith('oauth', {
      includeSchema: undefined,
      autoAuthorize: undefined,
      allowCachedAuth: false,
    });
  });
});

// Unix-domain socket servers can't bind a filesystem path on Windows; the daemon uses named pipes there.
const describeUnixSocket = process.platform === 'win32' ? describe.skip : describe;

describeUnixSocket('isDaemonResponding', () => {
  const servers: net.Server[] = [];
  const connections: net.Socket[] = [];
  const socketPaths: string[] = [];

  function socketPath(): string {
    const p = path.join(os.tmpdir(), `mcporter-probe-${randomUUID().slice(0, 8)}.sock`);
    socketPaths.push(p);
    return p;
  }

  function listen(server: net.Server, p: string): Promise<void> {
    servers.push(server);
    server.on('connection', (socket) => connections.push(socket));
    return new Promise((resolve) => server.listen(p, () => resolve()));
  }

  afterEach(async () => {
    for (const socket of connections.splice(0)) {
      socket.destroy();
    }
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const p of socketPaths.splice(0)) {
      await fs.rm(p, { force: true }).catch(() => {});
    }
  });

  function statusServer(result: Record<string, unknown>): net.Server {
    return net.createServer((socket) => {
      socket.on('data', () => socket.end(JSON.stringify({ id: '1', ok: true, result })));
    });
  }

  it('returns true when the socket answers status with a matching socket and live pid', async () => {
    const p = socketPath();
    await listen(statusServer({ pid: process.pid, socketPath: p }), p);
    expect(await isDaemonResponding(p)).toBe(true);
  });

  it('returns false when the socket accepts but never responds (hung daemon)', async () => {
    const p = socketPath();
    await listen(
      net.createServer(() => {
        // Accept the connection but never reply, mimicking a daemon whose event loop is blocked.
      }),
      p
    );
    expect(await isDaemonResponding(p)).toBe(false);
  }, 5_000);

  it('returns false when status reports a different socket (foreign listener)', async () => {
    const p = socketPath();
    await listen(statusServer({ pid: process.pid, socketPath: '/some/other/daemon.sock' }), p);
    expect(await isDaemonResponding(p)).toBe(false);
  });

  it('returns false when status reports a dead pid', async () => {
    const p = socketPath();
    await listen(statusServer({ pid: 2_147_483_646, socketPath: p }), p);
    expect(await isDaemonResponding(p)).toBe(false);
  });

  it('returns false when nothing is listening', async () => {
    expect(await isDaemonResponding(socketPath())).toBe(false);
  });
});

function createRuntimeDouble(): Pick<Runtime, 'callTool' | 'listTools'> {
  return {
    callTool: vi.fn().mockResolvedValue({ ok: true }),
    listTools: vi.fn().mockResolvedValue([]),
  };
}

function createManagedServers(): Map<string, ServerDefinition> {
  return new Map([
    [
      'local',
      {
        name: 'local',
        command: { kind: 'stdio', command: 'node', args: ['server.js'], cwd: '/tmp' },
        lifecycle: { mode: 'keep-alive' },
      },
    ],
    [
      'oauth',
      {
        name: 'oauth',
        command: { kind: 'http', url: new URL('https://oauth.example.com/mcp') },
        lifecycle: { mode: 'keep-alive' },
      },
    ],
  ]);
}
