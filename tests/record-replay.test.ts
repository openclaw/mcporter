import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client as ModernClient } from '@modelcontextprotocol/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { createRuntime, MCPORTER_VERSION } from '../src/runtime.js';
import { RecordTransport, type RecordedMessage } from '../src/runtime/record-transport.js';
import { ReplayTransport } from '../src/runtime/replay-transport.js';

const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');
const MODERN_FIXTURE = fileURLToPath(new URL('./servers/modern/server.ts', import.meta.url));

class StubTransport implements Transport {
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];
  sent: JSONRPCMessage[] = [];

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    this.sent.push(message);
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

describe('record/replay transports', () => {
  it('records one NDJSON line per send and recv with metadata', async () => {
    const recordPath = await tempRecordingPath();
    const inner = new StubTransport();
    const transport = new RecordTransport({ inner, recordPath, server: 'linear' });

    await transport.start();
    await transport.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_issues', arguments: { limit: 1 } },
    });
    inner.onmessage?.({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'ok' }] },
    } as JSONRPCMessage);
    await transport.close();

    const entries = await readRecording(recordPath);
    const traffic = entries.filter((entry) => entry._meta?.dir === 'send' || entry._meta?.dir === 'recv');
    expect(traffic).toHaveLength(2);
    expect(traffic.map((entry) => entry._meta?.dir)).toEqual(['send', 'recv']);
    expect(traffic.every((entry) => entry._meta?.server === 'linear')).toBe(true);
  });

  it('starts each recording with a fresh session file', async () => {
    const recordPath = await tempRecordingPath();
    await fs.writeFile(
      recordPath,
      `${JSON.stringify(send('linear', 1, 'tools/call', { name: 'stale', arguments: {} }))}\n`,
      'utf8'
    );
    const inner = new StubTransport();
    const transport = new RecordTransport({ inner, recordPath, server: 'linear' });

    await transport.start();
    await transport.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'fresh', arguments: {} },
    });
    await transport.close();

    const entries = await readRecording(recordPath);
    expect(entries.some((entry) => (entry as { params?: { name?: string } }).params?.name === 'stale')).toBe(false);
    expect(entries.some((entry) => (entry as { params?: { name?: string } }).params?.name === 'fresh')).toBe(true);
  });

  it('creates recordings with private filesystem permissions', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const recordPath = await tempRecordingPath();
    const inner = new StubTransport();
    const transport = new RecordTransport({ inner, recordPath, server: 'linear' });

    await transport.start();
    await transport.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'secret_tool', arguments: { token: 'secret' } },
    });
    await transport.close();

    expect((await fs.stat(path.dirname(recordPath))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(recordPath)).mode & 0o777).toBe(0o600);
  });

  it('preserves wrapped stdio public metadata for in-place negotiation', async () => {
    const stderr = new EventTarget();
    const inner = new StubTransport() as StubTransport & {
      pid: number;
      stderr: EventTarget;
    };
    inner.pid = 12345;
    inner.stderr = stderr;

    const transport = new RecordTransport({
      inner,
      recordPath: await tempRecordingPath(),
      server: 'linear',
    });

    const stdioShaped = transport as RecordTransport & { pid: number; stderr: EventTarget };
    expect(stdioShaped.pid).toBe(12345);
    expect(stdioShaped.stderr).toBe(stderr);
  });

  it('mirrors the wrapped v2 transport capability surface and message metadata', async () => {
    const inner = new StubTransport() as StubTransport & {
      hasPerRequestStream: boolean;
      sessionId?: string;
      setProtocolVersion: (version: string) => void;
      setSupportedProtocolVersions: (versions: string[]) => void;
      finishAuth: (authorizationCode: string, iss?: string) => Promise<void>;
    };
    inner.hasPerRequestStream = true;
    inner.sessionId = 'initial-session';
    inner.setProtocolVersion = vi.fn();
    inner.setSupportedProtocolVersions = vi.fn();
    inner.finishAuth = vi.fn(async () => {});
    const transport = new RecordTransport({
      inner,
      recordPath: await tempRecordingPath(),
      server: 'linear',
    });
    const receivedExtra: unknown[] = [];
    transport.onmessage = (_message, extra) => receivedExtra.push(extra);

    expect(transport.hasPerRequestStream).toBe(true);
    expect(transport.sessionId).toBe('initial-session');
    inner.sessionId = 'updated-session';
    expect(transport.sessionId).toBe('updated-session');

    await transport.start();
    const extra = { request: new Request('https://example.test/mcp') };
    inner.onmessage?.({ jsonrpc: '2.0', method: 'notifications/test' } as JSONRPCMessage, extra as never);
    transport.setProtocolVersion('2026-07-28');
    transport.setSupportedProtocolVersions(['2026-07-28', '2025-11-25']);
    await transport.finishAuth?.('authorization-code', 'https://issuer.example');

    expect(receivedExtra).toEqual([extra]);
    expect(inner.setProtocolVersion).toHaveBeenCalledWith('2026-07-28');
    expect(inner.setSupportedProtocolVersions).toHaveBeenCalledWith(['2026-07-28', '2025-11-25']);
    expect(inner.finishAuth).toHaveBeenCalledWith('authorization-code', 'https://issuer.example');
    await transport.close();
  });

  it('keeps replay transport on a shared in-memory channel', async () => {
    const recordPath = await writeRecording([]);
    const transport = new ReplayTransport({ recordPath, server: 'linear' });

    expect(transport.hasPerRequestStream).toBeUndefined();
  });

  it('forwards the OAuth authorization-response issuer through the recording wrapper', async () => {
    const finishAuth = vi.fn(async (_code: string, _iss?: string) => {});
    const inner = Object.assign(new StubTransport(), { finishAuth });
    const transport = new RecordTransport({
      inner,
      recordPath: await tempRecordingPath(),
      server: 'linear',
    });

    await transport.finishAuth?.('authorization-code', 'https://issuer.example');

    expect(finishAuth).toHaveBeenCalledWith('authorization-code', 'https://issuer.example');
  });

  it('replays matching requests by method and params using the active request id', async () => {
    const recordPath = await writeRecording([
      send('linear', 1, 'tools/call', { name: 'list_issues', arguments: { limit: 1 } }),
      recv('linear', 1, { content: [{ type: 'text', text: 'recorded' }] }),
    ]);
    const transport = new ReplayTransport({ recordPath, server: 'linear' });
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (message) => received.push(message);

    await transport.start();
    await transport.send({
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'list_issues', arguments: { limit: 1 } },
    });
    await Promise.resolve();

    expect(received).toEqual([
      {
        jsonrpc: '2.0',
        id: 99,
        result: { content: [{ type: 'text', text: 'recorded' }] },
      },
    ]);
  });

  it('replays inbound progress notifications before the recorded response', async () => {
    const recordPath = await writeRecording([
      send('linear', 1, 'tools/call', { name: 'long_task', arguments: {} }),
      recvNotification('linear', 'notifications/progress', {
        progressToken: 'task-1',
        progress: 1,
        total: 1,
      }),
      recv('linear', 1, { content: [{ type: 'text', text: 'done' }] }),
    ]);
    const transport = new ReplayTransport({ recordPath, server: 'linear' });
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (message) => received.push(message);

    await transport.send({
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'long_task', arguments: {} },
    });
    await Promise.resolve();

    expect(received).toEqual([
      {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: 'task-1', progress: 1, total: 1 },
      },
      {
        jsonrpc: '2.0',
        id: 99,
        result: { content: [{ type: 'text', text: 'done' }] },
      },
    ]);
  });

  it('detects legacy recordings and matches server/discover probes by method', async () => {
    const legacyPath = await writeRecording([
      send('linear', 1, 'initialize', { protocolVersion: '2025-11-25' }),
      recv('linear', 1, { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'legacy' } }),
    ]);
    expect(new ReplayTransport({ recordPath: legacyPath, server: 'linear' }).requiresLegacyNegotiation).toBe(true);

    const modernPath = await writeRecording([
      send('linear', 1, 'server/discover', { requestedVersion: 'recorded' }),
      recv('linear', 1, { supportedVersions: ['2026-07-28'], capabilities: {} }),
    ]);
    const modern = new ReplayTransport({ recordPath: modernPath, server: 'linear' });
    const received: JSONRPCMessage[] = [];
    modern.onmessage = (message) => received.push(message);
    expect(modern.requiresLegacyNegotiation).toBe(false);
    await modern.send({
      jsonrpc: '2.0',
      id: 99,
      method: 'server/discover',
      params: { requestedVersion: 'different', _meta: { client: 'new' } },
    } as JSONRPCMessage);
    await Promise.resolve();
    expect(received).toEqual([
      { jsonrpc: '2.0', id: 99, result: { supportedVersions: ['2026-07-28'], capabilities: {} } },
    ]);
  });

  it('detects legacy recordings and replays modern operations across client version drift', async () => {
    const legacyPath = await writeRecording([
      send('linear', 1, 'initialize', { protocolVersion: '2025-11-25' }),
      recv('linear', 1, { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'legacy' } }),
    ]);
    expect(new ReplayTransport({ recordPath: legacyPath, server: 'linear' }).requiresLegacyNegotiation).toBe(true);

    const modernPath = await writeRecording([
      send('linear', 1, 'server/discover', {}),
      recv('linear', 1, {
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
      }),
      send('linear', 2, 'tools/list', {
        _meta: {
          'io.modelcontextprotocol/clientInfo': { name: 'mcporter', version: '0.12.4' },
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
        },
      }),
      recv('linear', 2, {
        resultType: 'complete',
        ttlMs: 1_000,
        cacheScope: 'private',
        tools: [{ name: 'recorded-tool', description: 'Replay fixture tool', inputSchema: { type: 'object' } }],
      }),
    ]);

    const modern = new ReplayTransport({ recordPath: modernPath, server: 'linear' });
    const replayClient = new ModernClient(
      { name: 'mcporter', version: '0.12.5' },
      {
        capabilities: { elicitation: { form: {}, url: {} } },
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      }
    );
    expect(modern.requiresLegacyNegotiation).toBe(false);
    await replayClient.connect(modern);
    expect((await replayClient.listTools()).tools.map((tool) => tool.name)).toContain('recorded-tool');
    await replayClient.close();
  });

  it('replays initialize recordings across protocol and client version drift', async () => {
    const recordPath = await writeRecording([
      send('linear', 1, 'initialize', {
        protocolVersion: '2099-01-01',
        capabilities: { sampling: {} },
        clientInfo: { name: 'mcporter', version: '0.1.0' },
      }),
      recv('linear', 1, {
        protocolVersion: '2099-01-01',
        capabilities: {},
        serverInfo: { name: 'recorded-server', version: '1.0.0' },
      }),
      notification('linear', 'notifications/initialized'),
    ]);
    const transport = new ReplayTransport({ recordPath, server: 'linear' });
    const client = new Client({ name: 'mcporter', version: MCPORTER_VERSION }, { capabilities: {} });

    await expect(client.connect(transport)).resolves.toBeUndefined();
    await expect(client.close()).resolves.toBeUndefined();
  });

  it('keeps user-supplied modern request metadata strict during replay', async () => {
    const recordPath = await writeRecording([
      send('linear', 1, 'tools/list', {
        _meta: {
          'io.modelcontextprotocol/clientInfo': { name: 'mcporter', version: '0.12.4' },
          traceId: 'recorded-trace',
        },
      }),
      recv('linear', 1, { tools: [] }),
    ]);
    const transport = new ReplayTransport({ recordPath, server: 'linear' });

    await expect(
      transport.send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/clientInfo': { name: 'mcporter', version: '0.12.5' },
            traceId: 'different-trace',
          },
        },
      } as JSONRPCMessage)
    ).rejects.toThrow('Replay mismatch');
  });

  it('skips recorded requests that never received a response', async () => {
    const recordPath = await writeRecording([
      send('linear', 1, 'initialize', { protocolVersion: '2025-11-25' }),
      send('linear', 2, 'initialize', { protocolVersion: '2025-11-25' }),
      recv('linear', 2, { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'ok' } }),
    ]);
    const transport = new ReplayTransport({ recordPath, server: 'linear' });
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (message) => received.push(message);

    await transport.send({
      jsonrpc: '2.0',
      id: 99,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    });
    await Promise.resolve();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ id: 99 });
  });

  it('keeps replay order by request send order when responses arrive out of order', async () => {
    const recordPath = await writeRecording([
      send('linear', 1, 'tools/call', { name: 'first', arguments: {} }),
      send('linear', 2, 'tools/call', { name: 'second', arguments: {} }),
      recv('linear', 2, { content: [{ type: 'text', text: 'second' }] }),
      recv('linear', 1, { content: [{ type: 'text', text: 'first' }] }),
    ]);
    const transport = new ReplayTransport({ recordPath, server: 'linear' });
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (message) => received.push(message);

    await transport.send({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'first', arguments: {} },
    });
    await transport.send({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'second', arguments: {} },
    });
    await Promise.resolve();

    expect(
      received.map(
        (message) => (message as { result?: { content?: Array<{ text?: string }> } }).result?.content?.[0]?.text
      )
    ).toEqual(['first', 'second']);
  });

  it('does not treat server-initiated requests as responses', async () => {
    const recordPath = await writeRecording([
      send('linear', 1, 'tools/call', { name: 'first', arguments: {} }),
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'sampling/createMessage',
        params: {},
        _meta: { dir: 'recv', server: 'linear', ts: '2026-01-01T00:00:00.000Z' },
      } satisfies RecordedMessage,
      recv('linear', 1, { content: [{ type: 'text', text: 'first' }] }),
    ]);
    const transport = new ReplayTransport({ recordPath, server: 'linear' });
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (message) => received.push(message);

    await transport.send({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'first', arguments: {} },
    });
    await Promise.resolve();

    expect(received).toEqual([
      {
        jsonrpc: '2.0',
        id: 9,
        result: { content: [{ type: 'text', text: 'first' }] },
      },
    ]);
  });

  it('throws a clear mismatch error naming the request and next expected recv', async () => {
    const recordPath = await writeRecording([
      send('linear', 1, 'tools/call', { name: 'list_issues', arguments: { limit: 1 } }),
      recv('linear', 1, { content: [] }),
    ]);
    const transport = new ReplayTransport({ recordPath, server: 'linear' });

    await expect(
      transport.send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'create_issue', arguments: { title: 'Bug' } },
      })
    ).rejects.toThrow(
      'Replay mismatch for server \'linear\': request tools/call {"name":"create_issue","arguments":{"title":"Bug"}} did not match next expected recv tools/call {"name":"list_issues","arguments":{"limit":1}}.'
    );
  });

  it('throws on close when recorded requests remain unreplayed', async () => {
    const recordPath = await writeRecording([
      send('linear', 1, 'tools/call', { name: 'first', arguments: {} }),
      recv('linear', 1, { content: [] }),
      send('linear', 2, 'tools/call', { name: 'second', arguments: {} }),
      recv('linear', 2, { content: [] }),
    ]);
    const transport = new ReplayTransport({ recordPath, server: 'linear' });

    await transport.send({
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'first', arguments: {} },
    });

    await expect(transport.close()).rejects.toThrow(
      'Replay ended for server \'linear\' with 1 recorded request still unused; next expected recv tools/call {"name":"second","arguments":{}}.'
    );
  });

  it('surfaces unused recorded requests through normal runtime close', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-replay-runtime-'));
    const configPath = path.join(tempHome, 'mcporter.json');
    const recordingPath = path.join(tempHome, '.mcporter', 'recordings', 'partial.ndjson');
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const originalReplay = process.env.MCPORTER_REPLAY;
    const originalReplayServer = process.env.MCPORTER_REPLAY_SERVER;

    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          linear: {
            description: 'Replay-only test server',
            command: process.execPath,
            args: ['-e', 'process.exit(1)'],
          },
        },
      }),
      'utf8'
    );
    await fs.mkdir(path.dirname(recordingPath), { recursive: true });
    await fs.writeFile(
      recordingPath,
      [
        send('linear', 0, 'initialize', {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'mcporter', version: MCPORTER_VERSION },
        }),
        recv('linear', 0, {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'replay-fixture', version: '1.0.0' },
        }),
        notification('linear', 'notifications/initialized'),
        send('linear', 1, 'tools/call', { name: 'first', arguments: {} }),
        recv('linear', 1, { content: [] }),
        send('linear', 2, 'tools/call', { name: 'second', arguments: {} }),
        recv('linear', 2, { content: [] }),
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
      'utf8'
    );

    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.MCPORTER_REPLAY = 'partial';
    process.env.MCPORTER_REPLAY_SERVER = 'linear';

    try {
      const runtime = await createRuntime({ configPath });
      await runtime.callTool('linear', 'first');

      await expect(runtime.close()).rejects.toThrow(
        'Replay ended for server \'linear\' with 1 recorded request still unused; next expected recv tools/call {"name":"second","arguments":{}}.'
      );
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
      if (originalReplay === undefined) {
        delete process.env.MCPORTER_REPLAY;
      } else {
        process.env.MCPORTER_REPLAY = originalReplay;
      }
      if (originalReplayServer === undefined) {
        delete process.env.MCPORTER_REPLAY_SERVER;
      } else {
        process.env.MCPORTER_REPLAY_SERVER = originalReplayServer;
      }
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  });

  it('replays an accepted modern MRTR recording with the caller elicitation handler', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-replay-mrtr-'));
    const session = 'accepted-mrtr';
    const definition: ServerDefinition = {
      name: 'modern',
      command: {
        kind: 'stdio',
        command: process.execPath,
        args: [TSX_CLI, MODERN_FIXTURE, '--stdio'],
        cwd: process.cwd(),
      },
      source: { kind: 'local', path: MODERN_FIXTURE },
    };
    const acceptingHandler = vi.fn(async () => ({
      action: 'accept' as const,
      content: { confirm: true },
    }));
    const originalEnvironment = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      MCPORTER_RECORD: process.env.MCPORTER_RECORD,
      MCPORTER_REPLAY: process.env.MCPORTER_REPLAY,
    };

    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.MCPORTER_RECORD = session;
    delete process.env.MCPORTER_REPLAY;

    try {
      const recordingRuntime = await createRuntime({ servers: [definition], elicitationHandler: acceptingHandler });
      try {
        await expect(
          recordingRuntime.callTool('modern', 'confirm_delete', { args: { target: 'recorded-item' } })
        ).resolves.toMatchObject({ content: [{ type: 'text', text: 'deleted recorded-item' }] });
      } finally {
        await recordingRuntime.close();
      }

      delete process.env.MCPORTER_RECORD;
      process.env.MCPORTER_REPLAY = session;
      const replayRuntime = await createRuntime({ servers: [definition], elicitationHandler: acceptingHandler });
      try {
        await expect(
          replayRuntime.callTool('modern', 'confirm_delete', { args: { target: 'recorded-item' } })
        ).resolves.toMatchObject({ content: [{ type: 'text', text: 'deleted recorded-item' }] });
      } finally {
        await replayRuntime.close();
      }

      expect(acceptingHandler).toHaveBeenCalledTimes(2);
    } finally {
      for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  }, 15_000);

  it('keeps multi-server streams separated by metadata server', async () => {
    const recordPath = await writeRecording([
      send('linear', 1, 'tools/call', { name: 'list_issues', arguments: { limit: 1 } }),
      recv('linear', 1, { content: [{ type: 'text', text: 'linear' }] }),
      send('github', 1, 'tools/call', { name: 'list_issues', arguments: { state: 'open' } }),
      recv('github', 1, { content: [{ type: 'text', text: 'github' }] }),
    ]);
    const linear = new ReplayTransport({ recordPath, server: 'linear' });
    const github = new ReplayTransport({ recordPath, server: 'github' });
    const linearMessages: JSONRPCMessage[] = [];
    const githubMessages: JSONRPCMessage[] = [];
    linear.onmessage = (message) => linearMessages.push(message);
    github.onmessage = (message) => githubMessages.push(message);

    await github.send({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'list_issues', arguments: { state: 'open' } },
    });
    await linear.send({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'list_issues', arguments: { limit: 1 } },
    });
    await Promise.resolve();

    expect(githubMessages[0]).toMatchObject({ result: { content: [{ text: 'github' }] } });
    expect(linearMessages[0]).toMatchObject({ result: { content: [{ text: 'linear' }] } });
  });

  it('ignores lifecycle events during replay', async () => {
    const recordPath = await writeRecording([
      lifecycle('linear', '$transport/start'),
      send('linear', undefined, 'notifications/initialized', {}),
      lifecycle('linear', '$transport/close'),
    ]);
    const transport = new ReplayTransport({ recordPath, server: 'linear' });

    await expect(
      transport.send({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      })
    ).resolves.toBeUndefined();
  });
});

