import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn(() => ({ unref: vi.fn() }));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

const originalArgv = [...process.argv];
const originalExecArgv = [...process.execArgv];

describe('launchDaemonDetached', () => {
  beforeEach(() => {
    spawnMock.mockClear();
    process.argv = ['/tmp/mcporter', '/$bunfs/root/mcporter.js'];
    process.execArgv = ['--smol'];
  });

  afterEach(() => {
    process.argv = [...originalArgv];
    process.execArgv = [...originalExecArgv];
  });

  it('omits Bun virtual entry paths from detached child args', async () => {
    const { launchDaemonDetached } = await import('../src/daemon/launch.js');

    launchDaemonDetached({
      configPath: '/tmp/mcporter.json',
      configExplicit: true,
      rootDir: '/repo',
      socketPath: '/tmp/mcporter.sock',
      metadataPath: '/tmp/mcporter.meta.json',
      extraArgs: ['--log'],
    });

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ['--smol', '--config', '/tmp/mcporter.json', '--root', '/repo', 'daemon', 'start', '--foreground', '--log'],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
        env: expect.objectContaining({
          MCPORTER_DAEMON_CHILD: '1',
          MCPORTER_DAEMON_SOCKET: '/tmp/mcporter.sock',
          MCPORTER_DAEMON_METADATA: '/tmp/mcporter.meta.json',
        }),
      })
    );
  });
});
