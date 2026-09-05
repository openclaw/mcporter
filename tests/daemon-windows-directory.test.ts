import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { ensure, stat } = vi.hoisted(() => ({ ensure: vi.fn(), stat: vi.fn() }));
vi.mock('../src/chrome-devtools-relay-handoff.js', () => ({ ensureWindowsPrivateDirectory: ensure }));
vi.mock('node:fs/promises', () => ({ default: { lstat: stat } }));

const directory = (ino = 1, birthtimeMs = 1) => ({
  dev: 1,
  ino,
  birthtimeMs,
  isDirectory: () => true,
  isSymbolicLink: () => false,
});
beforeEach(() => {
  vi.resetModules();
  ensure.mockReset();
  stat.mockReset().mockResolvedValue(directory());
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
});
afterEach(() => vi.restoreAllMocks());

it('reuses ACL verification only for the same directory identity', async () => {
  const { secureDaemonDirectory } = await import('../src/daemon/paths.js');
  await secureDaemonDirectory();
  await secureDaemonDirectory();
  expect(ensure).toHaveBeenCalledTimes(1);
  stat.mockResolvedValue(directory(2));
  await secureDaemonDirectory();
  expect(ensure).toHaveBeenCalledTimes(2);
  stat.mockResolvedValue(directory(2, 3));
  await secureDaemonDirectory();
  expect(ensure).toHaveBeenCalledTimes(3);
});

it('rechecks a recreated directory and retains a failed ACL verdict', async () => {
  const { secureDaemonDirectory } = await import('../src/daemon/paths.js');
  await secureDaemonDirectory();
  stat.mockResolvedValue(directory(2));
  ensure.mockImplementation(() => {
    throw new Error('unsafe ACL');
  });
  await expect(secureDaemonDirectory()).rejects.toThrow('unsafe ACL');
  await expect(secureDaemonDirectory()).rejects.toThrow('unsafe ACL');
  expect(ensure).toHaveBeenCalledTimes(3);
});

it('does not accept a replaced directory symlink or a failed stat', async () => {
  const { secureDaemonDirectory } = await import('../src/daemon/paths.js');
  await secureDaemonDirectory();
  stat.mockResolvedValue({ ...directory(), isSymbolicLink: () => true });
  await expect(secureDaemonDirectory()).rejects.toThrow('Unsafe daemon directory');
  stat.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
  await expect(secureDaemonDirectory()).rejects.toThrow('denied');
});

it('delegates migration inspection and upgrade to the existing Windows ACL verifier', async () => {
  const { inspectLegacyDaemonDirectory, upgradeLegacyDaemonDirectory, daemonRunDir } =
    await import('../src/daemon/paths.js');
  const directoryPath = daemonRunDir();
  await expect(inspectLegacyDaemonDirectory(directoryPath)).resolves.toBe(true);
  expect(ensure).toHaveBeenCalledWith(directoryPath, true);
  await upgradeLegacyDaemonDirectory(directoryPath);
  expect(ensure).toHaveBeenCalledTimes(1);
  stat.mockResolvedValue(directory(2));
  ensure.mockImplementation(() => {
    throw new Error('unsafe ACL');
  });
  await expect(upgradeLegacyDaemonDirectory(directoryPath)).rejects.toThrow('unsafe ACL');
});

it('does not create absent directories during inspection or bypass ACL checks for symlinks', async () => {
  const { inspectLegacyDaemonDirectory, upgradeLegacyDaemonDirectory, daemonRunDir } =
    await import('../src/daemon/paths.js');
  stat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  await expect(inspectLegacyDaemonDirectory(daemonRunDir())).resolves.toBe(false);
  await upgradeLegacyDaemonDirectory(daemonRunDir());
  expect(ensure).not.toHaveBeenCalled();
  stat.mockResolvedValue({ ...directory(), isSymbolicLink: () => true });
  await expect(inspectLegacyDaemonDirectory(daemonRunDir())).rejects.toThrow('Unsafe daemon directory');
  expect(ensure).not.toHaveBeenCalled();
});
