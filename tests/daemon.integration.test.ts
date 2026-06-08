import { type ChildProcess, execFile, spawn } from 'node:child_process';
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

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExit(child: ChildProcess, retries = 50, delayMs = 100): Promise<void> {
  for (let attempt = 0; attempt < retries; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    await delay(delayMs);
  }
  throw new Error(`Process ${child.pid ?? '<unknown>'} did not exit.`);
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
    const launchLogPath = path.join(tempDir, 'launches.log');

    const stdioServerSource = `import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { McpServer } from '${MCP_SERVER_MODULE}';
import { StdioServerTransport } from '${STDIO_SERVER_MODULE}';
import { z } from '${ZOD_MODULE}';

const instanceId = randomUUID();
let counter = 0;

if (process.env.MCPORTER_TEST_LAUNCH_LOG) {
  await fs.appendFile(process.env.MCPORTER_TEST_LAUNCH_LOG, instanceId + '\\n', 'utf8');
}

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
      MCPORTER_TEST_LAUNCH_LOG: launchLogPath,
    };
    const cli = (args: string[]) => runCli(args, configPath, cliEnv);

    try {
      await cli(['daemon', 'stop']);

      await cli(['list', 'daemon-e2e', '--json']);
      await cli(['list', 'daemon-e2e', '--json']);

      const first = await cli(['call', 'daemon-e2e.next_value', '--output', 'json']);
      const firstResult = parseCliJson(first.stdout);
      expect(firstResult.count).toBe(1);

      const second = await cli(['call', 'daemon-e2e.next_value', '--output', 'json']);
      const secondResult = parseCliJson(second.stdout);
      expect(secondResult.count).toBe(2);
      expect(secondResult.instanceId).toBe(firstResult.instanceId);

      const launchLog = await readFileWithRetries(launchLogPath);
      expect(launchLog.trim().split('\n')).toEqual([firstResult.instanceId]);

      const logContents = await readFileWithRetries(logPath);
      expect(logContents).toContain('listTools start server=daemon-e2e');
      expect(logContents).toContain('listTools success server=daemon-e2e');
      expect(logContents).toContain('callTool start server=daemon-e2e tool=next_value');
      expect(logContents).toContain('callTool success server=daemon-e2e tool=next_value');
    } finally {
      await cli(['daemon', 'stop']).catch(() => {});
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 40_000);

  it('refuses duplicate binds when foreground starts race outside the client lock', async () => {
    await ensureDistBuilt();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-daemon-bind-'));
    const scriptPath = path.join(tempDir, 'bind-server.mjs');
    const configPath = path.join(tempDir, 'mcporter.bind.json');

    const serverSource = `import { McpServer } from '${MCP_SERVER_MODULE}';
import { StdioServerTransport } from '${STDIO_SERVER_MODULE}';
const server = new McpServer({ name: 'bind-e2e', version: '1.0.0' });
server.registerTool('ping', { title: 'ping', description: 'ping', inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: 'pong' }],
}));
await server.connect(new StdioServerTransport());
await new Promise(() => {});
`;
    await fs.writeFile(scriptPath, serverSource, 'utf8');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          'bind-e2e': { description: 'bind race server', command: 'node', args: [scriptPath], lifecycle: 'keep-alive' },
        },
      }),
      'utf8'
    );

    const children: ChildProcess[] = [];
    try {
      await runCli(['daemon', 'stop'], configPath).catch(() => {});
      for (let i = 0; i < 4; i++) {
        children.push(
          spawn(process.execPath, [CLI_ENTRY, '--config', configPath, 'daemon', 'start', '--foreground'], {
            env: { ...process.env, MCPORTER_NO_FORCE_EXIT: '1' },
            stdio: 'ignore',
          })
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      const alive = children.filter((child) => child.exitCode === null && child.signalCode === null);
      expect(alive).toHaveLength(1);
    } finally {
      for (const child of children) {
        child.kill('SIGKILL');
      }
      await runCli(['daemon', 'stop'], configPath).catch(() => {});
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 40_000);

  it('repairs metadata when a live daemon owns the socket and metadata is missing', async () => {
    await ensureDistBuilt();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-daemon-meta-'));
    const scriptPath = path.join(tempDir, 'meta-server.mjs');
    const configPath = path.join(tempDir, 'mcporter.meta.json');
    const metadataPath = path.join(tempDir, 'daemon.json');

    const serverSource = `import { McpServer } from '${MCP_SERVER_MODULE}';
