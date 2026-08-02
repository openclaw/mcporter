import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { printCallOutput, tailLogIfRequested } from '../src/cli/output-utils.js';
import { createCallResult } from '../src/result-utils.js';

function demo() {}

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
      'auto prints the full structuredContent object instead of only its data field',
      'auto',
      {
        structuredContent: {
          status: 'error',
          summary: 'Failed to create base: name is required',
          data: {},
          meta: {},
        },
        content: [
          {
            type: 'text',
            text: '{"status":"error","summary":"Failed to create base: name is required","data":{},"meta":{}}',
          },
        ],
      },
      (logged: unknown) => {
        expect(JSON.parse(String(logged))).toEqual({
          status: 'error',
          summary: 'Failed to create base: name is required',
          data: {},
          meta: {},
        });
      },
    ],
    [
      'auto prints structuredContent nested inside a result wrapper',
      'auto',
      {
        result: {
          content: [
            {
              type: 'text',
              text: '{\n  "entities": [],\n  "relations": []\n}',
            },
          ],
          structuredContent: {
            entities: [],
            relations: [],
          },
        },
      },
      (logged: unknown) => {
        expect(JSON.parse(String(logged))).toEqual({
          entities: [],
          relations: [],
        });
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
        expect(logged).toBe('"raw-only-string"');
      },
    ],
    [
      'json emits valid JSON for object raw fallback instead of inspect output',
      'json',
      { content: [{ type: 'text', text: 'no json here' }] },
      (logged: unknown) => {
        expect(JSON.parse(String(logged))).toEqual({ content: [{ type: 'text', text: 'no json here' }] });
      },
    ],
    [
      'json emits valid JSON for MCP error envelopes instead of inspect output',
      'json',
      { content: [{ type: 'text', text: 'MCP error -32602: Tool search not found' }], isError: true },
      (logged: unknown) => {
        expect(JSON.parse(String(logged))).toEqual({
          content: [{ type: 'text', text: 'MCP error -32602: Tool search not found' }],
          isError: true,
        });
      },
    ],
    [
      'json emits null for undefined raw fallback',
      'json',
      undefined,
      (logged: unknown) => {
        expect(logged).toBe('null');
      },
    ],
    [
      'json emits a JSON string when raw fallback is circular',
      'json',
      (() => {
        const circular: { self?: unknown } = {};
        circular.self = circular;
        return circular;
      })(),
      (logged: unknown) => {
        expect(typeof logged).toBe('string');
        expect(() => JSON.parse(String(logged))).not.toThrow();
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
    [
      'auto falls back to readable raw output for plain object payloads',
      'auto',
      { result: 'Available pages for facebook/react' },
      (logged: unknown) => {
        expect(String(logged)).toContain("result: 'Available pages for facebook/react'");
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

  it.each([
    [null, 'null'],
    [undefined, 'undefined'],
    [12n, '12'],
    [Symbol.for('demo'), 'Symbol(demo)'],
    [demo, 'function demo() {}'],
  ])('prints primitive raw value %s explicitly', (raw, expected) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printCallOutput(createCallResult(raw), raw, 'raw');
      expect(log).toHaveBeenCalledWith(expected);
    } finally {
      log.mockRestore();
    }
  });

  it('falls back from an unserializable JSON candidate to readable raw output', () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const wrapped = {
      json: () => circular,
      markdown: () => null,
      text: () => null,
    } as unknown as ReturnType<typeof createCallResult>;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printCallOutput(wrapped, { fallback: true }, 'auto');
      expect(String(log.mock.calls[0]?.[0])).toContain('self: [Circular');
    } finally {
      log.mockRestore();
    }
  });
});

describe('tailLogIfRequested', () => {
  it('prints only the final twenty lines from recognized absolute log paths', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-tail-log-'));
    const logPath = path.join(dir, 'server.log');
    await fs.writeFile(logPath, Array.from({ length: 25 }, (_, index) => `line-${index + 1}`).join('\n'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      tailLogIfRequested({ logFile: logPath }, true);
      expect(log).toHaveBeenCalledWith(`--- tail ${logPath} ---`);
      expect(log).not.toHaveBeenCalledWith('line-5');
      expect(log).toHaveBeenCalledWith('line-6');
      expect(log).toHaveBeenCalledWith('line-25');
    } finally {
      log.mockRestore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('ignores disabled and non-object inputs and warns for unsafe, missing, or unreadable paths', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-tail-errors-'));
    const missing = path.join(dir, 'missing.log');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      tailLogIfRequested({ logPath: missing }, false);
      tailLogIfRequested(null, true);
      tailLogIfRequested({ logPath: 'relative.log', logfile: missing, logFile: dir }, true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Refusing to tail non-absolute log path'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Log path not found'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Failed to read log file'));
    } finally {
      warn.mockRestore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
