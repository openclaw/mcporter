import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/runtime.js';

process.env.MCPORTER_DISABLE_AUTORUN = '1';

describe('mcporter --oauth-timeout flag', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('passes the override through to createRuntime', async () => {
    const definition = {
      name: 'fake',
      description: 'Fake HTTP server',
      command: { kind: 'http' as const, url: new URL('https://example.com/mcp') },
    };
    const listToolsSpy = vi.fn(async () => []);
    const runtimeStub: Runtime = {
      listServers: vi.fn(() => [definition.name]),
      getDefinitions: vi.fn(() => [definition]),
      getDefinition: vi.fn(() => definition),
      registerDefinition: vi.fn(),
      listTools: listToolsSpy,
      callTool: vi.fn(),
      listResources: vi.fn(),
      readResource: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const runtimeModule = await import('../src/runtime.js');
    const createRuntimeSpy = vi.spyOn(runtimeModule, 'createRuntime').mockResolvedValue(runtimeStub);
    const { runCli } = await import('../src/cli.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const previousNoForce = process.env.MCPORTER_NO_FORCE_EXIT;
    process.env.MCPORTER_NO_FORCE_EXIT = '1';
    try {
      await runCli(['--oauth-timeout', '250', 'list', 'fake']);
    } finally {
      process.env.MCPORTER_NO_FORCE_EXIT = previousNoForce;
    }

    expect(createRuntimeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        oauthTimeoutMs: 250,
      })
    );
    expect(listToolsSpy).toHaveBeenCalled();

    logSpy.mockRestore();
    createRuntimeSpy.mockRestore();
  });

  it('uses the override for the auth listTools request timeout', async () => {
    const definition = {
      name: 'fake',
      description: 'Fake HTTP server',
      command: { kind: 'http' as const, url: new URL('https://example.com/mcp') },
    };
    const listToolsSpy = vi.fn(async () => []);
    const runtimeStub: Runtime = {
      listServers: vi.fn(() => [definition.name]),
      getDefinitions: vi.fn(() => [definition]),
      getDefinition: vi.fn(() => definition),
      registerDefinition: vi.fn(),
      listTools: listToolsSpy,
      callTool: vi.fn(),
      listResources: vi.fn(),
      readResource: vi.fn(),
      connect: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const runtimeModule = await import('../src/runtime.js');
    const createRuntimeSpy = vi.spyOn(runtimeModule, 'createRuntime').mockResolvedValue(runtimeStub);
    const { runCli } = await import('../src/cli.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const previousNoForce = process.env.MCPORTER_NO_FORCE_EXIT;
    process.env.MCPORTER_NO_FORCE_EXIT = '1';

    try {
      await runCli(['--oauth-timeout', '600000', 'auth', 'fake']);
    } finally {
      process.env.MCPORTER_NO_FORCE_EXIT = previousNoForce;
    }

    expect(listToolsSpy).toHaveBeenCalledWith(
      'fake',
      expect.objectContaining({ autoAuthorize: true, timeoutMs: 600_000 })
    );

    logSpy.mockRestore();
    createRuntimeSpy.mockRestore();
  });

  it('rejects malformed --oauth-timeout values', async () => {
    const { runCli } = await import('../src/cli.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(runCli(['--oauth-timeout', '5000abc', 'list'])).rejects.toThrow(/process\.exit/);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('positive integer'));
  });

  it('returns once runtime.listTools surfaces an OAuth timeout error', async () => {
    const definition = {
      name: 'fake',
      description: 'Fake HTTP server',
      command: { kind: 'http' as const, url: new URL('https://example.com/mcp') },
    };
    const runtimeModule = await import('../src/runtime.js');
    const { OAuthTimeoutError: TimeoutError } = await import('../src/runtime/oauth.js');
    const failingListTools = vi.fn(async () => {
      throw new TimeoutError('fake', 500);
    });
    const closeSpy = vi.fn(async () => {});
    const runtimeStub: Runtime = {
      listServers: vi.fn(() => [definition.name]),
      getDefinitions: vi.fn(() => [definition]),
      getDefinition: vi.fn(() => definition),
      registerDefinition: vi.fn(),
      listTools: failingListTools,
      callTool: vi.fn(),
      listResources: vi.fn(),
      readResource: vi.fn(),
      connect: vi.fn(),
      close: closeSpy,
    };
    const createRuntimeSpy = vi.spyOn(runtimeModule, 'createRuntime').mockResolvedValue(runtimeStub);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const previousNoForce = process.env.MCPORTER_NO_FORCE_EXIT;
    process.env.MCPORTER_NO_FORCE_EXIT = '1';
    const { runCli } = await import('../src/cli.js');

    try {
      await runCli(['list', 'fake']);
      expect(failingListTools).toHaveBeenCalled();
      expect(closeSpy).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Tools: <timed out'));
    } finally {
      process.env.MCPORTER_NO_FORCE_EXIT = previousNoForce;
      warnSpy.mockRestore();
      createRuntimeSpy.mockRestore();
    }
  });
});
