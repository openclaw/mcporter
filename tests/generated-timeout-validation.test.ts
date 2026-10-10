import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateCli } from '../src/generate-cli.js';
import { budget } from './helpers/timing.js';

const run = promisify(execFile);
const tsx = createRequire(import.meta.url).resolve('tsx/cli');

describe('generated timeout validation', () => {
  it.each(['yaml', 'JSON', 'bogus'])(
    'rejects unsupported output format %s',
    async (value) => {
      await expect(
        run(process.execPath, [tsx, artifact, '--output', value, '__mcporter_inspect'], { timeout: budget(10000) })
      ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Allowed choices') });
    },
    budget(10000)
  );
  let directory: string;
  let artifact: string;
  beforeAll(async () => {
    await fs.mkdir(path.join(process.cwd(), 'tmp'), { recursive: true });
    directory = await fs.mkdtemp(path.join(process.cwd(), 'tmp', 'mcporter-timeout-'));
    artifact = path.join(directory, 'fixture.ts');
    await generateCli({
      serverRef: JSON.stringify({
        name: 'timeout-fixture',
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
  }, budget(10000));
  afterAll(async () => {
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  it.each(['0', '-1', '1.5', '100junk', 'NaN', 'Infinity'])(
    'rejects invalid timeout %s in the executable artifact',
    async (value) => {
      await expect(
        run(process.execPath, [tsx, artifact, '--timeout', value, '__mcporter_inspect'], { timeout: budget(10000) })
      ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('positive integer') });
    },
    budget(10000)
  );

  it(
    'accepts a positive integer timeout',
    async () => {
      const { stdout } = await run(process.execPath, [tsx, artifact, '--timeout', '1000', '__mcporter_inspect'], {
        timeout: budget(10000),
      });
      expect(JSON.parse(stdout)).toBeTypeOf('object');
    },
    budget(10000)
  );
});
