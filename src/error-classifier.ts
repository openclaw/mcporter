import { SdkHttpError, SseError, UnauthorizedError } from '@modelcontextprotocol/client';

export type ConnectionIssueKind = 'auth' | 'offline' | 'http' | 'stdio-exit' | 'other';

export interface ConnectionIssue {
  kind: ConnectionIssueKind;
  rawMessage: string;
  statusCode?: number;
  stdioExitCode?: number;
  stdioSignal?: string;
}

const AUTH_STATUSES = new Set([401, 403]);
// Keywords are unambiguous auth signals, so they outrank offline patterns: a rejected token is
// often reported alongside transport wording ("Access token expired; connection timed out").
// They stay substring matches because OAuth error codes embed them with underscores
// ("unauthorized_client", "invalid_token_hint").
const KEYWORD_AUTH_PATTERNS = [/unauthorized/, /invalid_token/, /forbidden/];
// A bare 401 is ambiguous, so it only applies once transport failures are ruled out, and only
// when it stands alone as a token. Ports, durations, hostnames, and request ids
// ("127.0.0.1:14012", "4010ms", "abc401def", "request_401_id") are therefore not read as one.
const NUMERIC_AUTH_PATTERNS = [/(?<![0-9a-z_])401(?![0-9a-z_])/i];
const OFFLINE_PATTERNS = [
  'fetch failed',
  'econnrefused',
  'connection refused',
  'connection closed',
  'connection reset',
  'socket hang up',
  'connect timeout',
  'network is unreachable',
  'timed out',
  'timeout',
  'timeout after',
  'getaddrinfo',
  'enotfound',
  'enoent',
  'eai_again',
  'econnaborted',
  'ehostunreach',
  'no such host',
  'failed to start',
  'spawn enoent',
];
const STATUS_DIRECT_PATTERN = /\b(?:status(?:\s+code)?|http(?:\s+(?:status|code|error))?)[:\s]*(\d{3})\b/i;
const STDIO_EXIT_PATTERN = /exit(?:ed)?(?:\s+with)?(?:\s+(?:code|status))\s+(-?\d+)/i;
const STDIO_SIGNAL_PATTERN = /signal\s+([A-Z0-9]+)/i;

export function analyzeConnectionError(error: unknown): ConnectionIssue {
  const rawMessage = extractMessage(error);
  if (error instanceof UnauthorizedError) {
    return { kind: 'auth', rawMessage };
  }
  if (error instanceof SdkHttpError) {
    return {
      kind: AUTH_STATUSES.has(error.status) ? 'auth' : 'http',
      rawMessage,
      statusCode: error.status,
    };
  }
  if (error instanceof SseError && typeof error.code === 'number') {
    return {
      kind: AUTH_STATUSES.has(error.code) ? 'auth' : 'http',
      rawMessage,
      statusCode: error.code,
    };
  }
  const stdio = extractStdioExit(rawMessage);
  if (stdio) {
    return { kind: 'stdio-exit', rawMessage, ...stdio };
  }
  const errorCode = extractErrorCode(error);
  const statusCode = errorCode ?? extractStatusCode(rawMessage);
  const normalized = rawMessage.toLowerCase();
  if (statusCode !== undefined) {
    if (AUTH_STATUSES.has(statusCode)) {
      return { kind: 'auth', rawMessage, statusCode };
    }
    if (statusCode >= 400) {
      return { kind: 'http', rawMessage, statusCode };
    }
  }
  if (matchesAny(KEYWORD_AUTH_PATTERNS, normalized)) {
    return { kind: 'auth', rawMessage, statusCode };
  }
  if (OFFLINE_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return { kind: 'offline', rawMessage };
  }
  if (matchesAny(NUMERIC_AUTH_PATTERNS, normalized)) {
    return { kind: 'auth', rawMessage, statusCode };
  }
  return { kind: 'other', rawMessage };
}

function extractMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message ?? '';
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error === undefined || error === null) {
    return '';
  }
  try {
    return JSON.stringify(error);
  } catch {
    return '';
  }
}

