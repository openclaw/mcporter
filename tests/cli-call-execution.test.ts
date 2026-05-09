import { describe, expect, it, vi } from 'vitest';
import { resolveEphemeralServer } from '../src/cli/adhoc-server.js';
import type { ServerDefinition } from '../src/config.js';

process.env.MCPORTER_DISABLE_AUTORUN = '1';
const cliModulePromise = import('../src/cli.js');

describe('CLI call execution behavior', () => {
  it('auto-selects the sole tool when omitted', async () => {
    const toolName = 'list_issues';
    const { handleCall } = await cliModulePromise;
    const { runtime, callTool } = createRuntimeStub(
      {
        linear: [
          {
            name: toolName,
            description: 'List issues',
            inputSchema: {
              type: 'object',
              properties: {
                limit: { type: 'number' },
              },
              required: [],
            },
          },
        ],
      },
      {
        definitions: [
          {
            name: 'linear',
            command: { kind: 'stdio', command: 'linear', args: [], cwd: process.cwd() },
            source: { kind: 'local', path: '<test>' },
          },
        ],
      }
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleCall(runtime, ['linear', 'limit=5']);
    expect(callTool).toHaveBeenCalledWith('linear', toolName, expect.objectContaining({ args: { limit: 5 } }));
    logSpy.mockRestore();
  });

  it('restores numeric-looking key=value args to schema-declared strings', async () => {
    const { handleCall } = await cliModulePromise;
    const { runtime, callTool, listTools } = createRuntimeStub({
      slack: [
        {
          name: 'conversations_replies',
          inputSchema: {
            type: 'object',
            properties: {
              channel_id: { type: 'string' },
              thread_ts: { type: 'string' },
              latest: { anyOf: [{ type: 'string' }, { type: 'null' }] },
              limit: { type: 'number' },
            },
            required: ['channel_id', 'thread_ts'],
          },
        },
      ],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleCall(runtime, [
      'slack.conversations_replies',
      'channel_id=C1234567890',
      'thread_ts=1234567890.123456',
      'latest=1234567899.987654',
      'limit=1',
    ]);

    expect(callTool).toHaveBeenCalledWith(
      'slack',
      'conversations_replies',
      expect.objectContaining({
        args: {
          channel_id: 'C1234567890',
          thread_ts: '1234567890.123456',
          latest: '1234567899.987654',
          limit: 1,
        },
      })
    );
    expect(listTools).toHaveBeenCalledWith('slack', { autoAuthorize: true, includeSchema: true });
    logSpy.mockRestore();
  });

  it('wraps bare long-flag strings when the schema declares an array', async () => {
    const { handleCall } = await cliModulePromise;
    const { runtime, callTool, listTools } = createRuntimeStub({
      email: [
        {
          name: 'send_email',
          inputSchema: {
            type: 'object',
            properties: {
              to: { type: 'array', items: { type: 'string' } },
              subject: { type: 'string' },
            },
            required: ['to', 'subject'],
          },
        },
      ],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleCall(runtime, ['email.send_email', '--to', 'miguel@example.com', '--subject', 'Test']);

    expect(callTool).toHaveBeenCalledWith(
      'email',
      'send_email',
      expect.objectContaining({
        args: {
          to: ['miguel@example.com'],
          subject: 'Test',
        },
      })
    );
    expect(listTools).toHaveBeenCalledWith('email', { autoAuthorize: true, includeSchema: true });
    logSpy.mockRestore();
  });

  it('does not load schemas for numeric values supplied via --args JSON', async () => {
    const { handleCall } = await cliModulePromise;
    const { runtime, callTool, listTools } = createRuntimeStub({
      linear: [
        {
          name: 'list_issues',
          inputSchema: {
            type: 'object',
            properties: {
              limit: { type: 'number' },
            },
          },
        },
      ],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleCall(runtime, ['linear.list_issues', '--args', '{"limit":5}']);

    expect(callTool).toHaveBeenCalledWith('linear', 'list_issues', expect.objectContaining({ args: { limit: 5 } }));
    expect(listTools).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('marks MCP isError tool results as process failures', async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const { handleCall } = await cliModulePromise;
      const { runtime, callTool } = createRuntimeStub({
        linear: [{ name: 'explode', inputSchema: { type: 'object', properties: {} } }],
      });
      callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Unknown resource' }], isError: true });
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await handleCall(runtime, ['linear.explode']);

      expect(process.exitCode).toBe(1);
      logSpy.mockRestore();
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('auto-corrects near-miss tool names returned as MCP isError content', async () => {
    const { handleCall } = await cliModulePromise;
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Unknown tool: read_wiki_structur' }], isError: true })
      .mockResolvedValueOnce({ ok: true });
    const listTools = vi.fn().mockResolvedValue([{ name: 'read_wiki_structure' }]);
    const runtime = {
      callTool,
      listTools,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleCall(runtime, ['deepwiki.read_wiki_structur']);

    const notes = logSpy.mock.calls.map((call) => call.join(' '));
    expect(notes.some((line) => line.includes('Auto-corrected tool call to deepwiki.read_wiki_structure'))).toBe(true);
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(callTool).toHaveBeenNthCalledWith(
      1,
      'deepwiki',
      'read_wiki_structur',
      expect.objectContaining({ args: {} })
    );
    expect(callTool).toHaveBeenNthCalledWith(
      2,
      'deepwiki',
      'read_wiki_structure',
      expect.objectContaining({ args: {} })
    );

    logSpy.mockRestore();
  });

  it('keeps auto-correct diagnostics off stdout for JSON output', async () => {
    const { handleCall } = await cliModulePromise;
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Unknown tool: read_wiki_structur' }], isError: true })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] });
    const listTools = vi.fn().mockResolvedValue([{ name: 'read_wiki_structure' }]);
    const runtime = {
      callTool,
      listTools,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await handleCall(runtime, ['deepwiki.read_wiki_structur', '--output', 'json']);

    expect(errorSpy.mock.calls.map((call) => call.join(' ')).join('\n')).toContain(
      'Auto-corrected tool call to deepwiki.read_wiki_structure'
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logSpy.mock.calls[0]?.[0]?.toString() ?? '{}')).toEqual({ ok: true });

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('still requires an explicit tool when multiple are available', async () => {
    const { handleCall } = await cliModulePromise;
    const { runtime, callTool } = createRuntimeStub(
      {
        linear: [
          { name: 'list_issues', inputSchema: {} },
          { name: 'create_issue', inputSchema: {} },
        ],
      },
      {
        definitions: [
          {
            name: 'linear',
            command: { kind: 'stdio', command: 'linear', args: [], cwd: process.cwd() },
            source: { kind: 'local', path: '<test>' },
          },
        ],
      }
    );
    await expect(handleCall(runtime, ['linear'])).rejects.toThrow(
      'Missing tool name. Provide it via <server>.<tool> or --tool.'
    );
    expect(callTool).not.toHaveBeenCalled();
  });

  it('runs quoted stdio commands without --stdio and infers the tool automatically', async () => {
    const command = 'npx -y vercel-domains-mcp';
    const { name: adhocName } = resolveEphemeralServer({ stdioCommand: command });
    const { handleCall } = await cliModulePromise;
    const { runtime, callTool } = createRuntimeStub({
      [adhocName]: [
        {
          name: 'getDomainAvailability',
          inputSchema: {
            type: 'object',
            properties: { domain: { type: 'string' } },
            required: ['domain'],
          },
        },
      ],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleCall(runtime, [command, 'domain=answeroverflow.com']);
    expect(callTool).toHaveBeenCalledWith(
      adhocName,
      'getDomainAvailability',
      expect.objectContaining({
        args: { domain: 'answeroverflow.com' },
      })
    );
    logSpy.mockRestore();
  });

  it('aborts long-running tools when the timeout elapses', async () => {
    vi.useFakeTimers();
    try {
      const { handleCall } = await cliModulePromise;
      const close = vi.fn().mockResolvedValue(undefined);
      const runtime = {
        callTool: () =>
          new Promise((resolve) => {
            setTimeout(() => resolve('done'), 1000);
          }),
        close,
      };
      const promise = handleCall(runtime as never, ['chrome-devtools.list_pages', '--timeout', '10']);
      const expectation = expect(promise).rejects.toThrow('Call to chrome-devtools.list_pages timed out after 10ms.');
      await vi.runOnlyPendingTimersAsync();
      await expectation;
      expect(close).toHaveBeenCalledWith('chrome-devtools');
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto-corrects near-miss tool names', async () => {
    const { handleCall } = await cliModulePromise;
    const callTool = vi
      .fn()
      .mockRejectedValueOnce(new Error('MCP error -32602: Tool listIssues not found'))
      .mockResolvedValueOnce({ ok: true });
    const listTools = vi.fn().mockResolvedValue([{ name: 'list_issues' }]);
    const runtime = {
      callTool,
      listTools,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleCall(runtime, ['linear.listIssues']);

    const notes = logSpy.mock.calls.map((call) => call.join(' '));
    expect(notes.some((line) => line.includes('Auto-corrected tool call to linear.list_issues'))).toBe(true);
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(callTool).toHaveBeenNthCalledWith(1, 'linear', 'listIssues', expect.objectContaining({ args: {} }));
    expect(callTool).toHaveBeenNthCalledWith(2, 'linear', 'list_issues', expect.objectContaining({ args: {} }));
    expect(listTools).toHaveBeenCalledWith('linear', { autoAuthorize: true, includeSchema: false });

    logSpy.mockRestore();
  });

  it('suggests similar tool names when the match is uncertain', async () => {
    const { handleCall } = await cliModulePromise;
    const callTool = vi.fn().mockRejectedValue(new Error('MCP error -32602: Tool listIssues not found'));
    const listTools = vi.fn().mockResolvedValue([{ name: 'list_issue_statuses' }]);
    const runtime = {
      callTool,
      listTools,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(handleCall(runtime, ['linear.listIssues'])).rejects.toThrow('listIssues not found');

    const messages = errorSpy.mock.calls.map((call) => call.join(' '));
    expect(messages.some((line) => line.includes('Did you mean linear.list_issue_statuses'))).toBe(true);

    errorSpy.mockRestore();
  });

  it("falls back to 'list' output when calling a missing help tool", async () => {
    const listModule = await import('../src/cli/list-command.js');
    const listSpy = vi.spyOn(listModule, 'handleList').mockResolvedValue(undefined);
    const { handleCall } = await cliModulePromise;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const definition: ServerDefinition = {
      name: 'chrome-devtools',
      description: 'Chrome DevTools MCP server',
      command: { kind: 'stdio', command: 'chrome-devtools', args: [], cwd: process.cwd() },
      source: { kind: 'local', path: '<test>' },
    };
    const { runtime, callTool } = createRuntimeStub(
      {
        'chrome-devtools': [
          {
            name: 'take_snapshot',
            description: 'Takes a snapshot.',
            inputSchema: {
              type: 'object',
              properties: { url: { type: 'string' } },
              required: ['url'],
            },
          },
        ],
      },
      { definitions: [definition] }
    );

    try {
      await handleCall(runtime, ['chrome-devtools.help']);
      expect(listSpy).toHaveBeenNthCalledWith(1, runtime, ['chrome-devtools']);
      expect(
        logSpy.mock.calls.some((call) => call.some((line) => line.includes("does not expose a 'help' tool")))
      ).toBe(true);
      logSpy.mockClear();
      await handleCall(runtime, ['chrome-devtools.help', '--output', 'json']);
      expect(listSpy).toHaveBeenNthCalledWith(2, runtime, ['chrome-devtools', '--json']);
      expect(callTool).not.toHaveBeenCalled();
    } finally {
      listSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('treats list_tools selector as a shortcut for mcporter list', async () => {
    const listModule = await import('../src/cli/list-command.js');
    const listSpy = vi.spyOn(listModule, 'handleList').mockResolvedValue(undefined);
    const { handleCall } = await cliModulePromise;
    const definition: ServerDefinition = {
      name: 'chrome-devtools',
      description: 'Chrome DevTools MCP server',
      command: { kind: 'stdio', command: 'chrome-devtools', args: [], cwd: process.cwd() },
      source: { kind: 'local', path: '<test>' },
    };
    const { runtime, callTool } = createRuntimeStub({ 'chrome-devtools': [] }, { definitions: [definition] });

    try {
      await handleCall(runtime, ['chrome-devtools.list_tools']);
      await handleCall(runtime, ['chrome-devtools.list_tools', '--output', 'json']);
      expect(listSpy).toHaveBeenNthCalledWith(1, runtime, ['chrome-devtools']);
      expect(listSpy).toHaveBeenNthCalledWith(2, runtime, ['chrome-devtools', '--json']);
      expect(callTool).not.toHaveBeenCalled();
    } finally {
      listSpy.mockRestore();
    }
  });
});

function createRuntimeStub(
  toolCatalog: Record<
    string,
    Array<{
      name: string;
      description?: string;
      inputSchema?: unknown;
    }>
  >,
  options: { definitions?: ServerDefinition[] } = {}
): {
  runtime: Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;
  callTool: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
} {
  const definitions = new Map<string, ServerDefinition>();
  for (const entry of options.definitions ?? []) {
    definitions.set(entry.name, entry);
  }
  const callTool = vi.fn().mockResolvedValue({ ok: true });
  const listTools = vi.fn().mockImplementation(async (server: string) => {
    const tools = toolCatalog[server];
    if (!tools) {
      throw new Error(`Unknown MCP server '${server}'.`);
    }
    return tools;
  });
  const close = vi.fn().mockResolvedValue(undefined);
  const runtime = {
    getDefinitions: () => [...definitions.values()],
    getDefinition: vi.fn().mockImplementation((name: string) => {
      const definition = definitions.get(name);
      if (!definition) {
        throw new Error(`Unknown MCP server '${name}'.`);
      }
      return definition;
    }),
    registerDefinition: vi.fn().mockImplementation((definition: ServerDefinition) => {
      definitions.set(definition.name, definition);
    }),
    listTools,
    callTool,
    close,
  } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;
  return { runtime, callTool, listTools };
}
