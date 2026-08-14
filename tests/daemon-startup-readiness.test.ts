import { describe, expect, it, vi } from 'vitest';
import { DAEMON_STARTUP_TIMEOUT_MS, waitForDaemonReady } from '../src/daemon/startup-readiness.js';

describe('daemon startup readiness', () => {
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
