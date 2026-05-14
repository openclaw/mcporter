import crypto from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const LOCK_POLL_MS = 25;
const MALFORMED_LOCK_STALE_MS = 1_000;
const MAX_SYMLINK_DEPTH = 40;
const DEFAULT_ATOMIC_FILE_MODE = 0o600;

// readJsonFile reads a JSON file and returns undefined when the file does not exist.
export async function readJsonFile<T = unknown>(filePath: string): Promise<T | undefined> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

// writeTextFileAtomic writes a file via same-directory temp file and rename.
export async function writeTextFileAtomic(filePath: string, data: string): Promise<void> {
  const target = await resolveAtomicWriteTarget(filePath);
  await fs.mkdir(path.dirname(target.path), { recursive: true });
  const tempPath = path.join(
    path.dirname(target.path),
    `.${path.basename(target.path)}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`
  );
  try {
    if (target.mode !== undefined) {
      await fs.access(target.path, constants.W_OK);
    }
    await fs.writeFile(tempPath, data, {
      encoding: 'utf8',
      flag: 'wx',
      mode: target.mode ?? DEFAULT_ATOMIC_FILE_MODE,
    });
    if (target.mode !== undefined) {
      await fs.chmod(tempPath, target.mode);
    }
    await fs.rename(tempPath, target.path);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    if (target.mode !== undefined && isPermissionError(error)) {
      await fs.writeFile(filePath, data, 'utf8');
      return;
    }
    throw error;
  }
}

// writeJsonFile writes a JSON object to disk, ensuring parent directories are created first.
export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await writeTextFileAtomic(filePath, JSON.stringify(data, null, 2));
}

export async function withFileLock<T>(
  filePath: string,
  task: () => Promise<T>,
  options: { timeoutMs?: number } = {}
): Promise<T> {
  const lockTargetPath = await resolvePathFollowingSymlinks(filePath);
  await fs.mkdir(path.dirname(lockTargetPath), { recursive: true });
  let lockPath = `${lockTargetPath}.lock`;
  const fallbackLockPath = lockTargetPath !== filePath ? `${filePath}.lock` : undefined;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const startedAt = Date.now();
  let acquired = false;

  while (!acquired) {
    try {
      await fs.writeFile(lockPath, `${process.pid}\n${new Date().toISOString()}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      acquired = true;
      break;
    } catch (error) {
      if (fallbackLockPath && lockPath !== fallbackLockPath && isPermissionError(error)) {
        await fs.mkdir(path.dirname(fallbackLockPath), { recursive: true });
        lockPath = fallbackLockPath;
        continue;
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      if (await removeRecoverableLock(lockPath)) {
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for file lock ${lockPath}`, { cause: error });
      }
      await sleep(LOCK_POLL_MS);
    }
  }

  try {
    return await task();
  } finally {
    await fs.unlink(lockPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    });
  }
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EPERM';
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveAtomicWriteTarget(filePath: string): Promise<{ path: string; mode?: number }> {
  try {
    const stats = await fs.lstat(filePath);
    if (stats.isSymbolicLink()) {
      const targetPath = await resolvePathFollowingSymlinks(filePath);
      return { path: targetPath, mode: await readMode(targetPath) };
    }
    return { path: filePath, mode: stats.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path: filePath };
    }
    throw error;
  }
}

async function resolvePathFollowingSymlinks(filePath: string): Promise<string> {
  let currentPath = await canonicalizeParentDirectory(filePath);
  for (let depth = 0; depth < MAX_SYMLINK_DEPTH; depth += 1) {
    let stats;
    try {
      stats = await fs.lstat(currentPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return await canonicalizeParentDirectory(currentPath);
      }
      throw error;
    }
    if (!stats.isSymbolicLink()) {
      return currentPath;
    }
    const link = await fs.readlink(currentPath);
    currentPath = await canonicalizeParentDirectory(
      path.isAbsolute(link) ? link : path.resolve(path.dirname(currentPath), link)
    );
  }
  throw new Error(`Too many symbolic links while resolving ${filePath}`);
}

async function canonicalizeParentDirectory(filePath: string): Promise<string> {
  try {
    return path.join(await fs.realpath(path.dirname(filePath)), path.basename(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return filePath;
    }
    throw error;
  }
}

async function readMode(filePath: string): Promise<number | undefined> {
  try {
    const stats = await fs.stat(filePath);
    return stats.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function removeRecoverableLock(lockPath: string): Promise<boolean> {
  const breakerPath = `${lockPath}.break`;
  try {
    await fs.writeFile(breakerPath, `${process.pid}\n${new Date().toISOString()}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      return false;
    }
    if (!(await isLockRecoverable(breakerPath))) {
      return false;
    }
    await fs.unlink(breakerPath).catch(() => {});
    return false;
  }

  try {
    if (!(await isLockRecoverable(lockPath))) {
      return false;
    }
    await fs.unlink(lockPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  } finally {
    await fs.unlink(breakerPath).catch(() => {});
  }
}

async function isLockRecoverable(lockPath: string): Promise<boolean> {
  let contents: string;
  try {
    contents = await fs.readFile(lockPath, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
  if (contents.length === 0) {
    return await isMalformedLockStale(lockPath);
  }
  const pid = Number.parseInt(contents.split(/\r?\n/, 1)[0] ?? '', 10);
  if (Number.isInteger(pid) && pid > 0) {
    return !isProcessRunning(pid);
  }
  return await isMalformedLockStale(lockPath);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function isMalformedLockStale(lockPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(lockPath);
    return Date.now() - stats.mtimeMs > MALFORMED_LOCK_STALE_MS;
  } catch {
    return false;
  }
}
