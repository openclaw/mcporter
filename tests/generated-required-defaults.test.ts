import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { generateCli } from '../src/generate-cli.js';
import { budget } from './helpers/timing.js';
const run = promisify(execFile);
const tsx = createRequire(import.meta.url).resolve('tsx/cli');

it(
  'allows the proxy to apply advertised defaults to required generated arguments',
  async () => {
    await fs.mkdir(path.join(process.cwd(), 'tmp'), { recursive: true });
    const dir = await fs.mkdtemp(path.join(process.cwd(), 'tmp', 'mcporter-required-default-'));
    const artifact = path.join(dir, 'fixture.ts');
    try {
      await generateCli({
        serverRef: JSON.stringify({
          name: 'default-fixture',
          command: {
            kind: 'stdio',
            command: process.execPath,
            args: [fileURLToPath(new URL('./fixtures/stdio-default-arguments.mjs', import.meta.url))],
            cwd: process.cwd(),
          },
          protocolVersion: 'legacy',
        }),
        runtime: 'node',
        outputPath: artifact,
      });
      const { stdout } = await run(
        process.execPath,
        [tsx, artifact, 'defaults', '--needed', 'provided', '--output', 'json'],
        { timeout: budget(10000) }
      );
      expect(JSON.parse(stdout)).toEqual({ limit: 0, confirm: false, text: '', needed: 'provided' });
      const overridden = await run(
        process.execPath,
        [
          tsx,
          artifact,
          'defaults',
          '--needed',
          'provided',
          '--limit',
          '7',
          '--confirm',
          'true',
          '--text',
          'override',
          '--output',
          'json',
        ],
        { timeout: budget(10000) }
      );
      expect(JSON.parse(overridden.stdout)).toEqual({ limit: 7, confirm: true, text: 'override', needed: 'provided' });
      await expect(
        run(process.execPath, [tsx, artifact, 'defaults'], { timeout: budget(10000) })
      ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Missing required option: --needed') });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
  budget(20000)
);
