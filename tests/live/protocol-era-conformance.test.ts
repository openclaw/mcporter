import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '../../src/runtime.js';

// Cross-era conformance against real public MCP servers. Opt-in: these hit the
// network and depend on third-party uptime, so they never run in the default gate.
// Run with: MCP_LIVE_TESTS=1 pnpm exec vitest run tests/live/protocol-era-conformance.test.ts

const LIVE_FLAG = process.env.MCP_LIVE_TESTS === '1';

interface EraTarget {
  readonly name: string;
  readonly url: string;
  /** Protocol revision this server negotiated when the matrix was last refreshed. */
  readonly expectedVersion: string;
  readonly expectedEra: 'modern' | 'legacy';
}

interface EraCall {
  readonly server: string;
  readonly revision: string;
  readonly toolNames: readonly string[];
  readonly args: Record<string, unknown>;
}

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

// One or more representatives per protocol revision mcporter must interoperate with.
// Verified reachable 2026-08-02; see tests/live/README.md for the full survey.
const ERA_TARGETS: readonly EraTarget[] = [
  { name: 'javadocs', url: 'https://www.javadocs.dev/mcp', expectedVersion: '2026-07-28', expectedEra: 'modern' },
  { name: 'hf', url: 'https://huggingface.co/mcp', expectedVersion: '2026-07-28', expectedEra: 'modern' },
  { name: 'cfdocs', url: 'https://docs.mcp.cloudflare.com/mcp', expectedVersion: '2026-07-28', expectedEra: 'modern' },
  { name: 'context7', url: 'https://mcp.context7.com/mcp', expectedVersion: '2026-07-28', expectedEra: 'modern' },
  { name: 'mslearn', url: 'https://learn.microsoft.com/api/mcp', expectedVersion: '2025-06-18', expectedEra: 'legacy' },
  { name: 'gitmcp', url: 'https://gitmcp.io/docs', expectedVersion: '2025-03-26', expectedEra: 'legacy' },
];

const ERA_CALLS: readonly EraCall[] = [
  {
    server: 'javadocs',
    revision: '2026-07-28',
    toolNames: ['get_latest_version'],
    args: { groupId: 'com.google.guava', artifactId: 'guava' },
  },
  {
    server: 'context7',
    revision: '2026-07-28',
    toolNames: ['resolve-library-id'],
    args: { query: 'testing', libraryName: 'vitest' },
  },
  {
    server: 'mslearn',
    revision: '2025-06-18',
    toolNames: ['microsoft_docs_search'],
    args: { query: 'TypeScript Model Context Protocol SDK' },
  },
  {
    server: 'gitmcp',
    revision: '2025-03-26',
    toolNames: ['match_common_libs_owner_repo_mapping'],
    args: { library: 'react' },
  },
];

let configPath: string;
let runtime: Runtime;
let tempDir: string;

