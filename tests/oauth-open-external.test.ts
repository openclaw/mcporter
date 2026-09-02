import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __oauthInternals } from '../src/oauth.js';

describe('openExternal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens the browser with the macOS open command', () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    const launch = vi.fn(() => child as unknown as ReturnType<typeof import('node:child_process').spawn>);
    const url = 'https://example.com/auth';

    __oauthInternals.openExternal(url, 'darwin', launch as unknown as typeof import('node:child_process').spawn);

    expect(launch).toHaveBeenCalledWith('open', [url], {
      stdio: 'ignore',
      detached: true,
    });
    expect(child.unref).toHaveBeenCalled();
  });

  it('swallows xdg-open error events on linux', () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    const launch = vi.fn(() => child as unknown as ReturnType<typeof import('node:child_process').spawn>);

    expect(() =>
      __oauthInternals.openExternal(
        'https://example.com/auth',
        'linux',
        launch as unknown as typeof import('node:child_process').spawn
      )
    ).not.toThrow();
    expect(launch).toHaveBeenCalledWith('xdg-open', ['https://example.com/auth'], {
      stdio: 'ignore',
      detached: true,
    });
    expect(() => child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))).not.toThrow();
    expect(child.unref).toHaveBeenCalled();
  });

  it('swallows open error events on darwin', () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    const launch = vi.fn(() => child as unknown as ReturnType<typeof import('node:child_process').spawn>);

    expect(() =>
      __oauthInternals.openExternal(
        'https://example.com/auth',
        'darwin',
        launch as unknown as typeof import('node:child_process').spawn
      )
    ).not.toThrow();
    expect(launch).toHaveBeenCalledWith('open', ['https://example.com/auth'], {
      stdio: 'ignore',
      detached: true,
    });
    expect(child.listenerCount('error')).toBeGreaterThan(0);
    expect(() => child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))).not.toThrow();
    expect(child.unref).toHaveBeenCalled();
  });

  it('swallows rundll32 error events on win32', () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    const launch = vi.fn(() => child as unknown as ReturnType<typeof import('node:child_process').spawn>);
    const url = 'https://example.com/auth?client_id=abc&redirect_uri=http://127.0.0.1:1234/callback';

    expect(() =>
      __oauthInternals.openExternal(url, 'win32', launch as unknown as typeof import('node:child_process').spawn)
    ).not.toThrow();
    expect(launch).toHaveBeenCalledWith('rundll32', ['url.dll,FileProtocolHandler', url], {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    expect(child.listenerCount('error')).toBeGreaterThan(0);
    expect(() => child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))).not.toThrow();
    expect(child.unref).toHaveBeenCalled();
  });

  it.each(['darwin', 'win32'] as const)(
    'does not turn a late %s spawn error into an unhandled process crash',
    async (platform) => {
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = vi.fn();
      const launch = vi.fn(() => child as unknown as ReturnType<typeof import('node:child_process').spawn>);
      const unhandled: unknown[] = [];
      const record = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', record);
      process.on('uncaughtException', record);
      try {
        __oauthInternals.openExternal(
          'https://example.com/auth',
          platform,
          launch as unknown as typeof import('node:child_process').spawn
        );
        await new Promise<void>((resolve) => {
          setImmediate(() => {
            try {
              child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
            } catch (error) {
              unhandled.push(error);
            }
            resolve();
          });
        });
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', record);
        process.off('uncaughtException', record);
      }
    }
  );

  it('opens the browser via rundll32 FileProtocolHandler on Windows (no cmd.exe)', () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    const launch = vi.fn(() => child as unknown as ReturnType<typeof import('node:child_process').spawn>);
    const url = 'https://example.com/auth?client_id=abc&redirect_uri=http://127.0.0.1:1234/callback';

    __oauthInternals.openExternal(url, 'win32', launch as unknown as typeof import('node:child_process').spawn);

    expect(launch).toHaveBeenCalledWith('rundll32', ['url.dll,FileProtocolHandler', url], {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    expect(child.unref).toHaveBeenCalled();
  });

  it('does not pass quote- or ampersand-bearing OAuth URLs through cmd.exe on Windows', () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    const launch = vi.fn(() => child as unknown as ReturnType<typeof import('node:child_process').spawn>);
    const url = 'https://example.com/auth?q="evil"&redirect_uri=http://127.0.0.1:1234/callback';

    __oauthInternals.openExternal(url, 'win32', launch as unknown as typeof import('node:child_process').spawn);

    const [exe, args] = launch.mock.calls[0] as unknown as [string, string[]];
    expect(exe).toBe('rundll32');
    expect(args).toEqual(['url.dll,FileProtocolHandler', url]);
    // Must not use cmd /c start (command-interpreter boundary).
    expect(exe.toLowerCase()).not.toContain('cmd');
    expect(args.some((a) => a === '/c' || a.toLowerCase() === 'start')).toBe(false);
    expect(child.unref).toHaveBeenCalled();
  });
});
