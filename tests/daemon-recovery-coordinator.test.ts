import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureDaemonRunning } from '../src/daemon/recovery.js';
import { launchDaemonDetached } from '../src/daemon/launch.js';
import { readLifecycle, writeLifecycle, updateOwner } from '../src/daemon/lifecycle-state.js';
import { retireManagedOwner } from '../src/daemon/managed-owner.js';
import { secureDaemonDirectory, getDaemonMetadataPath, getDaemonSocketPath } from '../src/daemon/paths.js';
import { privateFixtureDirectory } from './helpers/private-directory.js';
import type { StatusResult } from '../src/daemon/protocol.js';

vi.mock('../src/daemon/launch.js', () => ({ launchDaemonDetached: vi.fn() }));
vi.mock('../src/daemon/managed-owner.js', () => ({ retireManagedOwner: vi.fn() }));
let root: string;
let ready: string | undefined;
const old = '11111111-1111-4111-8111-111111111111';
const probe = async (): Promise<StatusResult | null> =>
  ready
    ? {
        pid: process.pid,
        generation: ready,
        startedAt: Date.now(),
        configPath: '',
        socketPath: getDaemonSocketPath(),
        servers: [],
      }
    : null;
const options = () => ({
  configPath: path.join(root, 'config.json'),
  metadataPath: getDaemonMetadataPath(),
  socketPath: getDaemonSocketPath(),
});
beforeEach(async () => {
  root = await fs.realpath(await privateFixtureDirectory('mcp-coord-'));
  vi.stubEnv('MCPORTER_DAEMON_DIR', root);
  await secureDaemonDirectory();
  ready = undefined;
  vi.mocked(retireManagedOwner)
    .mockReset()
    .mockImplementation(async (owner) => {
      expect((await readLifecycle()).active?.phase).toBe('retiring');
      expect((await readLifecycle()).active?.generation).toBe(owner.generation);
    });
  vi.mocked(launchDaemonDetached)
    .mockReset()
    .mockImplementation(async (launch) => {
      ready = launch.generation;
      return { exitCode: null, signalCode: null } as Awaited<ReturnType<typeof launchDaemonDetached>>;
    });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
it('replaces an unpublished reservation after a coordinator dies and fences its late child', async () => {
  await writeLifecycle({
    version: 1,
    attempts: [Date.now()],
    active: { generation: old, startedAt: Date.now(), kind: 'posix', phase: 'starting' },
  });
  await ensureDaemonRunning(options(), probe);
  expect(ready).not.toBe(old);
  expect(retireManagedOwner).not.toHaveBeenCalled();
  await expect(updateOwner(old, { phase: 'ready' })).rejects.toThrow('reservation expired');
});
it('revokes admission before retiring an existing owner', async () => {
  await writeLifecycle({
    version: 1,
    attempts: [Date.now()],
    active: {
      generation: old,
      startedAt: Date.now(),
      kind: 'posix',
      phase: 'ready',
      identity: { pid: process.pid, parent: process.ppid, owner: 'test', born: 'test' },
    },
  });
  await ensureDaemonRunning(options(), probe);
  expect(retireManagedOwner).toHaveBeenCalledOnce();
});
it('keeps a shared rolling restart budget after launch errors across independent callers', async () => {
  vi.mocked(launchDaemonDetached).mockRejectedValue(new Error('missing executable'));
  await expect(ensureDaemonRunning(options(), probe)).rejects.toThrow('bounded startup attempts');
  expect((await readLifecycle()).attempts).toHaveLength(2);
  await expect(ensureDaemonRunning(options(), probe)).rejects.toThrow('restart limit');
  expect(launchDaemonDetached).toHaveBeenCalledTimes(3);
  expect((await readLifecycle()).attempts).toHaveLength(3);
});
it('does not accept an authenticated but unexpected startup generation', async () => {
  vi.mocked(launchDaemonDetached).mockImplementation(async () => {
    ready = old;
    return { exitCode: null, signalCode: null } as Awaited<ReturnType<typeof launchDaemonDetached>>;
  });
  await expect(ensureDaemonRunning(options(), probe)).rejects.toThrow('bounded startup attempts');
});

it('replaces a responsive generation whose admission was already revoked', async () => {
  ready = old;
  await writeLifecycle({
    version: 1,
    attempts: [],
    active: {
      generation: old,
      startedAt: Date.now(),
      kind: 'posix',
      phase: 'retiring',
      identity: { pid: process.pid, parent: process.ppid, owner: 'test', born: 'test' },
    },
  });
  await ensureDaemonRunning(options(), probe);
  expect(ready).not.toBe(old);
  expect(retireManagedOwner).toHaveBeenCalledOnce();
});

it('latches foreground cancellation before ownership publication without retrying startup', async () => {
  const priorExitCode = process.exitCode;
  vi.mocked(launchDaemonDetached).mockImplementation(async () => {
    process.emit('SIGINT');
    return { exitCode: null, signalCode: null } as Awaited<ReturnType<typeof launchDaemonDetached>>;
  });
  try {
    await ensureDaemonRunning({ ...options(), foreground: true }, probe);
    expect(launchDaemonDetached).toHaveBeenCalledOnce();
    expect((await readLifecycle()).active?.phase).toBe('retiring');
    expect(process.exitCode).toBe(130);
  } finally {
    process.exitCode = priorExitCode;
  }
});
