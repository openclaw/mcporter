import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { makeShortTempDir } from './fixtures/test-helpers.js';
import { closeFixtureResources, stopFixtureChild } from './helpers/fixture-lifecycle.js';

const execFileAsync = promisify(execFile);
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

describe('fixture lifecycle', () => {
  it.each(['missing', 'rejecting'] as const)('stops children with a %s proxy', async (kind) => {
    const child = spawn(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 1_000)"], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const failure = new Error('proxy close failed');
    const proxy =
      kind === 'missing'
        ? undefined
        : {
            close: async () => {
              throw failure;
            },
          };
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('message', () => resolve());
        child.once('error', reject);
      });
      const closing = closeFixtureResources(proxy, new Set([child]));
      if (kind === 'rejecting') await expect(closing).rejects.toBe(failure);
      else await expect(closing).resolves.toBeUndefined();
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      await stopFixtureChild(child);
    }
  });

  it('runs TypeScript children without a persistent transform cache', async () => {
    const directory = await makeShortTempDir('fixture-cache');
    const sourcePath = path.join(directory, 'fixture.ts');
    await fs.writeFile(sourcePath, 'const answer: number = 42; console.log(answer);\n');
    try {
      const result = await execFileAsync(process.execPath, [TSX_CLI, sourcePath], {
        env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory },
      });
      expect(result.stdout.trim()).toBe('42');
      const user = process.geteuid ? process.geteuid() : os.userInfo().username;
      const entries = await fs.readdir(path.join(directory, `tsx-${user}`)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      expect(entries).toEqual([]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
