import { describe, expect, it, vi } from 'vitest';
import { createRuntime } from '../src/runtime.js';
import { getRuntimeConnectionCache } from './helpers/runtime-test-helpers.js';

type TestRuntime = Awaited<ReturnType<typeof createRuntime>>;
type ClientContext = Awaited<ReturnType<TestRuntime['connect']>>;
function fakeContext(instructions: string): ClientContext {
  return {
    client: {
      close: vi.fn().mockResolvedValue(undefined),
      getInstructions: vi.fn(() => instructions),
    },
    transport: { close: vi.fn().mockResolvedValue(undefined) },
    definition: {
      name: 'temp',
      description: 'test',
      command: { kind: 'stdio', command: 'node', args: [], cwd: process.cwd() },
      source: { kind: 'local', path: '<test>' },
    },
    oauthSession: undefined,
  } as unknown as ClientContext;
}

describe('runtime cache entries', () => {
  it('returns connection metadata from the active entry and tolerates rejected cached contexts', async () => {
    const runtime = await createRuntime({ servers: [] });
    const cache = getRuntimeConnectionCache(runtime);
    const context = fakeContext('metadata');
    Object.assign(context.client, {
      getNegotiatedProtocolVersion: () => '2026-07-28',
      getProtocolEra: () => 'modern',
    });
    cache.clients.set('temp:active', {
      server: 'temp',
      promise: Promise.resolve(context),
      allowCachedAuth: true,
      disableOAuth: false,
    });
    cache.activeClientKeys.set('temp', 'temp:active');

    await expect(runtime.getConnectionInfo?.(' temp ')).resolves.toEqual({
      protocolVersion: '2026-07-28',
      era: 'modern',
    });

    const rejected = Promise.reject(new Error('connection failed'));
    rejected.catch(() => {});
    cache.clients.set('broken:only', {
      server: 'broken',
      promise: rejected,
      allowCachedAuth: true,
      disableOAuth: false,
    });
    await expect(runtime.getInstructions?.('broken')).resolves.toBeUndefined();
    await expect(runtime.getConnectionInfo?.('broken')).resolves.toBeUndefined();
  });

  it('reports unknown servers and ignores resets without a failed context', async () => {
    const runtime = await createRuntime({ servers: [] });
    const cache = getRuntimeConnectionCache(runtime);

    await expect(runtime.connect('missing')).rejects.toThrow("Unknown MCP server 'missing'");
    await expect(cache.resetConnectionOnError('missing', new Error('Connection closed'))).resolves.toBeUndefined();
  });

  it('warns when superseded connection retirement fails', async () => {
    const warn = vi.fn();
    const runtime = await createRuntime({
      servers: [],
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });
    const cache = getRuntimeConnectionCache(runtime);
    const rejected = Promise.reject(new Error('connection setup failed'));
    rejected.catch(() => {});
    cache.clients.set('temp:old', {
      server: 'temp',
      promise: rejected,
      allowCachedAuth: true,
      disableOAuth: false,
    });

    cache.supersedeDefinition('temp', () => {});

    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Failed to close retired 'temp'"))
    );
  });

  it('makes connection setup release callbacks idempotent', async () => {
    const runtime = await createRuntime({ servers: [] });
    const cache = getRuntimeConnectionCache(runtime);
    const release = await (
      cache as unknown as { enterConnectionSetup(server: string): Promise<() => void> }
    ).enterConnectionSetup('temp');
    release();
    expect(() => release()).not.toThrow();
  });

  it('reads instructions from the active cached entry', async () => {
    const runtime = await createRuntime({ servers: [] });
    const older = fakeContext('older instructions');
    const active = fakeContext('active instructions');
    const cache = getRuntimeConnectionCache(runtime);

    cache.clients.set('temp:older', {
      server: 'temp',
      promise: Promise.resolve(older),
      allowCachedAuth: true,
      disableOAuth: false,
    });
    cache.clients.set('temp:active', {
      server: 'temp',
      promise: Promise.resolve(active),
      allowCachedAuth: true,
      disableOAuth: true,
    });
    cache.activeClientKeys.set('temp', 'temp:active');

    await expect(runtime.getInstructions?.('temp')).resolves.toBe('active instructions');
  });

  it('closes cached entries when replacing a server definition', async () => {
    const runtime = await createRuntime({ servers: [] });
    const context = fakeContext('old instructions');
    const transport = context.transport as unknown as { close: ReturnType<typeof vi.fn> };
    const cache = getRuntimeConnectionCache(runtime);

    cache.clients.set('temp:old', {
      server: 'temp',
      promise: Promise.resolve(context),
      allowCachedAuth: undefined,
      disableOAuth: false,
    });
    cache.contextCacheKeys.set(context, 'temp:old');

    runtime.registerDefinition(
      {
        name: 'temp',
        command: { kind: 'stdio', command: 'node', args: ['-v'], cwd: process.cwd() },
        source: { kind: 'local', path: '<test>' },
      },
      { overwrite: true }
    );

    await vi.waitFor(() => expect(transport.close).toHaveBeenCalled());
    expect(cache.clients.has('temp:old')).toBe(false);
  });

  it('removes cached entries before awaiting shutdown', async () => {
    const runtime = await createRuntime({ servers: [] });
    let releaseClose!: () => void;
    const clientClose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseClose = resolve;
        })
    );
    const context = {
      ...fakeContext('closing instructions'),
      client: {
        close: clientClose,
        getInstructions: vi.fn(() => 'closing instructions'),
      },
    } as unknown as ClientContext;
    const cache = getRuntimeConnectionCache(runtime);
    cache.clients.set('temp:closing', {
      server: 'temp',
      promise: Promise.resolve(context),
      allowCachedAuth: undefined,
      disableOAuth: false,
    });
    cache.activeClientKeys.set('temp', 'temp:closing');
    cache.contextCacheKeys.set(context, 'temp:closing');

    const closing = runtime.close('temp');

    expect(cache.clients.has('temp:closing')).toBe(false);
    expect(cache.activeClientKeys.has('temp')).toBe(false);
    await vi.waitFor(() => expect(clientClose).toHaveBeenCalled());
    releaseClose();
    await closing;
  });

  it('starts closing cached variants concurrently', async () => {
    const runtime = await createRuntime({ servers: [] });
    let resolvePending!: (context: ClientContext) => void;
    const pending = new Promise<ClientContext>((resolve) => {
      resolvePending = resolve;
    });
    const pendingContext = fakeContext('pending instructions');
    const readyContext = fakeContext('ready instructions');
    const readyTransport = readyContext.transport as unknown as { close: ReturnType<typeof vi.fn> };
    const cache = getRuntimeConnectionCache(runtime);
    cache.clients.set('temp:pending', {
      server: 'temp',
      promise: pending,
      allowCachedAuth: false,
      disableOAuth: false,
    });
    cache.clients.set('temp:ready', {
      server: 'temp',
      promise: Promise.resolve(readyContext),
      allowCachedAuth: true,
      disableOAuth: true,
    });

    const closing = runtime.close('temp');

    await vi.waitFor(() => expect(readyTransport.close).toHaveBeenCalled());
    resolvePending(pendingContext);
    await closing;
  });
});
