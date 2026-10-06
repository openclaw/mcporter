import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { JSONRPCMessage } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { RecordTransport } from '../src/runtime/record-transport.js';
import { ReplayTransport } from '../src/runtime/replay-transport.js';

it('keeps numeric and string request IDs distinct through recording and replay', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-rpc-id-types-'));
  const recordPath = path.join(dir, 'record.ndjson');
  const inner = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/stdio-replay-id-server.mjs', import.meta.url))],
    stderr: 'pipe',
  });
  const recorder = new RecordTransport({ inner, recordPath, server: 'fixture' });
  try {
    const wireResponses: JSONRPCMessage[] = [];
    const initialized = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    recorder.onmessage = (message) => {
      if ('id' in message && message.id === 'initialize') {
        initialized.resolve();
        return;
      }
      wireResponses.push(message);
      if (wireResponses.length === 2) completed.resolve();
    };
    recorder.onerror = completed.reject;
    await recorder.start();
    const initializeParams = {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'replay-id-proof', version: '1.0.0' },
    };
    await recorder.send({ jsonrpc: '2.0', id: 'initialize', method: 'initialize', params: initializeParams });
    await initialized.promise;
    await recorder.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await recorder.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'numeric' } });
    await recorder.send({ jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'string' } });
    await completed.promise;
    expect(wireResponses.map((message) => 'id' in message && message.id)).toEqual(['1', 1]);
    await recorder.close();

    const replay = new ReplayTransport({ recordPath, server: 'fixture' });
    const received: JSONRPCMessage[] = [];
    replay.onmessage = (message) => received.push(message);
    await replay.start();
    await replay.send({ jsonrpc: '2.0', id: 'initialize', method: 'initialize', params: initializeParams });
    await replay.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    received.length = 0;
    await replay.send({ jsonrpc: '2.0', id: 'active-numeric', method: 'tools/call', params: { name: 'numeric' } });
    await replay.send({ jsonrpc: '2.0', id: 'active-string', method: 'tools/call', params: { name: 'string' } });
    await replay.close();
    expect(received).toEqual([
      { jsonrpc: '2.0', id: 'active-numeric', result: { content: [{ type: 'text', text: 'numeric-response' }] } },
      { jsonrpc: '2.0', id: 'active-string', result: { content: [{ type: 'text', text: 'string-response' }] } },
    ]);
  } finally {
    await recorder.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
