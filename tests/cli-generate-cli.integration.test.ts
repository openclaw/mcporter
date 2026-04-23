import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const CLI_ENTRY = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const testRequire = createRequire(import.meta.url);
const MCP_SERVER_MODULE = pathToFileURL(testRequire.resolve('@modelcontextprotocol/sdk/server/mcp.js')).href;
const STDIO_SERVER_MODULE = pathToFileURL(testRequire.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href;
const ZOD_MODULE = pathToFileURL(path.join(process.cwd(), 'node_modules', 'zod', 'index.js')).href;
const PNPM_COMMAND = process.platform === 'win32' ? 'cmd.exe' : 'pnpm';
const PNPM_ARGS_PREFIX = process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm'] : [];

function pnpmArgs(args: string[]): string[] {
  return [...PNPM_ARGS_PREFIX, ...args];
}

async function ensureDistBuilt(): Promise<void> {
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

async function hasBun(): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    execFile('bun', ['--version'], { cwd: process.cwd(), env: process.env }, (error) => {
      resolve(!error);
    });
  });
}

async function ensureBunSupport(reason: string): Promise<boolean> {
  if (process.platform === 'win32') {
    console.warn(`bun not supported on Windows; skipping ${reason}.`);
    return false;
  }
  if (!(await hasBun())) {
    console.warn(`bun not available on this runner; skipping ${reason}.`);
    return false;
  }
  return true;
}

