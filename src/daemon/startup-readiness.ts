export const DAEMON_STARTUP_TIMEOUT_MS = 45_000;

const DAEMON_STARTUP_SLOW_NOTICE_MS = 5_000;
const DAEMON_STARTUP_POLL_INTERVAL_MS = 100;

export interface DaemonStartupReadinessTiming {
  readonly now?: () => number;
  readonly delay?: (ms: number) => Promise<void>;
  readonly reportSlowStart?: () => void;
}

export async function waitForDaemonReady<T>(
  probe: (timeoutMs: number) => Promise<T | null>,
  timing: DaemonStartupReadinessTiming = {}
): Promise<T> {
  const now = timing.now ?? Date.now;
  const wait = timing.delay ?? delay;
  const reportSlowStart = timing.reportSlowStart ?? defaultSlowStartReporter;
  const startedAt = now();
  const deadline = startedAt + DAEMON_STARTUP_TIMEOUT_MS;
  let reportedSlowStart = false;

  while (true) {
    const remainingBeforeProbe = deadline - now();
    if (remainingBeforeProbe <= 0) {
      throw daemonStartupTimeoutError();
    }

    const result = await probe(Math.min(DAEMON_STARTUP_POLL_INTERVAL_MS, remainingBeforeProbe)).catch(
      (error: unknown) => {
        // Only readiness's read-only status probe can be repeated after a timeout.
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ETIMEDOUT') return null;
        throw error;
      }
    );
    if (result !== null) {
      return result;
    }

    const currentTime = now();
    if (currentTime >= deadline) {
      throw daemonStartupTimeoutError();
    }
    if (!reportedSlowStart && currentTime - startedAt >= DAEMON_STARTUP_SLOW_NOTICE_MS) {
      reportedSlowStart = true;
      reportSlowStart();
    }

    await wait(Math.min(DAEMON_STARTUP_POLL_INTERVAL_MS, deadline - currentTime));
  }
}

function defaultSlowStartReporter(): void {
  console.error(
    '[mcporter] Daemon startup is taking longer than usual; Chrome relay discovery can take up to 30 seconds.'
  );
}

function daemonStartupTimeoutError(): Error {
  return new Error(
    "MCPorter daemon did not become ready within 45 seconds. Run 'mcporter daemon start --foreground --log' to diagnose startup."
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
