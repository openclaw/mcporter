import { describe, expect, it, vi } from 'vitest';
import { DAEMON_STARTUP_TIMEOUT_MS, waitForDaemonReady } from '../src/daemon/startup-readiness.js';

describe('daemon startup readiness', () => {
  it('repeats timed-out status probes within the existing deadline and never swallows authentication errors', async () => {
    let currentTime = 0;
    const probe = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('status timeout'), { code: 'ETIMEDOUT' }))
      .mockResolvedValue({ pid: 42 });
    const timing = {
      now: () => currentTime,
      delay: async (ms: number) => {
        currentTime += ms;
      },
    };
    await expect(waitForDaemonReady(probe, timing)).resolves.toEqual({ pid: 42 });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe.mock.calls).toEqual([[100], [100]]);
    expect(currentTime).toBe(100);
    const denied = vi.fn().mockRejectedValue(new Error('Daemon authentication failed.'));
    await expect(waitForDaemonReady(denied, timing)).rejects.toThrow('Daemon authentication failed.');
    expect(denied).toHaveBeenCalledOnce();
  });
  it('keeps polling beyond ten seconds and reports a slow start once', async () => {
    let currentTime = 0;
    const probe = vi.fn(async () => (currentTime >= 12_000 ? { pid: 42 } : null));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await waitForDaemonReady(probe, {
        now: () => currentTime,
        delay: async (ms) => {
          currentTime += ms;
        },
      });

      expect(result).toEqual({ pid: 42 });
      expect(currentTime).toBe(12_000);
      expect(errorSpy).toHaveBeenCalledOnce();
      expect(errorSpy).toHaveBeenCalledWith(
        '[mcporter] Daemon startup is taking longer than usual; Chrome relay discovery can take up to 30 seconds.'
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('times out at 45 seconds with foreground logging guidance', async () => {
    let currentTime = 0;

    const readiness = waitForDaemonReady(async () => null, {
      now: () => currentTime,
      delay: async (ms) => {
        currentTime += ms;
      },
      reportSlowStart: vi.fn(),
    });

    await expect(readiness).rejects.toThrow(
      "MCPorter daemon did not become ready within 45 seconds. Run 'mcporter daemon start --foreground --log' to diagnose startup."
    );
    expect(currentTime).toBe(DAEMON_STARTUP_TIMEOUT_MS);
  });
});
