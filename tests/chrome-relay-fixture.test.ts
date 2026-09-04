import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeShortTempDir } from './fixtures/test-helpers.js';
import {
  assertSyntheticRelayCredentialPath,
  isolateChromeRelayTestEnvironment,
} from './helpers/chrome-relay-fixture.js';

function caseInsensitiveEnvironment(values: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const target = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toUpperCase(), value]));
  return new Proxy(target, {
    get: (env, key: string) => env[key.toUpperCase()],
    set: (env, key: string, value: string) => {
      env[key.toUpperCase()] = value;
      return true;
    },
    deleteProperty: (env, key: string) => delete env[key.toUpperCase()],
  });
}

describe('Chrome relay fixture isolation', () => {
  it.each(['case-sensitive', 'case-insensitive'] as const)(
    'restores %s environment aliases and absent keys',
    (kind) => {
      const values = {
        PATH: '/synthetic/upper-bin',
        Path: '/synthetic/mixed-bin',
        COMSPEC: '/synthetic/upper-cmd',
        ComSpec: '/synthetic/mixed-cmd',
        SYSTEMROOT: '/synthetic/upper-system',
        SystemRoot: '/synthetic/mixed-system',
        WINDIR: '/synthetic/windows',
        TEMP: '/synthetic/temp',
        TMP: '/synthetic/tmp',
        HOME: '/synthetic/home',
        USERPROFILE: '/synthetic/profile',
        XDG_CONFIG_HOME: '/synthetic/config',
        XDG_STATE_HOME: '/synthetic/state',
        XDG_DATA_HOME: '/synthetic/data',
        XDG_CACHE_HOME: '/synthetic/cache',
      };
      const env: NodeJS.ProcessEnv = kind === 'case-insensitive' ? caseInsensitiveEnvironment(values) : { ...values };
      const before = { ...env };
      const restore = isolateChromeRelayTestEnvironment('/synthetic/home', env);
      expect(env.PATH).toBeUndefined();
      expect(env.Path).toBeUndefined();
      expect(env.COMSPEC).toBeUndefined();
      expect(env.ComSpec).toBeUndefined();
      expect(env.SYSTEMROOT).toBeUndefined();
      expect(env.SystemRoot).toBeUndefined();
      for (const key of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) {
        expect(env[key]).toBe(before[key]);
      }
      expect(env.TEMP).toBe('/synthetic/home');
      expect(env.TMP).toBe('/synthetic/home');
      expect(env.TMPDIR).toBe('/synthetic/home');
      restore();
      expect({ ...env }).toEqual(before);
    }
  );

  it('keeps Windows recursive temp fixtures inside the isolated home with discovery env cleared', async () => {
    const home = os.homedir();
    const restore = isolateChromeRelayTestEnvironment(home);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    let directory: string | undefined;
    try {
      expect(os.tmpdir()).toBe(home);
      expect(process.env.SystemRoot).toBeUndefined();
      Object.defineProperty(process, 'platform', { value: 'win32' });
      directory = await makeShortTempDir('relay-fixture');
      expect(path.isAbsolute(directory)).toBe(true);
      expect(path.dirname(directory)).toBe(home);
      expect((await fs.stat(directory)).isDirectory()).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', platform);
      restore();
      if (directory) await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    [path.posix, '/synthetic/home', '/synthetic/home/credentials/browser-extension-relay.secret'],
    [path.win32, 'C:\\synthetic\\home', 'C:\\synthetic\\home\\credentials\\browser-extension-relay.secret'],
    [path.win32, 'C:\\synthetic\\home', 'c:/SYNTHETIC/home/credentials/BROWSER-EXTENSION-RELAY.SECRET'],
  ])('allows synthetic credentials with native path containment (%#)', (paths, root, file) => {
    expect(() => assertSyntheticRelayCredentialPath(file, [root], paths)).not.toThrow();
  });

  it.each([
    [path.posix, '/synthetic/home', '/synthetic/home-other/browser-extension-relay.secret'],
    [path.posix, '/synthetic/home', '/synthetic/home/../outside/browser-extension-relay.secret'],
    [path.win32, 'C:\\synthetic\\home', 'C:\\synthetic\\outside\\browser-extension-relay.secret'],
    [path.win32, 'C:\\synthetic\\home', 'C:\\synthetic\\home-other\\browser-extension-relay.secret'],
    [path.win32, 'C:\\synthetic\\home', 'C:/synthetic/home/../outside/BROWSER-EXTENSION-RELAY.SECRET'],
    [path.win32, 'C:\\synthetic\\home', 'D:\\synthetic\\home\\browser-extension-relay.secret'],
    [path.win32, 'C:\\synthetic\\home', 'C:browser-extension-relay.secret'],
    [path.win32, 'C:\\synthetic\\home', '\\\\synthetic-server\\share\\browser-extension-relay.secret'],
  ])('blocks credentials outside fixtures before opening them (%#)', (paths, root, file) => {
    expect(() => assertSyntheticRelayCredentialPath(file, [root], paths)).toThrowError(
      expect.objectContaining({ code: 'ENOENT' })
    );
  });
});
