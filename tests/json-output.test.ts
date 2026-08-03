import { describe, expect, it } from 'vitest';
import { buildConnectionIssueEnvelope, formatErrorMessage, serializeConnectionIssue } from '../src/cli/json-output.js';

describe('JSON connection issue output', () => {
  it('serializes every diagnostic field without inventing missing values', () => {
    expect(
      buildConnectionIssueEnvelope({
        server: 'local',
        tool: 'run',
        error: new Error('failed'),
        issue: {
          kind: 'stdio-exit',
          statusCode: 500,
          stdioExitCode: 3,
          stdioSignal: 'SIGTERM',
          rawMessage: 'raw failure',
        },
      })
    ).toEqual({
      server: 'local',
      tool: 'run',
      error: 'failed',
      issue: {
        kind: 'stdio-exit',
        statusCode: 500,
        stdioExitCode: 3,
        stdioSignal: 'SIGTERM',
        rawMessage: 'raw failure',
      },
    });
    expect(serializeConnectionIssue()).toBeUndefined();
  });

  it('formats strings, nullish failures, objects, and circular values safely', () => {
    expect(formatErrorMessage('plain')).toBe('plain');
    expect(formatErrorMessage(undefined)).toBe('Unknown error');
    expect(formatErrorMessage({ code: 42 })).toBe('{"code":42}');
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(formatErrorMessage(circular)).toBe('Unknown error');
  });
});
