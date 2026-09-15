import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntime } from '../src/runtime.js';

const fixture = fileURLToPath(new URL('./servers/unsigned-format-output.mjs', import.meta.url));
const validOutput = { apps: [{ pid: 123 }], window_id: 456, timestamp: '2026-09-15T09:47:33Z' };

afterEach(() => vi.restoreAllMocks());

describe('unsigned integer output formats', () => {
  it.each([
    undefined,
    'http://json-schema.org/draft-07/schema#',
    'https://json-schema.org/draft/2019-09/schema',
    'https://json-schema.org/draft/2020-12/schema',
  ])('discovers and validates %s schemas without console warnings', async (dialect) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = await createRuntime({
      servers: [
        {
          name: 'unsigned-formats',
          protocolVersion: 'legacy',
          command: {
            kind: 'stdio',
            command: process.execPath,
            args: [fixture, ...(dialect ? [dialect] : [])],
            cwd: process.cwd(),
          },
        },
      ],
    });
    try {
      const tools = await runtime.listTools('unsigned-formats', { includeSchema: true });
      expect(tools[0]?.outputSchema).toMatchObject({
        anyOf: [{ properties: { window_id: { type: 'integer', format: 'uint64', minimum: 0 } } }],
      });
      await expect(runtime.callTool('unsigned-formats', 'echo', { args: validOutput })).resolves.toMatchObject({
        structuredContent: validOutput,
      });
      expect(warn).not.toHaveBeenCalled();
      for (const invalid of [
        { ...validOutput, apps: [{ pid: '123' }] },
        { ...validOutput, apps: [{ pid: -1 }] },
        { ...validOutput, apps: [{ pid: 4294967296 }] },
        { ...validOutput, window_id: 1.5 },
        { ...validOutput, timestamp: 'not-a-date' },
        { apps: [], window_id: 123 },
        { ...validOutput, unexpected: true },
      ]) {
        await expect(runtime.callTool('unsigned-formats', 'echo', { args: invalid })).rejects.toThrow('does not match');
      }
    } finally {
      await runtime.close();
    }
  });
});
