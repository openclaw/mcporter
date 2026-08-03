import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Client as ModernClient,
  StreamableHTTPClientTransport as ModernHttpTransport,
} from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyHttpTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { waitForChildExit } from '../../src/process-utils.js';
import { makeShortTempDir } from '../fixtures/test-helpers.js';

const LIVE_FLAG = process.env.MCP_LIVE_TESTS === '1';
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI_ENTRY = path.join(REPO_ROOT, 'dist', 'cli.js');

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface RunningBridge {
  readonly child: ChildProcess;
  readonly url: string;
  readonly stderr: () => string;
}

describe.skipIf(!LIVE_FLAG)('live multi-process workflows', () => {
  it('serves a live keep-alive upstream to modern and legacy clients', async ({ skip }) => {
    // Regression: serve cannot route a daemon-owned live transport, or one downstream era cannot list/call.
    // Vendor drift: a renamed upstream tool skips after both bridge negotiations and listings have succeeded.
    const tempDir = await makeShortTempDir('mcp-live-bridge');
    const configPath = path.join(tempDir, 'mcporter.json');
    const env = liveEnv(configPath, tempDir);
    let bridge: RunningBridge | undefined;
    let modernClient: ModernClient | undefined;
    let legacyClient: LegacyClient | undefined;
    try {
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            mcpServers: {
              javadocs: {
                url: 'https://www.javadocs.dev/mcp',
                lifecycle: { mode: 'keep-alive' },
              },
            },
          },
          null,
          2
        ),
        'utf8'
      );
      const daemon = await runCli(['daemon', 'start'], configPath, env);
      expect(daemon.exitCode, daemon.stderr || daemon.stdout).toBe(0);
      bridge = await startBridge(configPath, env);

      modernClient = new ModernClient(
        { name: 'mcporter-live-modern-bridge', version: '1.0.0' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } }
      );
      legacyClient = new LegacyClient({ name: 'mcporter-live-legacy-bridge', version: '1.0.0' });
      await modernClient.connect(new ModernHttpTransport(new URL(bridge.url)));
      await legacyClient.connect(new LegacyHttpTransport(new URL(bridge.url)));
      expect(modernClient.getProtocolEra()).toBe('modern');

      const modernTools = await modernClient.listTools();
      const legacyTools = await legacyClient.listTools();
      const modernNames = modernTools.tools.map((tool) => tool.name);
      const legacyNames = legacyTools.tools.map((tool) => tool.name);
      expect(modernNames.length).toBeGreaterThan(0);
      expect(legacyNames).toEqual(expect.arrayContaining(modernNames));
      const toolName = modernNames.find((name) => name === 'javadocs__get_latest_version');
      if (!toolName) {
        skip('javadocs.dev no longer advertises get_latest_version');
        return;
      }

      const args = { groupId: 'com.google.guava', artifactId: 'guava' };
      const modernResult = await modernClient.callTool({ name: toolName, arguments: args });
      const legacyResult = await legacyClient.callTool({ name: toolName, arguments: args });
      expectCallResultShape(modernResult);
      expectCallResultShape(legacyResult);
    } finally {
      await Promise.allSettled([modernClient?.close(), legacyClient?.close()]);
      await stopChild(bridge?.child);
      await runCli(['daemon', 'stop'], configPath, env).catch(() => undefined);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 90_000);

  it('records and replays a modern live session byte-for-byte', async () => {
    // Regression: modern probe frames are omitted/mismatched, replay touches the dead upstream, or output changes.
    // Vendor drift: only the recording phase can fail, clearly identifying the live endpoint rather than replay.
    const tempDir = await makeShortTempDir('mcp-live-record');
    const configPath = path.join(tempDir, 'mcporter.json');
    const sessionName = 'modern-live-roundtrip';
    const recordingPath = path.join(tempDir, '.mcporter', 'recordings', `${sessionName}.ndjson`);
    const env = {
      ...liveEnv(configPath, tempDir),
      HOME: tempDir,
      USERPROFILE: tempDir,
    };
    try {
      await writeRecordConfig(configPath, 'https://www.javadocs.dev/mcp');
      const args = [
        'call',
        'javadocs.get_latest_version',
        'groupId=com.google.guava',
        'artifactId=guava',
        '--output',
        'json',
      ];
      const recorded = await runCli(args, configPath, {
        ...env,
        MCPORTER_RECORD: sessionName,
        MCPORTER_RECORD_SERVER: 'javadocs',
      });
      expect(recorded.exitCode, recorded.stderr || recorded.stdout).toBe(0);
      const frames = (await fs.readFile(recordingPath, 'utf8'))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { method?: string; _meta?: { dir?: string } });
      expect(frames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: 'server/discover',
            _meta: expect.objectContaining({ dir: 'send' }),
          }),
        ])
      );

      // A dead URL proves replay is served entirely from the capture rather than accidentally reaching the vendor.
      await writeRecordConfig(configPath, 'http://127.0.0.1:1/mcp');
      const replayed = await runCli(args, configPath, {
        ...env,
        MCPORTER_REPLAY: sessionName,
        MCPORTER_REPLAY_SERVER: 'javadocs',
      });
      expect(replayed.exitCode, replayed.stderr || replayed.stdout).toBe(0);
      expect({ stdout: replayed.stdout, stderr: replayed.stderr }).toEqual({
        stdout: recorded.stdout,
        stderr: recorded.stderr,
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 90_000);
});

function liveEnv(configPath: string, tempDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    MCPORTER_CONFIG: configPath,
    MCPORTER_DAEMON_DIR: path.join(tempDir, 'daemon'),
    MCPORTER_NO_FORCE_EXIT: '1',
  };
}

async function writeRecordConfig(configPath: string, url: string): Promise<void> {
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: { javadocs: { url } } }, null, 2), 'utf8');
}

async function runCli(args: readonly string[], configPath: string, env: NodeJS.ProcessEnv): Promise<CliResult> {
  return await new Promise<CliResult>((resolve) => {
    execFile(
      process.execPath,
      [CLI_ENTRY, '--config', configPath, ...args],
      { cwd: REPO_ROOT, env, timeout: 75_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const exitCode = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
        resolve({ stdout, stderr, exitCode });
      }
    );
  });
}

async function startBridge(configPath: string, env: NodeJS.ProcessEnv): Promise<RunningBridge> {
  const child = spawn(process.execPath, [CLI_ENTRY, '--config', configPath, 'serve', '--http', '0'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.resume();
  child.stderr?.setEncoding('utf8');
  let captured = '';
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`mcporter serve did not become ready:\n${captured}`)), 20_000);
      child.stderr?.on('data', (chunk: string) => {
        captured += chunk;
        const match = captured.match(/bridge (http:\/\/127\.0\.0\.1:\d+\/mcp)/);
        if (!match?.[1]) return;
        clearTimeout(timer);
        resolve(match[1]);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`mcporter serve exited before ready (${code ?? signal}):\n${captured}`));
      });
    });
    return { child, url, stderr: () => captured };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  try {
    await waitForChildExit(child, 2_000);
  } catch {
    child.kill('SIGKILL');
    await waitForChildExit(child, 2_000).catch(() => {});
  }
}

function expectCallResultShape(result: unknown): void {
  expect(result).toBeTypeOf('object');
  expect(result).not.toBeNull();
  const content = (result as { content?: unknown }).content;
  expect(content).toBeInstanceOf(Array);
  expect((content as unknown[]).length).toBeGreaterThan(0);
  for (const item of content as Array<{ type?: unknown }>) expect(item.type).toBeTypeOf('string');
}
