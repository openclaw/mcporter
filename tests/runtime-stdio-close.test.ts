import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { RuntimeConnectionCache } from '../src/runtime/connection-cache.js';
import { McporterStdioTransport } from '../src/runtime/stdio-transport.js';

const fixture = new URL('./fixtures/sigterm-resistant-tree.mjs', import.meta.url).pathname;
const cleanupPids = new Set<number>();

afterEach(async () => {
  for (const pid of cleanupPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  cleanupPids.clear();
});

describe('stdio runtime close', () => {
  it('reaps a SIGTERM-resistant process tree with inherited stdio in bounded time', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-stdio-close-'));
    const pidFile = path.join(tempDir, 'descendant.pid');
    const definition: ServerDefinition = {
      name: 'resistant-tree',
      command: { kind: 'stdio', command: process.execPath, args: [fixture, pidFile], cwd: tempDir },
    };
    const transport = new McporterStdioTransport({
      command: process.execPath,
      args: [fixture, pidFile],
      cwd: tempDir,
    });
    await transport.start();
    const rootPid = transport.pid;
    if (!rootPid) throw new Error('fixture process did not start');
    cleanupPids.add(rootPid);
    const descendantPid = await waitForPid(pidFile);
    cleanupPids.add(descendantPid);
    const cache = new RuntimeConnectionCache(new Map([[definition.name, definition]]), {
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      clientInfo: { name: 'close-test', version: '1' },
      oauthTimeoutMs: 1_000,
      elicitationHandler: async () => ({ action: 'decline' }),
    });
    const started = Date.now();

    await cache.closeContext({
      client: { close: () => transport.close() } as never,
      transport,
      definition,
    });

    expect(Date.now() - started).toBeLessThan(2_500);
    await expectProcessExit(rootPid);
    await expectProcessExit(descendantPid);
    cleanupPids.delete(rootPid);
    cleanupPids.delete(descendantPid);
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});

async function waitForPid(pidFile: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt(await fs.readFile(pidFile, 'utf8'), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('descendant pid was not written');
}

async function expectProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(isProcessAlive(pid)).toBe(false);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
