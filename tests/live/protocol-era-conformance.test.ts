import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Cross-era conformance against real public MCP servers. Opt-in: these hit the
// network and depend on third-party uptime, so they never run in the default gate.
// Run with: MCP_LIVE_TESTS=1 pnpm exec vitest run tests/live/protocol-era-conformance.test.ts

const LIVE_FLAG = process.env.MCP_LIVE_TESTS === '1';
const execFileAsync = promisify(execFile);

interface EraTarget {
  readonly name: string;
  readonly url: string;
  /** Protocol revision this server negotiated when the matrix was last refreshed. */
  readonly expectedVersion: string;
  readonly expectedEra: 'modern' | 'legacy';
}

// One representative server per protocol revision mcporter must interoperate with.
// Verified reachable 2026-08-02; see tests/live/README.md for the full survey.
const ERA_TARGETS: readonly EraTarget[] = [
  { name: 'javadocs', url: 'https://www.javadocs.dev/mcp', expectedVersion: '2026-07-28', expectedEra: 'modern' },
  { name: 'hf', url: 'https://huggingface.co/mcp', expectedVersion: '2026-07-28', expectedEra: 'modern' },
  { name: 'cfdocs', url: 'https://docs.mcp.cloudflare.com/mcp', expectedVersion: '2026-07-28', expectedEra: 'modern' },
  { name: 'context7', url: 'https://mcp.context7.com/mcp', expectedVersion: '2025-11-25', expectedEra: 'legacy' },
  { name: 'mslearn', url: 'https://learn.microsoft.com/api/mcp', expectedVersion: '2025-06-18', expectedEra: 'legacy' },
  { name: 'gitmcp', url: 'https://gitmcp.io/docs', expectedVersion: '2025-03-26', expectedEra: 'legacy' },
];

let configPath: string;
let tempDir: string;

async function runCli(args: readonly string[]): Promise<string> {
  const result = await execFileAsync('node', ['dist/cli.js', ...args], {
    env: { ...process.env, MCPORTER_CONFIG: configPath },
    timeout: 60_000,
  }).catch((error: unknown) => {
    const failure = error as { stdout?: string; stderr?: string };
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  });
  return `${result.stdout}\n${result.stderr}`;
}

beforeAll(async () => {
  if (!LIVE_FLAG) return;
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-live-era-'));
  configPath = path.join(tempDir, 'mcporter.json');
  const mcpServers: Record<string, { url: string; protocolVersion?: string }> = {};
  for (const target of ERA_TARGETS) mcpServers[target.name] = { url: target.url };
  // Override coverage: pinning and forcing legacy must both be honored.
  mcpServers['hf-pinned'] = { url: 'https://huggingface.co/mcp', protocolVersion: '2026-07-28' };
  mcpServers['hf-legacy'] = { url: 'https://huggingface.co/mcp', protocolVersion: 'legacy' };
  await fs.writeFile(configPath, JSON.stringify({ mcpServers }, null, 2));
});

afterAll(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

describe.skipIf(!LIVE_FLAG)('live protocol-era conformance', () => {
  for (const target of ERA_TARGETS) {
    it(`negotiates ${target.expectedVersion} with ${target.name}`, async () => {
      const output = await runCli(['list', target.name, '--verbose']);
      // A third-party outage should read as a skip-worthy failure, not a silent pass.
      expect(output).toContain('Protocol:');
      expect(output).toContain(`${target.expectedVersion} (${target.expectedEra})`);
    }, 90_000);
  }

  it('honors an explicit modern pin', async () => {
    const output = await runCli(['list', 'hf-pinned', '--verbose']);
    expect(output).toContain('2026-07-28 (modern)');
  }, 90_000);

  it('honors an explicit legacy override against a modern server', async () => {
    const output = await runCli(['list', 'hf-legacy', '--verbose']);
    expect(output).toContain('(legacy)');
    expect(output).not.toContain('2026-07-28');
  }, 90_000);

  it('calls a tool on a modern (2026-07-28) server', async () => {
    const output = await runCli([
      'call',
      'javadocs.get_latest_version',
      'groupId=com.google.guava',
      'artifactId=guava',
    ]);
    // Guava publishes -jre/-android qualified versions; assert the shape, not a pinned value.
    expect(output).toMatch(/\d+\.\d+/);
  }, 90_000);

  it('calls a tool on a legacy server', async () => {
    const output = await runCli(['call', 'context7.resolve-library-id', 'query=testing', 'libraryName=vitest']);
    expect(output.toLowerCase()).toContain('vitest');
  }, 90_000);
});
