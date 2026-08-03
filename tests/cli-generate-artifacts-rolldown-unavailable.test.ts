import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('rolldown');
  vi.resetModules();
});

describe('unavailable Rolldown', () => {
  it('adds an actionable message to module loading errors', async () => {
    vi.doMock('rolldown', () => {
      throw new Error('fixture module load failure');
    });
    const { bundleOutput } = await import('../src/cli/generate/artifacts.js');
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-rolldown-unavailable-'));
    try {
      await expect(
        bundleOutput({
          sourcePath: path.join(tempDir, 'entry.ts'),
          targetPath: path.join(tempDir, 'bundle.js'),
          runtimeKind: 'node',
          minify: false,
          bundler: 'rolldown',
        })
      ).rejects.toThrow(
        'Rolldown bundling is unavailable in this build of mcporter; rerun with --bundler bun or install mcporter via npm'
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('wraps non-Error module loading failures', async () => {
    vi.doMock('rolldown', () => {
      throw 'fixture string failure';
    });
    const { bundleOutput } = await import('../src/cli/generate/artifacts.js');
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-rolldown-unavailable-'));
    try {
      await expect(
        bundleOutput({
          sourcePath: path.join(tempDir, 'entry.ts'),
          targetPath: path.join(tempDir, 'bundle.js'),
          runtimeKind: 'bun',
          minify: false,
          bundler: 'rolldown',
        })
      ).rejects.toMatchObject({
        message: expect.stringContaining('Rolldown bundling is unavailable in this build of mcporter'),
        cause: 'fixture string failure',
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
