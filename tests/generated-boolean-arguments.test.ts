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
  'rejects malformed boolean flags before a generated CLI can call the tool',
  async () => {
    await fs.mkdir(path.join(process.cwd(), 'tmp'), { recursive: true });
    const dir = await fs.mkdtemp(path.join(process.cwd(), 'tmp', 'mcporter-boolean-'));
    const log = path.join(dir, 'calls.jsonl');
    const artifact = path.join(dir, 'fixture.ts');
    try {
      await generateCli({
        serverRef: JSON.stringify({
          name: 'bool-fixture',
          command: {
            kind: 'stdio',
            command: process.execPath,
            args: [fileURLToPath(new URL('./fixtures/stdio-boolean-arguments.mjs', import.meta.url))],
            cwd: process.cwd(),
          },
          protocolVersion: 'legacy',
          env: { CALL_LOG: log },
        }),
        runtime: 'node',
        outputPath: artifact,
      });
      for (const flag of [
        ['--confirm', 'falze'],
        ['--flags', 'true,falze'],
        ['--flags', '[true,"false"]'],
      ]) {
        await expect(
          run(process.execPath, [tsx, artifact, 'apply', ...flag], { timeout: budget(10000) })
        ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Expected a boolean') });
        await expect(fs.readFile(log, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      }
      for (const [flag, expected] of [
        [['--confirm', 'false'], { confirm: false }],
        [['--confirm', 'true'], { confirm: true }],
        [['--flags', 'true,false'], { flags: [true, false] }],
        [['--flags', '[true,false]'], { flags: [true, false] }],
        [['--nullable-flags', '[true,null]'], { nullableFlags: [true, null] }],
        [['--mixed-flags', '[true,"label"]'], { mixedFlags: [true, 'label'] }],
      ] as const) {
        const { stdout } = await run(process.execPath, [tsx, artifact, 'apply', ...flag, '--output', 'json'], {
          timeout: budget(10000),
        });
        expect(JSON.parse(stdout)).toEqual(expected);
      }
      expect((await fs.readFile(log, 'utf8')).trim().split('\n')).toHaveLength(6);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
  budget(30000)
);
