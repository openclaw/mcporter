import fs from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { ensureWindowsPrivateDirectory } from '../chrome-devtools-relay-handoff.js';
import os from 'node:os';
import path from 'node:path';

/** Explicit namespaces are isolation boundaries, never alternate production owners. */
export function daemonBaseDir(): string {
  const override = process.env.MCPORTER_DAEMON_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(os.userInfo().homedir, '.mcporter');
}

export function daemonRunDir(): string {
  return path.join(daemonBaseDir(), 'daemon');
}

let verifiedWindowsDirectory: { path: string; dev: number; ino: number; birthtimeMs: number } | undefined;

export async function secureDaemonDirectory(): Promise<void> {
  if (process.platform === 'win32') {
    const directory = daemonRunDir();
    const previous = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    await verifyWindowsDaemonDirectory(directory, previous);
    return;
  }
  await fs.mkdir(daemonRunDir(), { recursive: true, mode: 0o700 });
  assertPosixDaemonDirectory(await fs.lstat(daemonRunDir()), false);
}

async function verifyWindowsDaemonDirectory(directory: string, previous: Stats | undefined): Promise<void> {
  if (previous && (!previous.isDirectory() || previous.isSymbolicLink())) throw new Error('Unsafe daemon directory.');
  if (
    verifiedWindowsDirectory?.path !== directory ||
    !previous ||
    previous.dev !== verifiedWindowsDirectory.dev ||
    previous.ino !== verifiedWindowsDirectory.ino ||
    previous.birthtimeMs !== verifiedWindowsDirectory.birthtimeMs
  ) {
    ensureWindowsPrivateDirectory(directory, true);
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe daemon directory.');
    verifiedWindowsDirectory = { path: directory, dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs };
  }
}

function assertPosixDaemonDirectory(info: Stats, allowLegacy: boolean): void {
  if (info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.()) {
    const mode = info.mode & 0o7777;
    if (mode === 0o700 || (allowLegacy && mode === 0o755)) return;
    if (mode === 0o755)
      throw new Error(
        'Legacy daemon directory has mode 0755. Inspect with daemon migrate; after draining all old clients, run daemon migrate --stop-legacy --confirmed-drained to upgrade it to mode 0700.'
      );
  }
  throw new Error('Daemon directory must be a current-user-owned directory (mode 0700), without symlinks.');
}

/** Only migration may accept the ordinary 0755 directory created by released daemons. */
export async function inspectLegacyDaemonDirectory(directory: string): Promise<boolean> {
  const info = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (!info) return false;
  if (process.platform === 'win32') {
    // Existing directories retain the Windows ACL verifier; absent paths stay absent.
    await verifyWindowsDaemonDirectory(directory, info);
  } else assertPosixDaemonDirectory(info, true);
  return true;
}

export async function upgradeLegacyDaemonDirectory(directory: string): Promise<void> {
  if (!(await inspectLegacyDaemonDirectory(directory)) || process.platform === 'win32') return;
  const before = await fs.lstat(directory);
  assertPosixDaemonDirectory(before, true);
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const assertIdentity = (info: Stats) => {
    assertPosixDaemonDirectory(info, true);
    if (info.dev !== before.dev || info.ino !== before.ino)
      throw new Error('Daemon directory changed during migration; inspect it before retrying.');
  };
  try {
    const opened = await handle.stat();
    assertIdentity(opened);
    assertIdentity(await fs.lstat(directory));
    // fchmod cannot follow a replacement path; recheck the pathname before any later use.
    if ((opened.mode & 0o7777) === 0o755) await handle.chmod(0o700);
    assertPosixDaemonDirectory(await handle.stat(), false);
    const after = await fs.lstat(directory);
    assertIdentity(after);
    assertPosixDaemonDirectory(after, false);
  } finally {
    await handle.close();
  }
}

export function getDaemonMetadataPath(_configKey?: string): string {
  return path.join(daemonRunDir(), 'user.json');
}

export function getDaemonSocketPath(_configKey?: string): string {
  if (process.platform === 'win32')
    return `\\\\.\\pipe\\mcporter-user-${createHash('sha256').update(daemonRunDir().toLowerCase()).digest('hex').slice(0, 24)}`;
  return path.join(daemonRunDir(), 'user.sock');
}

export function getDaemonLogPath(_configKey?: string): string {
  return path.join(daemonRunDir(), 'user.log');
}
