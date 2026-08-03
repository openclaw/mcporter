import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleCall } from '../src/cli/call-command.js';
import type { Runtime } from '../src/runtime.js';

function runtimeWith(tools: unknown[] | (() => Promise<unknown[]>)): {
  runtime: Runtime;
  callTool: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
} {
  const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
  const listTools = vi.fn(typeof tools === 'function' ? tools : async () => tools);
  return {
    runtime: { callTool, listTools, close: vi.fn().mockResolvedValue(undefined) } as unknown as Runtime,
    callTool,
    listTools,
  };
}

describe('CLI call positional and schema validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it.each([
    [
      'unavailable metadata',
      () => Promise.reject(new Error('discovery failed')),
      'Unable to load tool metadata; name positional arguments explicitly',
    ],
    ['an unknown tool', [], "Unknown tool 'search' on server 'linear'"],
    ['a missing input schema', [{ name: 'search' }], "Tool 'search' does not expose an input schema"],
    [
      'a parameterless tool',
      [{ name: 'search', inputSchema: { type: 'object', properties: {} } }],
      "Tool 'search' has no declared parameters",
    ],
    [
      'too many values',
      [
        {
          name: 'search',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      ],
      'Too many positional arguments (2) supplied; only 1 parameter remain on search',
    ],
  ])('rejects positional arguments with %s', async (_case, tools, message) => {
    const { runtime, callTool } = runtimeWith(tools as unknown[] | (() => Promise<unknown[]>));

    await expect(handleCall(runtime, ['linear.search("one", "two")'])).rejects.toThrow(message as string);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('maps positional values around explicitly named fields in schema order', async () => {
    const { runtime, callTool } = runtimeWith([
      {
        name: 'search',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' }, limit: { type: 'number' }, cursor: { type: 'string' } },
          required: ['query'],
        },
      },
    ]);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleCall(runtime, ['linear.search', 'cursor=next', 'bug']);

    expect(callTool).toHaveBeenCalledWith(
      'linear',
      'search',
      expect.objectContaining({ args: { query: 'bug', cursor: 'next' } })
    );
  });

  it('uses composed schemas to restore string ids and wrap array flags', async () => {
    const { runtime, callTool } = runtimeWith([
      {
        name: 'update',
        inputSchema: {
          type: 'object',
          properties: {
            issueId: { oneOf: [{ type: 'null' }, { type: 'string' }] },
            labels: { allOf: [{ type: ['array', 'null'], items: { type: 'string' } }] },
            count: { type: 'number' },
          },
        },
      },
    ]);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleCall(runtime, ['linear.update', '--issue-id', '1234567890123', '--labels', 'bug', '--count', '5']);

    expect(callTool).toHaveBeenCalledWith(
      'linear',
      'update',
      expect.objectContaining({ args: { issueId: '1234567890123', labels: ['bug'], count: 5 } })
    );
  });

  it('does not reinterpret scalar flags when the advertised schema is incompatible', async () => {
    const { runtime, callTool } = runtimeWith([
      {
        name: 'update',
        inputSchema: {
          type: 'object',
          properties: { count: { type: 'number' }, label: { type: ['string', 'null'] } },
        },
      },
    ]);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleCall(runtime, ['linear.update', '--count', '5', '--label', 'bug']);

    expect(callTool).toHaveBeenCalledWith(
      'linear',
      'update',
      expect.objectContaining({ args: { count: 5, label: 'bug' } })
    );
  });

  it('reports STDIO process exits with code and signal details', async () => {
    const { runtime, callTool } = runtimeWith([]);
    callTool.mockRejectedValue(new Error('STDIO transport exited with code 2 (signal SIGTERM)'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(handleCall(runtime, ['local.run'])).rejects.toThrow('exited with code 2');

    expect(errorSpy.mock.calls.map((call) => call.join(' ')).join('\n')).toContain(
      'STDIO server for local exited with code 2 (signal SIGTERM)'
    );
  });

  it('does not auto-correct a rejection naming a different tool', async () => {
    const { runtime, callTool, listTools } = runtimeWith([{ name: 'right_tool' }]);
    callTool.mockRejectedValue('Unknown tool: entirely_different');

    await expect(handleCall(runtime, ['linear.wrong_tool'])).rejects.toBe('Unknown tool: entirely_different');
    expect(listTools).not.toHaveBeenCalled();
  });
});
