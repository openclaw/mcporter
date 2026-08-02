import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../src/cli/logger-context.js');
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('runtime debug cleanup', () => {
  it('describes active handles and requests when hang diagnostics are enabled', async () => {
    vi.stubEnv('MCPORTER_DEBUG_HANG', '1');
    const info = vi.fn();
    const warn = vi.fn();
    vi.doMock('../src/cli/logger-context.js', () => ({ logInfo: info, logWarn: warn }));
    const socket = namedHandle('Socket', {
      localAddress: '127.0.0.1',
      localPort: 1234,
      remoteAddress: '127.0.0.2',
      remotePort: 4321,
      address: () => ({ address: '0.0.0.0', port: 9999 }),
      _host: 'example.test',
      path: '/tmp/socket',
      _custom: true,
    });
    const child = namedHandle('ChildProcess', { pid: 42 });
    const request = namedHandle('FSReqCallback', { fd: 7 });
    vi.spyOn(process as unknown as { _getActiveHandles: () => unknown[] }, '_getActiveHandles').mockReturnValue([
      socket,
      child,
    ]);
    vi.spyOn(process as unknown as { _getActiveRequests: () => unknown[] }, '_getActiveRequests').mockReturnValue([
      request,
      null,
    ]);
    const { dumpActiveHandles } = await import('../src/cli/runtime-debug.js');

    dumpActiveHandles('after-test');

    expect(info).toHaveBeenCalledWith('[debug] after-test: 2 active handle(s), 2 request(s)');
    expect(info).toHaveBeenCalledWith(expect.stringContaining('Socket local=127.0.0.1:1234'));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('remote=127.0.0.2:4321'));
    expect(info).toHaveBeenCalledWith('[debug] handle => ChildProcess (pid=42)');
    expect(info).toHaveBeenCalledWith('[debug] request => FSReqCallback (fd=7)');
    expect(info).toHaveBeenCalledWith('[debug] request => null');
  });

  it('closes socket and child streams and force-kills children in normal mode', async () => {
    vi.stubEnv('MCPORTER_DEBUG_HANG', '0');
    const destroySocket = vi.fn();
    const unref = vi.fn();
    const stdoutDestroy = vi.fn();
    const stderrDestroy = vi.fn();
    const stdinEnd = vi.fn();
    const kill = vi.fn();
    const socket = namedHandle('Socket', { destroy: destroySocket, unref });
    const child = namedHandle('ChildProcess', {
      pid: 42,
      killed: false,
      stdout: { destroy: stdoutDestroy },
      stderr: { destroy: stderrDestroy },
      stdin: { end: stdinEnd },
      kill,
    });
    vi.spyOn(process as unknown as { _getActiveHandles: () => unknown[] }, '_getActiveHandles').mockReturnValue([
      undefined,
      'text',
      socket,
      child,
    ]);
    const { terminateChildProcesses } = await import('../src/cli/runtime-debug.js');

    terminateChildProcesses('cleanup');

    expect(destroySocket).toHaveBeenCalledOnce();
    expect(unref).toHaveBeenCalledOnce();
    expect(stdoutDestroy).toHaveBeenCalledOnce();
    expect(stderrDestroy).toHaveBeenCalledOnce();
    expect(stdinEnd).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('logs diagnostic kill outcomes and tolerates cleanup methods that throw', async () => {
    vi.stubEnv('MCPORTER_DEBUG_HANG', '1');
    const warn = vi.fn();
    vi.doMock('../src/cli/logger-context.js', () => ({ logInfo: vi.fn(), logWarn: warn }));
    const throwing = vi.fn(() => {
      throw new Error('cleanup failed');
    });
    const child = namedHandle('ChildProcess', {
      pid: 88,
      stdout: { destroy: throwing },
      stderr: { destroy: throwing },
      stdin: { end: throwing },
      kill: vi.fn(() => false),
    });
    const socket = namedHandle('Socket', { destroy: throwing });
    vi.spyOn(process as unknown as { _getActiveHandles: () => unknown[] }, '_getActiveHandles').mockReturnValue([
      socket,
      child,
    ]);
    const { terminateChildProcesses } = await import('../src/cli/runtime-debug.js');

    expect(() => terminateChildProcesses('timeout')).not.toThrow();
    expect(warn).toHaveBeenCalledWith('[debug] forcibly kill-failed child pid=88 (timeout)');
  });
});

function namedHandle(name: string, properties: Record<string, unknown>): object {
  return Object.assign({ constructor: { name } }, properties);
}
