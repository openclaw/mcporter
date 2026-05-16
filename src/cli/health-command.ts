import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { ServerDefinition } from '../config.js';
import { analyzeConnectionError } from '../error-classifier.js';
import { buildOAuthPersistence } from '../oauth-persistence.js';
import type { Runtime } from '../runtime.js';
import { setStdioLogMode } from '../sdk-patches.js';
import { formatErrorMessage } from './json-output.js';
import { redText, yellowText } from './terminal.js';
import { withTimeout } from './timeouts.js';

export type HealthStatus = 'ok' | 'auth_required' | 'unreachable' | 'error';
export type OAuthState = 'valid' | 'expired' | 'not_required' | 'unknown';

export interface HealthRow {
  server: string;
  status: HealthStatus;
  initialize_ms: number | null;
  tool_count: number | null;
  oauth_state: OAuthState;
  error: string | null;
}

interface HealthFlags {
  readonly server?: string;
  readonly timeoutMs: number;
  readonly format: 'text' | 'json';
  readonly quiet: boolean;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 10_000;
const ERROR_PREVIEW_LENGTH = 200;

export async function handleHealth(runtime: Runtime, args: string[]): Promise<void> {
  const flags = parseHealthFlags(args);
  const previousStdioLogMode = flags.server ? undefined : setStdioLogMode('silent');
  try {
    const definitions = selectHealthServers(runtime, flags.server);

    if (definitions.length === 0) {
      if (!flags.quiet && flags.format === 'json') {
        console.log(JSON.stringify([], null, 2));
      } else if (!flags.quiet) {
        console.log('No MCP servers configured.');
      }
      return;
    }

    const results = await Promise.allSettled(
      definitions.map((definition) => checkServer(definition, runtime, flags.timeoutMs))
    );
    const rows = results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      const server = definitions[index]?.name ?? 'unknown';
      return buildErrorRow(server, result.reason);
    });
    const hasFailures = rows.some((row) => row.status !== 'ok');

    if (hasFailures) {
      process.exitCode = 1;
    }

    if (flags.quiet) {
      return;
    }

    if (flags.format === 'json') {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }

    printHealthTable(rows, flags.timeoutMs);
  } finally {
    if (previousStdioLogMode !== undefined) {
      setStdioLogMode(previousStdioLogMode);
    }
  }
}

export async function checkServer(
  definition: ServerDefinition,
  runtime: Runtime,
  timeoutMs: number
): Promise<HealthRow> {
  const startedAt = performance.now();
  try {
    const tools = await withTimeout(
      runtime.listTools(definition.name, { autoAuthorize: false, allowCachedAuth: true }),
      timeoutMs
    );
    const elapsed = Math.round(performance.now() - startedAt);
    const oauthState = await resolveOAuthState(definition);
    return {
      server: definition.name,
      status: 'ok',
      initialize_ms: elapsed,
      tool_count: tools.length,
      oauth_state: oauthState,
      error: null,
    };
  } catch (error) {
    return {
      ...buildErrorRow(definition.name, error),
      oauth_state: await resolveOAuthState(definition).catch(() => 'unknown' as const),
    };
  }
}

export function printHealthHelp(): void {
  console.log(`Usage: mcporter health [--server <name>] [--timeout <seconds>] [--json] [--quiet]

Check configured MCP servers at a glance.

Flags:
  --server <name>       Check only one configured server.
  --timeout <seconds>   Per-server timeout in seconds (default: 10).
  --json                Emit an array of health rows.
  --quiet               Suppress output and only set the exit code.`);
}

function parseHealthFlags(args: string[]): HealthFlags {
  let server: string | undefined;
  let timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS;
  let format: 'text' | 'json' = 'text';
  let quiet = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) {
      continue;
    }
    if (token === '--server') {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Flag '--server' requires a value.");
      }
      server = value;
      index += 1;
      continue;
    }
    if (token.startsWith('--server=')) {
      server = requireFlagValue('--server', token.slice('--server='.length));
      continue;
    }
    if (token === '--timeout') {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Flag '--timeout' requires a value.");
      }
      timeoutMs = parseTimeoutSeconds(value);
      index += 1;
      continue;
    }
    if (token.startsWith('--timeout=')) {
      timeoutMs = parseTimeoutSeconds(token.slice('--timeout='.length));
      continue;
    }
    if (token === '--json') {
      format = 'json';
      continue;
    }
    if (token === '--quiet') {
      quiet = true;
      continue;
    }
    throw new Error(`Unknown health flag '${token}'.`);
  }

  return { server, timeoutMs, format, quiet };
}

