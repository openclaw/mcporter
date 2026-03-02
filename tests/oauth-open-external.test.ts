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
});
