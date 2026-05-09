import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLI_ENTRY = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const testRequire = createRequire(import.meta.url);
const MCP_SERVER_MODULE = pathToFileURL(testRequire.resolve('@modelcontextprotocol/sdk/server/mcp.js')).href;
const STDIO_SERVER_MODULE = pathToFileURL(testRequire.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href;
const ZOD_MODULE = pathToFileURL(testRequire.resolve('zod')).href;
const describeDaemon = process.platform === 'win32' ? describe.skip : describe;

async function readFileWithRetries(filePath: string, retries = 20, delayMs = 100): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw lastError ?? new Error(`Failed to read ${filePath}`);
}

async function ensureDistBuilt(): Promise<void> {
  try {
    await fs.access(CLI_ENTRY);
  } catch {
    throw new Error('dist/cli.js is missing; run `pnpm build` before invoking this integration test directly.');
  }
}

async function runCli(
  args: string[],
  configPath: string,
  envOverrides: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLI_ENTRY, '--config', configPath, ...args],
      {
        env: { ...process.env, MCPORTER_NO_FORCE_EXIT: '1', ...envOverrides },
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

function parseCliJson(output: string): { instanceId: string; count: number } {
  const trimmed = output.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Unable to locate JSON payload in CLI output:\n${output}`);
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

describeDaemon('daemon keep-alive integration', () => {
  it('reuses stdio servers across mcporter invocations', async () => {
    await ensureDistBuilt();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-daemon-e2e-'));
    const scriptPath = path.join(tempDir, 'daemon-server.mjs');
    const configPath = path.join(tempDir, 'mcporter.daemon.json');

    const stdioServerSource = `import { randomUUID } from 'node:crypto';
import { McpServer } from '${MCP_SERVER_MODULE}';
import { StdioServerTransport } from '${STDIO_SERVER_MODULE}';
import { z } from '${ZOD_MODULE}';

const instanceId = randomUUID();
let counter = 0;

const server = new McpServer({ name: 'daemon-e2e', version: '1.0.0' });
server.registerTool('next_value', {
  title: 'Next value',
  description: 'Returns an incrementing counter along with the server instance id.',
  inputSchema: {},
  outputSchema: {
    instanceId: z.string(),
    count: z.number(),
  },
}, async () => {
  counter += 1;
  return {
    content: [{ type: 'text', text: JSON.stringify({ instanceId, count: counter }) }],
    structuredContent: { instanceId, count: counter },
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
await new Promise((resolve) => {
  transport.onclose = resolve;
});
`;

    await fs.writeFile(scriptPath, stdioServerSource, 'utf8');
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            'daemon-e2e': {
              description: 'E2E daemon test server',
              command: 'node',
              args: [scriptPath],
              lifecycle: 'keep-alive',
            },
          },
        },
        null,
        2
      ),
      'utf8'
    );

    const logPath = path.join(tempDir, 'daemon.log');
    const cliEnv = {
      MCPORTER_DAEMON_LOG: '1',
      MCPORTER_DAEMON_LOG_PATH: logPath,
      MCPORTER_DAEMON_LOG_SERVERS: 'daemon-e2e',
    };
    const cli = (args: string[]) => runCli(args, configPath, cliEnv);

    try {
      await cli(['daemon', 'stop']);

      const first = await cli(['call', 'daemon-e2e.next_value', '--output', 'json']);
      const firstResult = parseCliJson(first.stdout);
      expect(firstResult.count).toBe(1);

      const second = await cli(['call', 'daemon-e2e.next_value', '--output', 'json']);
      const secondResult = parseCliJson(second.stdout);
      expect(secondResult.count).toBe(2);
      expect(secondResult.instanceId).toBe(firstResult.instanceId);

      const logContents = await readFileWithRetries(logPath);
      expect(logContents).toContain('callTool start server=daemon-e2e tool=next_value');
      expect(logContents).toContain('callTool success server=daemon-e2e tool=next_value');
    } finally {
      await cli(['daemon', 'stop']).catch(() => {});
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 40_000);
});