function extractErrorCode(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === 'number' && Number.isFinite(code) && code >= 100 && code < 600) {
      return code;
    }
  }
  return undefined;
}

function extractStatusCode(message: string): number | undefined {
  const candidates = [
    message.match(/status code\s*\((\d{3})\)/i)?.[1],
    message.match(STATUS_DIRECT_PATTERN)?.[1],
    extractStatusAfterUrl(message),
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const parsed = Number.parseInt(candidate, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  const trimmed = message.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const candidate = findStatusInObject(parsed);
      if (typeof candidate === 'number') {
        return candidate;
      }
      if (typeof candidate === 'string') {
        const numeric = Number.parseInt(candidate, 10);
        if (Number.isFinite(numeric)) {
          return numeric;
        }
      }
    } catch {
      // fall through when the payload is not JSON
    }
  }
  return undefined;
}

function extractStatusAfterUrl(message: string): string | undefined {
  const normalized = message.toLowerCase();
  let searchStart = 0;
  while (searchStart < message.length) {
    const urlStart = findNextHttpUrl(normalized, searchStart);
    if (urlStart === -1) {
      return undefined;
    }
    let separatorIndex = urlStart;
    while (separatorIndex < normalized.length && !/\s/.test(normalized.charAt(separatorIndex))) {
      separatorIndex += 1;
    }
    if (separatorIndex < normalized.length) {
      const candidate = extractStatusFromUrlTail(normalized, separatorIndex);
      if (candidate !== undefined) {
        return candidate;
      }
    }
    searchStart = separatorIndex;
  }
  return undefined;
}

function extractStatusFromUrlTail(value: string, start: number): string | undefined {
  let cursor = skipWhitespace(value, start);
  for (const prefix of ['returned status', 'returned code', 'returned', 'status', 'code']) {
    if (value.startsWith(prefix, cursor)) {
      cursor = skipWhitespace(value, cursor + prefix.length);
      break;
    }
  }
  const candidate = value.slice(cursor, cursor + 3);
  const boundary = value.charAt(cursor + 3);
  return /^\d{3}$/.test(candidate) && !/[a-z0-9_]/i.test(boundary) ? candidate : undefined;
}

function skipWhitespace(value: string, start: number): number {
  let index = start;
  while (index < value.length && /\s/.test(value.charAt(index))) {
    index += 1;
  }
  return index;
}

function findNextHttpUrl(value: string, searchStart: number): number {
  let index = searchStart;
  while (index < value.length) {
    const candidate = value.indexOf('http', index);
    if (candidate === -1) {
      return -1;
    }
    const isUrl = value.startsWith('http://', candidate) || value.startsWith('https://', candidate);
    if (isUrl && (candidate === 0 || !/[a-z0-9_]/i.test(value.charAt(candidate - 1)))) {
      return candidate;
    }
    index = candidate + 1;
  }
  return -1;
}

function matchesAny(patterns: readonly RegExp[], normalizedMessage: string): boolean {
  return patterns.some((pattern) => pattern.test(normalizedMessage));
}

function extractStdioExit(message: string): { stdioExitCode?: number; stdioSignal?: string } | undefined {
  if (!message.toLowerCase().includes('stdio') && !STDIO_EXIT_PATTERN.test(message)) {
    return undefined;
  }
  const exitMatch = message.match(STDIO_EXIT_PATTERN);
  const signalMatch = message.match(STDIO_SIGNAL_PATTERN);
  if (!exitMatch && !signalMatch) {
    return undefined;
  }
  const exitCode = exitMatch ? Number.parseInt(exitMatch[1] ?? '', 10) : undefined;
  return {
    stdioExitCode: Number.isFinite(exitCode) ? exitCode : undefined,
    stdioSignal: signalMatch?.[1],
  };
}

function findStatusInObject(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.status === 'number' || typeof record.status === 'string') {
    return record.status;
  }
  if (typeof record.code === 'number' || typeof record.code === 'string') {
    return record.code;
  }
  if (typeof record.error === 'object' && record.error !== null) {
    return findStatusInObject(record.error);
  }
  return undefined;
}
