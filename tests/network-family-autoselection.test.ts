import { describe, expect, it, vi } from 'vitest';
import { configureAutoSelectFamilyAttemptTimeout } from '../src/network-family-autoselection.js';

describe('Happy-Eyeballs connect attempt timeout', () => {
  it('raises Node stock default to 1500ms', () => {
    const defaults = {
      getDefaultAutoSelectFamilyAttemptTimeout: vi.fn(() => 250),
      setDefaultAutoSelectFamilyAttemptTimeout: vi.fn(),
    };

    expect(configureAutoSelectFamilyAttemptTimeout(defaults, undefined)).toBe(true);
    expect(defaults.setDefaultAutoSelectFamilyAttemptTimeout).toHaveBeenCalledWith(1_500);
  });

  it('respects an existing API override', () => {
    const defaults = {
      getDefaultAutoSelectFamilyAttemptTimeout: vi.fn(() => 900),
      setDefaultAutoSelectFamilyAttemptTimeout: vi.fn(),
    };

    expect(configureAutoSelectFamilyAttemptTimeout(defaults, undefined)).toBe(false);
    expect(defaults.setDefaultAutoSelectFamilyAttemptTimeout).not.toHaveBeenCalled();
  });

  it('respects an explicit NODE_OPTIONS override even when it matches Node stock default', () => {
    const defaults = {
      getDefaultAutoSelectFamilyAttemptTimeout: vi.fn(() => 250),
      setDefaultAutoSelectFamilyAttemptTimeout: vi.fn(),
    };

    expect(
      configureAutoSelectFamilyAttemptTimeout(defaults, '--network-family-autoselection-attempt-timeout=250')
    ).toBe(false);
    expect(defaults.setDefaultAutoSelectFamilyAttemptTimeout).not.toHaveBeenCalled();
  });

  it.each([
    "'--network-family-autoselection-attempt-timeout=250'",
    '  "--network-family-autoselection-attempt-timeout=250"  ',
    "--trace-warnings '--network-family-autoselection-attempt-timeout 250'",
  ])('respects quoted NODE_OPTIONS overrides: %s', (nodeOptions) => {
    const defaults = {
      getDefaultAutoSelectFamilyAttemptTimeout: vi.fn(() => 250),
      setDefaultAutoSelectFamilyAttemptTimeout: vi.fn(),
    };

    expect(configureAutoSelectFamilyAttemptTimeout(defaults, nodeOptions)).toBe(false);
    expect(defaults.setDefaultAutoSelectFamilyAttemptTimeout).not.toHaveBeenCalled();
  });
});
