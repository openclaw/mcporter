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

  it('launches cmd.exe start with URL as a separate argv element on Windows', () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    const launch = vi.fn(() => child as unknown as ReturnType<typeof import('node:child_process').spawn>);
    const url = 'https://example.com/auth?client_id=abc&redirect_uri=http://127.0.0.1:1234/callback';

    __oauthInternals.openExternal(url, 'win32', launch as unknown as typeof import('node:child_process').spawn);

    expect(launch).toHaveBeenCalledWith('cmd', ['/c', 'start', '""', url], {
      stdio: 'ignore',
      detached: true,
    });
    expect(child.unref).toHaveBeenCalled();
  });

  it('keeps quote-bearing OAuth URLs out of a single cmd shell string on Windows', () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    const launch = vi.fn(() => child as unknown as ReturnType<typeof import('node:child_process').spawn>);
    const url = 'https://example.com/auth?q="evil"&redirect_uri=http://127.0.0.1:1234/callback';

    __oauthInternals.openExternal(url, 'win32', launch as unknown as typeof import('node:child_process').spawn);

    const args = launch.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(['/c', 'start', '""', url]);
    // URL must not be interpolated into a shell command string.
    expect(args.some((a) => a.includes('start "" "') && a.includes(url))).toBe(false);
    expect(child.unref).toHaveBeenCalled();
  });
});
