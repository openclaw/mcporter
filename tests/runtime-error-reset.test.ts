import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntime } from '../src/runtime.js';

describe('runtime connection resets', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('closes cached connections after fatal MCP errors', async () => {
    const runtime = await createRuntime({ servers: [] });
    type ClientContext = Awaited<ReturnType<typeof runtime.connect>>;
    const rejected = new McpError(ErrorCode.ConnectionClosed, 'Connection closed');
    const transport = { close: vi.fn().mockResolvedValue(undefined) };
    const context = {
      client: {
        callTool: vi.fn().mockRejectedValue(rejected),
      },
      transport,
      definition: {
        name: 'temp',
        description: 'test',
        command: { kind: 'stdio', command: 'node', args: [], cwd: process.cwd() },
        source: { kind: 'local', path: '<test>' },
      },
      oauthSession: undefined,
    } as unknown as ClientContext;
    vi.spyOn(runtime, 'connect').mockResolvedValue(context);
    const promise = Promise.resolve(context);
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
      promise,
      allowCachedAuth: true,
      disableOAuth: false,
    });
    (
      runtime as unknown as {
        contextCacheKeys: WeakMap<ClientContext, string>;
        contextCachePromises: WeakMap<ClientContext, Promise<ClientContext>>;
      }
    ).contextCacheKeys.set(context, 'temp:test');
    (
      runtime as unknown as {
        contextCachePromises: WeakMap<ClientContext, Promise<ClientContext>>;
      }
    ).contextCachePromises.set(context, promise);
    const closeSpy = vi.spyOn(runtime, 'close').mockResolvedValue();

    await expect(runtime.callTool('temp', 'list_pages')).rejects.toThrow('Connection closed');
    expect(closeSpy).not.toHaveBeenCalled();
    expect(transport.close).toHaveBeenCalled();
  });

  it('keeps the connection open for user-facing InvalidParams errors', async () => {
    const runtime = await createRuntime({ servers: [] });
    type ClientContext = Awaited<ReturnType<typeof runtime.connect>>;
    const rejected = new McpError(ErrorCode.InvalidParams, 'Tool help not found');
    const transport = { close: vi.fn().mockResolvedValue(undefined) };
    const context = {
      client: {
        callTool: vi.fn().mockRejectedValue(rejected),
      },
      transport,
      definition: {
        name: 'temp',
        description: 'test',
        command: { kind: 'stdio', command: 'node', args: [], cwd: process.cwd() },
        source: { kind: 'local', path: '<test>' },
      },
      oauthSession: undefined,
    } as unknown as ClientContext;
    vi.spyOn(runtime, 'connect').mockResolvedValue(context);
    const promise = Promise.resolve(context);
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
      promise,
      allowCachedAuth: true,
      disableOAuth: false,
    });
    (
      runtime as unknown as {
        contextCacheKeys: WeakMap<ClientContext, string>;
      }
    ).contextCacheKeys.set(context, 'temp:test');
    (
      runtime as unknown as {
        contextCachePromises: WeakMap<ClientContext, Promise<ClientContext>>;
      }
    ).contextCachePromises.set(context, promise);
    const closeSpy = vi.spyOn(runtime, 'close').mockResolvedValue();

    await expect(runtime.callTool('temp', 'help')).rejects.toThrow('Tool help not found');
    expect(closeSpy).not.toHaveBeenCalled();
    expect(transport.close).not.toHaveBeenCalled();
  });

  it('does not wait for unrelated cached connections when resetting a failed context', async () => {
    const runtime = await createRuntime({ servers: [] });
    type ClientContext = Awaited<ReturnType<typeof runtime.connect>>;
    const rejected = new McpError(ErrorCode.ConnectionClosed, 'Connection closed');
    const transport = { close: vi.fn().mockResolvedValue(undefined) };
    const context = {
      client: {
        callTool: vi.fn().mockRejectedValue(rejected),
      },
      transport,
      definition: {
        name: 'temp',
        description: 'test',
        command: { kind: 'stdio', command: 'node', args: [], cwd: process.cwd() },
        source: { kind: 'local', path: '<test>' },
      },
      oauthSession: undefined,
    } as unknown as ClientContext;
    const unresolved = new Promise<ClientContext>(() => {});
    const failedPromise = Promise.resolve(context);
    const internals = runtime as unknown as {
      clients: Map<
        string,
        {
          server: string;
          promise: Promise<ClientContext>;
          allowCachedAuth: boolean | undefined;
          disableOAuth: boolean;
        }
      >;
      contextCacheKeys: WeakMap<ClientContext, string>;
      contextCachePromises: WeakMap<ClientContext, Promise<ClientContext>>;
    };
    internals.clients.set('temp:unrelated', {
      server: 'temp',
      promise: unresolved,
      allowCachedAuth: true,
      disableOAuth: false,
    });
    internals.clients.set('temp:failed', {
      server: 'temp',
      promise: failedPromise,
      allowCachedAuth: true,
      disableOAuth: true,
    });
    internals.contextCacheKeys.set(context, 'temp:failed');
    internals.contextCachePromises.set(context, failedPromise);
    vi.spyOn(runtime, 'connect').mockResolvedValue(context);

    await expect(runtime.callTool('temp', 'list_pages')).rejects.toThrow('Connection closed');
    expect(transport.close).toHaveBeenCalled();
    expect(internals.clients.has('temp:failed')).toBe(false);
    expect(internals.clients.has('temp:unrelated')).toBe(true);
  });

  it('leaves cached entries alone when an uncached list operation fails', async () => {
    const runtime = await createRuntime({ servers: [] });
    type ClientContext = Awaited<ReturnType<typeof runtime.connect>>;
    const rejected = new McpError(ErrorCode.ConnectionClosed, 'Connection closed');
    const cachedTransport = { close: vi.fn().mockResolvedValue(undefined) };
    const uncachedTransport = { close: vi.fn().mockResolvedValue(undefined) };
    const cachedContext = {
      client: {},
      transport: cachedTransport,
      definition: {
        name: 'temp',
        description: 'test',
        command: { kind: 'stdio', command: 'node', args: [], cwd: process.cwd() },
        source: { kind: 'local', path: '<test>' },
      },
      oauthSession: undefined,
    } as unknown as ClientContext;
    const uncachedContext = {
      client: {
        listTools: vi.fn().mockRejectedValue(rejected),
      },
      transport: uncachedTransport,
      definition: {
        name: 'temp',
        description: 'test',
        command: { kind: 'stdio', command: 'node', args: [], cwd: process.cwd() },
        source: { kind: 'local', path: '<test>' },
      },
      oauthSession: undefined,
    } as unknown as ClientContext;
    const internals = runtime as unknown as {
      clients: Map<
        string,
        {
          server: string;
          promise: Promise<ClientContext>;
          allowCachedAuth: boolean | undefined;
          disableOAuth: boolean;
        }
      >;
      contextCacheKeys: WeakMap<ClientContext, string>;
      contextCachePromises: WeakMap<ClientContext, Promise<ClientContext>>;
    };
    internals.clients.set('temp:cached', {
      server: 'temp',
      promise: Promise.resolve(cachedContext),
      allowCachedAuth: true,
      disableOAuth: false,
    });
    internals.contextCacheKeys.set(cachedContext, 'temp:cached');
    vi.spyOn(runtime, 'connect').mockResolvedValue(uncachedContext);

    await expect(runtime.listTools('temp', { autoAuthorize: false })).rejects.toThrow('Connection closed');
    expect(uncachedTransport.close).toHaveBeenCalled();
    expect(cachedTransport.close).not.toHaveBeenCalled();
    expect(internals.clients.has('temp:cached')).toBe(true);
  });

  it('does not evict a replacement while closing a failed stdio context', async () => {
    const runtime = await createRuntime({ servers: [] });
    type ClientContext = Awaited<ReturnType<typeof runtime.connect>>;
    const rejected = new McpError(ErrorCode.ConnectionClosed, 'Connection closed');
    let releaseClose!: () => void;
    const transport = {
      close: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseClose = resolve;
          })
      ),
    };
    const context = {
      client: {
        close: vi.fn().mockResolvedValue(undefined),
        callTool: vi.fn().mockRejectedValue(rejected),
      },
      transport,
      definition: {
        name: 'temp',
        description: 'test',
        command: { kind: 'stdio', command: 'node', args: [], cwd: process.cwd() },
        source: { kind: 'local', path: '<test>' },
      },
      oauthSession: undefined,
    } as unknown as ClientContext;
    const promise = Promise.resolve(context);
    const internals = runtime as unknown as {
      clients: Map<
        string,
        {
          server: string;
          promise: Promise<ClientContext>;
          allowCachedAuth: boolean | undefined;
          disableOAuth: boolean;
        }
      >;
      contextCacheKeys: WeakMap<ClientContext, string>;
      contextCachePromises: WeakMap<ClientContext, Promise<ClientContext>>;
    };
    internals.clients.set('temp:stdio', {
      server: 'temp',
      promise,
      allowCachedAuth: undefined,
      disableOAuth: false,
    });
    internals.contextCacheKeys.set(context, 'temp:stdio');
    internals.contextCachePromises.set(context, promise);
    vi.spyOn(runtime, 'connect').mockResolvedValue(context);

    const call = runtime.callTool('temp', 'list_pages');
    const expectation = expect(call).rejects.toThrow('Connection closed');
    await vi.waitFor(() => expect(transport.close).toHaveBeenCalled());
    const replacement = Promise.resolve({
      ...context,
      transport: { close: vi.fn().mockResolvedValue(undefined) },
    } as unknown as ClientContext);
    internals.clients.set('temp:stdio', {
      server: 'temp',
      promise: replacement,
      allowCachedAuth: true,
      disableOAuth: true,
    });
    releaseClose();

    await expectation;
    expect(internals.clients.get('temp:stdio')?.promise).toBe(replacement);
  });
});
