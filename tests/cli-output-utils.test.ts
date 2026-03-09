import { describe, expect, it, vi } from 'vitest';
import { printCallOutput } from '../src/cli/output-utils.js';
import { createCallResult } from '../src/result-utils.js';

describe('printCallOutput format selection', () => {
  it.each([
    [
      'auto prefers json payloads when available',
      'auto',
      {
        content: [
          { type: 'text', text: 'fallback text' },
          { type: 'json', json: { source: 'json' } },
          { type: 'markdown', text: '# heading' },
        ],
      },
      (logged: unknown) => {
        expect(JSON.parse(String(logged))).toEqual({ source: 'json' });
      },
    ],
    [
      'text prefers text over markdown/json',
      'text',
      {
        content: [
          { type: 'text', text: 'plain text wins' },
          { type: 'markdown', text: '# heading' },
          { type: 'json', json: { source: 'json' } },
        ],
      },
      (logged: unknown) => {
        expect(logged).toBe('plain text wins\n# heading');
      },
    ],
    [
      'markdown prefers markdown content',
      'markdown',
      {
        content: [
          { type: 'text', text: 'plain text' },
          { type: 'markdown', text: '## markdown wins' },
        ],
      },
      (logged: unknown) => {
        expect(logged).toBe('## markdown wins');
      },
    ],
    [
      'json falls back to raw output when no JSON candidate exists',
      'json',
      'raw-only-string',
      (logged: unknown) => {
        expect(logged).toBe('raw-only-string');
      },
    ],
    [
      'raw prints inspect output even when json exists',
      'raw',
      { content: [{ type: 'json', json: { id: 1 } }] },
      (logged: unknown) => {
        expect(String(logged)).toContain("type: 'json'");
      },
    ],
  ] as const)('%s', (_name, format, raw, assertLogged) => {
    const wrapped = createCallResult(raw);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      printCallOutput(wrapped, raw, format);
      expect(log).toHaveBeenCalledTimes(1);
      const logged = log.mock.calls[0]?.[0];
      assertLogged(logged);
    } finally {
      log.mockRestore();
    }
  });
});

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
