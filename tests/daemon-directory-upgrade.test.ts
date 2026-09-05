import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { legacyDaemons, stopVerifiedLegacyDaemons } from '../src/daemon/migration.js';
import { daemonRunDir, secureDaemonDirectory, upgradeLegacyDaemonDirectory } from '../src/daemon/paths.js';
import { privateFixtureDirectory } from './helpers/private-directory.js';

async function mode(target: string): Promise<number> {
  return (await fs.lstat(target)).mode & 0o7777;
}

describe.skipIf(process.platform === 'win32')('POSIX legacy directory upgrade', () => {
  let root: string;
  let directory: string;
  beforeEach(async () => {
    root = await privateFixtureDirectory('mcp-upgrade-');
    vi.stubEnv('MCPORTER_DAEMON_DIR', root);
    directory = daemonRunDir();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function legacyDirectory(): Promise<void> {
    await fs.mkdir(directory);
    await fs.chmod(directory, 0o755);
  }

  it('inspects absent state without creating it, and creates private state on confirmed migration', async () => {
    expect(await legacyDaemons()).toEqual([]);
    await expect(fs.lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await stopVerifiedLegacyDaemons();
    expect(await mode(directory)).toBe(0o700);
    await secureDaemonDirectory();
  });

  it('upgrades empty legacy state explicitly, leaves parent and unrelated directories unchanged, and is idempotent', async () => {
    await legacyDirectory();
    const unrelated = path.join(root, 'other');
    await fs.mkdir(unrelated, { mode: 0o755 });
    const parentMode = await mode(root);
    expect(await legacyDaemons()).toEqual([]);
    expect(await mode(directory)).toBe(0o755);
    await expect(secureDaemonDirectory()).rejects.toThrow('daemon migrate --stop-legacy --confirmed-drained');
    expect(await mode(directory)).toBe(0o755);
    await stopVerifiedLegacyDaemons();
    expect(await mode(directory)).toBe(0o700);
    expect(await mode(root)).toBe(parentMode);
    expect(await mode(unrelated)).toBe(0o755);
    const chmod = vi.spyOn(fs, 'chmod');
    await stopVerifiedLegacyDaemons();
    await secureDaemonDirectory();
    expect(await mode(directory)).toBe(0o700);
    expect(chmod).not.toHaveBeenCalled();
  });

  it.each([0o777, 0o775, 0o705, 0o750, 0o1755])(
    'refuses untrusted mode %i without changing it',
    async (permissions) => {
      await legacyDirectory();
      await fs.chmod(directory, permissions);
      await expect(legacyDaemons()).rejects.toThrow('current-user-owned directory');
      await expect(stopVerifiedLegacyDaemons()).rejects.toThrow('current-user-owned directory');
      expect(await mode(directory)).toBe(permissions);
    }
  );

  it('refuses a different owner without changing permissions', async () => {
    await legacyDirectory();
    const uid = process.getuid!();
    vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    await expect(legacyDaemons()).rejects.toThrow('current-user-owned directory');
    await expect(stopVerifiedLegacyDaemons()).rejects.toThrow('current-user-owned directory');
    expect(await mode(directory)).toBe(0o755);
  });

  it.each(['symlink', 'file'])('refuses a %s without changing its target', async (kind) => {
    const target = path.join(root, 'target');
    await fs.mkdir(target, { mode: 0o755 });
    if (kind === 'symlink') await fs.symlink(target, directory);
    else await fs.writeFile(directory, 'unchanged', { mode: 0o755 });
    await expect(legacyDaemons()).rejects.toThrow('current-user-owned directory');
    await expect(stopVerifiedLegacyDaemons()).rejects.toThrow('current-user-owned directory');
    expect(await mode(target)).toBe(0o755);
    if (kind === 'file') {
      expect(await fs.readFile(directory, 'utf8')).toBe('unchanged');
      expect(await mode(directory)).toBe(0o755);
    } else expect(await fs.readlink(directory)).toBe(target);
  });

  it.each(['symlink', 'directory'])('rejects replacement by a %s between lstat and open', async (kind) => {
    await legacyDirectory();
    const moved = path.join(root, 'original');
    const target = path.join(root, 'target');
    await fs.mkdir(target, { mode: 0o755 });
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      await fs.rename(directory, moved);
      if (kind === 'symlink') await fs.symlink(target, directory);
      else await fs.mkdir(directory, { mode: 0o755 });
      return open(...args);
    });
    await expect(upgradeLegacyDaemonDirectory(directory)).rejects.toThrow();
    expect(await mode(moved)).toBe(0o755);
    expect(await mode(target)).toBe(0o755);
    if (kind === 'directory') expect(await mode(directory)).toBe(0o755);
  });

  it('fchmods only the opened inode and rejects replacement during chmod before retirement writes', async () => {
    await legacyDirectory();
    const moved = path.join(root, 'original');
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      const chmod = handle.chmod.bind(handle);
      vi.spyOn(handle, 'chmod').mockImplementationOnce(async (permissions) => {
        await fs.rename(directory, moved);
        await fs.mkdir(directory, { mode: 0o755 });
        return chmod(permissions);
      });
      return handle;
    });
    await expect(stopVerifiedLegacyDaemons()).rejects.toThrow('changed during migration');
    expect(await mode(moved)).toBe(0o700);
    expect(await mode(directory)).toBe(0o755);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('upgrades the known alternate state directory without creating absent historic directories', async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('MCPORTER_DAEMON_DIR', '');
    vi.stubEnv('XDG_STATE_HOME', path.join(root, 'state'));
    vi.spyOn(os, 'userInfo').mockReturnValue({ ...os.userInfo(), homedir: root });
    directory = daemonRunDir();
    const alternate = path.join(root, 'state', 'mcporter', 'daemon');
    expect(await legacyDaemons()).toEqual([]);
    await expect(fs.lstat(alternate)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.mkdir(alternate, { recursive: true, mode: 0o755 });
    await fs.chmod(alternate, 0o755);
    expect(await legacyDaemons()).toEqual([]);
    expect(await mode(alternate)).toBe(0o755);
    await stopVerifiedLegacyDaemons();
    expect(await mode(alternate)).toBe(0o700);
    expect(await mode(directory)).toBe(0o700);
  });
});
