import { beforeEach, describe, expect, it, vi } from 'vitest';

const stopMock = vi.fn();
const statusMock = vi.fn();
const mkdirMock = vi.fn();
const launchDaemonDetachedMock = vi.fn();
const runDaemonHostMock = vi.fn();
const createRuntimeMock = vi.fn();
const isKeepAliveServerMock = vi.fn(() => true);
const DaemonClientMock = vi.fn();

vi.mock('node:fs/promises', () => ({
  default: { mkdir: mkdirMock },
  mkdir: mkdirMock,
}));

vi.mock('../src/daemon/client.js', () => ({
  DaemonClient: DaemonClientMock,
  resolveDaemonPaths: vi.fn(() => ({
    key: 'abc123',
    socketPath: '/tmp/socket',
    metadataPath: '/tmp/meta',
  })),
}));

vi.mock('../src/daemon/launch.js', () => ({
  launchDaemonDetached: launchDaemonDetachedMock,
}));

vi.mock('../src/daemon/host.js', () => ({
  runDaemonHost: runDaemonHostMock,
}));

vi.mock('../src/daemon/paths.js', () => ({
  getDaemonLogPath: vi.fn(() => '/tmp/mock-daemon.log'),
}));

vi.mock('../src/env.js', () => ({
  expandHome: (value: string) => value,
}));

vi.mock('../src/runtime.js', () => ({
  createRuntime: (...args: Parameters<typeof createRuntimeMock>) => createRuntimeMock(...args),
}));

vi.mock('../src/lifecycle.js', () => ({
  isKeepAliveServer: (...args: Parameters<typeof isKeepAliveServerMock>) => isKeepAliveServerMock(...args),
}));

const { handleDaemonCli } = await import('../src/cli/daemon-command.js');

