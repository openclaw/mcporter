import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { handleRecordCli } from '../src/cli/record-command.js';
import { handleReplayCli } from '../src/cli/replay-command.js';

const spawnMock = vi.hoisted(() => {
  const calls: Array<{ command: string; args: string[]; options: { env?: NodeJS.ProcessEnv } }> = [];
  let exitCode: number | null = 0;
  let exitSignal: NodeJS.Signals | null = null;
  const spawn = vi.fn((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ command, args, options });
    const child = {
      once(event: string, handler: (codeOrError: number | Error | null, signal?: NodeJS.Signals | null) => void) {
        if (event === 'exit') {
          queueMicrotask(() => handler(exitCode, exitSignal));
        }
        return child;
      },
    };
    return child;
  });
  return {
    calls,
    spawn,
    setExit(code: number | null, signal: NodeJS.Signals | null = null) {
      exitCode = code;
      exitSignal = signal;
    },
  };
});

vi.mock('node:child_process', () => ({
  spawn: spawnMock.spawn,
}));

const originalEnv = { ...process.env };

describe('record/replay CLI command environments', () => {
  beforeEach(() => {
    spawnMock.calls.length = 0;
    spawnMock.spawn.mockClear();
    spawnMock.setExit(0);
    process.exitCode = undefined;
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('clears replay mode and disables keep-alive fast paths while recording a command', async () => {
    process.env.MCPORTER_REPLAY = 'stale';
    process.env.MCPORTER_REPLAY_SERVER = 'linear';

    await handleRecordCli(['demo', '--server', 'github', '--', 'node', 'script.js']);

    expect(spawnMock.calls).toHaveLength(1);
    const env = spawnMock.calls[0]?.options.env;
    expect(env).toMatchObject({
      MCPORTER_RECORD: 'demo',
      MCPORTER_RECORD_SERVER: 'github',
      MCPORTER_DISABLE_KEEPALIVE: '*',
    });
    expect(env).not.toHaveProperty('MCPORTER_REPLAY');
    expect(env).not.toHaveProperty('MCPORTER_REPLAY_SERVER');
  });

  it('clears recording mode and disables keep-alive fast paths while replaying a command', async () => {
    process.env.MCPORTER_RECORD = 'stale';
    process.env.MCPORTER_RECORD_SERVER = 'linear';

    await handleReplayCli(['demo', '--server', 'github', '--', 'node', 'script.js']);

    expect(spawnMock.calls).toHaveLength(1);
    const env = spawnMock.calls[0]?.options.env;
    expect(env).toMatchObject({
      MCPORTER_REPLAY: 'demo',
      MCPORTER_REPLAY_SERVER: 'github',
      MCPORTER_DISABLE_KEEPALIVE: '*',
    });
    expect(env).not.toHaveProperty('MCPORTER_RECORD');
    expect(env).not.toHaveProperty('MCPORTER_RECORD_SERVER');
  });

  it('writes manual record config and instructions that disable keep-alive fast paths', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-record-cli-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleRecordCli(['demo', '--server', 'github']);

    const configPath = path.join(tempHome, '.mcporter', 'recordings', 'demo.config.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(config).toEqual({
      session: 'demo',
      server: 'github',
      mode: 'record',
      recordPath: path.join(tempHome, '.mcporter', 'recordings', 'demo.ndjson'),
      env: {
        MCPORTER_RECORD: 'demo',
        MCPORTER_RECORD_SERVER: 'github',
        MCPORTER_DISABLE_KEEPALIVE: '*',
      },
    });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Set MCPORTER_RECORD=demo and MCPORTER_RECORD_SERVER=github and MCPORTER_DISABLE_KEEPALIVE=*'
      )
    );
    await expectPrivateRecordingPermissions(configPath);
  });

  it('writes manual replay config and instructions that disable keep-alive fast paths', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-replay-cli-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleReplayCli(['demo', '--server', 'github']);

    const configPath = path.join(tempHome, '.mcporter', 'recordings', 'demo.config.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(config).toEqual({
      session: 'demo',
      server: 'github',
      mode: 'replay',
      replayPath: path.join(tempHome, '.mcporter', 'recordings', 'demo.ndjson'),
      env: {
        MCPORTER_REPLAY: 'demo',
        MCPORTER_REPLAY_SERVER: 'github',
        MCPORTER_DISABLE_KEEPALIVE: '*',
      },
    });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Set MCPORTER_REPLAY=demo and MCPORTER_REPLAY_SERVER=github and MCPORTER_DISABLE_KEEPALIVE=*'
      )
    );
    await expectPrivateRecordingPermissions(configPath);
  });

  it('propagates nonzero child exit codes', async () => {
    spawnMock.setExit(7);

    await handleRecordCli(['demo', '--', 'node', 'script.js']);

    expect(process.exitCode).toBe(7);
  });

  it('rejects child signal termination with the existing command error', async () => {
    spawnMock.setExit(null, 'SIGTERM');

    await expect(handleReplayCli(['demo', '--', 'node', 'script.js'])).rejects.toThrow(
      "Command 'node' exited from signal SIGTERM."
    );
  });
});

async function expectPrivateRecordingPermissions(filePath: string): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }
  expect((await fs.stat(path.dirname(filePath))).mode & 0o777).toBe(0o700);
  expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
}
