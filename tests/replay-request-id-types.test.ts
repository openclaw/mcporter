import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client';
import { expect, it } from 'vitest';
import { RecordTransport } from '../src/runtime/record-transport.js';
import { ReplayTransport } from '../src/runtime/replay-transport.js';

it('keeps numeric and string request IDs distinct through recording and replay', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-rpc-id-types-'));
  const recordPath = path.join(dir, 'record.ndjson');
  const inner: Transport = {
    async start() {},
    async send() {},
    async close() {},
  };
  const recorder = new RecordTransport({ inner, recordPath, server: 'fixture' });
  try {
    await recorder.start();
    await recorder.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'numeric' } });
    await recorder.send({ jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'string' } });
    inner.onmessage?.({ jsonrpc: '2.0', id: '1', result: { marker: 'string-response' } });
    inner.onmessage?.({ jsonrpc: '2.0', id: 1, result: { marker: 'numeric-response' } });
    await recorder.close();

    const replay = new ReplayTransport({ recordPath, server: 'fixture' });
    const received: JSONRPCMessage[] = [];
    replay.onmessage = (message) => received.push(message);
    await replay.start();
    await replay.send({ jsonrpc: '2.0', id: 'active-numeric', method: 'tools/call', params: { name: 'numeric' } });
    await replay.send({ jsonrpc: '2.0', id: 'active-string', method: 'tools/call', params: { name: 'string' } });
    await replay.close();
    expect(received).toEqual([
      { jsonrpc: '2.0', id: 'active-numeric', result: { marker: 'numeric-response' } },
      { jsonrpc: '2.0', id: 'active-string', result: { marker: 'string-response' } },
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
