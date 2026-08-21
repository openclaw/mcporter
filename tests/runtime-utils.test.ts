import { describe, expect, it, vi } from 'vitest';
import { normalizeTimeout, raceWithTimeout } from '../src/runtime/utils.js';

describe('normalizeTimeout', () => {
  it('returns undefined for invalid inputs', () => {
    expect(normalizeTimeout(undefined)).toBeUndefined();
    expect(normalizeTimeout(Number.NaN)).toBeUndefined();
    expect(normalizeTimeout(-10)).toBeUndefined();
    expect(normalizeTimeout(0)).toBeUndefined();
  });

  it('returns a truncated positive integer', () => {
    expect(normalizeTimeout(1500.9)).toBe(1500);
  });

  it('caps values at Node timer maximum instead of wrapping to an immediate timeout', () => {
    expect(normalizeTimeout(Number.MAX_SAFE_INTEGER)).toBe(2_147_483_647);
  });
});

describe('raceWithTimeout', () => {
  it('resolves when the promise settles before the timeout', async () => {
    const promise = raceWithTimeout(Promise.resolve('ok'), 1_000);
    await expect(promise).resolves.toBe('ok');
  });

  it('rejects with a timeout error when exceeding the deadline', async () => {
    vi.useFakeTimers();
    const promise = raceWithTimeout(new Promise<void>(() => {}), 500);
    const expectation = expect(promise).rejects.toThrowError('Timeout');
    vi.advanceTimersByTime(500);
    await expectation;
    vi.useRealTimers();
  });
});
