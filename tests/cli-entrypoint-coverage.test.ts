import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/runtime.js';

process.env.MCPORTER_DISABLE_AUTORUN = '1';

const mocks = vi.hoisted(() => {
  const daemonCallTool = vi.fn().mockResolvedValue({ content: [] });
  const daemonCloseServer = vi.fn().mockResolvedValue(undefined);
  const daemonListResources = vi.fn().mockResolvedValue({ resources: [] });
  const daemonListTools = vi.fn().mockResolvedValue([]);
  const daemonReadResource = vi.fn().mockResolvedValue({ contents: [] });
  const DaemonClient = vi.fn(function MockDaemonClient() {
    return {
      callTool: daemonCallTool,
      closeServer: daemonCloseServer,
      listResources: daemonListResources,
      listTools: daemonListTools,
      readResource: daemonReadResource,
    };
  });
  return {
    close: vi.fn().mockResolvedValue(undefined),
    createRuntime: vi.fn(),
    daemonCallTool,
    daemonCloseServer,
    daemonListResources,
    daemonListTools,
    daemonReadResource,
    DaemonClient,
    handleAuth: vi.fn().mockResolvedValue(undefined),
    handleCall: vi.fn().mockResolvedValue(undefined),
    handleConfigCli: vi.fn().mockResolvedValue(undefined),
    handleDaemonCli: vi.fn().mockResolvedValue(undefined),
    handleEmitTs: vi.fn().mockResolvedValue(undefined),
    handleGenerateCli: vi.fn().mockResolvedValue(undefined),
    handleInspectCli: vi.fn().mockResolvedValue(undefined),
    handleList: vi.fn().mockResolvedValue(undefined),
    handleRecordCli: vi.fn().mockResolvedValue(undefined),
    handleReplayCli: vi.fn().mockResolvedValue(undefined),
    handleResource: vi.fn().mockResolvedValue(undefined),
    handleServeCli: vi.fn().mockResolvedValue(undefined),
    handleVault: vi.fn().mockResolvedValue(undefined),
    printAuthHelp: vi.fn(),
    printRecordHelp: vi.fn(),
    printReplayHelp: vi.fn(),
    printResourceHelp: vi.fn(),
    printVaultHelp: vi.fn(),
  };
});

function runtimeDouble() {
  return {
    callTool: vi.fn(),
    close: mocks.close,
    connect: vi.fn(),
    getDefinition: vi.fn(),
    getDefinitions: vi.fn(() => []),
    getInstructions: vi.fn(),
    listResources: vi.fn(),
    listServers: vi.fn(() => []),
    listTools: vi.fn(),
    readResource: vi.fn(),
    registerDefinition: vi.fn(),
  };
}

vi.mock('../src/runtime.js', () => ({
  MCPORTER_VERSION: 'test',
  createRuntime: mocks.createRuntime,
}));
vi.mock('../src/daemon/client.js', () => ({ DaemonClient: mocks.DaemonClient }));
vi.mock('../src/daemon/runtime-wrapper.js', () => ({ createKeepAliveRuntime: (runtime: unknown) => runtime }));
vi.mock('../src/lifecycle.js', () => ({ isKeepAliveServer: () => false }));
vi.mock('../src/cli/auth-command.js', () => ({ handleAuth: mocks.handleAuth, printAuthHelp: mocks.printAuthHelp }));
vi.mock('../src/cli/call-command.js', () => ({ handleCall: mocks.handleCall, printCallHelp: vi.fn() }));
vi.mock('../src/cli/config-command.js', () => ({ handleConfigCli: mocks.handleConfigCli }));
vi.mock('../src/cli/daemon-command.js', () => ({ handleDaemonCli: mocks.handleDaemonCli }));
vi.mock('../src/cli/emit-ts-command.js', () => ({ handleEmitTs: mocks.handleEmitTs, printEmitTsHelp: vi.fn() }));
vi.mock('../src/cli/generate-cli-runner.js', () => ({
  handleGenerateCli: mocks.handleGenerateCli,
  printGenerateCliHelp: vi.fn(),
}));
vi.mock('../src/cli/inspect-cli-command.js', () => ({
  handleInspectCli: mocks.handleInspectCli,
  printInspectCliHelp: vi.fn(),
}));
vi.mock('../src/cli/list-command.js', () => ({ handleList: mocks.handleList, printListHelp: vi.fn() }));
vi.mock('../src/cli/record-command.js', () => ({
  handleRecordCli: mocks.handleRecordCli,
  printRecordHelp: mocks.printRecordHelp,
}));
vi.mock('../src/cli/replay-command.js', () => ({
  handleReplayCli: mocks.handleReplayCli,
  printReplayHelp: mocks.printReplayHelp,
}));
vi.mock('../src/cli/resource-command.js', () => ({
  handleResource: mocks.handleResource,
  printResourceHelp: mocks.printResourceHelp,
}));
vi.mock('../src/cli/serve-command.js', () => ({ handleServeCli: mocks.handleServeCli, printServeHelp: vi.fn() }));
vi.mock('../src/cli/vault-command.js', () => ({
  handleVault: mocks.handleVault,
  printVaultHelp: mocks.printVaultHelp,
}));

