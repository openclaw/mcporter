import { SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { DaemonBroker } from '../src/daemon/broker.js';
import { effectiveDefinition } from '../src/daemon/connection-identity.js';

interface FakeRuntime {
  close: ReturnType<typeof vi.fn>;
  call: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
}
const runtimes: FakeRuntime[] = [];
let nextCallError: Error | undefined;
vi.mock('../src/runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runtime.js')>()),
  createRuntime: vi.fn(async () => {
    const runtime: FakeRuntime = {
      close: vi.fn(async () => {}),
      call: vi.fn(async () => {
        const error = nextCallError;
        nextCallError = undefined;
        if (error) throw error;
        return { content: [] };
      }),
      connect: vi.fn(async () => ({ client: { getServerVersion: () => undefined }, transport: {} })),
    };
    runtimes.push(runtime);
    return { connect: runtime.connect, callTool: runtime.call, close: runtime.close };
  }),
}));

const remote: ServerDefinition = {
  name: 'remote',
  command: { kind: 'http', url: new URL('https://mcp.example.test/mcp') },
  lifecycle: { mode: 'keep-alive' },
};

async function caller(broker: DaemonBroker) {
  const definition = await effectiveDefinition(remote, { PATH: process.env.PATH });
  const handle = broker.register(JSON.parse(JSON.stringify({ definitions: [definition] })));
  return () =>
    broker.invoke({ id: 'call', method: 'callTool', params: { server: 'remote', tool: 'ping', args: {} }, ...handle });
}

function httpError(status: number, text: string) {
  return new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, `Error POSTing to endpoint: ${text}`, {
    status,
    statusText: '',
    text,
  });
}

afterEach(() => {
  runtimes.length = 0;
  nextCallError = undefined;
});

describe('daemon broker HTTP rejections', () => {
  it.each([
    [
      404,
      '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Session expired. Please send a new initialize request."}}',
    ],
    [401, '{"error":"invalid_token","error_description":"Invalid access token"}'],
  ])('reconnects on the next call after HTTP %i instead of reusing the dead transport', async (status, text) => {
    const broker = new DaemonBroker();
    const call = await caller(broker);
    await call();
    nextCallError = httpError(status, text);

    await expect(call()).rejects.toBeInstanceOf(SdkHttpError);
    expect(runtimes[0]!.call).toHaveBeenCalledTimes(2);

    await expect(call()).resolves.toEqual({ content: [] });
    expect(runtimes[0]!.close).toHaveBeenCalledTimes(1);
    expect(runtimes).toHaveLength(2);
    expect(runtimes[1]!.connect).toHaveBeenCalledTimes(1);
    expect(runtimes[0]!.call).toHaveBeenCalledTimes(2);
  });

  it('keeps the transport after a non-transport error', async () => {
    const broker = new DaemonBroker();
    const call = await caller(broker);
    await call();
    nextCallError = new Error('tool failed');

    await expect(call()).rejects.toThrow('tool failed');
    await expect(call()).resolves.toEqual({ content: [] });
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]!.close).not.toHaveBeenCalled();
  });
});
