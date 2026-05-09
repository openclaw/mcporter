import { beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('daemon call fast path', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.DaemonClient.mockClear();
    mocks.createRuntime.mockClear();
    mocks.daemonCallTool.mockReset().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
    });
    mocks.daemonListTools.mockReset().mockResolvedValue([]);
    mocks.daemonCloseServer.mockReset().mockResolvedValue(undefined);
    process.exitCode = undefined;
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
});
