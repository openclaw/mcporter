import { describe, expect, it, vi } from 'vitest';
import { printCallOutput } from '../src/cli/output-utils.js';
import { createCallResult } from '../src/result-utils.js';

describe('printCallOutput raw output', () => {
  it('does not truncate long strings when printing raw output', () => {
    const longText = 'x'.repeat(15000);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const raw = { t: longText };
    const wrapped = createCallResult(raw);

    try {
      printCallOutput(wrapped, raw, 'raw');

      expect(log).toHaveBeenCalledTimes(1);
      const logged = log.mock.calls[0]?.[0];
      expect(typeof logged).toBe('string');
      expect(logged).not.toContain('... 5000 more characters');
      expect(logged).toContain(longText.slice(-50));
    } finally {
      log.mockRestore();
    }
  });

  it('prints nested values beyond the default inspect depth', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const raw = {
      level1: {
        level2: {
          level3: {
            level4: {
              level5: {
                level6: {
                  leaf: 'done',
                },
              },
            },
          },
        },
      },
    };
    const wrapped = createCallResult(raw);

    try {
      printCallOutput(wrapped, raw, 'raw');

      expect(log).toHaveBeenCalledTimes(1);
      const logged = log.mock.calls[0]?.[0];
      expect(typeof logged).toBe('string');
      expect(logged).toContain("leaf: 'done'");
    } finally {
      log.mockRestore();
    }
  });
});
