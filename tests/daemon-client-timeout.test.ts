import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashChromeDevtoolsRelayProcessEnvironment } from '../src/chrome-devtools-relay.js';
import { NON_INTERACTIVE_ELICITATION_HINT } from '../src/runtime/elicitation.js';
import { DAEMON_OAUTH_FLOW_ERROR_CODE } from '../src/daemon/protocol.js';
import { makeShortTempDir } from './fixtures/test-helpers.js';

const timeoutRecords: Array<{ method: string; timeout: number }> = [];

class MockSocket extends EventEmitter {
  currentTimeout = 0;

  setTimeout(ms: number): this {
    this.currentTimeout = ms;
    return this;
  }

  write(data: string, cb?: (err?: Error | null) => void): boolean {
    const payload = JSON.parse(data.toString());
    timeoutRecords.push({ method: payload.method, timeout: this.currentTimeout });
    const response = buildResponse(payload.method, payload.id);
    setTimeout(() => {
      this.emit('data', responseOverrides.get(payload.method) ?? JSON.stringify(response));
      this.emit('end');
    }, responseDelayMs);
    cb?.();
    return true;
  }

  end(cb?: () => void): this {
    cb?.();
    return this;
  }

  destroy(): this {
    return this;
  }
}

let responseDelayMs = 5;
let noticeOnCall = false;
const responseOverrides = new Map<string, string>();
let activeConfigPath = path.resolve('mcporter.config.json');
let activeSocketPath = '';
const createConnection = vi.hoisted(() => vi.fn());
createConnection.mockImplementation(() => {
  const socket = new MockSocket();
  setTimeout(() => socket.emit('connect'), 0);
  return socket;
});

let previousDaemonTimeout: string | undefined;
let previousDaemonDir: string | undefined;
let tmpDaemonDir: string | undefined;

vi.mock('node:net', () => ({
  createConnection,
  default: { createConnection },
}));

vi.mock('../src/daemon/launch.js', () => ({
  launchDaemonDetached: vi.fn(),
}));

const { DaemonClient, resolveDaemonPaths } = await import('../src/daemon/client.js');

function buildResponse(method: string, id: string) {
  if (method === 'status') {
    return {
      id,
      ok: true,
      result: {
        pid: process.pid,
        startedAt: Date.now(),
        configPath: activeConfigPath,
        socketPath: activeSocketPath,
        servers: [],
      },
    };
  }
  return {
    id,
    ok: true,
    result: { ok: true },
    ...(noticeOnCall ? { notices: [NON_INTERACTIVE_ELICITATION_HINT] } : {}),
  };
}

