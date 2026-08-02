import { afterEach, describe, expect, it, vi } from 'vitest';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { createRuntime } from '../src/runtime.js';

describe('runtime callTool timeouts', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('forwards timeout into MCP client request options', async () => {
    const runtime = await createRuntime({ servers: [] });

    const callTool = vi.fn(
      async (_params, options?: { timeout?: number; resetTimeoutOnProgress?: boolean; maxTotalTimeout?: number }) => {
        // Simulate a successful response without timing out.
        expect(options?.timeout).toBe(456);
        expect(options?.resetTimeoutOnProgress).toBe(true);
        expect(options?.maxTotalTimeout).toBe(456);
        return { ok: true };
      }
    );

    type ClientContext = Awaited<ReturnType<typeof runtime.connect>>;
    const fakeContext = {
      client: { callTool },
      transport: { close: vi.fn().mockResolvedValue(undefined) },
      definition: {
        name: 'temp',
        description: 'test',
        command: { kind: 'stdio', command: 'node', args: [], cwd: process.cwd() },
        source: { kind: 'local', path: '<test>' },
      },
      oauthSession: undefined,
    } as unknown as ClientContext;
    vi.spyOn(runtime, 'connect').mockResolvedValue(fakeContext);

    const result = await runtime.callTool('temp', 'ping', { timeoutMs: 456 });
    expect(result).toEqual({ ok: true });
    expect(callTool).toHaveBeenCalledOnce();
  });

  it('turns unsupported MRTR input into a clear mcporter error', async () => {
    const runtime = await createRuntime({ servers: [] });
    const callTool = vi.fn(async () => {
      throw new SdkError(
        SdkErrorCode.CapabilityNotSupported,
        "Cannot fulfil input request 'question': no handler is registered for 'elicitation/create' on this client."
      );
    });
    const close = vi.fn().mockResolvedValue(undefined);
    type ClientContext = Awaited<ReturnType<typeof runtime.connect>>;
    vi.spyOn(runtime, 'connect').mockResolvedValue({
      client: { callTool },
      transport: { close },
      definition: {
        name: 'temp',
        command: { kind: 'stdio', command: 'node', args: [], cwd: process.cwd() },
      },
    } as unknown as ClientContext);

    await expect(runtime.callTool('temp', 'ask')).rejects.toThrow(
      'Tool requires interactive input (MRTR); mcporter does not support this yet — coming in a follow-up'
    );
    expect(close).not.toHaveBeenCalled();
  });

  it('rejects when a call exceeds the timeout and closes the server', async () => {
    vi.useFakeTimers();
    const runtime = await createRuntime({ servers: [] });
    const callTool = vi.fn(() => new Promise(() => {}));
    type ClientContext = Awaited<ReturnType<typeof runtime.connect>>;
    const transport = { close: vi.fn().mockResolvedValue(undefined) };
    const fakeContext = {
      client: { callTool },
      transport,
      definition: {
        name: 'temp',
        description: 'test',
        command: { kind: 'stdio', command: 'node', args: [], cwd: process.cwd() },
        source: { kind: 'local', path: '<test>' },
      },
      oauthSession: undefined,
    } as unknown as ClientContext;
    vi.spyOn(runtime, 'connect').mockResolvedValue(fakeContext);
    const cachedPromise = Promise.resolve(fakeContext);
    (
      runtime as unknown as {
        clients: Map<
          string,
          {
            server: string;
            promise: Promise<ClientContext>;
            allowCachedAuth: boolean | undefined;
            disableOAuth: boolean;
          }
        >;
      }
    ).clients.set('temp:test', {
      server: 'temp',
      promise: cachedPromise,
      allowCachedAuth: true,
      disableOAuth: false,
    });
    (
      runtime as unknown as {
        contextCacheKeys: WeakMap<ClientContext, string>;
      }
    ).contextCacheKeys.set(fakeContext, 'temp:test');
    (
      runtime as unknown as {
        contextCachePromises: WeakMap<ClientContext, Promise<ClientContext>>;
      }
    ).contextCachePromises.set(fakeContext, cachedPromise);
    const closeSpy = vi.spyOn(runtime, 'close').mockResolvedValue();

    const promise = runtime.callTool('temp', 'ping', { timeoutMs: 123 });
    const expectation = expect(promise).rejects.toThrow('Timeout');
    await vi.advanceTimersByTimeAsync(200);
    await expectation;
    expect(closeSpy).not.toHaveBeenCalled();
    expect(transport.close).toHaveBeenCalled();
  });
});
