import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __oauthInternals } from '../src/oauth.js';

describe('openExternal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
