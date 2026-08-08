import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Client as ModernClient,
  StreamableHTTPClientTransport as ModernHttpTransport,
} from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyHttpTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { waitForChildExit } from '../src/process-utils.js';
import { createRuntime } from '../src/runtime.js';
import { makeShortTempDir } from './fixtures/test-helpers.js';
import { budget } from './helpers/timing.js';

// These tests spawn the real CLI repeatedly, and Windows pays a far higher
// process-startup cost: the same suite runs ~25s locally and ~100s on a Windows
// runner. The per-test budgets use the shared `budget()` helper, which scales
// by platform — they exist to catch hangs, not to measure machine speed.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_ENTRY = path.join(REPO_ROOT, 'dist', 'cli.js');
const LEGACY_SERVER = path.join(REPO_ROOT, 'tests', 'servers', 'legacy', 'server.ts');
const MODERN_SERVER = path.join(REPO_ROOT, 'tests', 'servers', 'modern', 'server.ts');
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');
const transports = ['stdio', 'http'] as const;
const fixtureKinds = ['legacy', 'modern'] as const;

type TransportKind = (typeof transports)[number];
type FixtureKind = (typeof fixtureKinds)[number];
type RawServerConfig = Record<string, unknown>;
type CliResult = { stdout: string; stderr: string; exitCode: number };

let legacyHttp: RunningFixture;
let modernHttp: RunningFixture;
let delayedLegacyHeadersProxy: RunningHttpProxy;
const spawnedChildren = new Set<ChildProcess>();
const DELAYED_LEGACY_SSE_HEADERS_MS = 500;

interface RunningFixture {
  child: ChildProcess;
  url: string;
  stderr: () => string;
}

interface RunningHttpProxy {
  url: string;
  events: () => readonly string[];
  close: () => Promise<void>;
}

beforeAll(async () => {
  await fs.access(CLI_ENTRY).catch(() => {
    throw new Error('dist/cli.js is missing; run `pnpm build` before invoking this e2e file directly.');
  });
  [legacyHttp, modernHttp] = await Promise.all([
    startHttpFixture('legacy', LEGACY_SERVER),
    startHttpFixture('modern', MODERN_SERVER),
  ]);
  delayedLegacyHeadersProxy = await startDelayedSseHeadersProxy(legacyHttp.url, DELAYED_LEGACY_SSE_HEADERS_MS);
}, budget(20_000));

afterAll(async () => {
  await delayedLegacyHeadersProxy.close();
  await Promise.allSettled([...spawnedChildren].map((child) => stopChild(child)));
});

describe.each(fixtureKinds)('%s fixture through the real CLI', (fixture) => {
  describe.each(transports)('%s', (transport) => {
    it(
      'lists, calls, fails, reports structured output, completes progress work, and reads resources',
      async () => {
        await withConfig({ fixture: configFor(fixture, transport) }, async (configPath, env) => {
          const listed = await runCli(['list', 'fixture', '--json', '--verbose', '--no-oauth'], configPath, env);
          expect(listed.exitCode, listed.stderr).toBe(0);
          const listPayload = parseJson<{
            tools: Array<{ name: string }>;
            protocolVersion?: string;
            era?: string;
          }>(listed.stdout);
          expect(listPayload.tools.map((tool) => tool.name)).toContain('echo');
          if (fixture === 'legacy') {
            expect(listPayload.tools.length).toBeGreaterThan(60);
            expect(listPayload.tools.at(-1)?.name).toBe('many_tools_60');
          } else {
            expect(listPayload.protocolVersion).toBe('2026-07-28');
            expect(listPayload.era).toBe('modern');
          }

          const echo = await runCli(['call', 'fixture.echo', 'text=fixture-echo', '--output', 'json'], configPath, env);
          expect(echo.exitCode, echo.stderr).toBe(0);
          expect(echo.stdout).toContain('fixture-echo');

          const add = await runCli(['call', 'fixture.add', 'a=19', 'b=23', '--output', 'json'], configPath, env);
          expect(add.exitCode, add.stderr).toBe(0);
          expect(parseJson<{ result: number }>(add.stdout)).toEqual({ result: 42 });

          const failed = await runCli(['call', 'fixture.fail', '--output', 'json'], configPath, env);
          expect(failed.exitCode).not.toBe(0);
          expect(`${failed.stdout}\n${failed.stderr}`).toContain(`${fixture} requested failure`);

          const longTask = await runCli(['call', 'fixture.long_task', 'steps=3', '--output', 'text'], configPath, env);
          expect(longTask.exitCode, longTask.stderr).toBe(0);
          expect(longTask.stdout).toContain(`${fixture} long task completed 3 steps`);

          const resources = await runCli(['resource', 'fixture', '--json'], configPath, env);
          expect(resources.exitCode, resources.stderr).toBe(0);
          const resourcePayload = parseJson<{ resources: Array<{ uri: string }> }>(resources.stdout);
          expect(resourcePayload.resources.map((resource) => resource.uri)).toContain(`fixture://${fixture}/welcome`);

          const welcome = await runCli(
            ['resource', 'fixture', `fixture://${fixture}/welcome`, '--output', 'text'],
            configPath,
            env
          );
          expect(welcome.exitCode, welcome.stderr).toBe(0);
          expect(welcome.stdout).toContain(`hello from the ${fixture} fixture`);

          if (fixture === 'legacy') {
            const binary = await runCli(
              ['resource', 'fixture', 'fixture://legacy/binary', '--output', 'json'],
              configPath,
              env
            );
            expect(binary.exitCode, binary.stderr).toBe(0);
            expect(binary.stdout).toContain('AAEC/f7/');
          }
        });
      },
      budget(30_000)
    );
  });
});

