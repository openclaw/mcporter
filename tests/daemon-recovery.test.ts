import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBootIdentity } from '../src/daemon/boot-identity.js';
import { assertLegacyDrained } from '../src/daemon/migration.js';
import { getDaemonMetadataPath, getDaemonSocketPath, secureDaemonDirectory } from '../src/daemon/paths.js';
import { DAEMON_PROTOCOL_VERSION } from '../src/daemon/protocol.js';
import { recoverDaemon } from '../src/daemon/recovery.js';
import { requestDaemon } from '../src/daemon/socket-rpc.js';
import { privateFixtureDirectory } from './helpers/private-directory.js';

vi.mock('../src/daemon/boot-identity.js', async (original) => ({
  ...(await original<typeof import('../src/daemon/boot-identity.js')>()),
  readBootIdentity: vi.fn(),
}));
vi.mock('../src/daemon/socket-rpc.js', () => ({ requestDaemon: vi.fn() }));
vi.mock('../src/daemon/migration.js', () => ({ assertLegacyDrained: vi.fn() }));
describe.skipIf(process.platform === 'win32')('prior-boot recovery safety', () => {
  const currentId = '11111111-1111-4111-8111-111111111111';
  const previousId = '22222222-2222-4222-8222-222222222222';
  let root: string;
  let metadataPath: string;
  let metadata: Record<string, unknown>;

  beforeEach(async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    root = await fs.realpath(await privateFixtureDirectory('mcp-recovery-'));
    vi.stubEnv('MCPORTER_DAEMON_DIR', root);
    await secureDaemonDirectory();
    metadataPath = getDaemonMetadataPath();
    metadata = {
      pid: process.pid,
      socketPath: getDaemonSocketPath(),
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      bootIdentity: { platform: 'linux', id: previousId },
    };
    await fs.writeFile(metadataPath, JSON.stringify(metadata), { mode: 0o600 });
    vi.mocked(readBootIdentity).mockResolvedValue({ platform: 'linux', id: currentId });
    vi.mocked(requestDaemon).mockRejectedValue(Object.assign(new Error('absent'), { code: 'ECONNREFUSED' }));
    vi.mocked(assertLegacyDrained).mockResolvedValue(undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('archives prior-boot evidence without signalling a reused PID or starting a host', async () => {
    const signal = vi.spyOn(process, 'kill');
    const archive = await recoverDaemon();
    expect(JSON.parse(await fs.readFile(archive!, 'utf8'))).toEqual(metadata);
    await expect(fs.stat(metadataPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(signal).not.toHaveBeenCalled();
    expect(vi.mocked(requestDaemon).mock.calls.map((call) => call[1].method)).toEqual(['status']);
    await expect(recoverDaemon()).resolves.toBeUndefined();
  });

  it.each([
    ['same boot', { bootIdentity: { platform: 'linux', id: currentId } }, 'Same-boot'],
    ['legacy metadata', { bootIdentity: undefined }, 'compatible boot evidence'],
    ['malformed boot ID', { bootIdentity: { platform: 'linux', id: 'invalid' } }, 'compatible boot evidence'],
    ['other platform', { bootIdentity: { platform: 'darwin', id: previousId } }, 'compatible boot evidence'],
    ['incompatible protocol', { protocolVersion: -1 }, 'compatible boot evidence'],
    ['another namespace', { socketPath: '/other/user.sock' }, 'compatible boot evidence'],
    ['invalid PID', { pid: -1 }, 'compatible boot evidence'],
  ])('preserves %s', async (_label, overrides, error) => {
    const raw = JSON.stringify({ ...metadata, ...overrides });
    await fs.writeFile(metadataPath, raw);
    await expect(recoverDaemon()).rejects.toThrow(error);
    expect(await fs.readFile(metadataPath, 'utf8')).toBe(raw);
  });

  it.each(['{', 'null', '[]'])('preserves malformed metadata %s', async (raw) => {
    await fs.writeFile(metadataPath, raw);
    await expect(recoverDaemon()).rejects.toThrow();
    expect(await fs.readFile(metadataPath, 'utf8')).toBe(raw);
  });

  it('fails closed when kernel boot identity is unavailable, including Windows', async () => {
    vi.mocked(readBootIdentity).mockResolvedValue(undefined);
    await expect(recoverDaemon()).rejects.toThrow('requires a kernel boot identity');
    expect(requestDaemon).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(metadataPath, 'utf8'))).toEqual(metadata);
  });

  it.each(['ETIMEDOUT', 'ECONNRESET', 'authentication_failed', 'process_observation_failed'])(
    'preserves state after %s',
    async (code) => {
      const error = Object.assign(new Error('inspection failed'), { code });
      if (code === 'process_observation_failed') vi.mocked(assertLegacyDrained).mockRejectedValue(error);
      else vi.mocked(requestDaemon).mockRejectedValue(error);
      await expect(recoverDaemon()).rejects.toThrow('inspection failed');
      expect(JSON.parse(await fs.readFile(metadataPath, 'utf8'))).toEqual(metadata);
    }
  );

  it.each([true, false])('refuses a responding daemon even when response.ok is %s', async (ok) => {
    vi.mocked(requestDaemon).mockResolvedValue({ id: 'status', ok });
    await expect(recoverDaemon()).rejects.toThrow('responding daemon');
    expect(JSON.parse(await fs.readFile(metadataPath, 'utf8'))).toEqual(metadata);
  });

  it.each(['user.json', 'user.json.lock', 'user.json.lock.break', 'user.sock'])(
    'rejects symlinked %s',
    async (name) => {
      const target = path.join(root, 'target');
      await fs.writeFile(target, 'untouched');
      const file = path.join(root, 'daemon', name);
      await fs.rm(file, { force: true });
      await fs.symlink(target, file);
      await expect(recoverDaemon()).rejects.toThrow('Unsafe daemon recovery artifact');
      expect(await fs.readFile(target, 'utf8')).toBe('untouched');
    }
  );

  it('rejects writable metadata and a regular file in place of the socket', async () => {
    await fs.chmod(metadataPath, 0o666);
    await expect(recoverDaemon()).rejects.toThrow('Unsafe daemon recovery artifact');
    await fs.chmod(metadataPath, 0o600);
    await fs.writeFile(getDaemonSocketPath(), 'not a socket');
    await expect(recoverDaemon()).rejects.toThrow('Unsafe daemon recovery artifact');
  });

  it('rejects hard links and unexpected artifact ownership', async () => {
    const target = path.join(root, 'linked');
    await fs.link(metadataPath, target);
    await expect(recoverDaemon()).rejects.toThrow('Unsafe daemon recovery artifact');
    await fs.unlink(target);
    const original = await fs.lstat(metadataPath);
    const lstat = fs.lstat.bind(fs);
    vi.spyOn(fs, 'lstat').mockImplementation(async (file) =>
      file === metadataPath ? Object.assign(Object.create(original), { uid: original.uid + 1 }) : lstat(file)
    );
    await expect(recoverDaemon()).rejects.toThrow('Unsafe daemon recovery artifact');
  });

  it('rejects an unsafe directory before probing or clearing ownership', async () => {
    await fs.chmod(path.dirname(metadataPath), 0o755);
    await expect(recoverDaemon()).rejects.toThrow('Legacy daemon directory');
    expect(requestDaemon).not.toHaveBeenCalled();
  });

  it('preserves metadata if unlink or archive fails and permits a deliberate retry', async () => {
    const originalUnlink = fs.unlink.bind(fs);
    const unlink = vi.spyOn(fs, 'unlink').mockImplementation(async (file) => {
      if (file === getDaemonSocketPath()) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return originalUnlink(file);
    });
    await expect(recoverDaemon()).rejects.toThrow('denied');
    expect(JSON.parse(await fs.readFile(metadataPath, 'utf8'))).toEqual(metadata);
    unlink.mockRestore();
    const rename = vi.spyOn(fs, 'rename').mockRejectedValue(new Error('archive failed'));
    await expect(recoverDaemon()).rejects.toThrow('archive failed');
    expect(JSON.parse(await fs.readFile(metadataPath, 'utf8'))).toEqual(metadata);
    rename.mockRestore();
    await expect(recoverDaemon()).resolves.toContain('recovered-');
  });
});
