import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';

export type ConnectionIssueKind = 'auth' | 'offline' | 'http' | 'stdio-exit' | 'other';

export interface ConnectionIssue {
  kind: ConnectionIssueKind;
  rawMessage: string;
  statusCode?: number;
  stdioExitCode?: number;
  stdioSignal?: string;
}

const AUTH_STATUSES = new Set([401, 403]);
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
const HTTP_STATUS_FALLBACK = /\bhttps?:\/\/[^\s]+(?:\s+returned\s+)?(?:status|code)?\s*(\d{3})\b/i;
const STATUS_DIRECT_PATTERN = /\b(?:status(?:\s+code)?|http(?:\s+(?:status|code|error))?)[:\s]*(\d{3})\b/i;
const STDIO_EXIT_PATTERN = /exit(?:ed)?(?:\s+with)?(?:\s+(?:code|status))\s+(-?\d+)/i;
const STDIO_SIGNAL_PATTERN = /signal\s+([A-Z0-9]+)/i;

export function analyzeConnectionError(error: unknown): ConnectionIssue {
  const rawMessage = extractMessage(error);
  if (error instanceof UnauthorizedError) {
    return { kind: 'auth', rawMessage };
  }
  const stdio = extractStdioExit(rawMessage);
  if (stdio) {
    return { kind: 'stdio-exit', rawMessage, ...stdio };
  }
  const statusCode = extractStatusCode(rawMessage);
  const normalized = rawMessage.toLowerCase();
  if (AUTH_STATUSES.has(statusCode ?? -1) || containsAuthToken(normalized)) {
    return { kind: 'auth', rawMessage, statusCode };
  }
  if (statusCode && statusCode >= 400) {
    return { kind: 'http', rawMessage, statusCode };
  }
  if (OFFLINE_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return { kind: 'offline', rawMessage };
  }
  return { kind: 'other', rawMessage };
}

export function isAuthIssue(issue: ConnectionIssue): boolean {
  return issue.kind === 'auth';
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

function extractStatusCode(message: string): number | undefined {
  const candidates = [
    message.match(/status code\s*\((\d{3})\)/i)?.[1],
    message.match(STATUS_DIRECT_PATTERN)?.[1],
    message.match(HTTP_STATUS_FALLBACK)?.[1],
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

function containsAuthToken(normalizedMessage: string): boolean {
  return (
    normalizedMessage.includes('401') ||
    normalizedMessage.includes('unauthorized') ||
    normalizedMessage.includes('invalid_token') ||
    normalizedMessage.includes('forbidden')
  );
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