describe.each(transports)('legacy long-tail over %s', (transport) => {
  it(
    'declines headless elicitation with a hint and handles unsupported sampling',
    async () => {
      await withConfig({ fixture: configFor('legacy', transport) }, async (configPath, env) => {
        const elicited = await runCli(['call', 'fixture.elicit_name', '--output', 'text'], configPath, env);
        expect(elicited.exitCode).toBe(0);
        expect(elicited.stderr).toContain('Server requested interactive input; run mcporter in a terminal.');
        expect(elicited.stdout).toContain('elicitation decline');

        const sampled = await runCli(['call', 'fixture.sample_poem', '--output', 'text'], configPath, env);
        expect(sampled.exitCode).toBe(0);
        expect(sampled.stdout).toContain('sampling declined or unsupported by client');
      });
    },
    budget(20_000)
  );
});

it('handles legacy elicitation when standalone SSE headers arrive after the startup grace', async () => {
  await withConfig(
    {
      fixture: {
        ...configFor('legacy', 'http'),
        baseUrl: delayedLegacyHeadersProxy.url,
      },
    },
    async (configPath, env) => {
      const elicited = await runCli(['call', 'fixture.elicit_name', '--output', 'text'], configPath, env);
      expect(elicited.exitCode, elicited.stderr).toBe(0);
      expect(elicited.stderr).toContain('Server requested interactive input; run mcporter in a terminal.');
      expect(elicited.stdout).toContain('elicitation decline');
      expect(delayedLegacyHeadersProxy.events()).toEqual([
        'standalone GET arrived',
        'tool POST arrived while headers held',
        'standalone SSE headers released',
      ]);
    }
  );
});

describe.each(transports)('modern MRTR and identity over %s', (transport) => {
  it('declines cleanly through the CLI and reports per-request client identity', async () => {
    await withConfig({ fixture: configFor('modern', transport) }, async (configPath, env) => {
      const declined = await runCli(
        ['call', 'fixture.confirm_delete', 'target=old-record', '--output', 'text'],
        configPath,
        env
      );
      expect(declined.exitCode).toBe(0);
      expect(declined.stderr).toContain('Server requested interactive input; run mcporter in a terminal.');
      expect(declined.stdout).toContain('delete declined for old-record');

      const whoami = await runCli(['call', 'fixture.whoami', '--output', 'json'], configPath, env);
      expect(whoami.exitCode, whoami.stderr).toBe(0);
      expect(parseJson(whoami.stdout)).toMatchObject({
        clientInfo: { name: 'mcporter' },
        protocolVersion: '2026-07-28',
      });
    });
  });

  it('completes through createRuntime with a scripted elicitation handler', async () => {
    const definition = runtimeDefinition('modern', transport);
    const runtime = await createRuntime({
      servers: [definition],
      elicitationHandler: async (request, context) => {
        expect(request.params.message).toBe('Delete runtime-record?');
        expect(context).toEqual({ server: 'fixture' });
        return { action: 'accept', content: { confirm: true } };
      },
    });
    try {
      const result = (await runtime.callTool('fixture', 'confirm_delete', {
        args: { target: 'runtime-record' },
      })) as { content?: Array<{ type: string; text?: string }> };
      expect(result.content?.[0]?.text).toBe('deleted runtime-record');
    } finally {
      await runtime.close();
    }
  });
});

