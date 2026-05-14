import { beforeEach, describe, expect, it, vi } from 'vitest';

const closeMock = vi.fn();
const createRuntimeMock = vi.fn();
const createKeepAliveRuntimeMock = vi.fn();
const daemonClientInstance = { callTool: vi.fn(), listTools: vi.fn(), closeServer: vi.fn() };
const DaemonClientMock = vi.fn();
const serveStdioMock = vi.fn();
const serveHttpMock = vi.fn();
const definitions = [
  {
    name: 'alpha',
    command: { kind: 'http', url: new URL('https://alpha.example.com') },
    lifecycle: { mode: 'keep-alive' },
  },
];

vi.mock('../src/runtime.js', () => ({
  createRuntime: (...args: Parameters<typeof createRuntimeMock>) => createRuntimeMock(...args),
}));

vi.mock('../src/daemon/client.js', () => ({
  DaemonClient: DaemonClientMock,
}));

vi.mock('../src/daemon/runtime-wrapper.js', () => ({
  createKeepAliveRuntime: (...args: Parameters<typeof createKeepAliveRuntimeMock>) =>
    createKeepAliveRuntimeMock(...args),
}));

vi.mock('../src/serve.js', async () => {
  const actual = await vi.importActual<typeof import('../src/serve.js')>('../src/serve.js');
  return {
    ...actual,
    serveStdio: serveStdioMock,
    serveHttp: serveHttpMock,
  };
});

const { handleServeCli } = await import('../src/cli/serve-command.js');

describe('serve command runtime wiring', () => {
  beforeEach(() => {
    closeMock.mockReset().mockResolvedValue(undefined);
    createRuntimeMock.mockReset();
    createKeepAliveRuntimeMock.mockReset();
    DaemonClientMock.mockReset();
    serveStdioMock.mockReset().mockResolvedValue(undefined);
    serveHttpMock.mockReset();

    const baseRuntime = {
      getDefinitions: () => definitions,
      close: closeMock,
    };
    const wrappedRuntime = {
      listTools: vi.fn(),
      callTool: vi.fn(),
      close: closeMock,
    };
    createRuntimeMock.mockResolvedValue(baseRuntime);
    createKeepAliveRuntimeMock.mockReturnValue(wrappedRuntime);
    DaemonClientMock.mockImplementation(function MockDaemonClient() {
      return daemonClientInstance;
    });
  });

  it('wraps configured keep-alive servers with the daemon runtime before serving stdio', async () => {
    await handleServeCli(['--servers', 'alpha'], { configPath: '/tmp/config.json', configExplicit: true });

    expect(DaemonClientMock).toHaveBeenCalledWith({
      configPath: '/tmp/config.json',
      configExplicit: true,
      rootDir: undefined,
    });
    expect(createKeepAliveRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({ getDefinitions: expect.any(Function) }),
      {
        daemonClient: daemonClientInstance,
        keepAliveServers: new Set(['alpha']),
      }
    );
    expect(serveStdioMock).toHaveBeenCalledWith({
      runtime: createKeepAliveRuntimeMock.mock.results[0]?.value,
      definitions: expect.arrayContaining([expect.objectContaining({ name: 'alpha' })]),
      servers: ['alpha'],
    });
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('validates selected servers before starting the HTTP listener', async () => {
    await expect(
      handleServeCli(['--http', '3000', '--servers', 'missing'], {
        configPath: '/tmp/config.json',
        configExplicit: true,
      })
    ).rejects.toThrow("Server 'missing' is not configured for keep-alive");

    expect(serveHttpMock).not.toHaveBeenCalled();
    expect(createKeepAliveRuntimeMock).not.toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('passes host overrides into the HTTP bridge', async () => {
    const httpServer = {
      once: vi.fn(),
      address: () => ({ address: '0.0.0.0', port: 3000 }),
    };
    serveHttpMock.mockResolvedValue(httpServer);

    await handleServeCli(['--http', '3000', '--host', '0.0.0.0'], {
      configPath: '/tmp/config.json',
      configExplicit: true,
    });

    expect(serveHttpMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: '0.0.0.0',
        port: 3000,
        servers: ['alpha'],
      })
    );
    expect(httpServer.once).toHaveBeenCalledWith('close', expect.any(Function));
  });

  it('closes the runtime when HTTP startup fails', async () => {
    serveHttpMock.mockRejectedValue(new Error('listen failed'));

    await expect(
      handleServeCli(['--http', '3000'], {
        configPath: '/tmp/config.json',
        configExplicit: true,
      })
    ).rejects.toThrow('listen failed');

    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});
