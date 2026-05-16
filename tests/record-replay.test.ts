import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it } from 'vitest';
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

  it('replays matching requests by method and params', async () => {
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
        id: 1,
        result: { content: [{ type: 'text', text: 'recorded' }] },
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