describe('daemon CLI restart', () => {
  beforeEach(() => {
    stopMock.mockReset();
    statusMock.mockReset();
    mkdirMock.mockReset();
    launchDaemonDetachedMock.mockReset();
    runDaemonHostMock.mockReset();
    createRuntimeMock.mockReset();
    isKeepAliveServerMock.mockReset();
    DaemonClientMock.mockReset();
    DaemonClientMock.mockImplementation(function MockDaemonClient() {
      return {
        stop: stopMock,
        status: statusMock,
      };
    });
    stopMock.mockResolvedValue(undefined);

    const closeMock = vi.fn().mockResolvedValue(undefined);
    createRuntimeMock.mockResolvedValue({
      getDefinitions: () => [{ name: 'daemon-e2e', lifecycle: 'keep-alive' }],
      close: closeMock,
    });
    isKeepAliveServerMock.mockReturnValue(true);
    mkdirMock.mockResolvedValue(undefined);
  });

  it('stops the daemon and launches a fresh instance while honoring log flags', async () => {
    statusMock
      .mockResolvedValueOnce(null) // restart wait sees daemon already stopped
      .mockResolvedValueOnce(null) // handleDaemonStart: no existing daemon
      .mockResolvedValueOnce(null) // waitFor: daemon not ready yet
      .mockResolvedValueOnce({ pid: 420, socketPath: '/tmp/socket', servers: [], logPath: '/tmp/mock-daemon.log' });

    await handleDaemonCli(['restart', '--log'], { configPath: '/tmp/config.json', configExplicit: true });

    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(launchDaemonDetachedMock).toHaveBeenCalledWith({
      configPath: '/tmp/config.json',
      configExplicit: true,
      rootDir: undefined,
      metadataPath: '/tmp/meta',
      socketPath: '/tmp/socket',
      extraArgs: ['--log-file', '/tmp/mock-daemon.log'],
    });
  });

  it('uses implicit config when no explicit path is provided, avoiding ENOENT', async () => {
    statusMock
      .mockResolvedValueOnce(null) // restart wait sees daemon already stopped
      .mockResolvedValueOnce(null) // handleDaemonStart: no existing daemon
      .mockResolvedValueOnce({ pid: 321, socketPath: '/tmp/socket', servers: [], logPath: undefined }); // waitFor ready

    await handleDaemonCli(['restart'], { configPath: '/tmp/config.json', configExplicit: false });

    expect(createRuntimeMock).toHaveBeenCalledWith({
      configPath: undefined,
      rootDir: undefined,
    });
  });

  it('prints help, rejects unknown commands, and stops directly', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await handleDaemonCli([], { configPath: '/tmp/config.json' });
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: mcporter daemon'));
      await expect(handleDaemonCli(['unknown'], { configPath: '/tmp/config.json' })).rejects.toThrow(
        "Unknown daemon subcommand 'unknown'"
      );
      await handleDaemonCli(['stop'], { configPath: '/tmp/config.json' });
      expect(stopMock).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith('Daemon stopped (if it was running).');
    } finally {
      log.mockRestore();
    }
  });

  it('renders stopped, empty, and active status details', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      statusMock.mockResolvedValueOnce(null);
      await handleDaemonCli(['status'], { configPath: '/tmp/config.json' });
      expect(log).toHaveBeenCalledWith('Daemon is not running.');

      statusMock.mockResolvedValueOnce({
        pid: 7,
        socketPath: '/tmp/socket',
        logPath: '/tmp/daemon.log',
        servers: [],
      });
      await handleDaemonCli(['status'], { configPath: '/tmp/config.json' });
      expect(log).toHaveBeenCalledWith('Log file: /tmp/daemon.log');
      expect(log).toHaveBeenCalledWith('No keep-alive servers registered.');

      statusMock.mockResolvedValueOnce({
        pid: 8,
        socketPath: '/tmp/socket',
        servers: [
          { name: 'active', connected: true, lastUsedAt: 0 },
          { name: 'idle', connected: false, lastUsedAt: Date.UTC(2026, 0, 2) },
        ],
      });
      await handleDaemonCli(['status'], { configPath: '/tmp/config.json' });
      expect(log).toHaveBeenCalledWith('- active: connected');
      expect(log).toHaveBeenCalledWith('- idle: idle (last used 2026-01-02T00:00:00.000Z)');
    } finally {
      log.mockRestore();
    }
  });

  it('does not launch when no keep-alive definitions exist', async () => {
    isKeepAliveServerMock.mockReturnValue(false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await handleDaemonCli(['start'], {
        configPath: '/tmp/config.json',
        configExplicit: true,
        rootDir: '/tmp/root',
      });
      expect(createRuntimeMock).toHaveBeenCalledWith({ configPath: '/tmp/config.json', rootDir: '/tmp/root' });
      expect(launchDaemonDetachedMock).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith('No MCP servers are configured for keep-alive; daemon not started.');
    } finally {
      log.mockRestore();
    }
  });

  it('runs foreground with parsed server logging options', async () => {
    await handleDaemonCli(['start', '--foreground', '--log-servers', ' alpha, beta,alpha '], {
      configPath: '/tmp/config.json',
      configExplicit: true,
      rootDir: '/tmp/root',
    });

    expect(mkdirMock).toHaveBeenCalled();
    expect(runDaemonHostMock).toHaveBeenCalledWith({
      socketPath: '/tmp/socket',
      metadataPath: '/tmp/meta',
      configPath: '/tmp/config.json',
      configExplicit: true,
      rootDir: '/tmp/root',
      logPath: '/tmp/mock-daemon.log',
      logServers: new Set(['alpha', 'beta']),
      logAllServers: false,
    });
    expect(launchDaemonDetachedMock).not.toHaveBeenCalled();
  });

  it('reports an already running daemon without launching another', async () => {
    statusMock.mockResolvedValue({ pid: 99, servers: [], socketPath: '/tmp/socket' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await handleDaemonCli(['start'], { configPath: '/tmp/config.json' });
      expect(launchDaemonDetachedMock).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith('Daemon already running (pid 99).');
    } finally {
      log.mockRestore();
    }
  });

  it('forwards an explicit log file and reports successful background startup', async () => {
    statusMock.mockResolvedValueOnce(null).mockResolvedValueOnce({ pid: 10, servers: [], socketPath: '/tmp/socket' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await handleDaemonCli(['start', '--log-file', './daemon.log'], { configPath: '/tmp/config.json' });
      expect(launchDaemonDetachedMock).toHaveBeenCalledWith(
        expect.objectContaining({ extraArgs: ['--log-file', expect.stringMatching(/daemon\.log$/u)] })
      );
      expect(log).toHaveBeenCalledWith('Daemon started for 1 server(s).');
    } finally {
      log.mockRestore();
    }
  });

  it('rejects value flags without values', async () => {
    await expect(handleDaemonCli(['start', '--log-file'], { configPath: '/tmp/config.json' })).rejects.toThrow(
      "Flag '--log-file' requires a value"
    );
  });
});
