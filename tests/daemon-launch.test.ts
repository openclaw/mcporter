import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { buildDaemonLaunchInvocation, launchDaemonDetached, type DaemonLaunchOptions } from '../src/daemon/launch.js';

const options: DaemonLaunchOptions = {
  configPath: '/tmp/mcporter/config.json',
  configExplicit: true,
  rootDir: '/tmp/project',
  socketPath: '/tmp/mcporter/daemon.sock',
  metadataPath: '/tmp/mcporter/daemon.json',
  extraArgs: ['--log-file', '/tmp/mcporter/daemon.log'],
};

describe('buildDaemonLaunchInvocation', () => {
  it('spawns and unreferences the detached daemon', () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    const launch = vi.fn(() => child as unknown as ReturnType<typeof import('node:child_process').spawn>);

    launchDaemonDetached(options, launch as unknown as typeof import('node:child_process').spawn);

    expect(launch).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(['daemon', 'start', '--foreground']),
      expect.objectContaining({ detached: true, stdio: 'ignore' })
    );
    expect(child.unref).toHaveBeenCalled();
  });

  it('attaches an error listener before unref so spawn failures stay handled', () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn(() => child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
    const launch = vi.fn(() => child as unknown as ReturnType<typeof import('node:child_process').spawn>);

    expect(() =>
      launchDaemonDetached(options, launch as unknown as typeof import('node:child_process').spawn)
    ).not.toThrow();
    expect(child.listenerCount('error')).toBeGreaterThan(0);
    expect(() => child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))).not.toThrow();
    expect(child.unref).toHaveBeenCalled();
  });

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
      fileURLToPath(new URL('../dist/cli.js', import.meta.url)),
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
    expect(invocation.args[0]).toBe('daemon');
    expect(invocation.args).not.toContain('--config');
    expect(invocation.env.MCPORTER_DISABLE_AUTORUN).toBe('0');
  });
});
