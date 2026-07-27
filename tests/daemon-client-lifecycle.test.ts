import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAEMON_PROTOCOL_VERSION } from '../src/daemon/protocol.js';
import { makeShortTempDir } from './fixtures/test-helpers.js';

const launchDaemonDetached = vi.hoisted(() => vi.fn());

vi.mock('../src/daemon/launch.js', () => ({
  launchDaemonDetached,
}));

const { DaemonClient, resolveDaemonPaths } = await import('../src/daemon/client.js');

interface MockDaemonOptions {
  readonly configPath: string;
  readonly socketPath: string;
  readonly metadataPath: string;
}

const servers: net.Server[] = [];
let previousDaemonDir: string | undefined;

describe('DaemonClient lifecycle reconciliation', () => {
  beforeEach(() => {
    previousDaemonDir = process.env.MCPORTER_DAEMON_DIR;
    launchDaemonDetached.mockReset();
    launchDaemonDetached.mockImplementation((options: MockDaemonOptions) => {
      void startMockDaemon(options, process.pid);
    });
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => closeServer(server)));
    if (previousDaemonDir === undefined) {
      delete process.env.MCPORTER_DAEMON_DIR;
    } else {
      process.env.MCPORTER_DAEMON_DIR = previousDaemonDir;
    }
  });

  it('serializes concurrent daemon starts with a filesystem lock', async () => {
    const tmpDir = await makeShortTempDir('daemon-lock');
    process.env.MCPORTER_DAEMON_DIR = tmpDir;
    const configPath = path.join(tmpDir, 'config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({ mcpServers: { warm: { command: 'node', args: ['server.js'], lifecycle: 'keep-alive' } } }),
      'utf8'
    );

    const firstClient = new DaemonClient({ configPath, configExplicit: true, rootDir: tmpDir });
    const secondClient = new DaemonClient({ configPath, configExplicit: true, rootDir: tmpDir });

    await Promise.all([firstClient.listTools({ server: 'warm' }), secondClient.listTools({ server: 'warm' })]);

    expect(launchDaemonDetached).toHaveBeenCalledTimes(1);
  });

  it('rejects socket responders that do not match metadata pid', async () => {
    const tmpDir = await makeShortTempDir('daemon-pid');
    process.env.MCPORTER_DAEMON_DIR = tmpDir;
    const configPath = path.join(tmpDir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    const { socketPath, metadataPath } = resolveDaemonPaths(configPath);
    await fs.mkdir(path.dirname(metadataPath), { recursive: true });
    await fs.writeFile(
      metadataPath,
      JSON.stringify({
        pid: process.pid,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        socketPath,
        configPath,
        configLayers: [{ path: configPath, mtimeMs: (await fs.stat(configPath)).mtimeMs }],
        startedAt: Date.now(),
      }),
      'utf8'
    );
    await startStatusServer(socketPath, process.pid + 10_000, configPath);

    const client = new DaemonClient({ configPath, configExplicit: true, rootDir: tmpDir });

    await expect(client.status()).resolves.toBeNull();
  });

  it('forces a new daemon after a request transport failure even when status still responds', async () => {
    const tmpDir = await makeShortTempDir('daemon-restart');
    process.env.MCPORTER_DAEMON_DIR = tmpDir;
    const configPath = path.join(tmpDir, 'config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({ mcpServers: { warm: { command: 'node', args: ['server.js'], lifecycle: 'keep-alive' } } }),
      'utf8'
    );
    const paths = resolveDaemonPaths(configPath);
    await startMockDaemon({ ...paths, configPath }, process.pid, { failCallTool: true });

    const client = new DaemonClient({ configPath, configExplicit: true, rootDir: tmpDir });
    const result = await client.callTool({ server: 'warm', tool: 'list' });

    expect(result).toEqual({ ok: true });
    expect(launchDaemonDetached).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent stale-config restarts after the first replacement wins', async () => {
    const tmpDir = await makeShortTempDir('daemon-stale-lock');
    process.env.MCPORTER_DAEMON_DIR = tmpDir;
    const configPath = path.join(tmpDir, 'config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({ mcpServers: { warm: { command: 'node', args: ['server.js'], lifecycle: 'keep-alive' } } }),
      'utf8'
    );
    const stat = await fs.stat(configPath);
    const deadPid = findNonRunningPid();
    const paths = resolveDaemonPaths(configPath);
    await fs.mkdir(path.dirname(paths.metadataPath), { recursive: true });
    await fs.writeFile(
      paths.metadataPath,
      JSON.stringify({
        pid: deadPid,
        socketPath: paths.socketPath,
        configPath,
        configLayers: [{ path: configPath, mtimeMs: stat.mtimeMs - 1000 }],
        startedAt: Date.now() - 10_000,
      }),
      'utf8'
    );

    const firstClient = new DaemonClient({ configPath, configExplicit: true, rootDir: tmpDir });
    const secondClient = new DaemonClient({ configPath, configExplicit: true, rootDir: tmpDir });

    await Promise.all([firstClient.listTools({ server: 'warm' }), secondClient.listTools({ server: 'warm' })]);

    expect(launchDaemonDetached).toHaveBeenCalledTimes(1);
  });
});

async function startMockDaemon(
  options: MockDaemonOptions,
  pid: number,
  behavior: { failCallTool?: boolean } = {}
): Promise<void> {
  const stat = await fs.stat(options.configPath);
  await startStatusServer(options.socketPath, pid, options.configPath, options.metadataPath, behavior);
  await fs.mkdir(path.dirname(options.metadataPath), { recursive: true });
  await fs.writeFile(
    options.metadataPath,
    JSON.stringify({
      pid,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      socketPath: options.socketPath,
      configPath: options.configPath,
      configLayers: [{ path: options.configPath, mtimeMs: stat.mtimeMs }],
      startedAt: Date.now(),
    }),
    'utf8'
  );
}

async function startStatusServer(
  socketPath: string,
  pid: number,
  configPath: string,
  metadataPath?: string,
  behavior: { failCallTool?: boolean } = {}
): Promise<void> {
  await fs.mkdir(path.dirname(socketPath), { recursive: true });
  await fs.unlink(socketPath).catch(() => {});
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const request = JSON.parse(buffer) as { id: string; method: string };
      if (request.method === 'callTool' && behavior.failCallTool) {
        behavior.failCallTool = false;
        socket.destroy();
        return;
      }
      if (request.method === 'stop') {
        socket.end(JSON.stringify({ id: request.id, ok: true, result: true }), () => {
          server.close(() => {});
          if (metadataPath) {
            void fs.unlink(metadataPath).catch(() => {});
          }
        });
        return;
      }
      const result =
        request.method === 'status'
          ? {
              pid,
              protocolVersion: DAEMON_PROTOCOL_VERSION,
              startedAt: Date.now(),
              configPath,
              socketPath,
              servers: [],
            }
          : request.method === 'callTool'
            ? { ok: true }
            : { tools: [] };
      socket.end(JSON.stringify({ id: request.id, ok: true, result }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      servers.push(server);
      resolve();
    });
  });
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve()).on('error', () => resolve());
  });
}

function findNonRunningPid(): number {
  for (let pid = process.pid + 100_000; pid < process.pid + 101_000; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        return pid;
      }
    }
  }
  throw new Error('Unable to find a non-running pid for daemon tests.');
}
