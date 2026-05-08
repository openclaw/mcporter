import { describe, expect, it } from 'vitest';
import { parseOAuthTimeout } from '../src/runtime/oauth.js';

describe('parseOAuthTimeout', () => {
  it('falls back to default on missing or invalid values', () => {
    expect(parseOAuthTimeout(undefined)).toBe(300_000);
    expect(parseOAuthTimeout('not-a-number')).toBe(300_000);
    expect(parseOAuthTimeout('-500')).toBe(300_000);
  });

  it('parses valid integer inputs', () => {
    expect(parseOAuthTimeout('45000')).toBe(45_000);
  });
});
