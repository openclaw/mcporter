import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.MCPORTER_DISABLE_AUTORUN = '1';

const mocks = vi.hoisted(() => {
  const daemonCallTool = vi.fn();
  const daemonListTools = vi.fn();
  const daemonCloseServer = vi.fn();
  const DaemonClient = vi.fn(function MockDaemonClient() {
    return {
      callTool: daemonCallTool,
      listTools: daemonListTools,
      listResources: vi.fn(),
      readResource: vi.fn(),
      closeServer: daemonCloseServer,
    };
  });
  return {
    DaemonClient,
    createRuntime: vi.fn(),
    daemonCallTool,
    daemonListTools,
    daemonCloseServer,
  };
});

vi.mock('../src/daemon/client.js', () => ({
  DaemonClient: mocks.DaemonClient,
}));

vi.mock('../src/runtime.js', () => ({
  MCPORTER_VERSION: 'test',
  createRuntime: mocks.createRuntime,
}));

const originalEnv = { ...process.env };

describe('daemon call fast path', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    mocks.DaemonClient.mockClear();
    mocks.createRuntime.mockClear();
    mocks.daemonCallTool.mockReset().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
    });
    mocks.daemonListTools.mockReset().mockResolvedValue([]);
    mocks.daemonCloseServer.mockReset().mockResolvedValue(undefined);
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('routes explicit default keep-alive calls without building the full runtime', async () => {
    const { runCli } = await import('../src/cli.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runCli(['call', 'chrome-devtools.list_pages', '--output', 'json']);

    expect(mocks.createRuntime).not.toHaveBeenCalled();
    expect(mocks.DaemonClient).toHaveBeenCalledWith(
      expect.objectContaining({
        configExplicit: false,
      })
    );
    expect(mocks.daemonCallTool).toHaveBeenCalledWith({
      server: 'chrome-devtools',
      tool: 'list_pages',
      args: {},
      timeoutMs: expect.any(Number),
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"text": "ok"'));
  });

  it('also routes inferred call tokens through the daemon fast path', async () => {
    const { runCli } = await import('../src/cli.js');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runCli(['chrome-devtools.list_pages', '--output', 'json']);

    expect(mocks.createRuntime).not.toHaveBeenCalled();
    expect(mocks.daemonCallTool).toHaveBeenCalledWith(
      expect.objectContaining({
        server: 'chrome-devtools',
        tool: 'list_pages',
      })
    );
  });

  it.each(['MCPORTER_RECORD', 'MCPORTER_REPLAY'] as const)(
    'bypasses the daemon fast path while %s is active',
    async (modeEnv) => {
      process.env[modeEnv] = 'demo';
      mocks.createRuntime.mockRejectedValue(new Error('runtime path used'));
      const { runCli } = await import('../src/cli.js');

      await expect(runCli(['call', 'chrome-devtools.list_pages', '--output', 'json'])).rejects.toThrow(
        'runtime path used'
      );

      expect(mocks.createRuntime).toHaveBeenCalled();
      expect(mocks.daemonCallTool).not.toHaveBeenCalled();
    }
  );
});
