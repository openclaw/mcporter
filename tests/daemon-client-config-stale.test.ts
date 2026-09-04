import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BROWSER_RELAY_AUTH_CHALLENGE_PATH,
  BROWSER_RELAY_AUTH_COMPLETE_PATH,
  BROWSER_RELAY_AUTH_LABEL,
  BROWSER_RELAY_AUTH_VERSION,
  deriveBrowserRelayKeyId,
} from '../src/browser-relay-auth-v2.js';
import { makeShortTempDir } from './fixtures/test-helpers.js';
import {
  CHROME_DEVTOOLS_RELAY_RUNTIME_IDENTITY_VERSION,
  chromeDevtoolsRelayEnvironmentKeys,
  hashChromeDevtoolsRelayEnvironment,
  resolveChromeDevtoolsRelayRuntimeIdentity,
} from '../src/chrome-devtools-relay.js';
import type { ServerDefinition } from '../src/config.js';
import { isolateChromeRelayTestEnvironment } from './helpers/chrome-relay-fixture.js';

const sentMethods: string[] = [];
const launchDaemonDetached = vi.hoisted(() => vi.fn());
const createConnection = vi.hoisted(() => vi.fn());
const spawnSyncOpenClaw = vi.hoisted(() => vi.fn(() => new Error('synchronous discovery is forbidden')));
const unavailableRelayIdentity = {
  discover: async () => ({ kind: 'unavailable' as const }),
  discovery: { platform: 'linux' as const },
};

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
        relayRuntimeIdentityVersion: CHROME_DEVTOOLS_RELAY_RUNTIME_IDENTITY_VERSION,
        relayRuntimeIdentity: activeRelayRuntimeIdentity,
        relayEnvironmentKeys: activeRelayEnvironmentKeys,
        oauthNoBrowser: activeOauthNoBrowser,
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
let previousOauthNoBrowser: string | undefined;
let activeLayers: Array<{ path: string; mtimeMs: number | null }> = [];
let activeRelayRuntimeIdentity = hashChromeDevtoolsRelayEnvironment([], {});
let activeRelayEnvironmentKeys: string[] = [];
let activeOauthNoBrowser = false;

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>();
  createConnection.mockImplementation(() => {
    const socket = new MockSocket();
    queueMicrotask(() => socket.emit('connect'));
    return socket as unknown as import('node:net').Socket;
  });
  return { ...actual, createConnection, default: { ...actual, createConnection } };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: spawnSyncOpenClaw,
    spawn: vi.fn(() => {
      throw new Error('Daemon fixtures must inject synthetic discovery');
    }),
  };
});

vi.mock('../src/daemon/launch.js', () => {
  return { launchDaemonDetached };
});

const { DaemonClient, resolveDaemonPaths } = await import('../src/daemon/client.js');

