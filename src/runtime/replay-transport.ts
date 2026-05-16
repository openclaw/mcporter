import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { RecordedMessage } from './record-transport.js';

export interface ReplayTransportOptions {
  readonly recordPath: string;
  readonly server: string;
}

interface ExpectedSend {
  readonly method: string;
  readonly params?: unknown;
  readonly response?: JSONRPCMessage;
}

type JsonRpcRecord = Record<string, unknown>;

export class ReplayTransport implements Transport {
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];
  sessionId?: string;

  private readonly expectedSends: ExpectedSend[];

  constructor(private readonly opts: ReplayTransportOptions) {
    this.expectedSends = buildReplayQueue(readRecordedMessages(opts.recordPath), opts.server);
  }

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const request = requestDetails(message);
    if (!request) {
      return;
    }

    const expected = this.expectedSends[0];
    if (!expected || expected.method !== request.method || !isDeepStrictEqual(expected.params, request.params)) {
      throw new Error(formatReplayMismatch(this.opts.server, request, expected));
    }

    this.expectedSends.shift();
    if (expected.response) {
      queueMicrotask(() => this.onmessage?.(expected.response as JSONRPCMessage));
    }
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

function readRecordedMessages(recordPath: string): RecordedMessage[] {
  try {
    const contents = fs.readFileSync(recordPath, 'utf8');
    return contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line, index) => {
        try {
          return JSON.parse(line) as RecordedMessage;
        } catch (error) {
          throw new Error(
            `Invalid JSON on recording line ${index + 1} in ${recordPath}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { cause: error }
          );
        }
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Replay recording not found: ${recordPath}`, { cause: error });
    }
    throw error;
  }
}

function buildReplayQueue(messages: RecordedMessage[], server: string): ExpectedSend[] {
  const pendingRequests = new Map<string, ExpectedSend>();
  const expected: ExpectedSend[] = [];

  for (const entry of messages) {
    if (entry._meta?.server !== server) {
      continue;
    }
    if (entry._meta.dir === 'lifecycle') {
      continue;
    }
    const clean = stripMeta(entry);
    if (entry._meta.dir === 'send') {
      const request = requestDetails(clean);
      if (!request) {
        continue;
      }
      const expectedSend: ExpectedSend = {
        method: request.method,
        params: request.params,
      };
      expected.push(expectedSend);
      if (request.id !== undefined) {
        pendingRequests.set(String(request.id), expectedSend);
      }
      continue;
    }
    if (entry._meta.dir === 'recv') {
      const responseId = responseIdOf(clean);
      if (responseId === undefined) {
        continue;
      }
      const pending = pendingRequests.get(String(responseId));
      if (pending) {
        pendingRequests.delete(String(responseId));
        (pending as { response?: JSONRPCMessage }).response = clean;
      }
    }
  }

  return expected;
}

function stripMeta(message: RecordedMessage): JSONRPCMessage {
  const { _meta, ...jsonrpc } = message;
  return jsonrpc as JSONRPCMessage;
}

function requestDetails(message: JSONRPCMessage):
  | {
      readonly id?: string | number;
      readonly method: string;
      readonly params?: unknown;
    }
  | undefined {
  const record = message as JsonRpcRecord;
  if (typeof record.method !== 'string') {
    return undefined;
  }
  if (record.method.startsWith('$transport/')) {
    return undefined;
  }
  return {
    id: typeof record.id === 'string' || typeof record.id === 'number' ? record.id : undefined,
    method: record.method,
    params: record.params,
  };
}

function responseIdOf(message: JSONRPCMessage): string | number | undefined {
  const id = (message as JsonRpcRecord).id;
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}

function formatReplayMismatch(
  server: string,
  request: { readonly method: string; readonly params?: unknown },
  expected: ExpectedSend | undefined
): string {
  const expectedText = expected
    ? `${expected.method} ${JSON.stringify(expected.params ?? {})}`
    : 'no remaining recorded recv';
  return `Replay mismatch for server '${server}': request ${request.method} ${JSON.stringify(
    request.params ?? {}
  )} did not match next expected recv ${expectedText}.`;
}
