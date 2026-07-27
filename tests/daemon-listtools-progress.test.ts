import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { DaemonClient, resolveDaemonPaths } from '../src/daemon/client.js';
import { collectConfigLayers } from '../src/daemon/config-layers.js';
import { __testHandleSocketRequest } from '../src/daemon/host.js';
import {
  DAEMON_PROGRESS_INTERVAL_MS,
  DAEMON_PROTOCOL_VERSION,
  resolveProgressInterval,
  type DaemonRequest,
} from '../src/daemon/protocol.js';
import type { Runtime, ServerToolInfo } from '../src/runtime.js';
import { makeShortTempDir } from './fixtures/test-helpers.js';

const { launchDaemonDetached } = vi.hoisted(() => ({ launchDaemonDetached: vi.fn() }));

vi.mock('../src/daemon/launch.js', () => ({ launchDaemonDetached }));

// Every phase runs longer than the client's socket deadline, so the request only
// survives if the daemon's progress frames keep resetting that deadline.
const CLIENT_TIMEOUT_MS = 400;
const PHASE_MS = 300;

interface DaemonMetadataStub {
  readonly configPath: string;
  readonly configLayers: Array<{ path: string; mtimeMs: number | null }>;
  readonly configMtimeMs: number | null;
  readonly socketPath: string;
  readonly startedAt: number;
  readonly logPath: string | null;
}

interface ServedDaemon {
  readonly configPath: string;
  readonly requests: DaemonRequest[];
  close: () => Promise<void>;
}

describe('progress cadence', () => {
  it('stays strictly inside every caller deadline it can', () => {
    // The cadence exists to refresh the deadline before it expires, so any
    // interval at or above the deadline defeats the mechanism. 1ms is the one
    // deadline integer milliseconds cannot beat -- and it was already
    // unachievable before progress frames existed.
    for (const deadlineMs of [2, 3, 5, 12, 24, 25, 74, 75, 300, 30_000, 300_000]) {
      expect(resolveProgressInterval(deadlineMs)).toBeLessThan(deadlineMs);
    }
    expect(resolveProgressInterval(1)).toBe(1);
  });

  it('never exceeds the default cadence for long deadlines', () => {
    expect(resolveProgressInterval(300_000)).toBe(DAEMON_PROGRESS_INTERVAL_MS);
    expect(resolveProgressInterval(0)).toBe(DAEMON_PROGRESS_INTERVAL_MS);
    expect(resolveProgressInterval(Number.NaN)).toBe(DAEMON_PROGRESS_INTERVAL_MS);
  });
});

