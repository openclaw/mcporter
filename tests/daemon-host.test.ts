import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import {
  __daemonHostInternals,
  __testProcessRequest,
  cleanupDaemonArtifactsIfOwned,
  isDaemonResponding,
  metadataMatches,
  runDaemonHost,
} from '../src/daemon/host.js';
import type { DaemonRequest, DaemonResponse, StatusResult } from '../src/daemon/protocol.js';
import type { Runtime } from '../src/runtime.js';

const describeUnixSocket = process.platform === 'win32' ? describe.skip : describe;

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
      disableOAuth: false,
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
      disableOAuth: false,
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
      disableOAuth: false,
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
      disableOAuth: false,
    });
  });

  it('forwards disableOAuth on daemon callTool and listTools requests', async () => {
    const runtime = createRuntimeDouble();
    const managedServers = createManagedServers();

    await __testProcessRequest('', runtime as unknown as Runtime, managedServers, new Map(), metadata, logContext, {
      id: 'call',
      method: 'callTool',
      params: { server: 'oauth', tool: 'ping', disableOAuth: true },
    });

    expect(runtime.callTool).toHaveBeenCalledWith('oauth', 'ping', {
      args: {},
      timeoutMs: undefined,
      disableOAuth: true,
    });

    await __testProcessRequest('', runtime as unknown as Runtime, managedServers, new Map(), metadata, logContext, {
      id: 'list',
      method: 'listTools',
      params: { server: 'oauth', includeSchema: true, disableOAuth: true },
    });

    expect(runtime.listTools).toHaveBeenCalledWith('oauth', {
      includeSchema: true,
      autoAuthorize: undefined,
      allowCachedAuth: true,
      disableOAuth: true,
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
      disableOAuth: false,
    });
  });

  it('dispatches resource, close, status, stop, and malformed requests with observable state', async () => {
    const runtime = createFullRuntimeDouble();
    const managedServers = createManagedServers();
    const activity = new Map([['oauth', { connected: false }]]);

    const listed = await __testProcessRequest(
      JSON.stringify({
        id: 'resources',
        method: 'listResources',
        params: { server: 'oauth', params: { cursor: 'next' }, allowCachedAuth: false, disableOAuth: true },
      }),
      runtime as unknown as Runtime,
      managedServers,
      activity,
      metadata,
      logContext
    );
    expect(listed.response).toMatchObject({ id: 'resources', ok: true, result: { resources: ['one'] } });
    expect(runtime.listResources).toHaveBeenCalledWith('oauth', {
      cursor: 'next',
      allowCachedAuth: false,
      disableOAuth: true,
    });

    const read = await __testProcessRequest(
      '',
      runtime as unknown as Runtime,
      managedServers,
      activity,
      metadata,
      logContext,
      {
        id: 'read',
        method: 'readResource',
        params: { server: 'oauth', uri: 'memo://one', allowCachedAuth: true },
      }
    );
    expect(read.response.result).toEqual({ contents: [{ uri: 'memo://one', text: 'value' }] });
    expect(runtime.readResource).toHaveBeenCalledWith('oauth', 'memo://one', {
      allowCachedAuth: true,
      disableOAuth: false,
    });
    expect(activity.get('oauth')).toMatchObject({ connected: true, lastUsedAt: expect.any(Number) });

    const status = await __testProcessRequest(
      '',
      runtime as unknown as Runtime,
      managedServers,
      activity,
      metadata,
      logContext,
      {
        id: 'status',
        method: 'status',
        params: {},
      }
    );
    expect(status.response.result).toMatchObject({
      configPath: metadata.configPath,
      socketPath: metadata.socketPath,
      servers: expect.arrayContaining([
        expect.objectContaining({ name: 'oauth', connected: true, lastUsedAt: expect.any(Number) }),
        expect.objectContaining({ name: 'local', connected: false }),
      ]),
    });

    const closed = await __testProcessRequest(
      '',
      runtime as unknown as Runtime,
      managedServers,
      activity,
      metadata,
      logContext,
      {
        id: 'close',
        method: 'closeServer',
        params: { server: 'oauth' },
      }
    );
    expect(closed.response).toMatchObject({ id: 'close', ok: true, result: true });
    expect(runtime.close).toHaveBeenCalledWith('oauth');
    expect(activity.get('oauth')).toEqual({ connected: false });

    const stopped = await __testProcessRequest(
      '',
      runtime as unknown as Runtime,
      managedServers,
      activity,
      metadata,
      logContext,
      {
        id: 'stop',
        method: 'stop',
        params: {},
      }
    );
    expect(stopped).toMatchObject({ response: { id: 'stop', ok: true }, shouldShutdown: true });

    const empty = await __testProcessRequest(
      '',
      runtime as unknown as Runtime,
      managedServers,
      activity,
      metadata,
      logContext
    );
    const invalid = await __testProcessRequest(
      '{bad',
      runtime as unknown as Runtime,
      managedServers,
      activity,
      metadata,
      logContext
    );
    const unknown = await __testProcessRequest(
      JSON.stringify({ id: 'mystery', method: 'mystery', params: {} }),
      runtime as unknown as Runtime,
      managedServers,
      activity,
      metadata,
      logContext
    );
    expect(empty.response.error?.code).toBe('empty_request');
    expect(invalid.response.error?.code).toBe('invalid_json');
    expect(unknown.response.error?.code).toBe('unknown_method');
  });

  it('maps unmanaged servers and runtime failures to daemon errors and records log context', async () => {
    const runtime = createFullRuntimeDouble();
    runtime.callTool.mockRejectedValue(new Error('tool exploded'));
    runtime.listTools.mockRejectedValue('list exploded');
    const managedServers = createManagedServers();
    const logged = { enabled: true, logAllServers: false, servers: new Set(['oauth']) };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const tool = await __testProcessRequest(
        '',
        runtime as unknown as Runtime,
        managedServers,
        new Map(),
        metadata,
        logged,
        {
          id: 'tool-error',
          method: 'callTool',
          params: { server: 'oauth', tool: 'fail' },
        }
      );
      const list = await __testProcessRequest(
        '',
        runtime as unknown as Runtime,
        managedServers,
        new Map(),
        metadata,
        logged,
        {
          id: 'list-error',
          method: 'listTools',
          params: { server: 'oauth' },
        }
      );
      const unmanaged = await __testProcessRequest(
        '',
        runtime as unknown as Runtime,
        managedServers,
        new Map(),
        metadata,
        logged,
        {
          id: 'unmanaged',
          method: 'readResource',
          params: { server: 'missing', uri: 'memo://one' },
        }
      );

      expect(tool.response).toMatchObject({ ok: false, error: { code: 'runtime_error', message: 'tool exploded' } });
      expect(list.response).toMatchObject({ ok: false, error: { code: 'runtime_error', message: 'list exploded' } });
      expect(unmanaged.response.error?.message).toContain("Server 'missing' is not managed");
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('callTool start server=oauth tool=fail'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('callTool error server=oauth tool=fail'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('listTools error server=oauth'));
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describeUnixSocket('runDaemonHost lifecycle', () => {
  it('claims a socket, serves split status requests, repairs metadata, and stops cleanly', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-host-lifecycle-'));
    const configPath = path.join(dir, 'mcporter.json');
    const metadataPath = path.join(dir, 'daemon.json');
    const socketPath = path.join(dir, 'daemon.sock');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          local: { command: 'node', args: ['unused-server.js'], lifecycle: 'keep-alive' },
        },
      }),
      'utf8'
    );
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const originalSignals = new Map(
      (['SIGINT', 'SIGTERM', 'SIGQUIT'] as const).map((signal) => [signal, new Set(process.listeners(signal))])
    );

    try {
      await runDaemonHost({ socketPath, metadataPath, configPath, configExplicit: true, rootDir: dir });
      const metadataFile = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as {
        pid: number;
        socketPath: string;
        definitionHash: string;
      };
      expect(metadataFile).toMatchObject({ pid: process.pid, socketPath });
      expect(metadataFile.definitionHash).toMatch(/^[a-f0-9]+$/u);

      const status = await requestDaemon<StatusResult>(
        socketPath,
        {
          id: 'status',
          method: 'status',
          params: {},
        },
        true
      );
      expect(status).toMatchObject({
        id: 'status',
        ok: true,
        result: {
          pid: process.pid,
          socketPath,
          configPath,
          servers: [{ name: 'local', connected: false }],
        },
      });

      await fs.rm(metadataPath, { force: true });
      await runDaemonHost({ socketPath, metadataPath, configPath, configExplicit: true, rootDir: dir });
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(JSON.parse(await fs.readFile(metadataPath, 'utf8'))).toMatchObject({ pid: process.pid, socketPath });

      const stopped = await requestDaemon<boolean>(socketPath, { id: 'stop', method: 'stop', params: {} });
      expect(stopped).toMatchObject({ id: 'stop', ok: true, result: true });
      await waitForMissing(metadataPath);
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGQUIT'] as const) {
        const originals = originalSignals.get(signal)!;
        for (const listener of process.listeners(signal)) {
          if (!originals.has(listener)) process.removeListener(signal, listener);
        }
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

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

  it('returns true when the socket answers status with a matching socket and live pid', async () => {
    const p = socketPath();
    await listen(statusServer({ pid: process.pid, socketPath: p }), p);
    expect(await isDaemonResponding(p)).toBe(true);
  });

  it('returns false when the socket accepts but never responds (hung daemon)', async () => {
    const p = socketPath();
    await listen(
      net.createServer((socket) => socket.pause()),
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

describe('metadataMatches', () => {
  let metadataPath: string;
  const live = { pid: 4321, socketPath: '/tmp/daemon.sock' };

  beforeEach(async () => {
    metadataPath = path.join(os.tmpdir(), `mcporter-meta-${randomUUID().slice(0, 8)}.json`);
  });

  afterEach(async () => {
    await fs.rm(metadataPath, { force: true }).catch(() => {});
  });

  it('matches when pid and socket agree', async () => {
    await fs.writeFile(metadataPath, JSON.stringify({ pid: 4321, socketPath: '/tmp/daemon.sock' }), 'utf8');
    expect(await metadataMatches(metadataPath, live)).toBe(true);
  });

  it('does not match a different pid', async () => {
    await fs.writeFile(metadataPath, JSON.stringify({ pid: 9999, socketPath: '/tmp/daemon.sock' }), 'utf8');
    expect(await metadataMatches(metadataPath, live)).toBe(false);
  });

  it('does not match when metadata is missing', async () => {
    expect(await metadataMatches(metadataPath, live)).toBe(false);
  });

  it('does not match when metadata is corrupt', async () => {
    await fs.writeFile(metadataPath, '{ not json', 'utf8');
    expect(await metadataMatches(metadataPath, live)).toBe(false);
  });
});

describe('daemon artifact cleanup', () => {
  let dir: string;
  let metadataPath: string;
  let socketPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-cleanup-'));
    metadataPath = path.join(dir, 'daemon.json');
    socketPath = path.join(dir, 'daemon.sock');
    await fs.writeFile(socketPath, 'socket', 'utf8');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('removes artifacts still owned by the stopping daemon', async () => {
    await fs.writeFile(metadataPath, JSON.stringify({ pid: 4321, socketPath }), 'utf8');

    await cleanupDaemonArtifactsIfOwned({ metadataPath, socketPath }, 4321);

    await expect(fs.access(metadataPath)).rejects.toThrow();
    if (process.platform === 'win32') {
      await expect(fs.access(socketPath)).resolves.toBeUndefined();
    } else {
      await expect(fs.access(socketPath)).rejects.toThrow();
    }
  });

  it('preserves artifacts replaced by a newer daemon', async () => {
    await fs.writeFile(metadataPath, JSON.stringify({ pid: 9876, socketPath }), 'utf8');

    await cleanupDaemonArtifactsIfOwned({ metadataPath, socketPath }, 4321);

    await expect(fs.access(metadataPath)).resolves.toBeUndefined();
    await expect(fs.access(socketPath)).resolves.toBeUndefined();
  });

  it('preserves the named pipe while removing owned metadata on Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    await fs.writeFile(metadataPath, JSON.stringify({ pid: 4321, socketPath }), 'utf8');

    await cleanupDaemonArtifactsIfOwned({ metadataPath, socketPath }, 4321);

    await expect(fs.access(metadataPath)).rejects.toThrow();
    await expect(fs.access(socketPath)).resolves.toBeUndefined();
  });

  it('skips filesystem socket preparation on Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const nestedSocket = path.join(dir, 'missing-parent', 'daemon.sock');

    await __daemonHostInternals.prepareSocket(nestedSocket);

    await expect(fs.access(path.dirname(nestedSocket))).rejects.toThrow();
  });

  it('removes stale sockets and creates their parent directory on POSIX', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const nestedDir = path.join(dir, 'nested');
    const nestedSocket = path.join(nestedDir, 'daemon.sock');
    await fs.mkdir(nestedDir);
    await fs.writeFile(nestedSocket, 'stale', 'utf8');

    await __daemonHostInternals.prepareSocket(nestedSocket);

    await expect(fs.access(nestedSocket)).rejects.toThrow();
    await expect(fs.access(nestedDir)).resolves.toBeUndefined();
  });
});

function createRuntimeDouble(): Pick<Runtime, 'callTool' | 'listTools'> {
  return {
    callTool: vi.fn().mockResolvedValue({ ok: true }),
    listTools: vi.fn().mockResolvedValue([]),
  };
}

function createFullRuntimeDouble() {
  return {
    callTool: vi.fn().mockResolvedValue({ ok: true }),
    listTools: vi.fn().mockResolvedValue([]),
    listResources: vi.fn().mockResolvedValue({ resources: ['one'] }),
    readResource: vi.fn().mockResolvedValue({ contents: [{ uri: 'memo://one', text: 'value' }] }),
    close: vi.fn().mockResolvedValue(undefined),
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

function statusServer(result: Record<string, unknown>): net.Server {
  return net.createServer((socket) => {
    socket.on('data', () => socket.end(JSON.stringify({ id: '1', ok: true, result })));
  });
}

async function requestDaemon<T>(socketPath: string, request: DaemonRequest, split = false): Promise<DaemonResponse<T>> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = '';
    socket.once('connect', () => {
      const payload = JSON.stringify(request);
      if (split) {
        const midpoint = Math.floor(payload.length / 2);
        socket.write(payload.slice(0, midpoint));
        setImmediate(() => socket.write(payload.slice(midpoint)));
      } else {
        socket.write(payload);
      }
    });
    socket.on('data', (chunk) => {
      response += chunk.toString();
    });
    socket.once('end', () => resolve(JSON.parse(response) as DaemonResponse<T>));
    socket.once('error', reject);
  });
}

async function waitForMissing(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.access(filePath);
    } catch {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath} to be removed.`);
}
