import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAEMON_PROTOCOL_VERSION } from '../src/daemon/protocol.js';
import { makeShortTempDir } from './fixtures/test-helpers.js';

const timeoutRecords: Array<{ method: string; timeout: number }> = [];

class MockSocket extends EventEmitter {
  currentTimeout = 0;
  private timeoutHandle?: NodeJS.Timeout;
  private progressHandle?: NodeJS.Timeout;

  // The client arms this as an idle deadline and re-arms it on every frame, so
  // the mock has to clear the previous timer instead of stacking them.
  setTimeout(ms: number): this {
    this.currentTimeout = ms;
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
    }
    if (enforceSocketTimeout && ms > 0) {
      this.timeoutHandle = setTimeout(() => this.emit('timeout'), ms);
    }
    return this;
  }

  write(data: string, cb?: (err?: Error | null) => void): boolean {
    const payload = JSON.parse(data.toString());
    timeoutRecords.push({ method: payload.method, timeout: this.currentTimeout });
    const response = buildResponse(payload.method, payload.id);
    if (progressIntervalMs > 0) {
      this.progressHandle = setInterval(() => {
        this.emit('data', `${JSON.stringify({ type: 'progress', id: payload.id })}\n`);
      }, progressIntervalMs);
    }
    setTimeout(() => {
      this.clearTimers();
      this.emit('data', JSON.stringify(response));
      this.emit('end');
    }, responseDelayMs);
    cb?.();
    return true;
  }

  end(cb?: () => void): this {
    cb?.();
    return this;
  }

  destroy(error?: Error): this {
    this.clearTimers();
    if (error) {
      queueMicrotask(() => this.emit('error', error));
    }
    return this;
  }

  private clearTimers(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
    }
    if (this.progressHandle) {
      clearInterval(this.progressHandle);
      this.progressHandle = undefined;
    }
  }
}

let responseDelayMs = 5;
let enforceSocketTimeout = false;
let progressIntervalMs = 0;
let activeConfigPath = path.resolve('mcporter.config.json');
let activeSocketPath = '';
const createConnection = vi.fn(() => {
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
        protocolVersion: DAEMON_PROTOCOL_VERSION,
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
  };
}

describe('DaemonClient timeouts', () => {
  beforeEach(async () => {
    timeoutRecords.length = 0;
    responseDelayMs = 5;
    enforceSocketTimeout = false;
    progressIntervalMs = 0;
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
    // The socket deadline is the caller deadline verbatim: it measures silence
    // from the daemon, not total operation time, so it never has to be scaled by
    // a guessed phase count.
    expect(statusRecord?.timeout).toBe(300_000);
    expect(listRecord?.timeout).toBe(300_000);
  });

  it('keeps the listTools socket alive while the daemon reports progress', async () => {
    // Progress frames arrive every 20ms for 600ms, so the response lands four
    // times past the point where a 150ms deadline measured against total elapsed
    // time would have fired. The gap between frame and deadline is wide enough to
    // survive coarse timer granularity (Windows resolves timers to ~15.6ms).
    responseDelayMs = 600;
    progressIntervalMs = 20;
    enforceSocketTimeout = true;
    const configPath = 'mcporter.config.json';
    await writeFreshMetadata(configPath);
    const client = new DaemonClient({ configPath, configExplicit: true });

    await expect(client.listTools({ server: 'foo', timeoutMs: 150 })).resolves.toEqual({ ok: true });

    const listRecord = timeoutRecords.find((entry) => entry.method === 'listTools');
    expect(listRecord?.timeout).toBe(150);
  });

  it('leaves callTool operation socket budget unchanged', async () => {
    const configPath = 'mcporter.config.json';
    await writeFreshMetadata(configPath);
    const client = new DaemonClient({ configPath, configExplicit: true });
    await client.callTool({ server: 'foo', tool: 'bar', timeoutMs: 12_345 });
    const callRecord = timeoutRecords.find((entry) => entry.method === 'callTool');
    expect(callRecord?.timeout).toBe(12_345);
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
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      socketPath: paths.socketPath,
      configPath,
      configLayers: [{ path: activeConfigPath, mtimeMs: null }],
      startedAt: Date.now(),
    }),
    'utf8'
  );
}
