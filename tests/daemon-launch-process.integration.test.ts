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
const launchModule = new URL('../dist/daemon/launch.js', import.meta.url);

beforeAll(async () => {
  await ensureDistBuilt(fileURLToPath(launchModule));
});

describe('detached daemon spawn failures in a real process', () => {
  it('survives an asynchronous ENOENT from the launch command', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-daemon-launch-error-'));
    try {
      const script = `
        import { spawn } from 'node:child_process';
        import { launchDaemonDetached } from ${JSON.stringify(launchModule.href)};
        const keepAlive = setTimeout(() => {}, 10_000);
        let child;
        launchDaemonDetached({
          configPath: ${JSON.stringify(path.join(tempDir, 'config.json'))},
          socketPath: ${JSON.stringify(path.join(tempDir, 'daemon.sock'))},
          metadataPath: ${JSON.stringify(path.join(tempDir, 'daemon.json'))},
        }, (_command, args, options) => {
          child = spawn(${JSON.stringify(path.join(tempDir, 'missing-daemon'))}, args, options);
          return child;
        });
        // Do not register an error listener here: production must handle it.
        await new Promise(resolve => child.once('close', resolve));
        clearTimeout(keepAlive);
        console.log('survived daemon spawn failure');
      `;
      const scriptPath = path.join(tempDir, 'proof.mjs');
      await fs.writeFile(scriptPath, script);
      const { stdout, stderr } = await runNode(process.execPath, [scriptPath], {
        timeout: budget(10_000),
      });
      expect(stdout.trim()).toBe('survived daemon spawn failure');
      expect(stderr).toBe('');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
