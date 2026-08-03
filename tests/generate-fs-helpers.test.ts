import fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { markExecutable, safeCopyFile } from '../src/cli/generate/fs-helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('generated CLI filesystem compatibility', () => {
  it('marks generated files executable', async () => {
    const chmod = vi.spyOn(fs, 'chmod').mockResolvedValue(undefined);

    await markExecutable('/tmp/generated-cli');

    expect(chmod).toHaveBeenCalledWith('/tmp/generated-cli', 0o755);
  });

  it.each(['EPERM', 'EINVAL', 'ENOSYS', 'EACCES'])('accepts %s when chmod is unsupported', async (code) => {
    vi.spyOn(fs, 'chmod').mockRejectedValue(Object.assign(new Error(code), { code }));

    await expect(markExecutable('/tmp/generated-cli')).resolves.toBeUndefined();
  });

  it('does not hide unrelated chmod failures', async () => {
    const failure = Object.assign(new Error('disk failed'), { code: 'EIO' });
    vi.spyOn(fs, 'chmod').mockRejectedValue(failure);

    await expect(markExecutable('/tmp/generated-cli')).rejects.toBe(failure);
  });

  it('copies files directly when the filesystem supports it', async () => {
    const copyFile = vi.spyOn(fs, 'copyFile').mockResolvedValue(undefined);

    await safeCopyFile('/tmp/source', '/tmp/target');

    expect(copyFile).toHaveBeenCalledWith('/tmp/source', '/tmp/target');
  });

  it('falls back to read and write when copyFile rejects POSIX operations', async () => {
    const contents = Buffer.from('generated');
    vi.spyOn(fs, 'copyFile').mockRejectedValue(Object.assign(new Error('unsupported'), { code: 'EACCES' }));
    const readFile = vi.spyOn(fs, 'readFile').mockResolvedValue(contents);
    const writeFile = vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined);

    await safeCopyFile('/tmp/source', '/tmp/target');

    expect(readFile).toHaveBeenCalledWith('/tmp/source');
    expect(writeFile).toHaveBeenCalledWith('/tmp/target', contents);
  });

  it('does not hide unrelated copy failures or non-error values', async () => {
    const failure = Object.assign(new Error('disk failed'), { code: 'EIO' });
    const copyFile = vi.spyOn(fs, 'copyFile').mockRejectedValueOnce(failure).mockRejectedValueOnce('failed');

    await expect(safeCopyFile('/tmp/source', '/tmp/target')).rejects.toBe(failure);
    await expect(safeCopyFile('/tmp/source', '/tmp/target')).rejects.toBe('failed');
    expect(copyFile).toHaveBeenCalledTimes(2);
  });
});
