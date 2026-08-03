const DEFAULT_LIST_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

// Deadline for the forced-exit path to flush stdout/stderr before calling
// process.exit(). Lives here (a leaf module) rather than in cli.ts so tests can
// derive their force-exit bounds from it without importing the CLI entrypoint,
// which auto-runs main() on import.
export const STDOUT_FLUSH_TIMEOUT_MS = 2000;

export function parsePositiveInteger(raw: string | undefined): number | undefined {
  if (!raw || !POSITIVE_INTEGER_PATTERN.test(raw)) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// parseTimeout reads timeout values from strings while honoring defaults.
export function parseTimeout(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  return parsePositiveInteger(raw) ?? fallback;
}

export const LIST_TIMEOUT_MS = parseTimeout(process.env.MCPORTER_LIST_TIMEOUT, DEFAULT_LIST_TIMEOUT_MS);

// resolveCallTimeout decides the call timeout based on environment overrides.
export function resolveCallTimeout(override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return override;
  }
  return parseTimeout(process.env.MCPORTER_CALL_TIMEOUT, DEFAULT_CALL_TIMEOUT_MS);
}

// withTimeout races a promise against a timeout to avoid hangs.
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  return raceWithTimeout(promise, timeoutMs);
}

export function consumeTimeoutFlag(
  args: string[],
  index: number,
  options?: { flagName?: string; missingValueMessage?: string }
): number {
  const flagName = options?.flagName ?? '--timeout';
  const missingValueMessage = options?.missingValueMessage ?? `Flag '${flagName}' requires a value.`;
  const value = args[index + 1];
  if (!value) {
    throw new Error(missingValueMessage);
  }
  const parsed = parsePositiveInteger(value);
  if (parsed === undefined) {
    throw new Error(`${flagName} must be a positive integer (milliseconds).`);
  }
  args.splice(index, 2);
  return parsed;
}
import { raceWithTimeout } from '../runtime/utils.js';