import { StdioServerTransport } from '${STDIO_SERVER_MODULE}';
const server = new McpServer({ name: 'meta-e2e', version: '1.0.0' });
server.registerTool('ping', { title: 'ping', description: 'ping', inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: 'pong' }],
}));
await server.connect(new StdioServerTransport());
await new Promise(() => {});
`;
    await fs.writeFile(scriptPath, serverSource, 'utf8');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          'meta-e2e': { description: 'meta server', command: 'node', args: [scriptPath], lifecycle: 'keep-alive' },
        },
      }),
      'utf8'
    );

    // Pin only the metadata path (not the socket, to stay under the unix socket length limit).
    const env = { ...process.env, MCPORTER_NO_FORCE_EXIT: '1', MCPORTER_DAEMON_METADATA: metadataPath };
    const children: ChildProcess[] = [];
    const startForeground = (): ChildProcess => {
      const child = spawn(process.execPath, [CLI_ENTRY, '--config', configPath, 'daemon', 'start', '--foreground'], {
        env,
        stdio: 'ignore',
      });
      children.push(child);
      return child;
    };

    try {
      const first = startForeground();
      const firstPid = JSON.parse(await readFileWithRetries(metadataPath, 50)).pid as number;
      expect(firstPid).toBe(first.pid);

      await fs.rm(metadataPath, { force: true });

      const replacement = startForeground();
      await waitForExit(replacement);

      const ownerPid = JSON.parse(await readFileWithRetries(metadataPath, 50)).pid as number;
      expect(ownerPid).toBe(first.pid);
      expect(first.exitCode).toBeNull();
    } finally {
      for (const child of children) {
        child.kill('SIGKILL');
      }
      await runCli(['daemon', 'stop'], configPath, { MCPORTER_DAEMON_METADATA: metadataPath }).catch(() => {});
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 40_000);

  it('stops a live daemon with stale config before rebinding', async () => {
    await ensureDistBuilt();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-daemon-stale-'));
    const scriptPath = path.join(tempDir, 'stale-server.mjs');
    const configPath = path.join(tempDir, 'mcporter.stale.json');
    const metadataPath = path.join(tempDir, 'daemon.json');

    const serverSource = `import { McpServer } from '${MCP_SERVER_MODULE}';
import { StdioServerTransport } from '${STDIO_SERVER_MODULE}';
const server = new McpServer({ name: 'stale-e2e', version: '1.0.0' });
server.registerTool('ping', { title: 'ping', description: 'ping', inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: 'pong' }],
}));
await server.connect(new StdioServerTransport());
await new Promise(() => {});
`;
    await fs.writeFile(scriptPath, serverSource, 'utf8');
    const writeConfig = async (description: string): Promise<void> => {
      await fs.writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            'stale-e2e': { description, command: 'node', args: [scriptPath], lifecycle: 'keep-alive' },
          },
        }),
        'utf8'
      );
    };
    await writeConfig('stale server v1');

    const env = { ...process.env, MCPORTER_NO_FORCE_EXIT: '1', MCPORTER_DAEMON_METADATA: metadataPath };
    const children: ChildProcess[] = [];
    const startForeground = (): ChildProcess => {
      const child = spawn(process.execPath, [CLI_ENTRY, '--config', configPath, 'daemon', 'start', '--foreground'], {
        env,
        stdio: 'ignore',
      });
      children.push(child);
      return child;
    };

    try {
      const first = startForeground();
      const firstPid = JSON.parse(await readFileWithRetries(metadataPath, 50)).pid as number;
      expect(firstPid).toBe(first.pid);

      await delay(20);
      await writeConfig('stale server v2');
      const staleConfigTime = new Date(Date.now() + 5_000);
      await fs.utimes(configPath, staleConfigTime, staleConfigTime);

      const replacement = startForeground();
      await waitForExit(first);

      const ownerPid = JSON.parse(await readFileWithRetries(metadataPath, 50)).pid as number;
      expect(ownerPid).toBe(replacement.pid);
      expect(replacement.exitCode).toBeNull();
    } finally {
      for (const child of children) {
        child.kill('SIGKILL');
      }
      await runCli(['daemon', 'stop'], configPath, { MCPORTER_DAEMON_METADATA: metadataPath }).catch(() => {});
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 40_000);

  it('stops a live daemon when imported root definitions change', async () => {
    await ensureDistBuilt();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-daemon-root-'));
    const scriptPath = path.join(tempDir, 'root-server.mjs');
    const configPath = path.join(tempDir, 'mcporter.root.json');
    const metadataPath = path.join(tempDir, 'daemon.json');
    const socketPath = path.join(tempDir, 'daemon.sock');
    const rootA = path.join(tempDir, 'root-a');
    const rootB = path.join(tempDir, 'root-b');
    const fakeHome = path.join(tempDir, 'home');

    const serverSource = `import { McpServer } from '${MCP_SERVER_MODULE}';
