import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { describe, expect, it } from 'vitest';
import { analyzeConnectionError } from '../src/error-classifier.js';

describe('analyzeConnectionError', () => {
  it('detects UnauthorizedError instances', () => {
    const issue = analyzeConnectionError(new UnauthorizedError('needs auth'));
    expect(issue.kind).toBe('auth');
  });

  it('flags offline transport failures', () => {
    const issue = analyzeConnectionError(new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:9000'));
    expect(issue.kind).toBe('offline');
  });

  it('parses stdio exit codes', () => {
    const issue = analyzeConnectionError(new Error('STDIO transport exited with code 2 (signal SIGTERM)'));
    expect(issue.kind).toBe('stdio-exit');
    expect(issue.stdioExitCode).toBe(2);
    expect(issue.stdioSignal).toBe('SIGTERM');
  });

  it('extracts HTTP status codes from plain text', () => {
    const issue = analyzeConnectionError(new Error('HTTP error 429: rate limited'));
    expect(issue.kind).toBe('http');
    expect(issue.statusCode).toBe(429);
  });

  it.each([401, 403] as const)('keeps %s classified as auth', (status) => {
    const issue = analyzeConnectionError(new Error(`SSE error: Non-200 status code (${status})`));
    expect(issue.kind).toBe('auth');
    expect(issue.statusCode).toBe(status);
  });

  it('classifies HTTP 405 as transport/http instead of auth', () => {
    const issue = analyzeConnectionError(new Error('SSE error: Non-200 status code (405)'));
    expect(issue.kind).toBe('http');
    expect(issue.statusCode).toBe(405);
  });

  it('extracts HTTP status codes from JSON payloads', () => {
    const issue = analyzeConnectionError(new Error('{"error":{"status":503}}'));
    expect(issue.kind).toBe('http');
    expect(issue.statusCode).toBe(503);
  });
});