describe('mcporter CLI integration', () => {
  let baseUrl: URL;
  let shutdown: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    await ensureDistBuilt();
    const app = express();
    app.use(express.json());
    const server = new McpServer({ name: 'context7', title: 'Context7 integration harness', version: '1.0.0' });
    server.registerTool(
      'ping',
      {
        title: 'Ping',
        description: 'Simple health check',
        inputSchema: { echo: z.string().optional() },
        outputSchema: { ok: z.boolean(), echo: z.string().optional() },
      },
      async ({ echo }) => ({
        content: [{ type: 'text', text: JSON.stringify({ ok: true, echo: echo ?? 'hi' }) }],
        structuredContent: { ok: true, echo: echo ?? 'hi' },
      })
    );
    server.registerTool(
      'admin_reset',
      {
        title: 'Admin Reset',
        description: 'Dangerous admin action',
        inputSchema: { reason: z.string().optional() },
        outputSchema: { ok: z.boolean() },
      },
      async () => ({
        content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
        structuredContent: { ok: true },
      })
    );

    app.post('/mcp', async (req, res) => {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        transport.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });

    const httpServer = createServer(app);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start integration server');
    }
    baseUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);
    shutdown = async () =>
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
  }, 60_000);

  afterAll(async () => {
    if (shutdown) {
      await shutdown();
    }
  });

  it('runs "node dist/cli.js generate-cli" from a dependency-less directory', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-cli-e2e-'));
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'mcporter-e2e', version: '0.0.0' }, null, 2),
      'utf8'
    );
    const bundlePath = path.join(tempDir, 'context7.cli.js');

    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [CLI_ENTRY, 'generate-cli', '--command', baseUrl.toString(), '--bundle', bundlePath, '--runtime', 'node'],
        {
          cwd: tempDir,
          env: { ...process.env, MCPORTER_NO_FORCE_EXIT: '1' },
        },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }
      );
    });

    const stats = await fs.stat(bundlePath);
    expect(stats.isFile()).toBe(true);
    const helpOutput = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(process.execPath, [bundlePath], { env: process.env }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
    expect(helpOutput.stdout).toMatch(/Usage: .+ <command> \[options]/);
    expect(helpOutput.stdout).toContain('Context7 integration harness');
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('filters generated CLI tools via --include-tools/--exclude-tools', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-cli-filter-'));
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'mcporter-cli-filter', version: '0.0.0' }, null, 2),
      'utf8'
    );

    const includePath = path.join(tempDir, 'context7-include.js');
    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [
          CLI_ENTRY,
          'generate-cli',
          '--command',
          baseUrl.toString(),
          '--runtime',
          'node',
          '--bundle',
          includePath,
          '--include-tools',
          'ping',
        ],
        { cwd: tempDir, env: { ...process.env, MCPORTER_NO_FORCE_EXIT: '1' } },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }
      );
    });
    const includeHelp = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(process.execPath, [includePath], { env: process.env }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
    expect(includeHelp.stdout).toContain('ping - Simple health check');
    expect(includeHelp.stdout).not.toContain('admin-reset');

    const excludePath = path.join(tempDir, 'context7-exclude.js');
    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [
          CLI_ENTRY,
          'generate-cli',
          '--command',
          baseUrl.toString(),
          '--runtime',
          'node',
          '--bundle',
          excludePath,
          '--exclude-tools',
          'ping',
        ],
        { cwd: tempDir, env: { ...process.env, MCPORTER_NO_FORCE_EXIT: '1' } },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }
      );
    });
    const excludeHelp = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(process.execPath, [excludePath], { env: process.env }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
    expect(excludeHelp.stdout).not.toContain('ping - Simple health check');
    expect(excludeHelp.stdout).toContain('admin-reset');

    await new Promise<void>((resolve) => {
      execFile(
        process.execPath,
        [
          CLI_ENTRY,
          'generate-cli',
          '--command',
          baseUrl.toString(),
          '--runtime',
          'node',
          '--bundle',
          path.join(tempDir, 'context7-missing.js'),
          '--include-tools',
          'missing-tool',
        ],
        { cwd: tempDir, env: { ...process.env, MCPORTER_NO_FORCE_EXIT: '1' } },
        (error, stdout, stderr) => {
          expect(error).toBeTruthy();
          expect(`${stdout}\n${stderr}`).toMatch(/Requested tools not found|missing-tool/);
          resolve();
        }
      );
    });

    await new Promise<void>((resolve) => {
      execFile(
        process.execPath,
        [
          CLI_ENTRY,
          'generate-cli',
          '--command',
          baseUrl.toString(),
          '--runtime',
          'node',
          '--bundle',
          path.join(tempDir, 'context7-empty.js'),
          '--include-tools',
          ',',
        ],
        { cwd: tempDir, env: { ...process.env, MCPORTER_NO_FORCE_EXIT: '1' } },
        (error, stdout, stderr) => {
          expect(error).toBeTruthy();
          expect(`${stdout}\n${stderr}`).toMatch(/--include-tools requires at least one/);
          resolve();
        }
      );
    });

    await new Promise<void>((resolve) => {
      execFile(
        process.execPath,
        [
          CLI_ENTRY,
          'generate-cli',
          '--command',
          baseUrl.toString(),
          '--runtime',
          'node',
          '--bundle',
          path.join(tempDir, 'context7-both.js'),
          '--include-tools',
          'ping',
          '--exclude-tools',
          'ping',
        ],
        { cwd: tempDir, env: { ...process.env, MCPORTER_NO_FORCE_EXIT: '1' } },
        (error, stdout, stderr) => {
          expect(error).toBeTruthy();
          expect(`${stdout}\n${stderr}`).toMatch(/cannot be used together/);
          resolve();
        }
      );
    });

    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }, 40_000);

  it('bundles with Bun automatically when runtime resolves to Bun', async () => {
    if (!(await ensureBunSupport('Bun bundler integration test'))) {
      return;
    }
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-bun-bundle-'));
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'mcporter-bun-bundle', version: '0.0.0' }, null, 2),
      'utf8'
    );
    const bundlePath = path.join(tempDir, 'context7-bun.js');

    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [CLI_ENTRY, 'generate-cli', '--command', baseUrl.toString(), '--runtime', 'bun', '--bundle', bundlePath],
        {
          cwd: tempDir,
          env: { ...process.env, MCPORTER_NO_FORCE_EXIT: '1' },
        },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }
      );
    });

    const stats = await fs.stat(bundlePath);
    expect(stats.isFile()).toBe(true);
    const helpOutput = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(bundlePath, [], { env: process.env }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
    expect(helpOutput.stdout).toMatch(/Usage: .+ <command> \[options]/);
    expect(helpOutput.stdout).toContain('Context7 integration harness');
    expect(helpOutput.stdout).toContain('ping - Simple health check');
    expect(helpOutput.stdout).toContain('--echo <echo>');
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }, 20000);

  it('generates a Bun CLI that can call a tool', async () => {
    if (!(await ensureBunSupport('Bun CLI execution test'))) {
      return;
    }
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-bun-cli-'));
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'mcporter-bun-cli', version: '0.0.0' }, null, 2),
      'utf8'
    );
    const bundlePath = path.join(tempDir, 'context7-bun-cli.js');

    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [CLI_ENTRY, 'generate-cli', '--command', baseUrl.toString(), '--runtime', 'bun', '--bundle', bundlePath],
        {
          cwd: tempDir,
          env: { ...process.env, MCPORTER_NO_FORCE_EXIT: '1' },
        },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }
      );
    });

    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(
        bundlePath,
        ['ping', '--echo', 'ban', '--output', 'json'],
        { env: process.env },
        (error, stdout, stderr) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout, stderr });
        }
      );
    });
    const parsed = JSON.parse(result.stdout.trim()) as { ok: boolean; echo?: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.echo).toBe('ban');
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }, 20000);

  it('runs "node dist/cli.js generate-cli --compile" when bun is available', async () => {
    if (!(await ensureBunSupport('compile integration test'))) {
      return;
    }
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-cli-compile-'));
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'mcporter-compile-e2e', version: '0.0.0' }, null, 2),
      'utf8'
    );
    const binaryPath = path.join(tempDir, 'context7-cli');

    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [CLI_ENTRY, 'generate-cli', '--command', baseUrl.toString(), '--compile', binaryPath, '--runtime', 'bun'],
        {
          cwd: tempDir,
          env: { ...process.env, MCPORTER_NO_FORCE_EXIT: '1' },
        },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }
      );
    });

    const stats = await fs.stat(binaryPath);
    expect(stats.isFile()).toBe(true);

    const helpOutput = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(binaryPath, [], { env: process.env }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
    expect(helpOutput.stdout).toMatch(/Usage: .+ <command> \[options]/);
    expect(helpOutput.stdout).toContain('Context7 integration harness');
    expect(helpOutput.stdout).toContain('ping - Simple health check');
    expect(helpOutput.stdout).toContain('--echo <echo>');

    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }, 20000);

  it('end-to-end: compiles a "bun" CLI and calls ping', async () => {
    if (!(await ensureBunSupport('Bun CLI end-to-end test'))) {
      return;
    }
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-cli-bun-'));
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'mcporter-bun-e2e', version: '0.0.0' }, null, 2),
      'utf8'
    );

    const binaryPath = path.join(tempDir, 'bun');
    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [
          CLI_ENTRY,
          'generate-cli',
          '--command',
          baseUrl.toString(),
          '--runtime',
          'bun',
          '--compile',
          binaryPath,
          '--name',
          'bun',
          '--include-tools',
          'ping',
        ],
        { cwd: tempDir, env: { ...process.env, MCPORTER_NO_FORCE_EXIT: '1' } },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }
      );
    });

    const helpOutput = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(binaryPath, [], { env: process.env }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
    expect(helpOutput.stdout).toMatch(/Usage: bun <command> \[options]/);
    expect(helpOutput.stdout).toContain('ping - Simple health check');
    expect(helpOutput.stdout).not.toContain('admin-reset');

    const pingOutput = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(
        binaryPath,
        ['ping', '--echo', 'works', '--output', 'json'],
        { env: process.env },
        (error, stdout, stderr) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout, stderr });
        }
      );
    });
    const parsed = JSON.parse(pingOutput.stdout.trim()) as { ok: boolean; echo?: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.echo).toBe('works');

    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }, 30000);

  it('runs "node dist/cli.js generate-cli --compile" using the Bun bundler by default', async () => {
    if (!(await ensureBunSupport('Bun bundler compile integration test'))) {
      return;
    }
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-cli-compile-bun-'));
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'mcporter-compile-bun', version: '0.0.0' }, null, 2),
      'utf8'
    );
    const binaryPath = path.join(tempDir, 'context7-cli-bun');

    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [CLI_ENTRY, 'generate-cli', '--command', baseUrl.toString(), '--compile', binaryPath, '--runtime', 'bun'],
        {
          cwd: tempDir,
          env: { ...process.env, MCPORTER_NO_FORCE_EXIT: '1' },
        },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }
      );
    });

    const stats = await fs.stat(binaryPath);
    expect(stats.isFile()).toBe(true);

    const helpOutput = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(binaryPath, [], { env: process.env }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
    expect(helpOutput.stdout).toMatch(/Usage: .+ <command> \[options]/);
    expect(helpOutput.stdout).toContain('ping - Simple health check');
    expect(helpOutput.stdout).toContain('--echo <echo>');

    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }, 20000);

  it('accepts inline stdio commands (e.g., "npx -y chrome-devtools-mcp@latest") when compiling', async () => {
    if (!(await ensureBunSupport('inline stdio compile integration test'))) {
      return;
    }
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-inline-stdio-'));
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'mcporter-inline-stdio', version: '0.0.0' }, null, 2),
      'utf8'
    );
    const scriptPath = path.join(tempDir, 'mock-stdio.mjs');
    const scriptSource = `import { McpServer } from '${MCP_SERVER_MODULE}';
import { StdioServerTransport } from '${STDIO_SERVER_MODULE}';
import { z } from '${ZOD_MODULE}';

const server = new McpServer({ name: 'inline-cli', version: '1.0.0' });
server.registerTool('echo', {
  title: 'Echo',
  description: 'Return the provided text',
  // Use Zod schemas to keep SDK 1.22.x happy when converting to JSON Schema.
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({ text: z.string() }),
}, async ({ text }) => ({
  content: [{ type: 'text', text }],
  structuredContent: { text },
}));

const transport = new StdioServerTransport();
await server.connect(transport);
await new Promise((resolve) => {
  transport.onclose = resolve;
});
`;
    await fs.writeFile(scriptPath, scriptSource, 'utf8');

    const binaryPath = path.join(tempDir, 'inline-cli');
    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [CLI_ENTRY, 'generate-cli', `node ${scriptPath}`, '--compile', binaryPath, '--runtime', 'bun'],
        {
          cwd: tempDir,
          env: { ...process.env, MCPORTER_NO_FORCE_EXIT: '1' },
        },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }
      );
    });

    const stats = await fs.stat(binaryPath);
    expect(stats.isFile()).toBe(true);

    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(binaryPath, [], { env: process.env }, (error, childStdout, childStderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout: childStdout, stderr: childStderr });
      });
    });
    expect(stdout).toContain('echo - Return the provided text');
    expect(stdout).toContain('[--raw <json>]');

    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }, 40_000);

  it('resolves relative stdio args from the bundle directory when invoked from any cwd (#56)', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-cli-reloc-'));
    const distDir = path.join(tempDir, 'dist');
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'mcporter-reloc-e2e', version: '0.0.0' }, null, 2),
      'utf8'
    );

    const serverPath = path.join(distDir, 'server.mjs');
    const serverSource = `import { McpServer } from '${MCP_SERVER_MODULE}';
import { StdioServerTransport } from '${STDIO_SERVER_MODULE}';
import { z } from '${ZOD_MODULE}';

const server = new McpServer({ name: 'reloc', version: '1.0.0' });
server.registerTool('echo', {
  title: 'Echo',
  description: 'Return the provided text',
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({ text: z.string() }),
}, async ({ text }) => ({
  content: [{ type: 'text', text }],
  structuredContent: { text },
}));

const transport = new StdioServerTransport();
await server.connect(transport);
await new Promise((resolve) => { transport.onclose = resolve; });
`;
    await fs.writeFile(serverPath, serverSource, 'utf8');

    const bundlePath = path.join(distDir, 'reloc-cli.cjs');
    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [CLI_ENTRY, 'generate-cli', '--command', 'node dist/server.mjs', '--bundle', bundlePath, '--runtime', 'node'],
        { cwd: tempDir, env: { ...process.env, MCPORTER_NO_FORCE_EXIT: '1' } },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }
      );
    });

    // Invoke the generated CLI from an unrelated cwd using an absolute path, so
    // we prove that the spawned stdio server's relative "dist/server.mjs" arg
    // is resolved against the bundle location rather than the caller's cwd.
    const callerCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-cli-reloc-caller-'));
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(
        process.execPath,
        [bundlePath, 'echo', '--text', 'relocated'],
        { cwd: callerCwd, env: process.env },
        (error, stdout, stderr) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout, stderr });
        }
      );
    });
    expect(result.stdout).toContain('relocated');

    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(callerCwd, { recursive: true, force: true }).catch(() => {});
  }, 30_000);
});
