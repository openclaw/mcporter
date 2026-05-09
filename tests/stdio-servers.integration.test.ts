import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLI_ENTRY = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

async function ensureDistBuilt(): Promise<void> {
  try {
    await fs.access(CLI_ENTRY);
  } catch {
    throw new Error('dist/cli.js is missing; run `pnpm build` before invoking this integration test directly.');
  }
}

async function runCli(args: string[], configPath: string): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLI_ENTRY, '--config', configPath, ...args],
      {
        env: { ...process.env, MCPORTER_NO_FORCE_EXIT: '1' },
      },
      (error, stdout, stderr) => {
        if (error) {
          const wrapped = new Error(`${error.message}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
          reject(wrapped);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

describe('stdio MCP servers (filesystem + memory)', () => {
  let tempDir: string;
  let configPath: string;
  let fsRoot: string;

  const filesystemServerScript = fileURLToPath(new URL('./fixtures/stdio-filesystem-server.mjs', import.meta.url));
  const memoryServerScript = fileURLToPath(new URL('./fixtures/stdio-memory-server.mjs', import.meta.url));

  beforeAll(async () => {
    await ensureDistBuilt();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-stdio-e2e-'));
    fsRoot = path.join(tempDir, 'fs-root');
    await fs.mkdir(fsRoot, { recursive: true });
    await fs.writeFile(path.join(fsRoot, 'hello.txt'), 'hello from stdio mcp\n', 'utf8');
    configPath = path.join(tempDir, 'stdio.config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            'fs-test': {
              description: 'Filesystem MCP for stdio e2e tests',
              command: process.execPath,
              args: [filesystemServerScript, fsRoot],
            },
            'memory-test': {
              description: 'Knowledge graph MCP for stdio e2e tests',
              command: process.execPath,
              args: [memoryServerScript],
            },
          },
        },
        null,
        2
      ),
      'utf8'
    );
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('lists filesystem tools and reads files via stdio MCP', async () => {
    const listResult = await runCli(['list', 'fs-test'], configPath);
    expect(listResult.stdout).toContain('Filesystem MCP for stdio e2e tests');
    const callResult = await runCli(
      [
        'call',
        'fs-test.read_text_file',
        '--output',
        'json',
        '--args',
        JSON.stringify({ path: path.join(fsRoot, 'hello.txt') }),
      ],
      configPath
    );
    expect(callResult.stdout).toContain('hello from stdio mcp');
  }, 20000);

  const memoryTest = process.platform === 'win32' ? it.skip : it;

  memoryTest(
    'creates entities with the memory stdio MCP server',
    async () => {
      const callResult = await runCli(
        [
          'call',
          'memory-test.create_entities',
          '--output',
          'json',
          '--args',
          JSON.stringify({ entities: ['alpha', 'beta'] }),
        ],
        configPath
      );
      expect(callResult.stderr).toBe('');
      expect(callResult.stdout).not.toContain('Error');
    },
    20000
  );
});
