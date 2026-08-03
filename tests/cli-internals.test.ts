import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.MCPORTER_DISABLE_AUTORUN = '1';
const cliModulePromise = import('../src/cli.js');

describe('CLI process helpers', () => {
  beforeEach(() => {
    process.env.MCPORTER_NO_FORCE_EXIT = '1';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.MCPORTER_NO_FORCE_EXIT;
  });

  it('ignores broken pipes but rethrows other stdio errors', async () => {
    const { __cliInternals } = await cliModulePromise;
    const brokenPipe = Object.assign(new Error('closed pipe'), { code: 'EPIPE' });
    expect(() => __cliInternals.handleStdioError(brokenPipe)).not.toThrow();

    const unexpected = Object.assign(new Error('write failed'), { code: 'EIO' });
    expect(() => __cliInternals.handleStdioError(unexpected)).toThrow(unexpected);
  });

  it('installs the same defensive error handler on stdout and stderr', async () => {
    const { __cliInternals } = await cliModulePromise;
    const stdoutBefore = process.stdout.listenerCount('error');
    const stderrBefore = process.stderr.listenerCount('error');

    __cliInternals.installStdioErrorHandlers();

    expect(process.stdout.listeners('error')).toContain(__cliInternals.handleStdioError);
    expect(process.stderr.listeners('error')).toContain(__cliInternals.handleStdioError);
    process.stdout.removeListener('error', __cliInternals.handleStdioError);
    process.stderr.removeListener('error', __cliInternals.handleStdioError);
    expect(process.stdout.listenerCount('error')).toBe(stdoutBefore);
    expect(process.stderr.listenerCount('error')).toBe(stderrBefore);
  });

  it('flushes writable streams and immediately accepts closed streams', async () => {
    const { __cliInternals } = await cliModulePromise;
    const write = vi.fn((_chunk: string, callback: () => void) => {
      callback();
      return true;
    });
    const writable = { writable: true, destroyed: false, writableEnded: false, write } as unknown as NodeJS.WriteStream;
    const closed = {
      writable: false,
      destroyed: true,
      writableEnded: true,
      write: vi.fn(),
    } as unknown as NodeJS.WriteStream;

    await expect(__cliInternals.flushWriteStreamForExit(writable)).resolves.toBeUndefined();
    await expect(__cliInternals.flushWriteStreamForExit(closed)).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledWith('', expect.any(Function));
  });

  it('forces exit only once when the flush completes after the timeout', async () => {
    vi.useFakeTimers();
    const { __cliInternals } = await cliModulePromise;
    const callbacks: Array<() => void> = [];
    const captureCallback = vi.fn((...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback === 'function') {
        callbacks.push(callback as () => void);
      }
      return true;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(captureCallback as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(captureCallback as never);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    __cliInternals.flushStdioThenForceExit();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(exitSpy).toHaveBeenCalledTimes(1);

    callbacks.forEach((callback) => callback());
    await Promise.resolve();
    await Promise.resolve();
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps only wrapper arguments before the command separator', async () => {
    const { __cliInternals } = await cliModulePromise;
    expect(__cliInternals.wrapperArgsBeforeSeparator(['demo', '--server', 'one', '--', 'node', 'app.js'])).toEqual([
      'demo',
      '--server',
      'one',
    ]);
    expect(__cliInternals.wrapperArgsBeforeSeparator(['demo'])).toEqual(['demo']);
  });
});
