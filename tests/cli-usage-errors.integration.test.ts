import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDistBuilt } from './helpers/dist.js';
import { budget } from './helpers/timing.js';

const CLI_ENTRY = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

describe('mcporter usage errors', () => {
  let tempDir: string;

  beforeAll(async () => {
    await ensureDistBuilt(CLI_ENTRY);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-usage-errors-'));
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it.each([
    [['resource'], 'Missing server name. Usage: mcporter resource <server> [uri]'],
    [['inspect-cli'], 'Usage: mcporter inspect-cli <artifact> [--json]'],
    [['auth', '--browser', 'x', 'linear'], "--browser must be 'none' when provided to mcporter auth."],
    [['list', '--output', 'bogus'], '--output format must be one of: auto, text, markdown, json, raw.'],
    [['list', '--brief'], '--brief requires a server target.'],
    [['list', '--stdio'], "Flag '--stdio' requires a value."],
    [['list', '--http-url', 'ftp://example.com'], "Unsupported protocol 'ftp:' for --http-url."],
    [['serve', '--http'], "Flag '--http' requires a port."],
    [['record'], 'Usage: mcporter record <session-name> [--server <name>] [-- <command-to-run>]'],
    [['generate-cli', '--bundler', 'x'], "--bundler must be 'rolldown' or 'bun'."],
    [['generate-cli', '--runtime', 'x'], "--runtime must be 'node' or 'bun'."],
    [
      ['generate-cli'],
      'Provide --server with a definition or a command we can infer a name from (use --name to override).',
    ],
    [
      ['generate-cli', '--from', 'cli.js', '--name', 'demo'],
      '--from cannot be combined with --command/--description/--name.',
    ],
    [
      ['generate-cli', '--include-tools', 'a', '--exclude-tools', 'b'],
      '--include-tools and --exclude-tools cannot be used together.',
    ],
    [['--config'], "Flag '--config' requires a value."],
  ])(
    'prints %j once without a stack trace',
    async (args, message) => {
      const { code, stderr } = await new Promise<{ code: number; stderr: string }>((resolve) => {
        execFile(
          process.execPath,
          [CLI_ENTRY, ...args],
          { cwd: tempDir, env: { ...process.env, HOME: tempDir, USERPROFILE: tempDir } },
          (error, _stdout, errorOutput) => {
            resolve({ code: typeof error?.code === 'number' ? error.code : 0, stderr: errorOutput });
          }
        );
      });
      expect(code).toBe(1);
      expect(stderr.trim()).toBe(`[mcporter] ${message}`);
    },
    budget(20_000)
  );
});
