import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function throwConnectBoom(): never {
  throw new Error('connect boom');
}

const mocks = vi.hoisted(() => {
  const connectMock = vi.fn();
  const listToolsMock = vi.fn();
  const callToolMock = vi.fn();
  const listResourcesMock = vi.fn();
  const readCachedAccessTokenMock = vi.fn();
  const clientInstances: unknown[] = [];
  const streamableInstances: unknown[] = [];
  const stdioInstances: unknown[] = [];

  class MockClient {
    constructor() {
      clientInstances.push(this);
    }

    async connect(transport: { start?: () => Promise<void> }) {
      connectMock(transport);
      if (typeof transport.start === 'function') {
        await transport.start();
      }
    }

    async close() {}

    async listTools(params: unknown) {
      return listToolsMock(params);
    }

    async callTool(params: unknown) {
      return callToolMock(params);
    }

    async listResources(params: unknown) {
      return listResourcesMock(params);
    }
  }

  class MockStreamableHTTPClientTransport {
    public start = vi.fn(async () => {});
    public close = vi.fn(async () => {});
    constructor(
      public url: URL,
      public options?: unknown
    ) {
      streamableInstances.push(this);
    }
  }

  class MockSSEClientTransport {
    public start = vi.fn(async () => {});
    public close = vi.fn(async () => {});
    constructor(
      public url: URL,
      public options?: unknown
    ) {}
  }

  class MockStdioClientTransport {
    public start = vi.fn(async () => {});
    public close = vi.fn(async () => {});
    constructor(public options: unknown) {
      stdioInstances.push(this);
    }
  }

  class MockUnauthorizedError extends Error {}

  return {
    connectMock,
    listToolsMock,
    callToolMock,
    listResourcesMock,
    readCachedAccessTokenMock,
    clientInstances,
    streamableInstances,
    stdioInstances,
    MockClient,
    MockStreamableHTTPClientTransport,
    MockSSEClientTransport,
    MockStdioClientTransport,
    MockUnauthorizedError,
  };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: mocks.MockClient,
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: mocks.MockStreamableHTTPClientTransport,
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: mocks.MockSSEClientTransport,
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: mocks.MockStdioClientTransport,
}));

vi.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  UnauthorizedError: mocks.MockUnauthorizedError,
}));

vi.mock('../src/oauth-persistence.js', () => ({
  readCachedAccessToken: mocks.readCachedAccessTokenMock,
}));

import { callOnce, createRuntime } from '../src/runtime.js';

