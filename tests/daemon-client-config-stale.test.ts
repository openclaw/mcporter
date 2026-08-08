import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeShortTempDir } from './fixtures/test-helpers.js';
import {
  chromeDevtoolsRelayEnvironmentKeys,
  hashChromeDevtoolsRelayEnvironment,
} from '../src/chrome-devtools-relay.js';
import type { ServerDefinition } from '../src/config.js';

const sentMethods: string[] = [];
const launchDaemonDetached = vi.hoisted(() => vi.fn());
const createConnection = vi.hoisted(() => vi.fn());

class MockSocket extends EventEmitter {
  setTimeout(): this {
    return this;
  }

  write(data: string, cb?: (err?: Error | null) => void): boolean {
    const payload = JSON.parse(data.toString());
    sentMethods.push(payload.method);
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
        startedAt: Date.now(),
        configPath: activeConfigPath,
        configMtimeMs: activeConfigMtime,
        configLayers: activeLayers,
        relayEnvironmentHash: activeRelayEnvironmentHash,
        relayEnvironmentKeys: activeRelayEnvironmentKeys,
        socketPath: activeSocketPath,
        servers: [],
      },
    };
  }
  if (method === 'stop') activeStatusPid = findNonRunningPid();
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
let activeRelayEnvironmentHash = hashChromeDevtoolsRelayEnvironment([], {});
let activeRelayEnvironmentKeys: string[] = [];

