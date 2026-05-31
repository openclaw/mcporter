import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { handleRecordCli } from '../src/cli/record-command.js';
import { handleReplayCli } from '../src/cli/replay-command.js';

const spawnMock = vi.hoisted(() => {
  const calls: Array<{ command: string; args: string[]; options: { env?: NodeJS.ProcessEnv } }> = [];
  const spawn = vi.fn((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ command, args, options });
    const child = {
      once(event: string, handler: (codeOrError: number | Error | null, signal?: NodeJS.Signals | null) => void) {
        if (event === 'exit') {
          queueMicrotask(() => handler(0, null));
        }
        return child;
      },
    };
    return child;
  });
  return { calls, spawn };
});

vi.mock('node:child_process', () => ({
  spawn: spawnMock.spawn,
}));

const originalEnv = { ...process.env };

describe('record/replay CLI command environments', () => {
  beforeEach(() => {
    spawnMock.calls.length = 0;
    spawnMock.spawn.mockClear();
    process.exitCode = undefined;
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
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
});