describe('DaemonClient timeouts', () => {
  beforeEach(async () => {
    timeoutRecords.length = 0;
    responseDelayMs = 5;
    noticeOnCall = false;
    responseOverrides.clear();
    previousDaemonTimeout = process.env.MCPORTER_DAEMON_TIMEOUT_MS;
    previousDaemonDir = process.env.MCPORTER_DAEMON_DIR;
    tmpDaemonDir = await makeShortTempDir('daemon-timeout');
    process.env.MCPORTER_DAEMON_DIR = tmpDaemonDir;
    delete process.env.MCPORTER_DAEMON_TIMEOUT_MS;
  });

  afterEach(async () => {
    if (previousDaemonTimeout === undefined) {
      delete process.env.MCPORTER_DAEMON_TIMEOUT_MS;
    } else {
      process.env.MCPORTER_DAEMON_TIMEOUT_MS = previousDaemonTimeout;
    }
    if (previousDaemonDir === undefined) {
      delete process.env.MCPORTER_DAEMON_DIR;
    } else {
      process.env.MCPORTER_DAEMON_DIR = previousDaemonDir;
    }
    if (tmpDaemonDir) {
      await fs.rm(tmpDaemonDir, { recursive: true, force: true });
    }
  });

  it('defaults to 30s per request', async () => {
    const configPath = 'mcporter.config.json';
    await writeFreshMetadata(configPath);
    const client = new DaemonClient({ configPath, configExplicit: true });
    await client.callTool({ server: 'foo', tool: 'bar' });
    const statusRecord = timeoutRecords.find((entry) => entry.method === 'status');
    const callRecord = timeoutRecords.find((entry) => entry.method === 'callTool');
    expect(statusRecord?.timeout).toBe(30_000);
    expect(callRecord?.timeout).toBe(30_000);
  });

  it('honors MCPORTER_DAEMON_TIMEOUT_MS override', async () => {
    process.env.MCPORTER_DAEMON_TIMEOUT_MS = '4500';
    const configPath = 'mcporter.config.json';
    await writeFreshMetadata(configPath);
    const client = new DaemonClient({ configPath, configExplicit: true });
    await client.callTool({ server: 'foo', tool: 'bar' });
    const statusRecord = timeoutRecords.find((entry) => entry.method === 'status');
    const callRecord = timeoutRecords.find((entry) => entry.method === 'callTool');
    expect(statusRecord?.timeout).toBe(4_500);
    expect(callRecord?.timeout).toBe(4_500);
  });

  it('honors per-call timeout overrides', async () => {
    const configPath = 'mcporter.config.json';
    await writeFreshMetadata(configPath);
    const client = new DaemonClient({ configPath, configExplicit: true });
    await client.callTool({ server: 'foo', tool: 'bar', timeoutMs: 12_345 });
    const statusRecord = timeoutRecords.find((entry) => entry.method === 'status');
    const callRecord = timeoutRecords.find((entry) => entry.method === 'callTool');
    expect(statusRecord?.timeout).toBe(12_345);
    expect(callRecord?.timeout).toBe(12_345);
  });

  it('honors per-listTools timeout overrides', async () => {
    const configPath = 'mcporter.config.json';
    await writeFreshMetadata(configPath);
    const client = new DaemonClient({ configPath, configExplicit: true });
    await client.listTools({ server: 'foo', timeoutMs: 300_000 });
    const statusRecord = timeoutRecords.find((entry) => entry.method === 'status');
    const listRecord = timeoutRecords.find((entry) => entry.method === 'listTools');
    expect(statusRecord?.timeout).toBe(300_000);
    expect(listRecord?.timeout).toBe(300_000);
  });

  it('clamps daemon status preflight timeout for tiny per-call timeouts', async () => {
    const configPath = 'mcporter.config.json';
    await writeFreshMetadata(configPath);
    const client = new DaemonClient({ configPath, configExplicit: true });
    await client.callTool({ server: 'foo', tool: 'bar', timeoutMs: 1 });
    const statusRecord = timeoutRecords.find((entry) => entry.method === 'status');
    const callRecord = timeoutRecords.find((entry) => entry.method === 'callTool');
    expect(statusRecord?.timeout).toBe(1_000);
    expect(callRecord?.timeout).toBe(1);
  });

  it('surfaces daemon notices to the calling CLI process', async () => {
    const configPath = 'mcporter.config.json';
    await writeFreshMetadata(configPath);
    noticeOnCall = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new DaemonClient({ configPath, configExplicit: true });

    await client.callTool({ server: 'foo', tool: 'bar' });

    expect(warn).toHaveBeenCalledWith(`[mcporter] ${NON_INTERACTIVE_ELICITATION_HINT}`);
    warn.mockRestore();
  });

  it('reconstructs stable OAuth flow error codes from daemon responses', async () => {
    const configPath = 'mcporter.config.json';
    await writeFreshMetadata(configPath);
    responseOverrides.set(
      'callTool',
      JSON.stringify({
        id: 'oauth-flow',
        ok: false,
        error: { code: DAEMON_OAUTH_FLOW_ERROR_CODE, message: 'browser launch is suppressed' },
      })
    );
    const client = new DaemonClient({ configPath, configExplicit: true });

    const error = await client.callTool({ server: 'foo', tool: 'bar' }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ message: 'browser launch is suppressed', code: DAEMON_OAUTH_FLOW_ERROR_CODE });
  });

  it('routes resource and close requests through the daemon protocol', async () => {
    const configPath = 'mcporter.config.json';
    await writeFreshMetadata(configPath);
    const client = new DaemonClient({ configPath, configExplicit: true });

    await client.listResources({ server: 'foo' });
    await client.readResource({ server: 'foo', uri: 'memo://one' });
    await client.closeServer({ server: 'foo' });

    expect(timeoutRecords.map((entry) => entry.method)).toEqual([
      'status',
      'listResources',
      'status',
      'readResource',
      'status',
      'closeServer',
    ]);
  });

  it.each([
    ['', 'Empty daemon response'],
    ['not-json', 'Failed to parse daemon response'],
    [
      JSON.stringify({ id: 'x', ok: false, error: { code: 'BAD_REQUEST', message: 'daemon rejected request' } }),
      'daemon rejected request',
    ],
  ])('rejects invalid daemon payload %j', async (payload, message) => {
    const configPath = 'mcporter.config.json';
    responseOverrides.set('listResources', payload);
    const client = new DaemonClient({ configPath, configExplicit: true });

    await expect(
      (
        client as unknown as {
          sendRequest(method: 'listResources', params: object): Promise<unknown>;
        }
      ).sendRequest('listResources', {})
    ).rejects.toThrow(message);
  });

  it('treats transport errors during stop as an already-stopped daemon', async () => {
    const configPath = 'mcporter.config.json';
    const client = new DaemonClient({ configPath, configExplicit: true });
    responseOverrides.set(
      'stop',
      JSON.stringify({ id: 'x', ok: false, error: { code: 'ECONNRESET', message: 'socket closed' } })
    );
    await expect(client.stop()).resolves.toBeUndefined();

    responseOverrides.set('stop', JSON.stringify({ id: 'x', ok: false, error: { code: 'DENIED', message: 'denied' } }));
    await expect(client.stop()).rejects.toThrow('denied');
  });

  it('falls back to the default timeout for invalid environment overrides', async () => {
    process.env.MCPORTER_DAEMON_TIMEOUT_MS = '-20';
    const configPath = 'mcporter.config.json';
    const client = new DaemonClient({ configPath, configExplicit: true });

    await (client as unknown as { sendRequest(method: 'listTools', params: object): Promise<unknown> }).sendRequest(
      'listTools',
      {}
    );

    expect(timeoutRecords.at(-1)?.timeout).toBe(30_000);
  });
});

async function writeFreshMetadata(configPath: string): Promise<void> {
  activeConfigPath = path.resolve(configPath);
  const paths = resolveDaemonPaths(configPath);
  activeSocketPath = paths.socketPath;
  await fs.mkdir(path.dirname(paths.metadataPath), { recursive: true });
  await fs.writeFile(
    paths.metadataPath,
    JSON.stringify({
      pid: process.pid,
      socketPath: paths.socketPath,
      configPath,
      configLayers: [{ path: activeConfigPath, mtimeMs: null }],
      relayEnvironmentHash: hashChromeDevtoolsRelayProcessEnvironment([], {}),
      relayEnvironmentKeys: [],
      startedAt: Date.now(),
    }),
    'utf8'
  );
}
