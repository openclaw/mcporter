import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDaemonLaunchInvocation, type DaemonLaunchOptions } from '../src/daemon/launch.js';

const options: DaemonLaunchOptions = {
  configPath: '/tmp/mcporter/config.json',
  configExplicit: true,
  rootDir: '/tmp/project',
  socketPath: '/tmp/mcporter/daemon.sock',
  metadataPath: '/tmp/mcporter/daemon.json',
  extraArgs: ['--log-file', '/tmp/mcporter/daemon.log'],
};

describe('buildDaemonLaunchInvocation', () => {
  it('launches Node entrypoints directly with the CLI script path', () => {
    const invocation = buildDaemonLaunchInvocation(options, {
      argvEntry: '/repo/dist/cli.js',
      env: { PATH: '/usr/bin' },
      execArgv: ['--enable-source-maps'],
      execPath: '/usr/local/bin/node',
      platform: 'darwin',
    });

    expect(invocation.command).toBe('/usr/local/bin/node');
    expect(invocation.args).toEqual([
      '--enable-source-maps',
      path.resolve('/repo/dist/cli.js'),
      '--config',
      '/tmp/mcporter/config.json',
      '--root',
      '/tmp/project',
      'daemon',
      'start',
      '--foreground',
      '--log-file',
      '/tmp/mcporter/daemon.log',
    ]);
    expect(invocation.env.MCPORTER_DAEMON_CHILD).toBe('1');
    expect(invocation.env.MCPORTER_DAEMON_SOCKET).toBe('/tmp/mcporter/daemon.sock');
    expect(invocation.env.MCPORTER_DAEMON_METADATA).toBe('/tmp/mcporter/daemon.json');
  });

  it('wraps compiled Bun binaries with nohup on macOS so detached self-spawn survives Tahoe', () => {
    const invocation = buildDaemonLaunchInvocation(options, {
      argvEntry: '/$bunfs/root/mcporter',
      env: { PATH: '/usr/bin' },
      execArgv: [],
      execPath: '/opt/homebrew/bin/mcporter',
      platform: 'darwin',
    });

    expect(invocation.command).toBe('nohup');
    expect(invocation.args).toEqual([
      '/opt/homebrew/bin/mcporter',
      '--config',
      '/tmp/mcporter/config.json',
      '--root',
      '/tmp/project',
      'daemon',
      'start',
      '--foreground',
      '--log-file',
      '/tmp/mcporter/daemon.log',
    ]);
    expect(invocation.env.MCPORTER_DAEMON_CHILD).toBe('1');
  });

  it('keeps non-macOS compiled launches on the direct exec path', () => {
    const invocation = buildDaemonLaunchInvocation(options, {
      argvEntry: '/$bunfs/root/mcporter',
      env: {},
      execArgv: [],
      execPath: '/usr/local/bin/mcporter',
      platform: 'linux',
    });

    expect(invocation.command).toBe('/usr/local/bin/mcporter');
    expect(invocation.args[0]).toBe('--config');
  });
});
