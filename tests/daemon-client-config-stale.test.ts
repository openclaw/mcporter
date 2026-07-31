import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAEMON_PROTOCOL_VERSION } from '../src/daemon/protocol.js';
import { makeShortTempDir } from './fixtures/test-helpers.js';

const sentMethods: string[] = [];
const launchDaemonDetached = vi.hoisted(() => vi.fn());
let createConnection: ReturnType<typeof vi.fn>;
// When true, the first `status` poll flips the fake daemon's `activeRequests`
// to zero. This models a shared daemon whose long request finishes while the
// upgrading client is still draining -- the very window the new wait-for-idle
// logic was introduced to cover.
let drainAfterFirstStatusPoll = false;
// When set, the first `status` poll after the drain has resolved swaps the
// fake daemon's reported pid to a fresh one. Models another client winning
// the race to replace the busy daemon during the drain window.
let replacementPidAfterDrain: number | null = null;
let statusPollCount = 0;

class MockSocket extends EventEmitter {
  setTimeout(): this {
    return this;
  }

  write(data: string, cb?: (err?: Error | null) => void): boolean {
    const payload = JSON.parse(data.toString());
    sentMethods.push(payload.method);
    if (payload.method === 'stop') {
      activeStatusPid = findNonRunningPid();
    }
    if (payload.method === 'status') {
      statusPollCount += 1;
      // Defer the drain to the SECOND status poll so the first poll still
      // reports the busy daemon -- otherwise probeLiveStatus would see
      // `activeRequests: 0` up front and the drain check would be skipped.
      if (drainAfterFirstStatusPoll && activeRequests > 0 && statusPollCount >= 2) {
        // Simulate a shared daemon whose in-flight request finishes after the
        // upgrading client has noticed the staleness but before the drain
        // timeout. The next status poll must see `activeRequests: 0` so the
        // replacement is allowed to proceed.
        activeRequests = 0;
      }
      // Simulate another client replacing the daemon during the drain. The
      // swap happens on the same poll the drain resolves so the upgrading
      // client observes the busy daemon, then the replacement -- the
      // sequence the drain check was added to handle.
      if (
        replacementPidAfterDrain !== null &&
        activeRequests === 0 &&
        statusPollCount >= 2 &&
        activeStatusPid !== replacementPidAfterDrain
      ) {
        activeStatusPid = replacementPidAfterDrain;
      }
    }
    const response = buildResponse(payload.method, payload.id);
    queueMicrotask(() => {
      this.emit('data', JSON.stringify(response));
      this.emit('end');
    });
    cb?.(null);
    return true;
  }

  end(): this {
    return this;
  }

  destroy(): this {
    return this;
  }
}

function buildResponse(method: string, id: string) {
  if (method === 'status') {
    return {
      id,
      ok: true,
      result: {
        pid: activeStatusPid,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        startedAt: Date.now(),
        configPath: activeConfigPath,
        configMtimeMs: activeConfigMtime,
        configLayers: activeLayers,
        socketPath: activeSocketPath,
        servers: [],
        // Default to idle so the existing config-stale tests still hit the
        // `stop` path quickly; the two-client busy-daemon tests below flip
        // this on to assert the new drain behavior.
        activeRequests,
      },
    };
  }
  return {
    id,
    ok: true,
    result: method === 'listTools' ? { tools: [] } : true,
  };
}

let activeConfigPath: string;
let activeConfigMtime: number | null = null;
let activeStatusPid = process.pid;
let activeSocketPath: string;
let previousDaemonDir: string | undefined;
let activeLayers: Array<{ path: string; mtimeMs: number | null }> = [];
// `activeRequests` is whatever the fake daemon wants to advertise to the next
// status poll. Tests that need to exercise the busy-daemon drain path bump it
// above zero; the default keeps the existing config-stale tests on the fast
// path.
let activeRequests = 0;

vi.mock('node:net', () => {
  createConnection = vi.fn(() => {
    const socket = new MockSocket();
    queueMicrotask(() => socket.emit('connect'));
    return socket as unknown as import('node:net').Socket;
  });
  return { createConnection, default: { createConnection } };
});

vi.mock('../src/daemon/launch.js', () => {
  return { launchDaemonDetached };
});

const { DaemonClient, resolveDaemonPaths } = await import('../src/daemon/client.js');

