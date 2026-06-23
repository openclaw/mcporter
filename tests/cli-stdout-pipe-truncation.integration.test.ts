import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLI_ENTRY = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const testRequire = createRequire(import.meta.url);
const MCP_SERVER_MODULE = pathToFileURL(testRequire.resolve('@modelcontextprotocol/sdk/server/mcp.js')).href;
const STDIO_SERVER_MODULE = pathToFileURL(testRequire.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href;

// Payload comfortably larger than the OS pipe buffer (~64KB) so that a forced
// exit which does not wait for stdout to drain would truncate the output.
const LARGE_TEXT_BYTES = 200_000;

async function ensureDistBuilt(): Promise<void> {
  try {
    await fs.access(CLI_ENTRY);
  } catch {
    throw new Error('dist/cli.js is missing; run `pnpm build` before invoking this integration test directly.');
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Run the CLI with stdout connected to a real pipe whose reader is briefly
// delayed before it starts draining. This is the faithful reproduction of the
// truncation bug: on POSIX, pipe writes are async, so while the reader sleeps
// the kernel pipe buffer fills and the remaining bytes stay queued in libuv. A
// forced `process.exit()` that does not wait for stdout to drain then drops
// them. The delay (500ms) stays under any reasonable flush window, so the fixed
// binary still completes once the reader resumes.
function runCliThroughPipe(args: string[], configPath: string, outFile: string): Promise<number> {
  const command = [
    shellQuote(process.execPath),
    shellQuote(CLI_ENTRY),
    '--config',
    shellQuote(configPath),
    ...args.map(shellQuote),
    '|',
    '(sleep 0.5; cat)',
    '>',
    shellQuote(outFile),
  ].join(' ');
  // Use bash with `pipefail` so a non-zero exit from the CLI (the first pipeline
  // stage) propagates, instead of being masked by the trailing `cat`.
  return new Promise((resolve) => {
    execFile('bash', ['-c', `set -o pipefail; ${command}`], { cwd: process.cwd(), env: process.env }, (error) => {
      resolve(typeof error?.code === 'number' ? error.code : 0);
    });
  });
}

// Run the CLI with stdout redirected straight to a file (synchronous writes on
// POSIX) to obtain the complete, untruncated reference output.
function runCliToFile(args: string[], configPath: string, outFile: string): Promise<number> {
  const command = [
    shellQuote(process.execPath),
    shellQuote(CLI_ENTRY),
    '--config',
    shellQuote(configPath),
    ...args.map(shellQuote),
    '>',
    shellQuote(outFile),
  ].join(' ');
  return new Promise((resolve) => {
    execFile('sh', ['-c', command], { cwd: process.cwd(), env: process.env }, (error) => {
      resolve(typeof error?.code === 'number' ? error.code : 0);
    });
  });
}

// POSIX-only: relies on `sh`, `sleep`, `cat` and POSIX async pipe semantics.
describe.skipIf(process.platform === 'win32')('mcporter stdout pipe truncation on forced exit', () => {
  let tempDir: string;
  let configPath: string;

  beforeAll(async () => {
    await ensureDistBuilt();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-pipe-truncation-'));
    const serverScriptPath = path.join(tempDir, 'large-output-server.mjs');
    configPath = path.join(tempDir, 'config.json');

    await fs.writeFile(
      serverScriptPath,
      `import { McpServer } from ${JSON.stringify(MCP_SERVER_MODULE)};
import { StdioServerTransport } from ${JSON.stringify(STDIO_SERVER_MODULE)};

const server = new McpServer({ name: 'large-output', version: '1.0.0' });

server.registerTool(
  'big',
  { title: 'Big', description: 'Return a large text payload', inputSchema: {} },
  async () => ({ content: [{ type: 'text', text: 'x'.repeat(${LARGE_TEXT_BYTES}) }] })
);

const transport = new StdioServerTransport();
await server.connect(transport);
`,
      'utf8'
    );

    await fs.writeFile(
      configPath,
      JSON.stringify(
        { mcpServers: { 'large-output': { command: process.execPath, args: [serverScriptPath] } } },
        null,
        2
      ),
      'utf8'
    );
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('does not truncate large output when stdout is a pipe', async () => {
    const args = ['call', 'large-output.big', '--output', 'json'];
    const fileOut = path.join(tempDir, 'file-output.json');
    const pipeOut = path.join(tempDir, 'pipe-output.json');

    const fileCode = await runCliToFile(args, configPath, fileOut);
    const pipeCode = await runCliThroughPipe(args, configPath, pipeOut);
    expect(fileCode).toBe(0);
    expect(pipeCode).toBe(0);

    const fileBytes = (await fs.readFile(fileOut)).byteLength;
    const pipeBytes = (await fs.readFile(pipeOut)).byteLength;

    // Sanity: the reference output must exceed the kernel pipe buffer, otherwise
    // the test cannot exercise the truncation path.
    expect(fileBytes).toBeGreaterThan(70_000);
    // The bug manifested as the piped output being clamped to the pipe buffer
    // size (exactly 65536 bytes in the reported case).
    expect(pipeBytes).not.toBe(65_536);
    // The piped output must match the complete file output byte-for-byte.
    expect(pipeBytes).toBe(fileBytes);
  }, 30000);

  it('still force-exits when stdout is piped to a consumer that never reads', async () => {
    // A consumer that keeps stdout open but never reads fills the pipe buffer
    // and blocks the drain callback. The fallback deadline must still terminate
    // the process instead of hanging indefinitely.
    const start = Date.now();
    const child = spawn(
      process.execPath,
      [CLI_ENTRY, '--config', configPath, 'call', 'large-output.big', '--output', 'json'],
      { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    // Intentionally never consume stdout so the OS pipe buffer stays full.
    child.stdout.pause();

    const code = await new Promise<number>((resolve) => {
      child.on('exit', (exitCode) => resolve(exitCode ?? -1));
    });
    const elapsed = Date.now() - start;

    expect(code).toBe(0);
    // Terminates via the fallback deadline (~2s) rather than hanging.
    expect(elapsed).toBeLessThan(8000);
  }, 20000);

  it('does not crash when a piped consumer closes stdout early (EPIPE)', async () => {
    const command = [
      shellQuote(process.execPath),
      shellQuote(CLI_ENTRY),
      '--config',
      shellQuote(configPath),
      'call',
      'large-output.big',
      '--output',
      'json',
      '|',
      'head -c 100',
      '>',
      '/dev/null',
    ].join(' ');
    const result = await new Promise<{ code: number; stderr: string }>((resolve) => {
      execFile(
        'bash',
        ['-c', `set -o pipefail; ${command}`],
        { cwd: process.cwd(), env: process.env },
        (error, _stdout, stderr) => {
          resolve({ code: typeof error?.code === 'number' ? error.code : 0, stderr });
        }
      );
    });

    expect(result.code).toBe(0);
    expect(result.stderr).not.toMatch(/EPIPE|Unhandled 'error'/);
  }, 20000);
});