describe('daemon listTools progress frames', () => {
  let tmpDir: string;
  let previousDaemonDir: string | undefined;
  let daemon: ServedDaemon | undefined;

  beforeEach(async () => {
    launchDaemonDetached.mockClear();
    previousDaemonDir = process.env.MCPORTER_DAEMON_DIR;
    tmpDir = await makeShortTempDir('daemon-progress');
    process.env.MCPORTER_DAEMON_DIR = tmpDir;
  });

  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    if (previousDaemonDir === undefined) {
      delete process.env.MCPORTER_DAEMON_DIR;
    } else {
      process.env.MCPORTER_DAEMON_DIR = previousDaemonDir;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('survives an OAuth wait followed by several paginated tools/list pages', async () => {
    const pages: ServerToolInfo[][] = [[{ name: 'alpha' }, { name: 'beta' }], [{ name: 'gamma' }], [{ name: 'delta' }]];
    const listTools = vi.fn(async (): Promise<ServerToolInfo[]> => {
      // Phase 1: the interactive OAuth code wait inside connect().
      await delay(PHASE_MS);
      const tools: ServerToolInfo[] = [];
      // Phases 2..n: one SDK tools/list request per cursor page.
      for (const page of pages) {
        await delay(PHASE_MS);
        tools.push(...page);
      }
      return tools;
    });
    daemon = await serveDaemon(tmpDir, listTools);
    const client = new DaemonClient({ configPath: daemon.configPath, configExplicit: true, rootDir: tmpDir });

    const startedAt = Date.now();
    const tools = await client.listTools({ server: 'oauth', timeoutMs: CLIENT_TIMEOUT_MS });
    const elapsedMs = Date.now() - startedAt;

    expect(tools).toEqual(pages.flat());
    // The operation outlived its socket deadline several times over -- the case a
    // budget sized for a fixed number of phases cannot express.
    expect(elapsedMs).toBeGreaterThan(CLIENT_TIMEOUT_MS);
    // No replay: the daemon ran the OAuth flow exactly once.
    expect(listTools).toHaveBeenCalledTimes(1);
    expect(daemon.requests.filter((request) => request.method === 'listTools')).toHaveLength(1);
    // No restart: a transport timeout would have relaunched the daemon.
    expect(launchDaemonDetached).not.toHaveBeenCalled();
  });

  it('reaches a deadline shorter than the default progress interval', async () => {
    // A caller deadline below DAEMON_PROGRESS_INTERVAL_MS would expire before the
    // daemon's first heartbeat if the cadence were fixed, restarting and replaying
    // the very request the frames exist to protect.
    const shortTimeoutMs = 120;
    const listTools = vi.fn(async (): Promise<ServerToolInfo[]> => {
      await delay(shortTimeoutMs * 3);
      return [{ name: 'alpha' }];
    });
    daemon = await serveDaemon(tmpDir, listTools);
    const client = new DaemonClient({ configPath: daemon.configPath, configExplicit: true, rootDir: tmpDir });

    const tools = await client.listTools({ server: 'oauth', timeoutMs: shortTimeoutMs });

    expect(tools).toEqual([{ name: 'alpha' }]);
    expect(listTools).toHaveBeenCalledTimes(1);
    expect(launchDaemonDetached).not.toHaveBeenCalled();
  });

  it('still trips the socket deadline when the daemon stops sending progress frames', async () => {
    // A wedged daemon accepts the request and then goes quiet. Silence is the one
    // signal the client still treats as a dead transport.
    daemon = await serveDaemon(tmpDir, undefined);
    const client = new DaemonClient({ configPath: daemon.configPath, configExplicit: true, rootDir: tmpDir });
    const sendRequest = (
      client as unknown as {
        sendRequest: (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>;
      }
    ).sendRequest.bind(client);

    await expect(sendRequest('listTools', { server: 'oauth' }, CLIENT_TIMEOUT_MS)).rejects.toMatchObject({
      code: 'ETIMEDOUT',
    });
  });
});

/**
 * Serves one daemon socket backed by the real host request path, so the test
 * exercises the shipping progress framing rather than a stand-in. Passing no
 * `listTools` leaves operations unanswered to model a wedged daemon.
 */
async function serveDaemon(tmpDir: string, listTools: Runtime['listTools'] | undefined): Promise<ServedDaemon> {
  const configPath = path.join(tmpDir, 'mcporter.config.json');
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }), 'utf8');
  const { socketPath, metadataPath } = resolveDaemonPaths(configPath);
  // On Windows the socket is a named pipe, so only the metadata directory is a
  // real path worth creating -- and there is no stale socket file to remove.
  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  await removeSocketFile(socketPath);

  const metadata: DaemonMetadataStub = {
    configPath,
    configLayers: await collectConfigLayers({ configPath, rootDir: tmpDir }),
    configMtimeMs: null,
    socketPath,
    startedAt: Date.now(),
    logPath: null,
  };
  await fs.writeFile(
    metadataPath,
    JSON.stringify({
      pid: process.pid,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      socketPath,
      configPath,
      configLayers: metadata.configLayers,
      startedAt: metadata.startedAt,
    }),
    'utf8'
  );

  const requests: DaemonRequest[] = [];
  const runtime = { listTools } as unknown as Runtime;
  const managedServers = new Map<string, ServerDefinition>([
    [
      'oauth',
      { name: 'oauth', command: { kind: 'http', url: new URL('https://example.test/mcp') } } as ServerDefinition,
    ],
  ]);

  const open = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.setEncoding('utf8');
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    let buffer = '';
    let handled = false;
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (handled) {
        return;
      }
      let request: DaemonRequest;
      try {
        request = JSON.parse(buffer.trim()) as DaemonRequest;
      } catch {
        return;
      }
      handled = true;
      requests.push(request);
      if (request.method === 'status') {
        // The client's liveness probe must keep working in both scenarios.
        socket.write(`${JSON.stringify({ id: request.id, ok: true, result: buildStatus(metadata) })}\n`, () =>
          socket.end()
        );
        return;
      }
      if (!listTools) {
        return;
      }
      void __testHandleSocketRequest(socket, request, runtime, managedServers, metadata);
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
    configPath,
    requests,
    close: async () => {
      for (const socket of open) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await removeSocketFile(socketPath);
    },
  };
}

function buildStatus(metadata: DaemonMetadataStub) {
  return {
    pid: process.pid,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    startedAt: metadata.startedAt,
    configPath: metadata.configPath,
    configLayers: metadata.configLayers,
    socketPath: metadata.socketPath,
    servers: [],
  };
}

async function removeSocketFile(socketPath: string): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }
  await fs.unlink(socketPath).catch(() => {});
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