it(
  'streams modern tool-list changes and exposes cache metadata',
  async () => {
    const client = new ModernClient(
      { name: 'fixture-modern-subscription-client', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );
    let toolListChanges = 0;
    client.setNotificationHandler('notifications/tools/list_changed', () => {
      toolListChanges += 1;
    });

    try {
      await client.connect(new ModernHttpTransport(new URL(modernHttp.url)));
      const initial = await client.listTools(undefined, { cacheMode: 'refresh' });
      expect(initial).toMatchObject({ ttlMs: 1_000, cacheScope: 'private' });
      const initiallyEnabled = initial.tools.some((tool) => tool.name === 'runtime_tool');
      const subscription = await client.listen({ toolsListChanged: true });
      expect(subscription.honoredFilter).toEqual({ toolsListChanged: true });

      try {
        await client.callTool({ name: 'toggle_tool', arguments: {} });
        // Guards against a dropped list_changed notification; the poll fails if
        // the notification never arrives, so scale the wait for slow platforms.
        await expect.poll(() => toolListChanges, { timeout: budget(2_000) }).toBeGreaterThan(0);
        const refreshed = await client.listTools(undefined, { cacheMode: 'refresh' });
        expect(refreshed).toMatchObject({ ttlMs: 1_000, cacheScope: 'private' });
        expect(refreshed.tools.some((tool) => tool.name === 'runtime_tool')).toBe(!initiallyEnabled);
      } finally {
        await subscription.close();
      }
    } finally {
      await client.close();
    }
  },
  budget(20_000)
);

it(
  'bridges both fixtures to pinned modern and legacy HTTP clients through mcporter serve',
  async () => {
    await withConfig(
      {
        legacy: { ...configFor('legacy', 'http'), lifecycle: 'keep-alive' },
        modern: { ...configFor('modern', 'http'), lifecycle: 'keep-alive' },
      },
      async (configPath, env, tempDir) => {
        const daemon = await runCli(['daemon', 'start', '--log'], configPath, env);
        const daemonLogs = daemon.exitCode === 0 ? '' : await readDaemonLogs(path.join(tempDir, 'daemon'));
        expect(daemon.exitCode, `${daemon.stdout}\n${daemon.stderr}\n${daemonLogs}`).toBe(0);
        const bridge = await startBridge(configPath, env);
        const modernClient = new ModernClient(
          { name: 'fixture-modern-bridge-client', version: '1.0.0' },
          { versionNegotiation: { mode: { pin: '2026-07-28' } } }
        );
        const legacyClient = new LegacyClient({ name: 'fixture-legacy-bridge-client', version: '1.0.0' });
        try {
          await modernClient.connect(new ModernHttpTransport(new URL(bridge.url)));
          expect(modernClient.getProtocolEra()).toBe('modern');
          const modernTools = await modernClient.listTools();
          expect(modernTools.tools.map((tool) => tool.name)).toEqual(
            expect.arrayContaining(['legacy__echo', 'modern__echo'])
          );
          await expect(
            modernClient.callTool({ name: 'modern__echo', arguments: { text: 'modern bridge' } })
          ).resolves.toMatchObject({ content: [{ type: 'text', text: 'modern bridge' }] });

          await legacyClient.connect(new LegacyHttpTransport(new URL(bridge.url)));
          const legacyTools = await legacyClient.listTools();
          expect(legacyTools.tools.map((tool) => tool.name)).toEqual(
            expect.arrayContaining(['legacy__echo', 'modern__echo'])
          );
          await expect(
            legacyClient.callTool({ name: 'legacy__echo', arguments: { text: 'legacy bridge' } })
          ).resolves.toMatchObject({ content: [{ type: 'text', text: 'legacy bridge' }] });
        } finally {
          await Promise.allSettled([modernClient.close(), legacyClient.close()]);
          await stopChild(bridge.child);
          await runCli(['daemon', 'stop'], configPath, { ...env, MCPORTER_DAEMON_DIR: path.join(tempDir, 'daemon') });
        }
      }
    );
  },
  budget(40_000)
);

describe('fixture child lifecycle', () => {
  it('kills a fixture child when readiness times out', async () => {
    const tempDir = await makeShortTempDir('fixture-timeout');
    const serverPath = path.join(tempDir, 'never-ready.ts');
    await fs.writeFile(serverPath, 'setInterval(() => {}, 1_000);\n', 'utf8');
    const existing = new Set(spawnedChildren);

    try {
      await expect(startHttpFixture('modern', serverPath, 50)).rejects.toThrow('did not become ready');
      expect([...spawnedChildren].filter((child) => !existing.has(child))).toHaveLength(0);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps partially started fixture children registered for cleanup', async () => {
    const tempDir = await makeShortTempDir('fixture-partial');
    const waitingPath = path.join(tempDir, 'waiting.ts');
    const failingPath = path.join(tempDir, 'failing.ts');
    await fs.writeFile(waitingPath, 'setInterval(() => {}, 1_000);\n', 'utf8');
    await fs.writeFile(failingPath, 'process.exit(23);\n', 'utf8');
    const existing = new Set(spawnedChildren);

    try {
      await expect(
        Promise.all([startHttpFixture('modern', waitingPath, 10_000), startHttpFixture('legacy', failingPath, 10_000)])
      ).rejects.toThrow('exited before ready');
      const partialChildren = [...spawnedChildren].filter((child) => !existing.has(child));
      expect(partialChildren).toHaveLength(1);
      await Promise.all(partialChildren.map((child) => stopChild(child)));
      expect([...spawnedChildren].filter((child) => !existing.has(child))).toHaveLength(0);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

function configFor(fixture: FixtureKind, transport: TransportKind): RawServerConfig {
  if (transport === 'http') {
    return {
      description: `${fixture} committed fixture over HTTP`,
      baseUrl: fixture === 'legacy' ? legacyHttp.url : modernHttp.url,
      ...(fixture === 'legacy' ? { protocolVersion: 'legacy' } : {}),
    };
  }
  return {
    description: `${fixture} committed fixture over stdio`,
    command: process.execPath,
    args: [TSX_CLI, fixture === 'legacy' ? LEGACY_SERVER : MODERN_SERVER, '--stdio'],
    ...(fixture === 'legacy' ? { protocolVersion: 'legacy' } : {}),
  };
}

function runtimeDefinition(fixture: FixtureKind, transport: TransportKind): ServerDefinition {
  const base = {
    name: 'fixture',
    description: `${fixture} committed fixture`,
    source: { kind: 'local' as const, path: REPO_ROOT },
    ...(fixture === 'legacy' ? { protocolVersion: 'legacy' as const } : {}),
  };
  if (transport === 'http') {
    return {
      ...base,
      command: { kind: 'http', url: new URL(fixture === 'legacy' ? legacyHttp.url : modernHttp.url) },
    };
  }
  return {
    ...base,
    command: {
      kind: 'stdio',
      command: process.execPath,
      args: [TSX_CLI, fixture === 'legacy' ? LEGACY_SERVER : MODERN_SERVER, '--stdio'],
      cwd: REPO_ROOT,
    },
  };
}

async function withConfig<T>(
  servers: Record<string, RawServerConfig>,
  run: (configPath: string, env: NodeJS.ProcessEnv, tempDir: string) => Promise<T>
): Promise<T> {
  const tempDir = await makeShortTempDir('mcp-fixture');
  const configPath = path.join(tempDir, 'mcporter.json');
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: servers }, null, 2), 'utf8');
  const env = {
    ...process.env,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    MCPORTER_CONFIG: configPath,
    MCPORTER_DAEMON_DIR: path.join(tempDir, 'daemon'),
    MCPORTER_NO_FORCE_EXIT: '1',
  };
  try {
    return await run(configPath, env, tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function runCli(args: string[], configPath: string, env: NodeJS.ProcessEnv): Promise<CliResult> {
  return await new Promise<CliResult>((resolve) => {
    execFile(
      process.execPath,
      [CLI_ENTRY, '--config', configPath, ...args],
      { cwd: REPO_ROOT, env, timeout: budget(20_000), maxBuffer: 5 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
        resolve({ stdout, stderr, exitCode: code });
      }
    );
  });
}

function parseJson<T = Record<string, unknown>>(value: string): T {
  return JSON.parse(value.trim()) as T;
}

async function startHttpFixture(
  fixture: FixtureKind,
  serverPath: string,
  readyTimeoutMs = budget(10_000)
): Promise<RunningFixture> {
  const child = trackChild(
    spawn(process.execPath, [TSX_CLI, serverPath, '--http', '0'], {
      cwd: REPO_ROOT,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  );
  child.stdout?.resume();
  child.stderr?.setEncoding('utf8');
  let captured = '';
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${fixture} fixture did not become ready:\n${captured}`)),
        readyTimeoutMs
      );
      child.stderr?.on('data', (chunk: string) => {
        captured += chunk;
        const match = captured.match(/listening on (http:\/\/127\.0\.0\.1:\d+\/mcp)/);
        if (!match?.[1]) return;
        clearTimeout(timer);
        resolve(match[1]);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`${fixture} fixture exited before ready (${code ?? signal}):\n${captured}`));
      });
    });
    return { child, url, stderr: () => captured };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

async function startDelayedSseHeadersProxy(targetUrl: string, delayMs: number): Promise<RunningHttpProxy> {
  const target = new URL(targetUrl);
  const events: string[] = [];
  let headersReleased = false;
  const proxy = createServer((request, response) => {
    let requestBody = '';
    if (request.method === 'GET') {
      events.push('standalone GET arrived');
    } else if (request.method === 'POST') {
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        requestBody += chunk;
      });
      request.once('end', () => {
        const message = JSON.parse(requestBody) as { method?: string };
        if (message.method === 'tools/call') {
          events.push(
            headersReleased ? 'tool POST arrived after headers released' : 'tool POST arrived while headers held'
          );
        }
      });
    }
    const upstreamRequest = httpRequest(
      target,
      {
        method: request.method,
        headers: request.headers,
      },
      (upstreamResponse) => {
        const forwardResponse = () => {
          if (response.destroyed) {
            upstreamResponse.destroy();
            return;
          }
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        };
        if (request.method === 'GET') {
          setTimeout(() => {
            headersReleased = true;
            events.push('standalone SSE headers released');
            forwardResponse();
          }, delayMs);
        } else {
          forwardResponse();
        }
      }
    );
    upstreamRequest.on('error', (error) => {
      if (!response.headersSent) response.writeHead(502);
      response.end(error.message);
    });
    request.pipe(upstreamRequest);
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', resolve);
  });
  const address = proxy.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    events: () => events,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        proxy.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function startBridge(configPath: string, env: NodeJS.ProcessEnv): Promise<RunningFixture> {
  const child = trackChild(
    spawn(process.execPath, [CLI_ENTRY, '--config', configPath, 'serve', '--http', '0'], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  );
  child.stdout?.resume();
  child.stderr?.setEncoding('utf8');
  let captured = '';
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`mcporter serve did not become ready:\n${captured}`)),
        budget(15_000)
      );
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

function trackChild(child: ChildProcess): ChildProcess {
  spawnedChildren.add(child);
  child.once('exit', () => spawnedChildren.delete(child));
  return child;
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  try {
    await waitForChildExit(child, budget(2_000));
  } catch {
    child.kill('SIGKILL');
    await waitForChildExit(child, budget(2_000)).catch(() => {});
  }
}

async function readDaemonLogs(root: string): Promise<string> {
  const entries = await fs.readdir(path.join(root, 'daemon')).catch(() => []);
  const logs = await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.log'))
      .map((entry) => fs.readFile(path.join(root, 'daemon', entry), 'utf8'))
  );
  return logs.join('\n');
}
