import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDistBuilt } from './helpers/dist.js';
import { budget } from './helpers/timing.js';

const CLI_ENTRY = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function runCli(args: string[], configPath: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLI_ENTRY, '--config', configPath, ...args],
      {
        cwd: process.cwd(),
        env: { ...process.env, MCPORTER_NO_FORCE_EXIT: '1' },
        maxBuffer: 1024 * 1024,
        timeout: budget(15_000),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            Object.assign(new Error(`${error.message}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`), {
              code: error.code,
              stderr,
            })
          );
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

describe('mcporter HTTP selector CLI integration', () => {
  let httpServer: HttpServer;
  let baseUrl: URL;
  let tempDir: string;
  let configuredPath: string;
  let emptyPath: string;
  const observedToolNames: string[] = [];
  let mcpRequests = 0;

  beforeAll(async () => {
    await ensureDistBuilt(CLI_ENTRY);

    const app = express();
    app.use((_req, _res, next) => {
      mcpRequests += 1;
      next();
    });
    app.use(express.json());
    const server = new McpServer({ name: 'http-selector-e2e', version: '1.0.0' });
    server.registerTool(
      'check_login_status',
      {
        title: 'Check login status',
        description: 'Return a deterministic login status',
        inputSchema: {},
      },
      async () => {
        observedToolNames.push('check_login_status');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ loggedIn: true, observedTool: 'check_login_status' }),
            },
          ],
        };
      }
    );
    server.registerTool(
      'xhs.check_login_status',
      {
        title: 'Literal dotted tool',
        description: 'Prove that --tool remains literal',
        inputSchema: {},
      },
      async () => {
        observedToolNames.push('xhs.check_login_status');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ loggedIn: true, observedTool: 'xhs.check_login_status' }),
            },
          ],
        };
      }
    );

    app.post('/mcp', async (req, res) => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        transport.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });

    httpServer = createServer(app);
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', resolve);
    });
    const address = httpServer.address() as AddressInfo;
    baseUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-http-selector-e2e-'));
    configuredPath = path.join(tempDir, 'configured.json');
    emptyPath = path.join(tempDir, 'empty.json');
    await fs.writeFile(
      configuredPath,
      JSON.stringify(
        { imports: [], mcpServers: { xhs: { baseUrl: baseUrl.href }, '--literal': { baseUrl: baseUrl.href } } },
        null,
        2
      ),
      'utf8'
    );
    await fs.writeFile(emptyPath, JSON.stringify({ imports: [], mcpServers: {} }, null, 2), 'utf8');
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it.each(['xhs', '--literal'])('lists configured HTTP server %s with JSON schemas', async (name) => {
    const result = await runCli(['list', name, '--schema', '--json'], configuredPath);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: 'server',
      name,
      status: 'ok',
      tools: expect.arrayContaining([
        expect.objectContaining({ name: 'check_login_status' }),
        expect.objectContaining({ name: 'xhs.check_login_status' }),
      ]),
    });
  });

  it.each([
    { args: ['xhs', '--no-oauht'], unexpected: '--no-oauht' },
    { args: ['xhs', 'extra-server'], unexpected: 'extra-server' },
    { args: ['--xhs'], unexpected: '--xhs' },
  ])('rejects unexpected list argument $unexpected before contacting the server', async ({ args, unexpected }) => {
    const previousRequests = mcpRequests;
    await expect(runCli(['list', ...args, '--json'], configuredPath)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(`Unexpected list argument '${unexpected}'.`),
    });
    expect(mcpRequests).toBe(previousRequests);
  });

  it(
    'routes configured and ad-hoc HTTP selectors to the intended literal tool names',
    async () => {
      const cases: Array<{ args: string[]; configPath: string; expectedTool: string }> = [
        {
          args: ['call', 'xhs.check_login_status', '--output', 'json'],
          configPath: configuredPath,
          expectedTool: 'check_login_status',
        },
        {
          args: ['call', 'xhs.check_login_status', '--http-url', baseUrl.href, '--allow-http', '--output', 'json'],
          configPath: configuredPath,
          expectedTool: 'check_login_status',
        },
        {
          args: ['call', 'xhs.check_login_status', '--http-url', baseUrl.href, '--allow-http', '--output', 'json'],
          configPath: emptyPath,
          expectedTool: 'check_login_status',
        },
        {
          args: [
            'call',
            'xhs.check_login_status',
            '--http-url',
            baseUrl.href,
            '--allow-http',
            '--name',
            'xhs',
            '--output',
            'json',
          ],
          configPath: emptyPath,
          expectedTool: 'check_login_status',
        },
        {
          args: [
            'call',
            'xhs.selector_tool',
            '--http-url',
            baseUrl.href,
            '--allow-http',
            '--tool',
            'check_login_status',
            '--output',
            'json',
          ],
          configPath: emptyPath,
          expectedTool: 'check_login_status',
        },
        {
          args: [
            'call',
            '--http-url',
            baseUrl.href,
            '--allow-http',
            '--name',
            'xhs',
            '--tool',
            'xhs.check_login_status',
            '--output',
            'json',
          ],
          configPath: emptyPath,
          expectedTool: 'xhs.check_login_status',
        },
      ];

      for (const testCase of cases) {
        const result = await runCli(testCase.args, testCase.configPath);
        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout)).toEqual({ loggedIn: true, observedTool: testCase.expectedTool });
      }

      expect(observedToolNames).toEqual(cases.map((testCase) => testCase.expectedTool));
    },
    budget(30_000)
  );
});
