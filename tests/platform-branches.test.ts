import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathsForImport } from '../src/config-imports.js';
import { normalizeProjectPath, pathsEqual } from '../src/config/imports/paths-utils.js';
import { getDaemonLogPath, getDaemonMetadataPath, getDaemonSocketPath } from '../src/daemon/paths.js';

const originalEnv = { ...process.env };

describe('host-independent platform paths', () => {
  const homeDir = path.join(os.tmpdir(), 'mcporter-platform-home');
  const appData = path.join(homeDir, 'AppData', 'Roaming');
  const rootDir = path.join(os.tmpdir(), 'mcporter-platform-root');

  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
    process.env = {
      ...originalEnv,
      HOME: homeDir,
      USERPROFILE: homeDir,
      APPDATA: appData,
      MCPORTER_DAEMON_DIR: path.join(homeDir, 'state'),
    };
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.OPENCODE_CONFIG;
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OPENAI_WORKDIR;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it.each([
    {
      platform: 'darwin' as const,
      vscodeDir: path.join(homeDir, 'Library', 'Application Support', 'Code'),
      claudePath: path.join(homeDir, 'Library', 'Application Support', 'Claude', 'settings.json'),
      opencodeDir: path.join(homeDir, '.config', 'opencode'),
    },
    {
      platform: 'win32' as const,
      vscodeDir: path.join(appData, 'Code'),
      claudePath: path.join(homeDir, 'AppData', 'Roaming', 'Claude', 'settings.json'),
      opencodeDir: path.join(appData, 'opencode'),
    },
    {
      platform: 'linux' as const,
      vscodeDir: path.join(homeDir, '.config', 'Code'),
      claudePath: path.join(homeDir, '.config', 'Claude', 'settings.json'),
      opencodeDir: path.join(homeDir, '.config', 'opencode'),
    },
  ])(
    'selects $platform import locations while running on any host',
    ({ platform, vscodeDir, claudePath, opencodeDir }) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);

      expect(pathsForImport('vscode', rootDir)).toContain(path.join(vscodeDir, 'User', 'mcp.json'));
      expect(pathsForImport('claude-desktop', rootDir)).toEqual([claudePath]);
      expect(pathsForImport('opencode', rootDir)).toContain(path.join(opencodeDir, 'opencode.jsonc'));

      const windsurfPaths = pathsForImport('windsurf', rootDir);
      const windowsWindsurfPath = path.join(appData, 'Codeium', 'windsurf', 'mcp_config.json');
      expect(windsurfPaths.includes(windowsWindsurfPath)).toBe(platform === 'win32');
    }
  );

  it('compares Windows paths case-insensitively and POSIX paths case-sensitively', () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    expect(pathsEqual('/Users/Test/Config.json', '/users/test/config.JSON')).toBe(true);

    platformSpy.mockReturnValue('linux');
    expect(pathsEqual('/Users/Test/Config.json', '/users/test/config.JSON')).toBe(false);
    expect(pathsEqual('/same/path', '/same/path')).toBe(true);
    expect(pathsEqual('', '/same/path')).toBe(false);
  });

  it('expands both POSIX and Windows home shortcuts without host assumptions', () => {
    expect(normalizeProjectPath('~')).toBe(path.resolve(homeDir));
    expect(normalizeProjectPath('~/project')).toBe(path.resolve(homeDir, 'project'));
    expect(normalizeProjectPath('~\\project')).toBe(path.resolve(homeDir, 'project'));
    expect(normalizeProjectPath('')).toBe('');
  });

  it('selects named pipes on Windows and filesystem sockets on POSIX', () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    expect(getDaemonSocketPath('abc')).toMatch(/^\\\\\.\\pipe\\mcporter-user-[a-f0-9]{24}$/);

    platformSpy.mockReturnValue('linux');
    expect(getDaemonSocketPath('abc')).toBe(path.join(homeDir, 'state', 'daemon', 'user.sock'));
    expect(getDaemonMetadataPath('abc')).toBe(path.join(homeDir, 'state', 'daemon', 'user.json'));
    expect(getDaemonLogPath('abc')).toBe(path.join(homeDir, 'state', 'daemon', 'user.log'));
  });

  it('honors config overrides and Windows fallback directories', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    delete process.env.APPDATA;
    process.env.OPENCODE_CONFIG = path.join(homeDir, 'custom.jsonc');
    process.env.OPENCODE_CONFIG_DIR = path.join(homeDir, 'opencode-override');
    process.env.OPENAI_WORKDIR = path.join(homeDir, 'workdir');
    process.env.XDG_CONFIG_HOME = path.join(homeDir, 'xdg');

    const paths = pathsForImport('opencode', rootDir);
    expect(paths).toEqual(
      expect.arrayContaining([
        path.join(homeDir, 'custom.jsonc'),
        path.join(homeDir, 'opencode-override', 'opencode.jsonc'),
        path.join(homeDir, 'workdir', '.openai', 'config.json'),
        path.join(homeDir, 'xdg', 'opencode', 'opencode.jsonc'),
      ])
    );

    delete process.env.XDG_CONFIG_HOME;
    expect(pathsForImport('windsurf', rootDir)).toContain(
      path.join(homeDir, 'AppData', 'Roaming', 'Codeium', 'windsurf', 'mcp_config.json')
    );
    expect(pathsForImport('vscode', rootDir)).toContain(
      path.join(homeDir, 'AppData', 'Roaming', 'Code', 'User', 'mcp.json')
    );
    expect(pathsForImport('unknown' as never, rootDir)).toEqual([]);
  });
});