import { StdioServerTransport } from '${STDIO_SERVER_MODULE}';
const server = new McpServer({ name: 'root-e2e', version: '1.0.0' });
server.registerTool('ping', { title: 'ping', description: 'ping', inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: 'pong' }],
}));
await server.connect(new StdioServerTransport());
await new Promise(() => {});
`;
    await fs.writeFile(scriptPath, serverSource, 'utf8');
    await fs.writeFile(configPath, JSON.stringify({ imports: ['cursor'], mcpServers: {} }), 'utf8');

    const writeCursorImport = async (rootDir: string, name: string): Promise<void> => {
      const importPath = path.join(rootDir, '.cursor', 'mcp.json');
      await fs.mkdir(path.dirname(importPath), { recursive: true });
      await fs.writeFile(
        importPath,
        JSON.stringify({
          mcpServers: {
            [name]: {
              description: name,
              command: 'node',
              args: [scriptPath],
              lifecycle: 'keep-alive',
            },
          },
        }),
        'utf8'
      );
    };
    await writeCursorImport(rootA, 'root-a-e2e');
    await writeCursorImport(rootB, 'root-b-e2e');

    const env = {
      ...process.env,
      MCPORTER_NO_FORCE_EXIT: '1',
      MCPORTER_DAEMON_METADATA: metadataPath,
      MCPORTER_DAEMON_SOCKET: socketPath,
      MCPORTER_KEEPALIVE: '*',
      HOME: fakeHome,
      XDG_CONFIG_HOME: path.join(tempDir, 'xdg'),
      APPDATA: path.join(tempDir, 'appdata'),
    };
    const children: ChildProcess[] = [];
    const startForeground = (rootDir: string): ChildProcess => {
      const child = spawn(
        process.execPath,
        [CLI_ENTRY, '--config', configPath, '--root', rootDir, 'daemon', 'start', '--foreground'],
        {
          env,
          stdio: 'ignore',
        }
      );
      children.push(child);
      return child;
    };

    try {
      const first = startForeground(rootA);
      const firstMetadata = JSON.parse(await readFileWithRetries(metadataPath, 50)) as {
        pid: number;
        definitionHash?: string;
      };
      expect(firstMetadata.pid).toBe(first.pid);
      expect(typeof firstMetadata.definitionHash).toBe('string');

      const replacement = startForeground(rootB);
      await waitForExit(first);

      const replacementMetadata = JSON.parse(await readFileWithRetries(metadataPath, 50)) as {
        pid: number;
        definitionHash?: string;
      };
      expect(replacementMetadata.pid).toBe(replacement.pid);
      expect(replacementMetadata.definitionHash).not.toBe(firstMetadata.definitionHash);
      expect(replacement.exitCode).toBeNull();
    } finally {
      for (const child of children) {
        child.kill('SIGKILL');
      }
      await runCli(['daemon', 'stop'], configPath, {
        MCPORTER_DAEMON_METADATA: metadataPath,
        MCPORTER_DAEMON_SOCKET: socketPath,
        MCPORTER_KEEPALIVE: '*',
        HOME: fakeHome,
        XDG_CONFIG_HOME: path.join(tempDir, 'xdg'),
        APPDATA: path.join(tempDir, 'appdata'),
      }).catch(() => {});
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 40_000);
});
