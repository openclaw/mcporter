import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureDistBuilt } from './helpers/dist.js';
import { budget } from './helpers/timing.js';

const runNode = promisify(execFile);
const oauthModule = new URL('../dist/oauth.js', import.meta.url);

beforeAll(async () => {
  await ensureDistBuilt(fileURLToPath(oauthModule));
});

describe('browser helper spawn failures in a real process', () => {
  it.each(['darwin', 'win32', 'linux'] as const)('survives an asynchronous %s ENOENT', async (platform) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-browser-error-'));
    try {
      const script = `
        import { spawn } from 'node:child_process';
        import { __oauthInternals } from ${JSON.stringify(oauthModule.href)};
        const keepAlive = setTimeout(() => {}, 10_000);
        let child;
        __oauthInternals.openExternal('https://example.com/auth', ${JSON.stringify(platform)},
          (_command, args, options) => {
            child = spawn(${JSON.stringify(path.join(tempDir, 'missing-helper'))}, args, options);
            return child;
          });
        // Do not register an error listener here: production must handle it.
        await new Promise(resolve => child.once('close', resolve));
        clearTimeout(keepAlive);
        console.log('survived browser helper failure');
      `;
      const { stdout, stderr } = await runNode(process.execPath, ['--input-type=module', '--eval', script], {
        timeout: budget(10_000),
      });
      expect(stdout.trim()).toBe('survived browser helper failure');
      expect(stderr).toBe('');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
