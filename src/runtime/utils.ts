import { resolveEnvPlaceholders } from '../env.js';

const ENV_PLACEHOLDER_PATTERN = /\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function resolveCommandArgument(value: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!value) {
    return value;
  }
  if (!value.includes('$')) {
    return value;
  }
  const needsInterpolation = value.startsWith('$env:') || ENV_PLACEHOLDER_PATTERN.test(value);
  if (!needsInterpolation) {
    return value;
  }
  return resolveEnvPlaceholders(value, env);
}

export function resolveCommandArguments(args: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
  if (args.length === 0) {
    return [];
  }
  return args.map((arg) => resolveCommandArgument(arg, env));
}

export function normalizeTimeout(raw?: number): number | undefined {
  if (raw == null) {
    return undefined;
  }
  if (!Number.isFinite(raw)) {
    return undefined;
  }
  const coerced = Math.trunc(raw);
  return coerced > 0 ? Math.min(coerced, MAX_TIMER_DELAY_MS) : undefined;
}

export function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const delayMs = Number.isFinite(timeoutMs)
      ? Math.min(Math.max(Math.trunc(timeoutMs), 1), MAX_TIMER_DELAY_MS)
      : MAX_TIMER_DELAY_MS;
    const cancelTimeout = scheduleDeadline(() => {
      // Reject with a Timeout error; higher-level catch blocks decide whether to recycle the transport.
      reject(new Error('Timeout'));
    }, delayMs);
    promise.then(
      (value) => {
        cancelTimeout();
        resolve(value);
      },
      (error) => {
        cancelTimeout();
        reject(error);
      }
    );
  });
}

function scheduleDeadline(callback: () => void, delayMs: number): () => void {
  const deadline = Date.now() + delayMs;
  let timer: NodeJS.Timeout | undefined;
  let cancelled = false;

  const scheduleNext = (): void => {
    if (cancelled) return;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      callback();
    } else if (remainingMs > 86_400_000) {
      timer = setTimeout(scheduleNext, 86_400_000);
    } else if (remainingMs > 3_600_000) {
      timer = setTimeout(scheduleNext, 3_600_000);
    } else if (remainingMs > 60_000) {
      timer = setTimeout(scheduleNext, 60_000);
    } else if (remainingMs > 1_000) {
      timer = setTimeout(scheduleNext, 1_000);
    } else if (remainingMs > 100) {
      timer = setTimeout(scheduleNext, 100);
    } else if (remainingMs > 10) {
      timer = setTimeout(scheduleNext, 10);
    } else {
      timer = setTimeout(scheduleNext, 1);
    }
  };

  scheduleNext();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}
