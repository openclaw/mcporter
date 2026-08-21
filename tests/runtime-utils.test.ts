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
    try {
      const promise = raceWithTimeout(new Promise<void>(() => {}), 500);
      const expectation = expect(promise).rejects.toThrowError('Timeout');
      await vi.advanceTimersByTimeAsync(500);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the timeout budget stable across wall-clock adjustments', async () => {
    vi.useFakeTimers();
    try {
      const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_000);
      const { promise: operation, resolve: resolveOperation } = Promise.withResolvers<string>();
      const promise = raceWithTimeout(operation, 500);

      dateNow.mockReturnValue(60_001_000);
      await vi.advanceTimersByTimeAsync(499);
      resolveOperation('ok');

      await expect(promise).resolves.toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });
});