async function tempRecordingPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-record-replay-'));
  return path.join(dir, 'session.ndjson');
}

async function writeRecording(entries: RecordedMessage[]): Promise<string> {
  const recordPath = await tempRecordingPath();
  await fs.writeFile(recordPath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
  return recordPath;
}

async function readRecording(recordPath: string): Promise<RecordedMessage[]> {
  const contents = await fs.readFile(recordPath, 'utf8');
  return contents
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as RecordedMessage);
}

function send(server: string, id: number | undefined, method: string, params: unknown): RecordedMessage {
  return {
    jsonrpc: '2.0',
    ...(id === undefined ? {} : { id }),
    method,
    params,
    _meta: { dir: 'send', server, ts: '2026-05-16T00:00:00.000Z' },
  } as RecordedMessage;
}

function recv(server: string, id: number, result: unknown): RecordedMessage {
  return {
    jsonrpc: '2.0',
    id,
    result,
    _meta: { dir: 'recv', server, ts: '2026-05-16T00:00:00.000Z' },
  } as RecordedMessage;
}

function lifecycle(server: string, method: string): RecordedMessage {
  return {
    jsonrpc: '2.0',
    method,
    _meta: { dir: 'lifecycle', server, ts: '2026-05-16T00:00:00.000Z' },
  } as RecordedMessage;
}

function notification(server: string, method: string): RecordedMessage {
  return {
    jsonrpc: '2.0',
    method,
    _meta: { dir: 'send', server, ts: '2026-05-16T00:00:00.000Z' },
  } as RecordedMessage;
}

function recvNotification(server: string, method: string, params: unknown): RecordedMessage {
  return {
    jsonrpc: '2.0',
    method,
    params,
    _meta: { dir: 'recv', server, ts: '2026-05-16T00:00:00.000Z' },
  } as RecordedMessage;
}
