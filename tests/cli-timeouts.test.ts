import { describe, expect, it } from 'vitest';
import { CliUsageError } from '../src/cli/errors.js';
import { consumeTimeoutFlag, parseTimeout } from '../src/cli/timeouts.js';

describe('CLI timeout parsing', () => {
  it('accepts positive integer millisecond values', () => {
    expect(parseTimeout('2500', 30_000)).toBe(2_500);

    const args = ['--timeout', '7500', 'server'];
    expect(consumeTimeoutFlag(args, 0)).toBe(7_500);
    expect(args).toEqual(['server']);
  });

  it('falls back for non-positive and partially numeric environment values', () => {
    for (const value of ['0', '-1', '1s', '10abc', '100.5']) {
      expect(parseTimeout(value, 30_000)).toBe(30_000);
    }
  });

  it('rejects non-positive and partially numeric CLI flag values', () => {
    for (const value of ['0', '-1', '1s', '10abc', '100.5']) {
      expect(() => consumeTimeoutFlag(['--timeout', value], 0)).toThrow(
        new CliUsageError('--timeout must be a positive integer (milliseconds).')
      );
      expect(() => consumeTimeoutFlag(['--timeout', value], 0)).toThrow(CliUsageError);
    }
  });

  it('reports a missing value as a usage error', () => {
    expect(() => consumeTimeoutFlag(['--timeout'], 0)).toThrow(CliUsageError);
    expect(() => consumeTimeoutFlag(['--timeout'], 0)).toThrow("Flag '--timeout' requires a value.");
  });
});
