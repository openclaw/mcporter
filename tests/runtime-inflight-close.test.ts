import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRuntime } from '../src/runtime.js';

const fixture = new URL('./fixtures/unresponsive-stdio.mjs', import.meta.url).pathname;

describe('runtime in-flight connection close', () => {
  it('cancels an unresponsive stdio connect in under one second', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-inflight-close-'));
    const pidFile = path.join(tempDir, 'server.pid');
    const runtime = await createRuntime({
      servers: [
        {
          name: 'unresponsive',
          command: {
            kind: 'stdio',
            command: process.execPath,
            args: [fixture, pidFile],
            cwd: tempDir,
          },
          protocolVersion: 'legacy',
        },
      ],
    });
    const connecting = runtime.connect('unresponsive');
    const connectionResult = connecting.then(
      () => undefined,
      (error: unknown) => error
    );
    const pid = await waitForPid(pidFile);
    let closing: Promise<void> | undefined;
    try {
      closing = runtime.close();
      const settledPromptly = await Promise.race([
        closing.then(
          () => true,
          () => true
        ),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);
      expect(settledPromptly).toBe(true);
      await expect(connectionResult).resolves.toBeInstanceOf(Error);
    } finally {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
      await Promise.allSettled([connecting, closing]);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
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
  throw new Error('unresponsive fixture did not start');
}