vi.mock('node:net', () => {
  createConnection.mockImplementation(() => {
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
    activeRelayEnvironmentHash = hashChromeDevtoolsRelayEnvironment([], {});
    activeRelayEnvironmentKeys = [];
    launchDaemonDetached.mockClear();
    launchDaemonDetached.mockImplementation(
      (options: { metadataPath: string; socketPath: string; configPath: string }) => {
        activeStatusPid = process.pid;
        void fs.writeFile(
          options.metadataPath,
          JSON.stringify(
            {
              pid: process.pid,
              socketPath: options.socketPath,
              configPath: options.configPath,
              startedAt: Date.now(),
              logPath: null,
              configMtimeMs: activeConfigMtime,
              configLayers: activeLayers,
              relayEnvironmentHash: activeRelayEnvironmentHash,
              relayEnvironmentKeys: activeRelayEnvironmentKeys,
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
          socketPath,
          configPath,
          startedAt: Date.now() - 10_000,
          logPath: null,
          configMtimeMs: stat.mtimeMs,
          configLayers: activeLayers,
          relayEnvironmentHash: activeRelayEnvironmentHash,
          relayEnvironmentKeys: activeRelayEnvironmentKeys,
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

  it('restarts when relay policy environment changes without a config mtime change', async () => {
    const tmpDir = await makeShortTempDir('daemon-relay-env');
    process.env.MCPORTER_DAEMON_DIR = tmpDir;
    const configPath = path.join(tmpDir, 'config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          chrome: {
            command: 'npx',
            args: ['-y', 'chrome-devtools-mcp@latest', '--autoConnect'],
            lifecycle: 'keep-alive',
          },
        },
      }),
      'utf8'
    );
    const stat = await fs.stat(configPath);
    const { metadataPath, socketPath } = resolveDaemonPaths(configPath);
    const definition: ServerDefinition = {
      name: 'chrome',
      command: {
        kind: 'stdio',
        command: 'npx',
        args: ['-y', 'chrome-devtools-mcp@latest', '--autoConnect'],
        cwd: tmpDir,
      },
    };
    activeConfigPath = configPath;
    activeSocketPath = socketPath;
    activeConfigMtime = stat.mtimeMs;
    activeStatusPid = process.pid;
    activeLayers = [{ path: configPath, mtimeMs: stat.mtimeMs }];
    activeRelayEnvironmentHash = hashChromeDevtoolsRelayEnvironment([definition], {});
    activeRelayEnvironmentKeys = chromeDevtoolsRelayEnvironmentKeys([definition]);
    await fs.mkdir(path.dirname(metadataPath), { recursive: true });
    await fs.writeFile(
      metadataPath,
      JSON.stringify({
        pid: process.pid,
        socketPath,
        configPath,
        startedAt: Date.now() - 10_000,
        configMtimeMs: stat.mtimeMs,
        configLayers: activeLayers,
        relayEnvironmentHash: activeRelayEnvironmentHash,
        relayEnvironmentKeys: activeRelayEnvironmentKeys,
      }),
      'utf8'
    );

    const previousPolicy = process.env.MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY;
    process.env.MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY = 'require';
    try {
      const client = new DaemonClient({ configPath, configExplicit: true, rootDir: tmpDir });
      await client.listTools({ server: 'chrome' });
      expect(sentMethods[0]).toBe('status');
      expect(sentMethods).toContain('stop');
      expect(launchDaemonDetached).toHaveBeenCalledOnce();
    } finally {
      if (previousPolicy === undefined) delete process.env.MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY;
      else process.env.MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY = previousPolicy;
    }
  });

  it('restarts when the relay key rotates at the same credential path', async () => {
    const tmpDir = await makeShortTempDir('daemon-relay-key');
    process.env.MCPORTER_DAEMON_DIR = tmpDir;
    const previousOauthDir = process.env.OPENCLAW_OAUTH_DIR;
    process.env.OPENCLAW_OAUTH_DIR = tmpDir;
    const configPath = path.join(tmpDir, 'config.json');
    const secretPath = path.join(tmpDir, 'browser-extension-relay.secret');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          chrome: {
            command: 'npx',
            args: ['-y', 'chrome-devtools-mcp@latest', '--autoConnect'],
            lifecycle: 'keep-alive',
          },
        },
      }),
      'utf8'
    );
    await fs.writeFile(secretPath, 'a'.repeat(64), { mode: 0o600 });
    const stat = await fs.stat(configPath);
    const { metadataPath, socketPath } = resolveDaemonPaths(configPath);
    const definition: ServerDefinition = {
      name: 'chrome',
      command: {
        kind: 'stdio',
        command: 'npx',
        args: ['-y', 'chrome-devtools-mcp@latest', '--autoConnect'],
        cwd: tmpDir,
      },
    };
    activeConfigPath = configPath;
    activeSocketPath = socketPath;
    activeConfigMtime = stat.mtimeMs;
    activeStatusPid = process.pid;
    activeLayers = [{ path: configPath, mtimeMs: stat.mtimeMs }];
    activeRelayEnvironmentKeys = chromeDevtoolsRelayEnvironmentKeys([definition]);
    activeRelayEnvironmentHash = hashChromeDevtoolsRelayEnvironment([definition]);
    await fs.mkdir(path.dirname(metadataPath), { recursive: true });
    await fs.writeFile(
      metadataPath,
      JSON.stringify({
        pid: process.pid,
        socketPath,
        configPath,
        startedAt: Date.now() - 10_000,
        configMtimeMs: stat.mtimeMs,
        configLayers: activeLayers,
        relayEnvironmentHash: activeRelayEnvironmentHash,
        relayEnvironmentKeys: activeRelayEnvironmentKeys,
      }),
      'utf8'
    );

    try {
      await fs.writeFile(secretPath, 'b'.repeat(64), { mode: 0o600 });
      const client = new DaemonClient({ configPath, configExplicit: true, rootDir: tmpDir });
      await client.listTools({ server: 'chrome' });
      expect(sentMethods[0]).toBe('status');
      expect(sentMethods).toContain('stop');
      expect(launchDaemonDetached).toHaveBeenCalledOnce();
    } finally {
      if (previousOauthDir === undefined) delete process.env.OPENCLAW_OAUTH_DIR;
      else process.env.OPENCLAW_OAUTH_DIR = previousOauthDir;
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
