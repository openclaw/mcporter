import type { ServerDefinition } from '../config.js';
import { resolveChromeDevtoolsAutoConnectCommand } from '../chrome-devtools-command.js';
import { resolveCommandArgument, resolveCommandArguments } from '../runtime/utils.js';
import { resolveChromeDevtoolsRelayEnvironment } from '../chrome-devtools-relay.js';
const DEFAULT_LIST_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
// Five discoveries and a probe can each take 30s, plus 45s daemon readiness
// and MCP initialization/dispatch. Keep the outer deadline above that total.
const DEFAULT_CHROME_TIMEOUT_MS = 300_000;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

// Deadline for the forced-exit path to flush stdout/stderr before calling
// process.exit(). Lives here rather than in cli.ts so tests can
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

export function resolveListTimeout(override?: number, definition?: ServerDefinition): number {
  return (
    override ??
    parsePositiveInteger(process.env.MCPORTER_LIST_TIMEOUT) ??
    defaultServerTimeout(DEFAULT_LIST_TIMEOUT_MS, definition)
  );
}

// resolveCallTimeout decides the call timeout based on environment overrides.
export function resolveCallTimeout(override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) return override;
  return parseTimeout(process.env.MCPORTER_CALL_TIMEOUT, DEFAULT_CALL_TIMEOUT_MS);
}

export function resolveServerCallTimeout(override?: number, definition?: ServerDefinition, server?: string): number {
  const timeoutMs = resolveCallTimeout(override);
  if (
    (typeof override === 'number' && Number.isFinite(override) && override > 0) ||
    parsePositiveInteger(process.env.MCPORTER_CALL_TIMEOUT)
  )
    return timeoutMs;
  // The daemon-only runtime intentionally has no definitions; it admits this canonical alias directly.
  if (!definition && server === 'chrome-devtools') return DEFAULT_CHROME_TIMEOUT_MS;
  return defaultServerTimeout(timeoutMs, definition);
}

function defaultServerTimeout(fallback: number, definition?: ServerDefinition): number {
  if (definition?.command.kind !== 'stdio') return fallback;
  try {
    const env = resolveChromeDevtoolsRelayEnvironment(definition.env);
    const command = resolveCommandArgument(definition.command.command, env);
    const args = resolveCommandArguments(definition.command.args, env);
    return resolveChromeDevtoolsAutoConnectCommand(command, args).enabled ? DEFAULT_CHROME_TIMEOUT_MS : fallback;
  } catch {
    // Let the server operation report unresolved configuration without aborting a multi-server list.
    return fallback;
  }
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
