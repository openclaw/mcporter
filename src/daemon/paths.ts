import fs from 'node:fs/promises';
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
      return;
    }
    if (!previous.isDirectory() || previous.isSymbolicLink()) throw new Error('Unsafe daemon directory.');
    return;
  }
  await fs.mkdir(daemonRunDir(), { recursive: true, mode: 0o700 });
  const info = await fs.lstat(daemonRunDir());
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error('Daemon directory must be an owner-only directory (mode 0700), without symlinks.');
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
