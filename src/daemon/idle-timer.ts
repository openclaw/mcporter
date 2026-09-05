// Native timers overflow above this delay; keep the configured deadline in elapsed time.
export const MAX_NATIVE_TIMER_MS = 2_147_483_647;

export function idleTimerDelay(timeoutMs: number, lastActivity: number): number {
  const remaining = timeoutMs - (Date.now() - lastActivity);
  // An expired but blocked host checks again at its ordinary interval, without spinning.
  return Math.min(MAX_NATIVE_TIMER_MS, Math.max(1, remaining > 0 ? remaining : timeoutMs));
}
