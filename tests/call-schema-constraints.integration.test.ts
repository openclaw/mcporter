import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { budget } from './helpers/timing.js';

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const server = fileURLToPath(new URL('./servers/schema-constraints.mjs', import.meta.url));

it(
  'coerces composed schema values through the built CLI and a real stdio server',
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-schema-constraints-'));
    try {
      const config = path.join(dir, 'mcporter.json');
      await fs.writeFile(
        config,
        JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [server] } } })
      );
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          cli,
          '--config',
          config,
          'call',
          'fixture.echo',
          '--labels',
          'bug',
          'mode=none',
          'choice=null',
          'nullable=null',
          '--output',
          'json',
        ],
        { timeout: budget(15_000) }
      );
      expect(JSON.parse(stdout)).toEqual({
        labels: ['bug'],
        mode: 'none',
        choice: 'null',
        nullable: null,
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
  budget(20_000)
);