describe('mcporter composability', () => {
  beforeEach(() => {
    mocks.connectMock.mockClear();
    mocks.listToolsMock.mockReset();
    mocks.callToolMock.mockReset();
    mocks.listResourcesMock.mockReset();
    mocks.readCachedAccessTokenMock.mockReset();
    mocks.clientInstances.length = 0;
    mocks.streamableInstances.length = 0;
    mocks.stdioInstances.length = 0;

    mocks.listToolsMock.mockResolvedValue({ tools: [] });
    mocks.callToolMock.mockResolvedValue({ ok: true });
    mocks.listResourcesMock.mockResolvedValue({ resources: [] });
    mocks.readCachedAccessTokenMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('reuses a single client connection for sequential calls', async () => {
    mocks.listToolsMock.mockResolvedValueOnce({
      tools: [{ name: 'echo', description: 'Echo tool' }],
    });
    mocks.callToolMock.mockResolvedValueOnce({ ok: 'first' }).mockResolvedValueOnce({ ok: 'second' });

    const previousToken = process.env.INLINE_TOKEN;
    process.env.INLINE_TOKEN = 'inline-test';

    const runtime = await createRuntime({
      servers: [
        {
          name: 'fake',
          description: 'Inline fake server',
          command: {
            kind: 'http' as const,
            url: new URL('https://example.com'),
            headers: { Authorization: `Bearer \${INLINE_TOKEN}` },
          },
        },
      ],
    });

    try {
      const tools = await runtime.listTools('fake');
      expect(tools).toEqual([
        {
          name: 'echo',
          description: 'Echo tool',
          inputSchema: undefined,
          outputSchema: undefined,
        },
      ]);
      expect(mocks.connectMock).toHaveBeenCalledTimes(1);
      expect(mocks.clientInstances).toHaveLength(1);
      const streamableTransport = mocks.streamableInstances[0] as {
        options?: {
          requestInit?: { headers?: Record<string, string> };
          authProvider?: unknown;
        };
        close: ReturnType<typeof vi.fn>;
      };
      expect(streamableTransport.options?.requestInit?.headers).toEqual({
        Authorization: 'Bearer inline-test',
      });

      const first = await runtime.callTool('fake', 'echo', {
        args: { text: 'hi' },
      });
      const second = await runtime.callTool('fake', 'echoSecond', {
        args: { count: 2 },
      });

      expect(first).toEqual({ ok: 'first' });
      expect(second).toEqual({ ok: 'second' });
      expect(mocks.callToolMock).toHaveBeenNthCalledWith(1, {
        name: 'echo',
        arguments: { text: 'hi' },
      });
      expect(mocks.callToolMock).toHaveBeenNthCalledWith(2, {
        name: 'echoSecond',
        arguments: { count: 2 },
      });
      expect(mocks.connectMock).toHaveBeenCalledTimes(1);
      expect(mocks.clientInstances).toHaveLength(1);
    } finally {
      await runtime.close();
      const streamableTransport = mocks.streamableInstances[0] as {
        close: ReturnType<typeof vi.fn>;
      };
      expect(mocks.streamableInstances).toHaveLength(1);
      expect(streamableTransport.close).toHaveBeenCalledTimes(1);
      if (previousToken === undefined) {
        delete process.env.INLINE_TOKEN;
      } else {
        process.env.INLINE_TOKEN = previousToken;
      }
    }
  });

  it('passes the current process env to stdio transports', async () => {
    vi.stubEnv('MCPORTER_STDIO_TEST', 'from-parent');
    const runtime = await createRuntime({
      servers: [
        {
          name: 'local',
          command: { kind: 'stdio', command: 'node', args: ['-v'], cwd: process.cwd() },
          source: { kind: 'local', path: '<test>' },
        },
      ],
    });
    await runtime.callTool('local', 'echo', {});
    const instance = mocks.stdioInstances.at(-1) as { options?: { env?: Record<string, string> } };
    expect(instance?.options?.env?.MCPORTER_STDIO_TEST).toBe('from-parent');
  });

  it('reuses stdio clients across auth-policy no-op differences', async () => {
    const runtime = await createRuntime({
      servers: [
        {
          name: 'local',
          command: { kind: 'stdio', command: 'node', args: ['-v'], cwd: process.cwd() },
          source: { kind: 'local', path: '<test>' },
        },
      ],
    });

    try {
      await runtime.connect('local');
      await runtime.callTool('local', 'echo', {});
      await runtime.connect('local', { disableOAuth: true });
      await runtime.listTools('local', { autoAuthorize: false });

      expect(mocks.stdioInstances).toHaveLength(1);
      expect(mocks.connectMock).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.close();
    }
  });

  it('overrides inherited env vars with server-specific values', async () => {
    vi.stubEnv('MCPORTER_STDIO_TEST', 'parent');
    const runtime = await createRuntime({
      servers: [
        {
          name: 'local',
          command: { kind: 'stdio', command: 'node', args: ['-v'], cwd: process.cwd() },
          env: { MCPORTER_STDIO_TEST: 'from-config', EXTRA: '42' },
          source: { kind: 'local', path: '<test>' },
        },
      ],
    });
    await runtime.callTool('local', 'echo', {});
    const instance = mocks.stdioInstances.at(-1) as { options?: { env?: Record<string, string> } };
    expect(instance?.options?.env?.MCPORTER_STDIO_TEST).toBe('from-config');
    expect(instance?.options?.env?.EXTRA).toBe('42');
  });

  it('applies cached auth for callTool connections', async () => {
    mocks.readCachedAccessTokenMock.mockResolvedValue('cached-token');
    const runtime = await createRuntime({
      servers: [
        {
          name: 'oauth',
          command: { kind: 'http' as const, url: new URL('https://oauth.example.com/mcp') },
        },
      ],
    });

    try {
      await runtime.callTool('oauth', 'ping');
      expect(mocks.readCachedAccessTokenMock).toHaveBeenCalledOnce();
      const streamableTransport = mocks.streamableInstances[0] as {
        options?: { requestInit?: { headers?: Record<string, string> } };
      };
      expect(streamableTransport.options?.requestInit?.headers).toEqual({
        Authorization: 'Bearer cached-token',
      });
    } finally {
      await runtime.close();
    }
  });

  it('preserves a disabled-OAuth cached connection through high-level helpers', async () => {
    const runtime = await createRuntime({
      servers: [
        {
          name: 'oauth',
          command: { kind: 'http' as const, url: new URL('https://oauth.example.com/mcp') },
        },
      ],
    });

    try {
      await runtime.connect('oauth', { disableOAuth: true, allowCachedAuth: true });
      await runtime.callTool('oauth', 'ping');
      await runtime.listTools('oauth');
      await runtime.listResources('oauth');

      expect(mocks.streamableInstances).toHaveLength(1);
      expect(mocks.connectMock).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.close();
    }
  });

  it('reuses active cached-auth connections for resource helpers with unspecified auth policy', async () => {
    const runtime = await createRuntime({
      servers: [
        {
          name: 'oauth',
          command: { kind: 'http' as const, url: new URL('https://oauth.example.com/mcp') },
        },
      ],
    });

    try {
      mocks.readCachedAccessTokenMock.mockResolvedValue('cached-token');
      await runtime.listTools('oauth');
      await runtime.listResources('oauth');

      expect(mocks.streamableInstances).toHaveLength(1);
      expect(mocks.connectMock).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.close();
    }
  });

  it('uses disableOAuth on cold callTool/listTools helper connections', async () => {
    const runtime = await createRuntime({
      servers: [
        {
          name: 'oauth',
          command: { kind: 'http' as const, url: new URL('https://oauth.example.com/mcp') },
          auth: 'oauth' as const,
        },
      ],
    });

    try {
      await runtime.callTool('oauth', 'ping', { disableOAuth: true });
      await runtime.listTools('oauth', { disableOAuth: true });

      expect(mocks.streamableInstances).toHaveLength(1);
      expect(mocks.connectMock).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.close();
    }
  });

  it('preserves cached-auth opt out for disabled-OAuth helper calls', async () => {
    const runtime = await createRuntime({
      servers: [
        {
          name: 'oauth',
          command: { kind: 'http' as const, url: new URL('https://oauth.example.com/mcp') },
          auth: 'oauth' as const,
        },
      ],
    });

    try {
      await runtime.connect('oauth', { disableOAuth: true, allowCachedAuth: false });
      await runtime.callTool('oauth', 'ping');
      await runtime.listTools('oauth');
      await runtime.listResources('oauth');

      expect(mocks.streamableInstances).toHaveLength(1);
      expect(mocks.readCachedAccessTokenMock).not.toHaveBeenCalled();
      await runtime.connect('oauth', { disableOAuth: true });
      expect(mocks.streamableInstances).toHaveLength(2);
    } finally {
      await runtime.close();
    }
  });

  it('keeps separate cached transports for OAuth posture changes', async () => {
    const runtime = await createRuntime({
      servers: [
        {
          name: 'oauth',
          command: { kind: 'http' as const, url: new URL('https://oauth.example.com/mcp') },
        },
      ],
    });

    try {
      const disabled = await runtime.connect('oauth', { disableOAuth: true });
      const disabledTransport = mocks.streamableInstances[0] as { close: ReturnType<typeof vi.fn> };
      const normal = await runtime.connect('oauth');

      expect(normal).not.toBe(disabled);
      expect(mocks.streamableInstances).toHaveLength(2);
      expect(disabledTransport.close).not.toHaveBeenCalled();
      await expect(runtime.connect('oauth', { disableOAuth: true })).resolves.toBe(disabled);
      await runtime.callTool('oauth', 'ping');
      expect(mocks.streamableInstances).toHaveLength(2);
    } finally {
      await runtime.close();
    }
  });

  it('restores the previous active cached variant when a new variant fails to connect', async () => {
    const runtime = await createRuntime({
      servers: [
        {
          name: 'oauth',
          command: { kind: 'http' as const, url: new URL('https://oauth.example.com/mcp') },
        },
      ],
    });

    try {
      await runtime.connect('oauth');
      await runtime.connect('oauth', { disableOAuth: true });
      const internals = runtime as unknown as {
        activeClientKeys: Map<string, string>;
        clients: Map<
          string,
          {
            allowCachedAuth: boolean | undefined;
            disableOAuth: boolean;
          }
        >;
      };
      const disabledKey = [...internals.clients.entries()].find(
        ([, cached]) => cached.disableOAuth && cached.allowCachedAuth === true
      )?.[0];

      mocks.connectMock.mockImplementationOnce(throwConnectBoom).mockImplementationOnce(throwConnectBoom);
      await expect(runtime.connect('oauth', { disableOAuth: true, allowCachedAuth: false })).rejects.toThrow(
        'connect boom'
      );

      expect(internals.activeClientKeys.get('oauth')).toBe(disabledKey);
    } finally {
      await runtime.close();
    }
  });

  it('serializes concurrent OAuth-capable HTTP variant setup', async () => {
    const runtime = await createRuntime({
      servers: [
        {
          name: 'oauth',
          command: { kind: 'http' as const, url: new URL('https://oauth.example.com/mcp') },
        },
      ],
    });
    let releaseFirst!: () => void;
    mocks.connectMock.mockImplementationOnce((transport: { start?: ReturnType<typeof vi.fn> }) => {
      transport.start?.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirst = resolve;
          })
      );
    });

    try {
      const first = runtime.connect('oauth', { allowCachedAuth: false });
      await vi.waitFor(() => expect(mocks.streamableInstances).toHaveLength(1));
      const second = runtime.connect('oauth', { allowCachedAuth: true });
      await Promise.resolve();

      expect(mocks.streamableInstances).toHaveLength(1);
      releaseFirst();
      await first;
      await second;
      expect(mocks.streamableInstances).toHaveLength(2);
    } finally {
      await runtime.close();
    }
  });

  it('does not create a new OAuth-capable variant after close interrupts retirement', async () => {
    const runtime = await createRuntime({
      servers: [
        {
          name: 'oauth',
          command: { kind: 'http' as const, url: new URL('https://oauth.example.com/mcp') },
        },
      ],
    });
    await runtime.connect('oauth', { allowCachedAuth: false });
    let releaseClose!: () => void;
    const firstClient = mocks.clientInstances[0] as { close: () => Promise<void> };
    firstClient.close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseClose = resolve;
        })
    );

    const replacement = runtime.connect('oauth', { allowCachedAuth: true });
    const replacementExpectation = expect(replacement).rejects.toThrow('superseded');
    await vi.waitFor(() => expect(firstClient.close).toHaveBeenCalled());
    const closing = runtime.close('oauth');
    releaseClose();

    await Promise.all([replacementExpectation, closing]);
    expect(mocks.streamableInstances).toHaveLength(1);
  });

  it('releases serialized setup after conflicting-entry retirement fails', async () => {
    const runtime = await createRuntime({
      servers: [
        {
          name: 'oauth',
          command: { kind: 'http' as const, url: new URL('https://oauth.example.com/mcp') },
        },
      ],
    });
    type ClientContext = Awaited<ReturnType<typeof runtime.connect>>;
    const rejected = Promise.reject(new Error('retire boom')) as Promise<ClientContext>;
    void rejected.catch(() => {});
    (
      runtime as unknown as {
        clients: Map<
          string,
          {
            server: string;
            promise: Promise<ClientContext>;
            contextPromise: Promise<ClientContext>;
            allowCachedAuth: boolean | undefined;
            disableOAuth: boolean;
          }
        >;
      }
    ).clients.set('oauth:conflict', {
      server: 'oauth',
      promise: rejected,
      contextPromise: rejected,
      allowCachedAuth: false,
      disableOAuth: false,
    });

    await expect(runtime.connect('oauth', { allowCachedAuth: true })).rejects.toThrow('retire boom');
    await expect(runtime.connect('oauth', { allowCachedAuth: true })).resolves.toBeDefined();
    await runtime.close();
  });

  it('cancels queued OAuth-capable setup when the server closes', async () => {
    const runtime = await createRuntime({
      servers: [
        {
          name: 'oauth',
          command: { kind: 'http' as const, url: new URL('https://oauth.example.com/mcp') },
        },
      ],
    });
    let releaseFirst!: () => void;
    mocks.connectMock.mockImplementationOnce((transport: { start?: ReturnType<typeof vi.fn> }) => {
      transport.start?.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirst = resolve;
          })
      );
    });

    const first = runtime.connect('oauth', { allowCachedAuth: false });
    const firstExpectation = expect(first).rejects.toThrow('superseded');
    await vi.waitFor(() => expect(mocks.streamableInstances).toHaveLength(1));
    const second = runtime.connect('oauth', { allowCachedAuth: true });
    const secondExpectation = expect(second).rejects.toThrow('superseded');
    await Promise.resolve();

    const closing = runtime.close('oauth');
    releaseFirst();
    await Promise.all([firstExpectation, secondExpectation, closing]);
    expect(mocks.streamableInstances).toHaveLength(1);
  });

  it('rejects an in-flight connection when its definition is replaced', async () => {
    const runtime = await createRuntime({
      servers: [
        {
          name: 'oauth',
          command: { kind: 'http' as const, url: new URL('https://old.example.com/mcp') },
        },
      ],
    });
    let releaseConnect!: () => void;
    mocks.connectMock.mockImplementationOnce((transport: { start?: ReturnType<typeof vi.fn> }) => {
      transport.start?.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseConnect = resolve;
          })
      );
    });

    const connecting = runtime.connect('oauth');
    const waiting = runtime.connect('oauth');
    const expectations = Promise.all([
      expect(connecting).rejects.toThrow('superseded'),
      expect(waiting).rejects.toThrow('superseded'),
    ]);
    await vi.waitFor(() => expect(mocks.streamableInstances).toHaveLength(1));
    runtime.registerDefinition(
      {
        name: 'oauth',
        command: { kind: 'http' as const, url: new URL('https://new.example.com/mcp') },
      },
      { overwrite: true }
    );
    releaseConnect();

    await expectations;
    const oldTransport = mocks.streamableInstances[0] as { close: ReturnType<typeof vi.fn> };
    await vi.waitFor(() => expect(oldTransport.close).toHaveBeenCalled());
  });

  it('forwards disableOAuth through callOnce', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-call-once-'));
    const configPath = path.join(tempDir, 'mcporter.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          oauth: {
            url: 'https://oauth.example.com/mcp',
            auth: 'oauth',
          },
        },
      }),
      'utf8'
    );

    try {
      await callOnce({
        server: 'oauth',
        toolName: 'ping',
        args: { ok: true },
        configPath,
        disableOAuth: true,
      });

      expect(mocks.callToolMock).toHaveBeenCalledWith({
        name: 'ping',
        arguments: { ok: true },
      });
      const streamableTransport = mocks.streamableInstances[0] as {
        options?: { authProvider?: unknown };
      };
      expect(streamableTransport.options?.authProvider).toBeUndefined();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reconnects when callTool needs cached auth after an uncached connection', async () => {
    const runtime = await createRuntime({
      servers: [
        {
          name: 'oauth',
          command: { kind: 'http' as const, url: new URL('https://oauth.example.com/mcp') },
        },
      ],
    });

    try {
      await runtime.listTools('oauth', { allowCachedAuth: false });
      expect(mocks.streamableInstances).toHaveLength(1);
      const firstTransport = mocks.streamableInstances[0] as { close: ReturnType<typeof vi.fn> };

      mocks.readCachedAccessTokenMock.mockResolvedValue('cached-token');
      await runtime.callTool('oauth', 'ping');

      expect(mocks.streamableInstances).toHaveLength(2);
      expect(firstTransport.close).toHaveBeenCalled();
      const streamableTransport = mocks.streamableInstances[1] as {
        options?: { requestInit?: { headers?: Record<string, string> } };
      };
      expect(streamableTransport.options?.requestInit?.headers).toEqual({
        Authorization: 'Bearer cached-token',
      });
    } finally {
      await runtime.close();
    }
  });
});

