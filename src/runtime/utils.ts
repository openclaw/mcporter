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
    const timer = setTimeout(() => {
      // Reject with a Timeout error; higher-level catch blocks decide whether to recycle the transport.
      reject(new Error('Timeout'));
    }, delayMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
