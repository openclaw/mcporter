import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readJsonFile, withFileLock, writeJsonFile } from '../src/fs-json.js';

describe('fs-json helpers', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-fs-json-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns undefined when reading a missing file', async () => {
    const missingPath = path.join(tempDir, 'missing.json');
    const value = await readJsonFile<Record<string, string>>(missingPath);
    expect(value).toBeUndefined();
  });

  it('writes JSON and reads it back, ensuring parent directories are created', async () => {
    const nestedPath = path.join(tempDir, 'nested', 'config.json');
    const payload = { apiKey: 'secret', retries: 2 };
    await writeJsonFile(nestedPath, payload);

    const roundTripped = await readJsonFile<typeof payload>(nestedPath);
    expect(roundTripped).toEqual(payload);

    const raw = await fs.readFile(nestedPath, 'utf8');
    expect(raw).toContain('\n  "apiKey"');
  });

  it.runIf(process.platform !== 'win32')('preserves existing file mode during atomic writes', async () => {
    const targetPath = path.join(tempDir, 'credentials.json');
    await fs.writeFile(targetPath, '{}', 'utf8');
    await fs.chmod(targetPath, 0o600);

    await writeJsonFile(targetPath, { token: 'secret' });

    const stats = await fs.stat(targetPath);
    expect(stats.mode & 0o777).toBe(0o600);
    expect(await readJsonFile(targetPath)).toEqual({ token: 'secret' });
  });

  it.runIf(process.platform !== 'win32')('creates new files with private permissions', async () => {
    const targetPath = path.join(tempDir, 'new-credentials.json');

    await writeJsonFile(targetPath, { token: 'secret' });

    const stats = await fs.stat(targetPath);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it.runIf(process.platform !== 'win32')('does not replace existing read-only files', async () => {
    const targetPath = path.join(tempDir, 'readonly.json');
    await fs.writeFile(targetPath, '{"locked":true}', 'utf8');
    await fs.chmod(targetPath, 0o400);

    try {
      await expect(writeJsonFile(targetPath, { locked: false })).rejects.toThrow();
      expect(await fs.readFile(targetPath, 'utf8')).toBe('{"locked":true}');
    } finally {
      await fs.chmod(targetPath, 0o600).catch(() => {});
    }
  });

  it.runIf(process.platform !== 'win32')(
    'falls back to direct writes when the target directory is read-only',
    async () => {
      const readOnlyDir = path.join(tempDir, 'readonly-dir');
      const targetPath = path.join(readOnlyDir, 'config.json');
      await fs.mkdir(readOnlyDir, { recursive: true });
      await fs.writeFile(targetPath, '{}', 'utf8');
      await fs.chmod(targetPath, 0o600);

      try {
        await fs.chmod(readOnlyDir, 0o555);
        await writeJsonFile(targetPath, { fallback: true });
      } finally {
        await fs.chmod(readOnlyDir, 0o755).catch(() => {});
      }

      expect(await readJsonFile(targetPath)).toEqual({ fallback: true });
    }
  );

  it.runIf(process.platform !== 'win32')('writes through symlinks without replacing them', async () => {
    const realPath = path.join(tempDir, 'real.json');
    const symlinkPath = path.join(tempDir, 'linked.json');
    await fs.writeFile(realPath, '{}', 'utf8');
    await fs.symlink(realPath, symlinkPath);

    await writeJsonFile(symlinkPath, { linked: true });

    expect((await fs.lstat(symlinkPath)).isSymbolicLink()).toBe(true);
    expect(await readJsonFile(realPath)).toEqual({ linked: true });
  });

  it.runIf(process.platform !== 'win32')('writes through symlink chains without replacing links', async () => {
    const realPath = path.join(tempDir, 'real.json');
    const middleSymlinkPath = path.join(tempDir, 'middle.json');
    const symlinkPath = path.join(tempDir, 'linked.json');
    await fs.writeFile(realPath, '{}', 'utf8');
    await fs.symlink(realPath, middleSymlinkPath);
    await fs.symlink(middleSymlinkPath, symlinkPath);

    await writeJsonFile(symlinkPath, { chained: true });

    expect((await fs.lstat(symlinkPath)).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(middleSymlinkPath)).isSymbolicLink()).toBe(true);
    expect(await readJsonFile(realPath)).toEqual({ chained: true });
  });

  it.runIf(process.platform !== 'win32')('writes through symlink chains whose target does not exist yet', async () => {
    const realPath = path.join(tempDir, 'real.json');
    const middleSymlinkPath = path.join(tempDir, 'middle.json');
    const symlinkPath = path.join(tempDir, 'linked.json');
    await fs.symlink(realPath, middleSymlinkPath);
    await fs.symlink(middleSymlinkPath, symlinkPath);

    await writeJsonFile(symlinkPath, { created: true });

    expect((await fs.lstat(symlinkPath)).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(middleSymlinkPath)).isSymbolicLink()).toBe(true);
    expect(await readJsonFile(realPath)).toEqual({ created: true });
  });

  it.runIf(process.platform !== 'win32')('uses the same lock for symlinks and their real target', async () => {
    const realPath = path.join(tempDir, 'shared.json');
    const symlinkPath = path.join(tempDir, 'linked.json');
    await writeJsonFile(realPath, []);
    await fs.symlink(realPath, symlinkPath);

    const appendWithLock = async (targetPath: string, value: string) =>
      withFileLock(targetPath, async () => {
        const current = (await readJsonFile<string[]>(realPath)) ?? [];
        await new Promise((resolve) => setTimeout(resolve, 20));
        current.push(value);
        await writeJsonFile(targetPath, current);
      });

    await Promise.all([appendWithLock(realPath, 'real'), appendWithLock(symlinkPath, 'link')]);

    expect((await readJsonFile<string[]>(realPath))?.toSorted()).toEqual(['link', 'real']);
    expect((await fs.lstat(symlinkPath)).isSymbolicLink()).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('uses the same lock through symlinked parent directories', async () => {
    const realDir = path.join(tempDir, 'real');
    const linkDir = path.join(tempDir, 'linked-dir');
    const realPath = path.join(realDir, 'shared.json');
    const linkedPath = path.join(linkDir, 'shared.json');
    await fs.mkdir(realDir, { recursive: true });
    await writeJsonFile(realPath, []);
    await fs.symlink(realDir, linkDir);

    const appendWithLock = async (targetPath: string, value: string) =>
      withFileLock(targetPath, async () => {
        const current = (await readJsonFile<string[]>(realPath)) ?? [];
        await new Promise((resolve) => setTimeout(resolve, 20));
        current.push(value);
        await writeJsonFile(targetPath, current);
      });

    await Promise.all([appendWithLock(realPath, 'real'), appendWithLock(linkedPath, 'link')]);

    expect((await readJsonFile<string[]>(realPath))?.toSorted()).toEqual(['link', 'real']);
    expect((await fs.lstat(linkDir)).isSymbolicLink()).toBe(true);
  });

  it.runIf(process.platform !== 'win32')(
    'falls back to direct symlink writes when target dir is read-only',
    async () => {
      const realDir = path.join(tempDir, 'real');
      const linkDir = path.join(tempDir, 'links');
      const realPath = path.join(realDir, 'config.json');
      const symlinkPath = path.join(linkDir, 'config.json');
      await fs.mkdir(realDir, { recursive: true });
      await fs.mkdir(linkDir, { recursive: true });
      await fs.writeFile(realPath, '{}', 'utf8');
      await fs.symlink(realPath, symlinkPath);

      try {
        await fs.chmod(realDir, 0o555);
        await writeJsonFile(symlinkPath, { fallback: true });
      } finally {
        await fs.chmod(realDir, 0o755).catch(() => {});
      }

      expect((await fs.lstat(symlinkPath)).isSymbolicLink()).toBe(true);
      expect(await readJsonFile(realPath)).toEqual({ fallback: true });
    }
  );

  it.runIf(process.platform !== 'win32')('falls back to symlink-side locks when target dir is read-only', async () => {
    const realDir = path.join(tempDir, 'real');
    const linkDir = path.join(tempDir, 'links');
    const realPath = path.join(realDir, 'config.json');
    const symlinkPath = path.join(linkDir, 'config.json');
    await fs.mkdir(realDir, { recursive: true });
    await fs.mkdir(linkDir, { recursive: true });
    await fs.writeFile(realPath, '{}', 'utf8');
    await fs.symlink(realPath, symlinkPath);
    let ran = false;

    try {
      await fs.chmod(realDir, 0o555);
      await withFileLock(symlinkPath, async () => {
        ran = true;
      });
    } finally {
      await fs.chmod(realDir, 0o755).catch(() => {});
    }

    expect(ran).toBe(true);
    await expect(fs.access(`${symlinkPath}.lock`)).rejects.toThrow();
  });

  it('serializes concurrent tasks with a file lock', async () => {
    const lockTarget = path.join(tempDir, 'shared.json');
    const order: number[] = [];

    await Promise.all(
      Array.from({ length: 5 }, async (_, index) =>
        withFileLock(lockTarget, async () => {
          const snapshot = [...order];
          await new Promise((resolve) => setTimeout(resolve, 5));
          expect(order).toEqual(snapshot);
          order.push(index);
        })
      )
    );

    expect(order).toHaveLength(5);
    await expect(fs.access(`${lockTarget}.lock`)).rejects.toThrow();
  });

  it('recovers lock files left by dead processes', async () => {
    const lockTarget = path.join(tempDir, 'shared.json');
    await fs.writeFile(`${lockTarget}.lock`, '99999999\n2026-01-01T00:00:00.000Z\n', 'utf8');
    let ran = false;

    await withFileLock(lockTarget, async () => {
      ran = true;
    });

    expect(ran).toBe(true);
    await expect(fs.access(`${lockTarget}.lock`)).rejects.toThrow();
  });

  it('does not recover fresh empty lock files', async () => {
    const lockTarget = path.join(tempDir, 'shared.json');
    await fs.writeFile(`${lockTarget}.lock`, '', 'utf8');

    await expect(withFileLock(lockTarget, async () => {}, { timeoutMs: 75 })).rejects.toThrow(
      /Timed out waiting for file lock/
    );
    expect(await fs.readFile(`${lockTarget}.lock`, 'utf8')).toBe('');
  });

  it('recovers stale empty lock files left before metadata is written', async () => {
    const lockTarget = path.join(tempDir, 'shared.json');
    const lockPath = `${lockTarget}.lock`;
    await fs.writeFile(lockPath, '', 'utf8');
    const staleDate = new Date(Date.now() - 2_000);
    await fs.utimes(lockPath, staleDate, staleDate);
    let ran = false;

    await withFileLock(lockTarget, async () => {
      ran = true;
    });

    expect(ran).toBe(true);
    await expect(fs.access(`${lockTarget}.lock`)).rejects.toThrow();
  });

  it('serializes waiters while recovering a stale lock', async () => {
    const lockTarget = path.join(tempDir, 'shared.json');
    const order: number[] = [];
    await fs.writeFile(`${lockTarget}.lock`, '99999999\n2026-01-01T00:00:00.000Z\n', 'utf8');

    await Promise.all(
      Array.from({ length: 2 }, async (_, index) =>
        withFileLock(lockTarget, async () => {
          const snapshot = [...order];
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(order).toEqual(snapshot);
          order.push(index);
        })
      )
    );

    expect(order).toHaveLength(2);
    await expect(fs.access(`${lockTarget}.lock`)).rejects.toThrow();
  });
});
