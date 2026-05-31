import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it } from 'vitest';
import { createRuntime, MCPORTER_VERSION } from '../src/runtime.js';
import { RecordTransport, type RecordedMessage } from '../src/runtime/record-transport.js';
import { ReplayTransport } from '../src/runtime/replay-transport.js';

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

  it('exposes wrapped stdio process metadata for cleanup helpers', async () => {
    const child = { pid: 12345 } as unknown as import('node:child_process').ChildProcess;
    const inner = new StubTransport() as StubTransport & {
      pid: number;
      _process: import('node:child_process').ChildProcess;
    };
    inner.pid = 12345;
    inner._process = child;

    const transport = new RecordTransport({
      inner,
      recordPath: await tempRecordingPath(),
      server: 'linear',
    });

    expect(transport.pid).toBe(12345);
    expect(transport._process).toBe(child);
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
