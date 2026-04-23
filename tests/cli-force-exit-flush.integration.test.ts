import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLI_ENTRY = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const PNPM_COMMAND = process.platform === 'win32' ? 'cmd.exe' : 'pnpm';
const PNPM_ARGS_PREFIX = process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm'] : [];
const testRequire = createRequire(import.meta.url);
const MCP_SERVER_MODULE = pathToFileURL(testRequire.resolve('@modelcontextprotocol/sdk/server/mcp.js')).href;
const STDIO_SERVER_MODULE = pathToFileURL(testRequire.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href;
const ZOD_MODULE = pathToFileURL(path.join(process.cwd(), 'node_modules', 'zod', 'index.js')).href;

function pnpmArgs(args: string[]): string[] {
  return [...PNPM_ARGS_PREFIX, ...args];
}

async function ensureDistBuilt(): Promise<void> {
  try {
    await fs.access(CLI_ENTRY);
  } catch {
    await new Promise<void>((resolve, reject) => {
      execFile(PNPM_COMMAND, pnpmArgs(['build']), { cwd: process.cwd(), env: process.env }, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

describe('mcporter forced exit flush', () => {
  let tempDir: string;
  let configPath: string;

  beforeAll(async () => {
    await ensureDistBuilt();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-force-exit-flush-'));
    const serverScriptPath = path.join(tempDir, 'large-schema-server.mjs');
    configPath = path.join(tempDir, 'config.json');

    const toolCount = 64;
    const longDescription = 'Large schema tool description. '.repeat(30);
    await fs.writeFile(
      serverScriptPath,
      `import { McpServer } from ${JSON.stringify(MCP_SERVER_MODULE)};
import { StdioServerTransport } from ${JSON.stringify(STDIO_SERVER_MODULE)};
import { z } from ${JSON.stringify(ZOD_MODULE)};

const server = new McpServer({ name: 'large-schema', version: '1.0.0' });

for (let index = 0; index < ${toolCount}; index += 1) {
  server.registerTool(
    \`tool_\${index}\`,
    {
      title: \`Tool \${index}\`,
      description: ${JSON.stringify(longDescription)} + index,
      inputSchema: {
        alpha: z.string().describe(${JSON.stringify(longDescription)}),
        beta: z.string().optional().describe(${JSON.stringify(longDescription)}),
      },
      outputSchema: {
        ok: z.boolean(),
      },
    },
    async () => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { ok: true },
    })
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
`,
      'utf8'
    );

    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            'large-schema': {
              command: process.execPath,
              args: [serverScriptPath],
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

  it('does not truncate large JSON output when force exit is enabled', async () => {
    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(
        process.execPath,
        [CLI_ENTRY, '--config', configPath, 'list', 'large-schema', '--schema', '--output', 'json'],
        {
          cwd: process.cwd(),
          env: process.env,
          maxBuffer: 1024 * 1024,
        },
        (error, childStdout, childStderr) => {
          if (error) {
            reject(new Error(`${error.message}\nSTDOUT:\n${childStdout}\nSTDERR:\n${childStderr}`));
            return;
          }
          resolve({ stdout: childStdout, stderr: childStderr });
        }
      );
    });

    expect(stderr).toBe('');
    expect(Buffer.byteLength(stdout)).toBeGreaterThan(8192);

    const payload = JSON.parse(stdout);
    expect(payload.tools).toHaveLength(64);
    expect(payload.tools[0]?.name).toBe('tool_0');
    expect(payload.tools.at(-1)?.name).toBe('tool_63');
  }, 20000);
});