function selectHealthServers(runtime: Runtime, serverName: string | undefined): ServerDefinition[] {
  if (!serverName) {
    return runtime.getDefinitions();
  }
  return [runtime.getDefinition(serverName)];
}

function buildErrorRow(server: string, error: unknown): HealthRow {
  const issue = analyzeConnectionError(error);
  const message = formatErrorMessage(error).slice(0, ERROR_PREVIEW_LENGTH);
  const status: HealthStatus =
    issue.kind === 'auth' ? 'auth_required' : issue.kind === 'offline' ? 'unreachable' : 'error';
  return {
    server,
    status,
    initialize_ms: null,
    tool_count: null,
    oauth_state: 'unknown',
    error: message,
  };
}

async function resolveOAuthState(definition: ServerDefinition): Promise<OAuthState> {
  if (!isOAuthConfigured(definition)) {
    return 'not_required';
  }
  try {
    const persistence = await buildOAuthPersistence(definition);
    const tokens = await persistence.readTokens();
    if (!tokens || !hasAccessToken(tokens)) {
      return 'expired';
    }
    return isExpired(tokens) ? 'expired' : 'valid';
  } catch {
    return 'unknown';
  }
}

function isOAuthConfigured(definition: ServerDefinition): boolean {
  return Boolean(
    definition.auth === 'oauth' ||
    definition.auth === 'refreshable_bearer' ||
    definition.tokenCacheDir ||
    definition.oauthClientId ||
    definition.oauthClientSecret ||
    definition.oauthClientSecretEnv ||
    definition.oauthRedirectUrl ||
    definition.oauthScope ||
    definition.oauthCommand
  );
}

function hasAccessToken(tokens: OAuthTokens): boolean {
  return typeof tokens.access_token === 'string' && tokens.access_token.trim().length > 0;
}

function isExpired(tokens: OAuthTokens): boolean {
  const record = tokens as OAuthTokens & {
    expires_at?: number;
    expiresAt?: number;
  };
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof record.expires_at === 'number' && Number.isFinite(record.expires_at)) {
    return record.expires_at <= nowSeconds;
  }
  if (typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt)) {
    return record.expiresAt <= nowSeconds;
  }
  if (typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in)) {
    return tokens.expires_in <= 0;
  }
  return false;
}

function printHealthTable(rows: readonly HealthRow[], timeoutMs: number): void {
  const timeoutSeconds = Math.round(timeoutMs / 1000);
  console.log(`mcporter health (${rows.length} server${rows.length === 1 ? '' : 's'}, timeout: ${timeoutSeconds}s)`);
  const headers = ['Server', 'Status', 'Latency', 'Tools', 'OAuth', 'Error'];
  const renderedRows = rows.map((row) => [
    row.server,
    colorStatus(row.status),
    row.initialize_ms === null ? '-' : `${row.initialize_ms}ms`,
    row.tool_count === null ? '-' : String(row.tool_count),
    row.oauth_state,
    row.error ?? '',
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...renderedRows.map((row) => stripAnsi(row[index] ?? '').length))
  );

  console.log(formatTableRow(headers, widths));
  console.log(
    formatTableRow(
      widths.map((width) => '-'.repeat(width)),
      widths
    )
  );
  for (const row of renderedRows) {
    console.log(formatTableRow(row, widths));
  }
}

function colorStatus(status: HealthStatus): string {
  if (status === 'ok') {
    return status;
  }
  if (status === 'auth_required') {
    return yellowText(status);
  }
  return redText(status);
}

function formatTableRow(values: readonly string[], widths: readonly number[]): string {
  return values.map((value, index) => padAnsi(value, widths[index] ?? value.length)).join('  ');
}

function padAnsi(value: string, width: number): string {
  return `${value}${' '.repeat(Math.max(0, width - stripAnsi(value).length))}`;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex
}

function parseTimeoutSeconds(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('--timeout must be a positive integer (seconds).');
  }
  return parsed * 1000;
}

function requireFlagValue(flag: string, value: string): string {
  if (!value) {
    throw new Error(`Flag '${flag}' requires a value.`);
  }
  return value;
}
