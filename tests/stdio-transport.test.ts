import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';
import { McporterStdioTransport } from '../src/runtime/stdio-transport.js';
import { evaluateStdioLogPolicy, type StdioLogMode } from '../src/sdk-stdio-logging.js';

function evaluate(mode: StdioLogMode, hasStderr: boolean, exitCode: number | null) {
  return evaluateStdioLogPolicy(mode, hasStderr, exitCode);
}

describe('McporterStdioTransport', () => {
  it('is an SDK stdio subclass with stderr available before start', () => {
    const transport = new McporterStdioTransport({ command: 'unused' });
    expect(transport).toBeInstanceOf(StdioClientTransport);
    expect(transport.stderr).not.toBeNull();
  });

  it('prints logs in auto mode only for a non-zero exit with stderr', () => {
    expect(evaluate('auto', true, 1)).toBe(true);
    expect(evaluate('auto', true, 0)).toBe(false);
    expect(evaluate('auto', false, 1)).toBe(false);
  });

  it('supports always and silent policy overrides', () => {
    expect(evaluate('always', true, 0)).toBe(true);
    expect(evaluate('always', true, null)).toBe(true);
    expect(evaluate('silent', true, 2)).toBe(false);
    expect(evaluate('silent', true, null)).toBe(false);
  });
});
