import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { privateFixtureDirectory } from './helpers/private-directory.js';
import { runDaemonHost } from '../src/daemon/host.js';
import { DaemonClient, resolveDaemonPaths } from '../src/daemon/client.js';
import { DaemonBroker } from '../src/daemon/broker.js';
import { MAX_NATIVE_TIMER_MS } from '../src/daemon/idle-timer.js';

it('slices the full host deadline, reschedules activity, and waits without spinning when shutdown is blocked', async () => {
  const root = await privateFixtureDirectory('mcp-host-clock-');
  const previous = process.env.MCPORTER_DAEMON_DIR;
  process.env.MCPORTER_DAEMON_DIR = path.join(root, '.mcporter');
  const account = vi.spyOn(os, 'userInfo').mockReturnValue({ ...os.userInfo(), homedir: root });
  const month = 30 * 24 * 60 * 60 * 1000;
  let host: Awaited<ReturnType<typeof runDaemonHost>> | undefined;
  try {
    await fs.mkdir(process.env.MCPORTER_DAEMON_DIR, { mode: 0o700 });
    await fs.writeFile(
      path.join(process.env.MCPORTER_DAEMON_DIR, 'mcporter.json'),
      JSON.stringify({ imports: [], mcpServers: {}, daemonIdleTimeoutMs: month })
    );
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const paths = resolveDaemonPaths('');
    host = await runDaemonHost({ ...paths, configPath: '' });
    const close = vi.spyOn(DaemonBroker.prototype, 'close');
    await vi.advanceTimersByTimeAsync(MAX_NATIVE_TIMER_MS);
    expect(close).not.toHaveBeenCalled();
    // Actual authenticated activity resets the host's inactivity deadline.
    expect(await new DaemonClient({ configPath: '' }).status()).toMatchObject({ idleTimeoutMs: month });
    await vi.advanceTimersByTimeAsync(month - MAX_NATIVE_TIMER_MS);
    expect(close).not.toHaveBeenCalled();
    const permitted = vi.spyOn(DaemonBroker.prototype, 'canIdleShutdown').mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(MAX_NATIVE_TIMER_MS);
    expect(close).not.toHaveBeenCalled();
    const checks = permitted.mock.calls.length;
    await vi.advanceTimersByTimeAsync(MAX_NATIVE_TIMER_MS - 1);
    expect(permitted).toHaveBeenCalledTimes(checks);
    await vi.advanceTimersByTimeAsync(1);
    expect(permitted).toHaveBeenCalledTimes(checks + 1);
    permitted.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(MAX_NATIVE_TIMER_MS);
    expect(close).toHaveBeenCalledTimes(1);
    await host.close();
    await expect(fs.stat(paths.metadataPath)).rejects.toMatchObject({ code: 'ENOENT' });
    host = await runDaemonHost({ ...paths, configPath: '' });
    await vi.advanceTimersByTimeAsync(month - 1);
    expect(close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(close).toHaveBeenCalledTimes(2);
    await host.close();
    expect(timers.mock.calls.every(([, delay]) => delay! > 0 && delay! <= MAX_NATIVE_TIMER_MS)).toBe(true);
  } finally {
    vi.useRealTimers();
    await host?.close();
    account.mockRestore();
    vi.restoreAllMocks();
    if (previous === undefined) delete process.env.MCPORTER_DAEMON_DIR;
    else process.env.MCPORTER_DAEMON_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
