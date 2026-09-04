import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { singletonFixture, fixtureResult } from './helpers/singleton.js';
import { runDaemonHost } from '../src/daemon/host.js';
import { resolveDaemonPaths } from '../src/daemon/client.js';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it('expires generic idle transports only after queued calls finish, and reconnects one generation', async () => {
  const f = await singletonFixture();
  let pending: Promise<unknown> = Promise.resolve();
  try {
    const definition = { ...f.definition, lifecycle: { mode: 'keep-alive' as const, idleTimeoutMs: 10 } };
    const a = f.client(definition),
      b = f.client({ ...definition, name: 'alias' });
    const first = a.callTool({ server: 'fixture', tool: 'delayed' });
    const queued = b.callTool({ server: 'alias', tool: 'delayed' });
    pending = Promise.allSettled([first, queued]);
    await vi.waitFor(() => expect(f.host.status().servers[0]?.activeCalls).toBe(2));
    await pause(30);
    expect(f.host.status().servers[0]?.activeCalls).toBe(2);
    const results = (await Promise.all([first, queued])).map(fixtureResult);
    expect(results[0]?.id).toBe(results[1]?.id);
    await vi.waitFor(() => expect(f.host.status().servers[0]?.connected).toBe(false));
    const nextCalls = [
      a.callTool({ server: 'fixture', tool: 'delayed' }),
      b.callTool({ server: 'alias', tool: 'identity' }),
    ];
    pending = Promise.allSettled(nextCalls);
    const next = (await Promise.all(nextCalls)).map(fixtureResult);
    expect(next[0]?.id).not.toBe(results[0]?.id);
    expect(next[1]?.id).toBe(next[0]?.id);
    expect(f.host.status().servers[0]?.connectionGeneration).toBe(2);
    expect((await fs.readFile(path.join(f.root, 'instances'), 'utf8')).trim().split('\n')).toHaveLength(2);
  } finally {
    await pending;
    await f.close();
  }
});

it('separates generic idle policies and retains unknown outcomes without replay or idle retirement', async () => {
  const f = await singletonFixture();
  let pending: Promise<unknown> = Promise.resolve();
  try {
    const retained = fixtureResult(await f.client().callTool({ server: 'fixture', tool: 'identity' }));
    const timed = f.client({ ...f.definition, lifecycle: { mode: 'keep-alive', idleTimeoutMs: 10 } });
    const calls = [
      timed.callTool({ server: 'fixture', tool: 'identity' }),
      expect(timed.callTool({ server: 'fixture', tool: 'delayed', timeoutMs: 20 })).rejects.toMatchObject({
        code: 'operation_timeout',
      }),
    ];
    pending = Promise.allSettled(calls);
    const [initial] = await Promise.all(calls);
    const other = fixtureResult(initial);
    expect(other.id).not.toBe(retained.id);
    await pause(300);
    expect(f.host.status().servers.find((entry) => entry.idleTimeoutMs === 10)?.idleBlocked).toBe('unknown-outcome');
    expect(fixtureResult(await timed.callTool({ server: 'fixture', tool: 'identity' })).id).toBe(other.id);
    expect(fixtureResult(await f.client().callTool({ server: 'fixture', tool: 'identity' })).id).toBe(retained.id);
    expect((await fs.readFile(path.join(f.root, 'effects'), 'utf8')).trim().split('\n')).toEqual(['once']);
  } finally {
    await pending;
    await f.close();
  }
});

it('honors canonical user host idle settings after active calls finish and ignores project idle settings', async () => {
  const f = await singletonFixture();
  const previous = process.env.MCPORTER_DAEMON_DIR;
  let host: Awaited<ReturnType<typeof runDaemonHost>> | undefined;
  let pending: Promise<unknown> = Promise.resolve();
  let setupClock: { mockRestore(): void } | undefined;
  const info = os.userInfo();
  const account = vi.spyOn(os, 'userInfo').mockReturnValue({ ...info, homedir: f.root });
  try {
    await f.host.close();
    process.env.MCPORTER_DAEMON_DIR = path.join(f.root, '.mcporter');
    await fs.mkdir(process.env.MCPORTER_DAEMON_DIR, { mode: 0o700 });
    await fs.writeFile(
      path.join(process.env.MCPORTER_DAEMON_DIR, 'mcporter.json'),
      JSON.stringify({ imports: [], mcpServers: {}, daemonIdleTimeoutMs: 50 })
    );
    const paths = resolveDaemonPaths('');
    // Hold startup time until the request is admitted, independently of OS setup latency.
    setupClock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    host = await runDaemonHost({ ...paths, configPath: '' });
    const call = f.client().callTool({ server: 'fixture', tool: 'delayed' });
    pending = Promise.allSettled([call]);
    await vi.waitFor(() => expect(host?.status().servers[0]?.activeCalls).toBe(1));
    setupClock.mockRestore();
    setupClock = undefined;
    await pause(75);
    expect(host.status().idleTimeoutMs).toBe(50);
    expect(host.status().idleShutdownBlocked).toBe(true);
    await expect(fs.stat(paths.metadataPath)).resolves.toBeDefined();
    await call;
    // Poll the artifact instead of keeping a Windows directory watcher alive during removal.
    while (
      await fs.stat(paths.metadataPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      })
    )
      await pause(10);
    await expect(fs.stat(paths.metadataPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(host.status().servers).toEqual([]);
    // A project path passed at host startup never becomes canonical user authority.
    await fs.writeFile(
      path.join(process.env.MCPORTER_DAEMON_DIR, 'mcporter.json'),
      JSON.stringify({ imports: [], mcpServers: {} })
    );
    const project = path.join(f.root, 'project.json');
    await fs.writeFile(project, JSON.stringify({ imports: [], mcpServers: {}, daemonIdleTimeoutMs: 1 }));
    host = await runDaemonHost({ ...paths, configPath: project });
    await pause(75);
    expect(host.status().idleTimeoutMs).toBeUndefined();
    await expect(fs.stat(paths.metadataPath)).resolves.toBeDefined();
  } finally {
    setupClock?.mockRestore();
    await pending;
    await host?.close();
    account.mockRestore();
    if (previous === undefined) delete process.env.MCPORTER_DAEMON_DIR;
    else process.env.MCPORTER_DAEMON_DIR = previous;
    await f.close();
  }
});