describe('stdio transport environment', () => {
  const previousEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...previousEnv };
    mocks.listToolsMock.mockReset();
    mocks.listToolsMock.mockResolvedValue({ tools: [] });
    mocks.clientInstances.length = 0;
    mocks.stdioInstances.length = 0;
  });

  afterEach(() => {
    process.env = { ...previousEnv };
    vi.clearAllMocks();
  });

  it('resolves env overrides before spawning stdio transport', async () => {
    process.env.OBSIDIAN_API_KEY = 'secret';
    delete process.env.OBSIDIAN_BASE_URL;

    const runtime = await createRuntime({
      servers: [
        {
          name: 'obsidian',
          description: 'Local Obsidian bridge',
          command: {
            kind: 'stdio' as const,
            command: 'node',
            args: ['--version'],
            cwd: '/repo',
          },
          env: {
            // Placeholders resolve against process env at runtime.
            OBSIDIAN_API_KEY: '${OBSIDIAN_API_KEY}',
            // Placeholders resolve against process env at runtime.
            OBSIDIAN_BASE_URL: '${OBSIDIAN_BASE_URL:-https://127.0.0.1:27124}',
            EMPTY_VAR: '',
          },
        },
      ],
    });

    try {
      await runtime.listTools('obsidian');
      expect(mocks.stdioInstances).toHaveLength(1);
      const transport = mocks.stdioInstances[0] as { options: { env?: Record<string, string> } };
      expect(transport.options.env).toEqual(
        expect.objectContaining({
          OBSIDIAN_API_KEY: 'secret',
          OBSIDIAN_BASE_URL: 'https://127.0.0.1:27124',
        })
      );
    } finally {
      await runtime.close().catch(() => {});
    }
  });
});