async function runCli(args: readonly string[]): Promise<CliResult> {
  return await new Promise<CliResult>((resolve) => {
    execFile(
      process.execPath,
      ['dist/cli.js', '--config', configPath, ...args],
      {
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          NO_COLOR: '1',
          MCPORTER_CONFIG: configPath,
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

beforeAll(async () => {
  if (!LIVE_FLAG) return;
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-live-era-'));
  configPath = path.join(tempDir, 'mcporter.json');
  const mcpServers: Record<string, { url: string; protocolVersion?: string }> = {};
  for (const target of ERA_TARGETS) mcpServers[target.name] = { url: target.url };
  mcpServers['javadocs-modern-pin'] = {
    url: 'https://www.javadocs.dev/mcp',
    protocolVersion: '2026-07-28',
  };
  mcpServers['mslearn-modern-pin'] = {
    url: 'https://learn.microsoft.com/api/mcp',
    protocolVersion: '2026-07-28',
  };
  await fs.writeFile(configPath, JSON.stringify({ mcpServers }, null, 2), 'utf8');
  runtime = await createRuntime({ configPath });
});

afterAll(async () => {
  await runtime?.close().catch(() => {});
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

describe.skipIf(!LIVE_FLAG)('live protocol-era conformance', () => {
  for (const target of ERA_TARGETS) {
    it(`negotiates ${target.expectedVersion} with ${target.name}`, async () => {
      // Regression: mcporter cannot connect or reports the wrong era. Vendor drift: the assertion names the
      // newly negotiated revision so the survey can be refreshed instead of presenting a transport crash.
      const result = await runCli(['list', target.name, '--json', '--verbose', '--no-oauth']);
      expect(result.exitCode, result.stderr || result.stdout).toBe(0);
      const payload = JSON.parse(result.stdout) as { protocolVersion?: string; era?: string; tools?: unknown[] };
      expect(payload.protocolVersion, `${target.name} changed its advertised protocol revision`).toBe(
        target.expectedVersion
      );
      expect(payload.era).toBe(target.expectedEra);
      expect(payload.tools).toBeInstanceOf(Array);
    }, 90_000);
  }

  for (const liveCall of ERA_CALLS) {
    it(`calls a real tool over ${liveCall.revision}`, async ({ skip }) => {
      // Regression: listing succeeds but mcporter cannot dispatch or decode the call result. Vendor drift:
      // a renamed tool or newly required auth skips this call while the separate negotiation test stays active.
      const tools = await runtime.listTools(liveCall.server, { includeSchema: true, disableOAuth: true });
      const tool = tools.find((entry) => liveCall.toolNames.includes(entry.name));
      if (!tool) {
        skip(`${liveCall.server} no longer advertises ${liveCall.toolNames.join(' or ')}`);
        return;
      }
      let result: unknown;
      try {
        result = await runtime.callTool(liveCall.server, tool.name, { args: liveCall.args, disableOAuth: true });
      } catch (error) {
        if (/\b(?:401|403|unauthori[sz]ed|auth required)\b/i.test(String(error))) {
          skip(`${liveCall.server} now requires authorization for ${tool.name}`);
          return;
        }
        throw error;
      }
      expectToolResultShape(result);
    }, 90_000);
  }

  it('honors an explicit modern pin against a modern server', async () => {
    // Regression: the pin is ignored or modern discovery cannot complete. Vendor drift: javadocs.dev stops
    // offering 2026-07-28 and the SDK's explicit pin error points directly at the changed server contract.
    const tools = await runtime.listTools('javadocs-modern-pin', { disableOAuth: true });
    expect(tools.length).toBeGreaterThan(0);
    await expect(runtime.getConnectionInfo?.('javadocs-modern-pin')).resolves.toEqual({
      protocolVersion: '2026-07-28',
      era: 'modern',
    });
  }, 90_000);

  it('preserves the SDK pin error against a legacy-only server', async () => {
    // Regression: auto fallback masks the pinned negotiation failure as an SSE error. Vendor drift: if Microsoft
    // Learn adopts 2026-07-28 this begins succeeding, clearly signaling that the survey target needs replacing.
    let failure: unknown;
    try {
      await runtime.listTools('mslearn-modern-pin', { disableOAuth: true });
    } catch (error) {
      failure = error;
    }
    expect(failure, 'Microsoft Learn unexpectedly accepted the modern pin').toBeDefined();
    const message = String(failure);
    expect(message).toMatch(/pinned protocol version 2026-07-28|pin mode/i);
    expect(message).not.toMatch(/SSE error/i);
    expect(failure).toMatchObject({ code: 'ERA_NEGOTIATION_FAILED' });
  }, 90_000);
});

function expectToolResultShape(result: unknown): void {
  expect(result).toBeTypeOf('object');
  expect(result).not.toBeNull();
  const content = (result as { content?: unknown }).content;
  expect(content).toBeInstanceOf(Array);
  expect((content as unknown[]).length).toBeGreaterThan(0);
  for (const item of content as Array<{ type?: unknown }>) {
    expect(item).toBeTypeOf('object');
    expect(item.type).toBeTypeOf('string');
  }
}