describe('DaemonClient config freshness', () => {
  beforeEach(() => {
    sentMethods.length = 0;
    previousDaemonDir = process.env.MCPORTER_DAEMON_DIR;
    activeLayers = [];
    activeRequests = 0;
    drainAfterFirstStatusPoll = false;
    replacementPidAfterDrain = null;
    statusPollCount = 0;
    launchDaemonDetached.mockClear();
    launchDaemonDetached.mockImplementation(
      (options: { metadataPath: string; socketPath: string; configPath: string }) => {
        activeStatusPid = process.pid;
        void fs.writeFile(
          options.metadataPath,
          JSON.stringify(
            {
              pid: process.pid,
              protocolVersion: DAEMON_PROTOCOL_VERSION,
              socketPath: options.socketPath,
              configPath: options.configPath,
              startedAt: Date.now(),
              logPath: null,
              configMtimeMs: activeConfigMtime,
              configLayers: activeLayers,
            },
            null,
            2
          ),
          'utf8'
        );
      }
    );
  });

  afterEach(async () => {
    if (previousDaemonDir === undefined) {
      delete process.env.MCPORTER_DAEMON_DIR;
    } else {
      process.env.MCPORTER_DAEMON_DIR = previousDaemonDir;
    }
  });

  it('restarts the daemon when config mtime changes', async () => {
    const tmpDir = await makeShortTempDir('daemon-stale');
    process.env.MCPORTER_DAEMON_DIR = tmpDir;

    const configPath = path.join(tmpDir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    const stat = await fs.stat(configPath);
    const oldMtime = stat.mtimeMs - 1000;
    const deadPid = findNonRunningPid();
    const { metadataPath, socketPath } = resolveDaemonPaths(configPath);
    activeConfigPath = configPath;
    activeSocketPath = socketPath;
    activeConfigMtime = stat.mtimeMs;
    activeStatusPid = deadPid;
    activeLayers = [{ path: configPath, mtimeMs: stat.mtimeMs }];

    await fs.mkdir(path.dirname(metadataPath), { recursive: true });
    await fs.writeFile(
      metadataPath,
      JSON.stringify(
        {
          pid: deadPid,
          socketPath,
          configPath,
          startedAt: Date.now() - 10_000,
          logPath: null,
          configMtimeMs: oldMtime,
          configLayers: [{ path: configPath, mtimeMs: oldMtime }],
        },
        null,
        2
      ),
      'utf8'
    );

    const client = new DaemonClient({ configPath, configExplicit: true, rootDir: tmpDir });
    await client.listTools({ server: 'playwright' });

    expect(sentMethods[0]).toBe('stop');
    expect(sentMethods).toContain('status');
    expect(sentMethods).toContain('listTools');
    expect(launchDaemonDetached).toHaveBeenCalledTimes(1);
  });

  it('restarts when metadata layers differ from current layers', async () => {
    const tmpDir = await makeShortTempDir('daemon-layers');
    process.env.MCPORTER_DAEMON_DIR = tmpDir;

    const configPath = path.join(tmpDir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    const stat = await fs.stat(configPath);
    const deadPid = findNonRunningPid();
    const { metadataPath, socketPath } = resolveDaemonPaths(configPath);
    activeConfigPath = configPath;
    activeSocketPath = socketPath;
    activeConfigMtime = stat.mtimeMs;
    activeStatusPid = deadPid;
    activeLayers = [{ path: configPath, mtimeMs: stat.mtimeMs }];

    await fs.mkdir(path.dirname(metadataPath), { recursive: true });
    await fs.writeFile(
      metadataPath,
      JSON.stringify(
        {
          pid: deadPid,
          socketPath,
          configPath,
          startedAt: Date.now() - 10_000,
          logPath: null,
          configMtimeMs: stat.mtimeMs,
          configLayers: [
            { path: configPath, mtimeMs: stat.mtimeMs },
            { path: path.join(tmpDir, 'shadow.json'), mtimeMs: stat.mtimeMs },
          ],
        },
        null,
        2
      ),
      'utf8'
    );

    const client = new DaemonClient({ configPath, configExplicit: true, rootDir: tmpDir });
    await client.listResources({ server: 'playwright' });

    expect(sentMethods[0]).toBe('stop');
    expect(launchDaemonDetached).toHaveBeenCalledTimes(1);
  });

  it('does not restart when metadata layers match', async () => {
    const tmpDir = await makeShortTempDir('daemon-layers-stable');
    process.env.MCPORTER_DAEMON_DIR = tmpDir;

    const configPath = path.join(tmpDir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    const stat = await fs.stat(configPath);
    const { metadataPath, socketPath } = resolveDaemonPaths(configPath);
    activeConfigPath = configPath;
    activeSocketPath = socketPath;
    activeConfigMtime = stat.mtimeMs;
    activeStatusPid = process.pid;
    activeLayers = [{ path: configPath, mtimeMs: stat.mtimeMs }];

    await fs.mkdir(path.dirname(metadataPath), { recursive: true });
    await fs.writeFile(
      metadataPath,
      JSON.stringify(
        {
          pid: process.pid,
          protocolVersion: DAEMON_PROTOCOL_VERSION,
          socketPath,
          configPath,
          startedAt: Date.now() - 10_000,
          logPath: null,
          configMtimeMs: stat.mtimeMs,
          configLayers: activeLayers,
        },
        null,
        2
      ),
      'utf8'
    );

    const client = new DaemonClient({ configPath, configExplicit: true, rootDir: tmpDir });
    await client.listTools({ server: 'playwright' });

    expect(sentMethods).toEqual(['status', 'listTools']);
    expect(sentMethods).not.toContain('stop');
    expect(launchDaemonDetached).not.toHaveBeenCalled();
  });

  it('restarts a daemon whose metadata predates the current protocol', async () => {
    const tmpDir = await makeShortTempDir('daemon-protocol-stale');
    process.env.MCPORTER_DAEMON_DIR = tmpDir;

    const configPath = path.join(tmpDir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    const stat = await fs.stat(configPath);
    const { metadataPath, socketPath } = resolveDaemonPaths(configPath);
    activeConfigPath = configPath;
    activeSocketPath = socketPath;
    activeConfigMtime = stat.mtimeMs;
    activeStatusPid = process.pid;
    activeLayers = [{ path: configPath, mtimeMs: stat.mtimeMs }];

    await fs.mkdir(path.dirname(metadataPath), { recursive: true });
    await fs.writeFile(
      metadataPath,
      JSON.stringify({
        pid: process.pid,
        socketPath,
        configPath,
        startedAt: Date.now() - 10_000,
        logPath: null,
        configMtimeMs: stat.mtimeMs,
        configLayers: activeLayers,
      }),
      'utf8'
    );

    const client = new DaemonClient({ configPath, configExplicit: true, rootDir: tmpDir });
    await client.listTools({ server: 'playwright' });

    expect(sentMethods).toContain('stop');
    expect(launchDaemonDetached).toHaveBeenCalledTimes(1);
    expect(sentMethods).toContain('listTools');
  });

  // Codex / ClawSweeper P1: an upgraded client must not stop a shared daemon
  // that another caller is still waiting on. The next two tests prove both
  // halves of the new wait-for-idle path against a status response that
  // honestly reports the in-flight count.
  it('waits for a busy shared daemon to drain before sending stop', async () => {
    const tmpDir = await makeShortTempDir('daemon-busy-drain');
    process.env.MCPORTER_DAEMON_DIR = tmpDir;

    const configPath = path.join(tmpDir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    const stat = await fs.stat(configPath);
    // Use the live test pid so `isProcessRunning` returns true and the
    // client's `readVerifiedStatus` actually consults the fake daemon --
    // otherwise the drain check is bypassed and the upgrade races to a
    // stop regardless of in-flight work.
    const livePid = process.pid;
    const { metadataPath, socketPath } = resolveDaemonPaths(configPath);
    activeConfigPath = configPath;
    activeSocketPath = socketPath;
    activeConfigMtime = stat.mtimeMs;
    activeStatusPid = livePid;
    activeLayers = [{ path: configPath, mtimeMs: stat.mtimeMs }];
    // Another client is still waiting on a long request on the v1 daemon.
    activeRequests = 1;
    // The in-flight request finishes on the next status poll, mid-drain.
    drainAfterFirstStatusPoll = true;

    await fs.mkdir(path.dirname(metadataPath), { recursive: true });
    await fs.writeFile(
      metadataPath,
      JSON.stringify({
        pid: livePid,
        protocolVersion: DAEMON_PROTOCOL_VERSION - 1,
        socketPath,
        configPath,
        startedAt: Date.now() - 10_000,
        logPath: null,
        configMtimeMs: stat.mtimeMs,
        configLayers: activeLayers,
      }),
      'utf8'
    );

    const client = new DaemonClient({ configPath, configExplicit: true, rootDir: tmpDir });
    await client.listTools({ server: 'playwright' });

    // The upgrading client must observe `activeRequests` flip to 0 *before*
    // it issues `stop`. Anything else would have killed the busy peer's
    // in-flight OAuth or cursor page.
    const stopIndex = sentMethods.indexOf('stop');
    const statusCount = sentMethods.filter((method) => method === 'status').length;
    expect(stopIndex).toBeGreaterThan(0);
    expect(statusCount).toBeGreaterThanOrEqual(2);
    // The last `status` poll seen by the client before `stop` already saw
    // the drained counter.
    expect(activeRequests).toBe(0);
    expect(launchDaemonDetached).toHaveBeenCalledTimes(1);
    expect(sentMethods).toContain('listTools');
  });

  it('does not stop a peer fresh daemon if it replaces the busy one mid-drain', async () => {
    const tmpDir = await makeShortTempDir('daemon-busy-replaced');
    process.env.MCPORTER_DAEMON_DIR = tmpDir;

    const configPath = path.join(tmpDir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }), 'utf8');
    const stat = await fs.stat(configPath);
    const originalPid = process.pid;
    const replacementPid = findNonRunningPid();
    const { metadataPath, socketPath } = resolveDaemonPaths(configPath);
    activeConfigPath = configPath;
    activeSocketPath = socketPath;
    activeConfigMtime = stat.mtimeMs;
    activeStatusPid = originalPid;
    activeLayers = [{ path: configPath, mtimeMs: stat.mtimeMs }];
    // The busy peer drains to idle on the first poll, then another client
    // races in and replaces the daemon before our post-drain re-check runs.
    activeRequests = 1;
    drainAfterFirstStatusPoll = true;
    replacementPidAfterDrain = replacementPid;

    await fs.mkdir(path.dirname(metadataPath), { recursive: true });
    await fs.writeFile(
      metadataPath,
      JSON.stringify({
        pid: originalPid,
        protocolVersion: DAEMON_PROTOCOL_VERSION - 1,
        socketPath,
        configPath,
        startedAt: Date.now() - 10_000,
        logPath: null,
        configMtimeMs: stat.mtimeMs,
        configLayers: activeLayers,
      }),
      'utf8'
    );

    const client = new DaemonClient({ configPath, configExplicit: true, rootDir: tmpDir });
    await client.listTools({ server: 'playwright' });

    // The peer's fresh daemon must not have received `stop` -- only the
    // request that the upgrading client actually wanted to make. Killing the
    // replacement would be the same regression the drain was added to stop.
    expect(sentMethods).not.toContain('stop');
    // The replacing pid appeared in the status poll, proving the upgrade
    // window was actually exercised.
    expect(activeStatusPid).toBe(replacementPid);
    expect(launchDaemonDetached).not.toHaveBeenCalled();
    expect(sentMethods).toContain('listTools');
  });

  it('refuses to replace a daemon that never drains before the timeout', async () => {
    const tmpDir = await makeShortTempDir('daemon-busy-stuck');
    process.env.MCPORTER_DAEMON_DIR = tmpDir;
    // Shrink the drain cap so the test does not block for the production
    // 60s default. The env var is the same knob the client reads at runtime.
    const previousDrainTimeout = process.env.MCPORTER_DAEMON_DRAIN_TIMEOUT_MS;
    process.env.MCPORTER_DAEMON_DRAIN_TIMEOUT_MS = '500';

    try {
      const configPath = path.join(tmpDir, 'config.json');
      await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }), 'utf8');
      const stat = await fs.stat(configPath);
      const livePid = process.pid;
      const { metadataPath, socketPath } = resolveDaemonPaths(configPath);
      activeConfigPath = configPath;
      activeSocketPath = socketPath;
      activeConfigMtime = stat.mtimeMs;
      activeStatusPid = livePid;
      activeLayers = [{ path: configPath, mtimeMs: stat.mtimeMs }];
      // The peer is wedged and never returns. The client must refuse to stop
      // the daemon -- the alternative is killing the peer's request and
      // triggering the very replay this PR exists to remove.
      activeRequests = 1;

      await fs.mkdir(path.dirname(metadataPath), { recursive: true });
      await fs.writeFile(
        metadataPath,
        JSON.stringify({
          pid: livePid,
          protocolVersion: DAEMON_PROTOCOL_VERSION - 1, // stale: triggers the drain
          socketPath,
          configPath,
          startedAt: Date.now() - 10_000,
          logPath: null,
          configMtimeMs: stat.mtimeMs,
          configLayers: activeLayers,
        }),
        'utf8'
      );

      const client = new DaemonClient({ configPath, configExplicit: true, rootDir: tmpDir });
      await expect(client.listTools({ server: 'playwright' })).rejects.toThrow(
        /still busy after 500ms; refusing to replace it/
      );
      expect(launchDaemonDetached).not.toHaveBeenCalled();
      // The busy daemon was not stopped: the peer's request is left intact.
      expect(sentMethods).not.toContain('stop');
    } finally {
      if (previousDrainTimeout === undefined) {
        delete process.env.MCPORTER_DAEMON_DRAIN_TIMEOUT_MS;
      } else {
        process.env.MCPORTER_DAEMON_DRAIN_TIMEOUT_MS = previousDrainTimeout;
      }
    }
  });
});

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
