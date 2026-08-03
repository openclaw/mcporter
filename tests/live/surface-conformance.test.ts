import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '../../src/runtime.js';

const LIVE_FLAG = process.env.MCP_LIVE_TESTS === '1';

interface CapabilityTarget {
  readonly name: string;
  readonly url: string;
}

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const CAPABILITY_TARGETS: readonly CapabilityTarget[] = [
  { name: 'hf', url: 'https://huggingface.co/mcp' },
  { name: 'cfdocs', url: 'https://docs.mcp.cloudflare.com/mcp' },
  { name: 'exa', url: 'https://mcp.exa.ai/mcp' },
  { name: 'mslearn', url: 'https://learn.microsoft.com/api/mcp' },
];

let authConfigPath: string;
let runtime: Runtime;
let tempDir: string;

beforeAll(async () => {
  if (!LIVE_FLAG) return;
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-live-surface-'));
  authConfigPath = path.join(tempDir, 'mcporter.json');
  await fs.writeFile(
    authConfigPath,
    JSON.stringify(
      {
        mcpServers: {
          linear: { url: 'https://mcp.linear.app/mcp' },
          notion: { url: 'https://mcp.notion.com/mcp' },
        },
      },
      null,
      2
    ),
    'utf8'
  );
  runtime = await createRuntime({
    servers: [
      ...CAPABILITY_TARGETS.map((target) => ({
        name: target.name,
        command: { kind: 'http' as const, url: new URL(target.url) },
        source: { kind: 'local' as const, path: '<live-test>' },
      })),
      {
        name: 'spacemolt',
        command: { kind: 'http' as const, url: new URL('https://game.spacemolt.com/mcp') },
        source: { kind: 'local' as const, path: '<live-test>' },
      },
      {
        name: 'jina-sse',
        command: { kind: 'http' as const, url: new URL('https://mcp.jina.ai/sse') },
        source: { kind: 'local' as const, path: '<live-test>' },
      },
    ],
  });
});

afterAll(async () => {
  await runtime?.close().catch(() => {});
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

describe.skipIf(!LIVE_FLAG)('live MCP surface conformance', () => {
  for (const target of CAPABILITY_TARGETS) {
    it(`enumerates advertised resources and prompts on ${target.name}`, async ({ skip }) => {
      // Regression: an advertised capability cannot be listed/read through mcporter. Vendor drift: disappearing
      // capabilities skip cleanly, while newly empty lists remain valid and newly added resources are read.
      const context = await runtime.connect(target.name, { disableOAuth: true });
      const capabilities = context.client.getServerCapabilities();
      const advertisesResources = capabilities?.resources !== undefined;
      const advertisesPrompts = capabilities?.prompts !== undefined;
      if (!advertisesResources && !advertisesPrompts) {
        skip(`${target.name} no longer advertises resources or prompts`);
        return;
      }

      if (advertisesResources) {
        const listed = (await runtime.listResources(target.name, { disableOAuth: true })) as {
          resources?: Array<{ uri?: unknown }>;
        };
        expect(listed.resources).toBeInstanceOf(Array);
        const first = listed.resources?.[0];
        if (first) {
          expect(first.uri).toBeTypeOf('string');
          const read = (await runtime.readResource(target.name, String(first.uri), { disableOAuth: true })) as {
            contents?: Array<{ uri?: unknown; text?: unknown; blob?: unknown }>;
          };
          expect(read.contents).toBeInstanceOf(Array);
          expect(read.contents?.length).toBeGreaterThan(0);
          for (const content of read.contents ?? []) {
            expect(content.uri).toBeTypeOf('string');
            expect(content.text !== undefined || content.blob !== undefined).toBe(true);
          }
        }
      }

      if (advertisesPrompts) {
        const listed = await context.client.listPrompts();
        expect(listed.prompts).toBeInstanceOf(Array);
        for (const prompt of listed.prompts) expect(prompt.name).toBeTypeOf('string');
      }
    }, 90_000);
  }

  it("aggregates SpaceMolt's duplicate-heavy large tool surface", async () => {
    // Regression: duplicate-name validation aborts tools/list or pagination truncates the surface. Vendor drift:
    // a changed count is accepted as long as the public server still supplies a genuinely large distinct set.
    const tools = await runtime.listTools('spacemolt', { includeSchema: true, disableOAuth: true });
    expect(tools.length).toBeGreaterThan(200);
    expect(new Set(tools.map((tool) => tool.name)).size).toBeGreaterThan(200);
    for (const tool of tools) expect(tool.name).toBeTypeOf('string');
  }, 90_000);

  it("lists and calls through Jina's SSE-only endpoint", async ({ skip }) => {
    // Regression: Streamable HTTP failure no longer falls back to standalone SSE, or SSE calls cannot return.
    // Vendor drift: a renamed read tool or newly required auth skips the call after transport listing succeeds.
    const tools = await runtime.listTools('jina-sse', { includeSchema: true, disableOAuth: true });
    expect(tools.length).toBeGreaterThan(0);
    await expect(runtime.getConnectionInfo?.('jina-sse')).resolves.toMatchObject({ era: 'legacy' });
    const readTool = tools.find((tool) => tool.name === 'read_url');
    if (!readTool) {
      skip('Jina no longer advertises read_url');
      return;
    }
    let result: unknown;
    try {
      result = await runtime.callTool('jina-sse', readTool.name, {
        args: { url: 'https://modelcontextprotocol.io/' },
        disableOAuth: true,
      });
    } catch (error) {
      if (/\b(?:401|403|unauthori[sz]ed|auth required)\b/i.test(String(error))) {
        skip('Jina now requires authorization for read_url');
        return;
      }
      throw error;
    }
    expectToolResultShape(result);
  }, 90_000);

  for (const server of ['linear', 'notion'] as const) {
    it(`reports actionable auth-required output for ${server}`, async () => {
      // Regression: a 401 crashes, launches interactive OAuth, or is mislabeled as an offline/SSE failure.
      // Vendor drift: a public no-auth response fails on the expected status and signals survey reclassification.
      const result = await runCli(['list', server, '--json', '--no-oauth']);
      expect(result.exitCode, result.stderr || result.stdout).not.toBe(0);
      const payload = JSON.parse(result.stdout) as {
        status?: string;
        error?: string;
        authCommand?: string;
        issue?: { kind?: string; statusCode?: number };
      };
      expect(payload).toMatchObject({
        status: 'auth',
        error: 'auth required',
        issue: { kind: 'auth', statusCode: 401 },
      });
      expect(payload.authCommand).toMatch(/^mcporter auth /);
    }, 90_000);
  }
});

async function runCli(args: readonly string[]): Promise<CliResult> {
  return await new Promise<CliResult>((resolve) => {
    execFile(
      process.execPath,
      ['dist/cli.js', '--config', authConfigPath, ...args],
      {
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          NO_COLOR: '1',
          MCPORTER_CONFIG: authConfigPath,
          MCPORTER_NO_FORCE_EXIT: '1',
        },
        timeout: 75_000,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const exitCode = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
        resolve({ stdout, stderr, exitCode });
      }
    );
  });
}

function expectToolResultShape(result: unknown): void {
  expect(result).toBeTypeOf('object');
  expect(result).not.toBeNull();
  const content = (result as { content?: unknown }).content;
  expect(content).toBeInstanceOf(Array);
  expect((content as unknown[]).length).toBeGreaterThan(0);
  for (const item of content as Array<{ type?: unknown }>) expect(item.type).toBeTypeOf('string');
}