describe('DaemonClient config freshness', () => {
  let restoreEnvironment: () => void;

  beforeEach(() => {
    restoreEnvironment = isolateChromeRelayTestEnvironment(os.homedir());
    sentMethods.length = 0;
    previousDaemonDir = process.env.MCPORTER_DAEMON_DIR;
    previousOauthNoBrowser = process.env.MCPORTER_OAUTH_NO_BROWSER;
    delete process.env.MCPORTER_OAUTH_NO_BROWSER;
    activeLayers = [];
    activeRelayRuntimeIdentity = hashChromeDevtoolsRelayEnvironment([], {});
    activeRelayEnvironmentKeys = [];
    activeOauthNoBrowser = false;
    spawnSyncOpenClaw.mockClear();
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
              relayRuntimeIdentityVersion: CHROME_DEVTOOLS_RELAY_RUNTIME_IDENTITY_VERSION,
              relayRuntimeIdentity: activeRelayRuntimeIdentity,
              relayEnvironmentKeys: activeRelayEnvironmentKeys,
              oauthNoBrowser: activeOauthNoBrowser,
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
    const fixtureDaemonDir = process.env.MCPORTER_DAEMON_DIR;
    if (fixtureDaemonDir && fixtureDaemonDir !== previousDaemonDir) {
      await fs.rm(fixtureDaemonDir, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
    restoreEnvironment();
    if (previousDaemonDir === undefined) {
      delete process.env.MCPORTER_DAEMON_DIR;
    } else {
      process.env.MCPORTER_DAEMON_DIR = previousDaemonDir;
    }
    if (previousOauthNoBrowser === undefined) {
      delete process.env.MCPORTER_OAUTH_NO_BROWSER;
    } else {
      process.env.MCPORTER_OAUTH_NO_BROWSER = previousOauthNoBrowser;
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

  it('keeps config-isolated daemons on separate sockets even with identical relay settings', async () => {
    const directory = await makeShortTempDir('daemon-config-isolation');
    process.env.MCPORTER_DAEMON_DIR = directory;
    const first = resolveDaemonPaths(path.join(directory, 'first.json'));
    const second = resolveDaemonPaths(path.join(directory, 'second.json'));
    expect(first.socketPath).not.toBe(second.socketPath);
    expect(first.metadataPath).not.toBe(second.metadataPath);
    expect(launchDaemonDetached).not.toHaveBeenCalled();
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
          relayRuntimeIdentityVersion: CHROME_DEVTOOLS_RELAY_RUNTIME_IDENTITY_VERSION,
          relayRuntimeIdentity: activeRelayRuntimeIdentity,
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

  it.each([
    { label: 'unset and explicit prefer', after: { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'prefer' }, restart: false },
    {
      label: 'policy case and whitespace',
      after: { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: ' PREFER ' },
      restart: false,
    },
    {
      label: 'explicit default timeout',
      after: { MCPORTER_CHROME_DEVTOOLS_RELAY_TIMEOUT_MS: '05000' },
      restart: false,
    },
    { label: 'default profile alias', after: { OPENCLAW_PROFILE: ' DEFAULT ' }, restart: false },
    { label: 'meaningful policy', after: { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'require' }, restart: true },
    { label: 'meaningful profile', after: { OPENCLAW_PROFILE: 'work' }, restart: true },
    { label: 'discovery PATH', after: { PATH: '/synthetic/other-bin' }, restart: true },
    {
      label: 'explicit endpoint',
      after: { MCPORTER_CHROME_DEVTOOLS_RELAY_URL: 'http://127.0.0.1:19111' },
      restart: true,
    },
    {
      label: 'shadowed process policy',
      after: { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'off' },
      definitionEnv: { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'require' },
      restart: false,
    },
  ] satisfies Array<{
    label: string;
    after: NodeJS.ProcessEnv;
    definitionEnv?: Record<string, string>;
    restart: boolean;
  }>)(
    'checks effective relay identity for $label without a config mtime change',
    async ({ after, definitionEnv, restart }) => {
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
              env: definitionEnv,
            },
          },
        }),
        'utf8'
      );
      const stat = await fs.stat(configPath);
      const { metadataPath, socketPath } = resolveDaemonPaths(configPath);
      const definition: ServerDefinition = {
        name: 'chrome',
        env: definitionEnv,
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
      activeRelayRuntimeIdentity = await resolveChromeDevtoolsRelayRuntimeIdentity(
        activeRelayEnvironmentKeys,
        process.env,
        unavailableRelayIdentity
      );
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
          relayRuntimeIdentityVersion: CHROME_DEVTOOLS_RELAY_RUNTIME_IDENTITY_VERSION,
          relayRuntimeIdentity: activeRelayRuntimeIdentity,
          relayEnvironmentKeys: activeRelayEnvironmentKeys,
        }),
        'utf8'
      );

      for (const [key, value] of Object.entries(after)) vi.stubEnv(key, value);
      const client = new DaemonClient({
        configPath,
        configExplicit: true,
        rootDir: tmpDir,
        chromeDevtoolsRelayIdentity: unavailableRelayIdentity,
      });
      await client.listTools({ server: 'chrome' });
      expect(sentMethods[0]).toBe('status');
      if (restart) {
        expect(sentMethods).toContain('stop');
        expect(launchDaemonDetached).toHaveBeenCalledOnce();
      } else {
        expect(sentMethods).toEqual(['status', 'listTools']);
        expect(launchDaemonDetached).not.toHaveBeenCalled();
      }
      expect(spawnSyncOpenClaw).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      'definition URL port',
      'SERVER_RELAY_URL',
      'MCPORTER_CHROME_DEVTOOLS_RELAY_URL',
      'http://127.0.0.1:19110',
      'http://127.0.0.1:19111',
    ],
    ['definition policy', 'SERVER_RELAY_POLICY', 'MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY', 'prefer', 'require'],
  ] as const)(
    'restarts when a %s placeholder changes without config mtime change',
    async (_case, sourceName, relayEnvName, before, after) => {
      const tmpDir = await makeShortTempDir('daemon-relay-definition-env');
      process.env.MCPORTER_DAEMON_DIR = tmpDir;
      const previousSourceValue = process.env[sourceName];
      process.env[sourceName] = before;
      const configPath = path.join(tmpDir, 'config.json');
      const definitionEnv = { [relayEnvName]: `$env:${sourceName}` };
      await fs.writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            chrome: {
              command: 'npx',
              args: ['-y', 'chrome-devtools-mcp@latest', '--autoConnect'],
              lifecycle: 'keep-alive',
              env: definitionEnv,
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
        env: definitionEnv,
      };
      activeConfigPath = configPath;
      activeSocketPath = socketPath;
      activeConfigMtime = stat.mtimeMs;
      activeStatusPid = process.pid;
      activeLayers = [{ path: configPath, mtimeMs: stat.mtimeMs }];
      activeRelayEnvironmentKeys = chromeDevtoolsRelayEnvironmentKeys([definition], process.env);
      activeRelayRuntimeIdentity = await resolveChromeDevtoolsRelayRuntimeIdentity(
        activeRelayEnvironmentKeys,
        process.env,
        unavailableRelayIdentity
      );
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
          relayRuntimeIdentityVersion: CHROME_DEVTOOLS_RELAY_RUNTIME_IDENTITY_VERSION,
          relayRuntimeIdentity: activeRelayRuntimeIdentity,
          relayEnvironmentKeys: activeRelayEnvironmentKeys,
        }),
        'utf8'
      );

      try {
        process.env[sourceName] = after;
        const client = new DaemonClient({
          configPath,
          configExplicit: true,
          rootDir: tmpDir,
          chromeDevtoolsRelayIdentity: unavailableRelayIdentity,
        });
        await client.listTools({ server: 'chrome' });
        expect(sentMethods[0]).toBe('status');
        expect(sentMethods).toContain('stop');
        expect(launchDaemonDetached).toHaveBeenCalledOnce();
        expect(spawnSyncOpenClaw).not.toHaveBeenCalled();
      } finally {
        if (previousSourceValue === undefined) delete process.env[sourceName];
        else process.env[sourceName] = previousSourceValue;
      }
    }
  );

  it('restarts when normalized no-browser environment state changes', async () => {
    const tmpDir = await makeShortTempDir('daemon-oauth-browser-env');
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
    activeOauthNoBrowser = false;
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
        relayRuntimeIdentityVersion: CHROME_DEVTOOLS_RELAY_RUNTIME_IDENTITY_VERSION,
        relayRuntimeIdentity: activeRelayRuntimeIdentity,
        relayEnvironmentKeys: activeRelayEnvironmentKeys,
        oauthNoBrowser: false,
      }),
      'utf8'
    );

    process.env.MCPORTER_OAUTH_NO_BROWSER = ' YeS ';
    const client = new DaemonClient({ configPath, configExplicit: true, rootDir: tmpDir });
    await client.listTools({ server: 'oauth' });

    expect(sentMethods[0]).toBe('status');
    expect(sentMethods).toContain('stop');
    expect(launchDaemonDetached).toHaveBeenCalledOnce();
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
    activeRelayRuntimeIdentity = await resolveChromeDevtoolsRelayRuntimeIdentity(
      activeRelayEnvironmentKeys,
      process.env,
      unavailableRelayIdentity
    );
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
        relayRuntimeIdentityVersion: CHROME_DEVTOOLS_RELAY_RUNTIME_IDENTITY_VERSION,
        relayRuntimeIdentity: activeRelayRuntimeIdentity,
        relayEnvironmentKeys: activeRelayEnvironmentKeys,
      }),
      'utf8'
    );

    try {
      await fs.writeFile(secretPath, 'b'.repeat(64), { mode: 0o600 });
      const client = new DaemonClient({
        configPath,
        configExplicit: true,
        rootDir: tmpDir,
        chromeDevtoolsRelayIdentity: unavailableRelayIdentity,
      });
      await client.listTools({ server: 'chrome' });
      expect(sentMethods[0]).toBe('status');
      expect(sentMethods).toContain('stop');
      expect(launchDaemonDetached).toHaveBeenCalledOnce();
      expect(spawnSyncOpenClaw).not.toHaveBeenCalled();
    } finally {
      if (previousOauthDir === undefined) delete process.env.OPENCLAW_OAUTH_DIR;
      else process.env.OPENCLAW_OAUTH_DIR = previousOauthDir;
    }
  });

  it('does not reuse daemon state after the discovered relay port changes', async () => {
    const tmpDir = await makeShortTempDir('daemon-relay-port');
    process.env.MCPORTER_DAEMON_DIR = tmpDir;
    const previousOauthDir = process.env.OPENCLAW_OAUTH_DIR;
    process.env.OPENCLAW_OAUTH_DIR = tmpDir;
    const configPath = path.join(tmpDir, 'config.json');
    const relayKeyHex = Buffer.alloc(32, 0x61).toString('hex');
    const keyId = deriveBrowserRelayKeyId(Buffer.from(relayKeyHex, 'hex'));
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
    await fs.writeFile(path.join(tmpDir, 'browser-extension-relay.secret'), relayKeyHex, { mode: 0o600 });
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
    let relayPort = 19_110;
    const identity = {
      discover: async () => ({ kind: 'success' as const, stdout: relayMetadata(keyId, relayPort) }),
      discovery: { platform: 'linux' as const },
    };
    activeConfigPath = configPath;
    activeSocketPath = socketPath;
    activeConfigMtime = stat.mtimeMs;
    activeStatusPid = process.pid;
    activeLayers = [{ path: configPath, mtimeMs: stat.mtimeMs }];
    activeRelayEnvironmentKeys = chromeDevtoolsRelayEnvironmentKeys([definition]);
    activeRelayRuntimeIdentity = await resolveChromeDevtoolsRelayRuntimeIdentity(
      activeRelayEnvironmentKeys,
      process.env,
      identity
    );
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
        relayRuntimeIdentityVersion: CHROME_DEVTOOLS_RELAY_RUNTIME_IDENTITY_VERSION,
        relayRuntimeIdentity: activeRelayRuntimeIdentity,
        relayEnvironmentKeys: activeRelayEnvironmentKeys,
      }),
      'utf8'
    );

    try {
      relayPort = 19_111;
      const client = new DaemonClient({
        configPath,
        configExplicit: true,
        rootDir: tmpDir,
        chromeDevtoolsRelayIdentity: identity,
      });
      await client.listTools({ server: 'chrome' });
      expect(sentMethods[0]).toBe('status');
      expect(sentMethods).toContain('stop');
      expect(launchDaemonDetached).toHaveBeenCalledOnce();
      expect(relayPort).toBe(19_111);
      expect(spawnSyncOpenClaw).not.toHaveBeenCalled();
    } finally {
      if (previousOauthDir === undefined) delete process.env.OPENCLAW_OAUTH_DIR;
      else process.env.OPENCLAW_OAUTH_DIR = previousOauthDir;
    }
  });
});

function relayMetadata(keyId: string, port: number): Buffer {
  const browserUrl = `http://127.0.0.1:${port}`;
  return Buffer.from(
    JSON.stringify({
      browserUrl,
      wsEndpoint: `ws://127.0.0.1:${port}/cdp`,
      auth: {
        label: BROWSER_RELAY_AUTH_LABEL,
        version: BROWSER_RELAY_AUTH_VERSION,
        keyId,
        challengeUrl: new URL(BROWSER_RELAY_AUTH_CHALLENGE_PATH, browserUrl).toString(),
        completeUrl: new URL(BROWSER_RELAY_AUTH_COMPLETE_PATH, browserUrl).toString(),
        role: 'cdp',
        transport: 'connection',
        method: 'SEQUENCE',
        resource: '/json/version -> /cdp',
        flow: 'cdp',
      },
    })
  );
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
