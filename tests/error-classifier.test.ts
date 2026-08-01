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

  describe('error.code property (StreamableHTTPError / SseError)', () => {
    it('classifies code=401 as auth even when message lacks 401', () => {
      const err = Object.assign(new Error('Error POSTing to endpoint: {}'), {
        code: 401,
      });
      const issue = analyzeConnectionError(err);
      expect(issue.kind).toBe('auth');
      expect(issue.statusCode).toBe(401);
    });

    it('classifies code=403 as auth', () => {
      const err = Object.assign(new Error('Forbidden'), { code: 403 });
      const issue = analyzeConnectionError(err);
      expect(issue.kind).toBe('auth');
      expect(issue.statusCode).toBe(403);
    });

    it('classifies code=404 as http (not auth)', () => {
      const err = Object.assign(new Error('Not Found'), { code: 404 });
      const issue = analyzeConnectionError(err);
      expect(issue.kind).toBe('http');
      expect(issue.statusCode).toBe(404);
    });

    it('classifies code=500 as http', () => {
      const err = Object.assign(new Error('Internal Server Error'), {
        code: 500,
      });
      const issue = analyzeConnectionError(err);
      expect(issue.kind).toBe('http');
      expect(issue.statusCode).toBe(500);
    });

    it('falls back to message parsing when code is absent', () => {
      const issue = analyzeConnectionError(new Error('network timeout'));
      expect(issue.kind).toBe('offline');
      expect(issue.statusCode).toBeUndefined();
    });
  });

  describe('transport failures whose text embeds auth-like digits', () => {
    it('keeps a refused connection offline when the port embeds 401', () => {
      const issue = analyzeConnectionError(new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:14012'));
      expect(issue.kind).toBe('offline');
    });

    it('keeps a timeout offline when the duration embeds 401', () => {
      const issue = analyzeConnectionError(new Error('Request timed out after 4010ms'));
      expect(issue.kind).toBe('offline');
    });

    it('keeps a DNS failure offline when the hostname embeds 401', () => {
      const issue = analyzeConnectionError(new Error('getaddrinfo ENOTFOUND mcp-4015.internal'));
      expect(issue.kind).toBe('offline');
    });

    it('does not treat a request id that embeds 401 as auth', () => {
      const issue = analyzeConnectionError(new Error('Error POSTing to endpoint: request 8401f2 failed'));
      expect(issue.kind).not.toBe('auth');
    });
  });

  describe('known status codes take precedence over message keywords', () => {
    it('classifies code=404 as http when the message also mentions unauthorized', () => {
      const err = Object.assign(new Error('Not Found: /unauthorized'), {
        code: 404,
      });
      const issue = analyzeConnectionError(err);
      expect(issue.kind).toBe('http');
      expect(issue.statusCode).toBe(404);
    });

    it('classifies code=500 as http when the message embeds 401', () => {
      const err = Object.assign(new Error('Internal Server Error (request 401ab3)'), { code: 500 });
      const issue = analyzeConnectionError(err);
      expect(issue.kind).toBe('http');
      expect(issue.statusCode).toBe(500);
    });

    it('classifies a parsed 429 as http when the message also mentions forbidden', () => {
      const issue = analyzeConnectionError(new Error('HTTP error 429: rate limited for forbidden_tool'));
      expect(issue.kind).toBe('http');
      expect(issue.statusCode).toBe(429);
    });
  });

  describe('auth detection without a status code is preserved', () => {
    it('classifies a bare unauthorized message as auth', () => {
      const issue = analyzeConnectionError(new Error('Unauthorized'));
      expect(issue.kind).toBe('auth');
    });

    it('classifies a standalone 401 in the message as auth', () => {
      const issue = analyzeConnectionError(new Error('Server replied 401'));
      expect(issue.kind).toBe('auth');
    });

    it('classifies invalid_token in the message as auth', () => {
      const issue = analyzeConnectionError(new Error('OAuth rejected the request: invalid_token'));
      expect(issue.kind).toBe('auth');
    });
  });
});
