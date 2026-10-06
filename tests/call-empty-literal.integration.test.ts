import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { parseCallArguments } from '../src/cli/call-arguments.js';
import { budget } from './helpers/timing.js';

const execFileAsync = promisify(execFile);
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const server = fileURLToPath(new URL('./servers/modern/server.ts', import.meta.url));

it('preserves empty literal positions and their order after --', () => {
  const parsed = parseCallArguments(['fixture.echo', '--', '', '--flag', '', ' ']);
  expect(parsed.positionalArgs).toEqual(['', '--flag', '', '']);
});

it(
  'passes an empty literal string through the CLI to a real stdio MCP server',
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-empty-literal-'));
    const config = path.join(dir, 'mcporter.json');
    try {
      await fs.writeFile(
        config,
        JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [tsxCli, server] } } })
      );
      const { stdout } = await execFileAsync(
        process.execPath,
        [tsxCli, cli, '--config', config, 'call', 'fixture.echo', '--output', 'json', '--', ''],
        { timeout: budget(15_000) }
      ).catch((error: unknown) => {
        const detail = error as { stdout?: string; stderr?: string };
        throw new Error(`CLI failed: ${detail.stdout ?? ''}${detail.stderr ?? ''}`, { cause: error });
      });
      expect(JSON.parse(stdout)).toMatchObject({ content: [{ type: 'text', text: '' }] });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
  budget(20_000)
);