const cliModulePromise = import('../src/cli.js');

describe('CLI entrypoint dispatch coverage', () => {
  beforeEach(() => {
    process.env.MCPORTER_NO_FORCE_EXIT = '1';
    process.exitCode = undefined;
    mocks.createRuntime.mockReset().mockImplementation(() => Promise.resolve(runtimeDouble()));
    for (const mock of Object.values(mocks)) {
      if (typeof mock === 'function' && mock !== mocks.createRuntime) {
        mock.mockClear();
      }
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MCPORTER_NO_FORCE_EXIT;
    process.exitCode = undefined;
  });

  it('dispatches early commands without constructing a runtime', async () => {
    const { runCli } = await cliModulePromise;

    await runCli(['generate-cli', 'demo']);
    await runCli(['inspect-cli', 'demo']);
    await runCli(['daemon', 'status']);
    await runCli(['serve', '--http', '3000']);
    await runCli(['record', 'demo']);
    await runCli(['replay', 'demo']);

    expect(mocks.handleGenerateCli).toHaveBeenCalledWith(['demo'], expect.any(Object));
    expect(mocks.handleInspectCli).toHaveBeenCalledWith(['demo']);
    expect(mocks.handleDaemonCli).toHaveBeenCalledWith(['status'], expect.any(Object));
    expect(mocks.handleServeCli).toHaveBeenCalledWith(['--http', '3000'], expect.any(Object));
    expect(mocks.handleRecordCli).toHaveBeenCalledWith(['demo']);
    expect(mocks.handleReplayCli).toHaveBeenCalledWith(['demo']);
    expect(mocks.createRuntime).not.toHaveBeenCalled();
  });

  it('recognizes record and replay help only before the wrapped command', async () => {
    const { runCli } = await cliModulePromise;

    await runCli(['record', '--help', '--', 'node', 'script.js']);
    await runCli(['replay', 'help', '--', 'node', 'script.js']);

    expect(mocks.printRecordHelp).toHaveBeenCalledOnce();
    expect(mocks.printReplayHelp).toHaveBeenCalledOnce();
    expect(mocks.handleRecordCli).not.toHaveBeenCalled();
    expect(mocks.handleReplayCli).not.toHaveBeenCalled();
  });

  it('creates and always closes a runtime for emit-ts', async () => {
    const { runCli } = await cliModulePromise;

    await runCli(['emit-ts', 'demo']);

    expect(mocks.handleEmitTs).toHaveBeenCalledWith(expect.any(Object), ['demo']);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it.each([
    ['list', mocks.handleList],
    ['call', mocks.handleCall],
    ['auth', mocks.handleAuth],
    ['vault', mocks.handleVault],
    ['resource', mocks.handleResource],
  ] as const)('routes %s through the shared runtime', async (command, handler) => {
    const { runCli } = await cliModulePromise;

    await runCli([command]);

    if (command === 'auth') {
      expect(handler).toHaveBeenCalledWith(expect.any(Object), [], { oauthTimeoutMs: undefined });
    } else {
      expect(handler).toHaveBeenCalledWith(expect.any(Object), []);
    }
    expect(mocks.close).toHaveBeenCalled();
  });

  it('routes complex keep-alive calls through the daemon-only runtime surface', async () => {
    mocks.handleCall.mockImplementationOnce(async (runtime: Runtime) => {
      expect(runtime.listServers()).toEqual([]);
      expect(runtime.getDefinitions()).toEqual([]);
      expect(() => runtime.getDefinition('chrome-devtools')).toThrow('only available through the keep-alive daemon');
      expect(() => runtime.registerDefinition({} as never)).toThrow('Ad-hoc servers are not supported');
      await expect(runtime.getInstructions!('chrome-devtools')).resolves.toBeUndefined();
      await runtime.listTools('chrome-devtools', { includeSchema: true, disableOAuth: true } as never);
      await runtime.callTool('chrome-devtools', 'list_pages', { args: { page: 1 }, timeoutMs: 25 } as never);
      await runtime.listResources('chrome-devtools', {
        cursor: 'next',
        allowCachedAuth: true,
        disableOAuth: true,
        oauthSessionOptions: {},
      } as never);
      await runtime.readResource('chrome-devtools', 'memo://one', { allowCachedAuth: true } as never);
      await expect(runtime.connect('chrome-devtools')).rejects.toThrow('only available through daemon request methods');
      await runtime.close('chrome-devtools');
    });
    const { runCli } = await cliModulePromise;

    await runCli(['call', 'chrome-devtools.list_pages', 'positional']);

    expect(mocks.createRuntime).not.toHaveBeenCalled();
    expect(mocks.daemonListTools).toHaveBeenCalledWith({
      server: 'chrome-devtools',
      includeSchema: true,
      autoAuthorize: undefined,
      allowCachedAuth: undefined,
      disableOAuth: true,
    });
    expect(mocks.daemonCallTool).toHaveBeenCalledWith({
      server: 'chrome-devtools',
      tool: 'list_pages',
      args: { page: 1 },
      timeoutMs: 25,
      disableOAuth: undefined,
    });
    expect(mocks.daemonListResources).toHaveBeenCalledWith({
      server: 'chrome-devtools',
      params: { cursor: 'next' },
      allowCachedAuth: true,
      disableOAuth: true,
    });
    expect(mocks.daemonReadResource).toHaveBeenCalledWith({
      server: 'chrome-devtools',
      uri: 'memo://one',
      allowCachedAuth: true,
      disableOAuth: undefined,
    });
    expect(mocks.daemonCloseServer).toHaveBeenCalledWith({ server: 'chrome-devtools' });
  });

  it('prints vault and resource help before invoking their handlers', async () => {
    const { runCli } = await cliModulePromise;

    await runCli(['vault', '--help']);
    await runCli(['resource', 'help']);

    expect(mocks.printVaultHelp).toHaveBeenCalledOnce();
    expect(mocks.printResourceHelp).toHaveBeenCalledOnce();
    expect(mocks.handleVault).not.toHaveBeenCalled();
    expect(mocks.handleResource).not.toHaveBeenCalled();
  });

  it('closes the runtime and preserves handler failures', async () => {
    const failure = new Error('list failed');
    mocks.handleList.mockRejectedValueOnce(failure);
    const { runCli } = await cliModulePromise;

    await expect(runCli(['list'])).rejects.toBe(failure);

    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('stops after command inference rejects an unknown configured server', async () => {
    const runtime = runtimeDouble();
    runtime.getDefinitions.mockReturnValue([
      { name: 'configured', command: { kind: 'http', url: new URL('https://example.com') } } as never,
    ]);
    mocks.createRuntime.mockResolvedValueOnce(runtime);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runCli } = await cliModulePromise;

    await runCli(['entirely-unknown']);

    expect(process.exitCode).toBe(1);
    expect(mocks.handleList).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('lets config auth reuse the entrypoint runtime lifecycle', async () => {
    mocks.handleConfigCli.mockImplementationOnce(async (context: { invokeAuth(args: string[]): Promise<void> }) => {
      await context.invokeAuth(['demo']);
    });
    const { runCli } = await cliModulePromise;

    await runCli(['config', 'auth', 'demo']);

    expect(mocks.handleAuth).toHaveBeenCalledWith(expect.any(Object), ['demo'], { oauthTimeoutMs: undefined });
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('prints help and exits for empty or unknown commands', async () => {
    const { runCli } = await cliModulePromise;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await runCli([]);
    await runCli(['unknown-command']);

    expect(exitSpy).toHaveBeenNthCalledWith(1, 1);
    expect(exitSpy).toHaveBeenNthCalledWith(2, 1);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('delegates the public lazy command wrappers', async () => {
    const cli = await cliModulePromise;
    const runtime = runtimeDouble();

    await cli.handleAuth(runtime as never, ['auth']);
    await cli.handleCall(runtime as never, ['call']);
    await cli.handleGenerateCli(['generate'], {});
    await cli.handleInspectCli(['inspect']);
    await cli.handleList(runtime as never, ['list']);
    await cli.handleResource(runtime as never, ['resource']);
    await cli.printAuthHelp();

    expect(mocks.handleAuth).toHaveBeenCalledWith(runtime, ['auth']);
    expect(mocks.handleCall).toHaveBeenCalledWith(runtime, ['call']);
    expect(mocks.handleGenerateCli).toHaveBeenCalledWith(['generate'], {});
    expect(mocks.handleInspectCli).toHaveBeenCalledWith(['inspect']);
    expect(mocks.handleList).toHaveBeenCalledWith(runtime, ['list']);
    expect(mocks.handleResource).toHaveBeenCalledWith(runtime, ['resource']);
    expect(mocks.printAuthHelp).toHaveBeenCalledOnce();
  });
});
