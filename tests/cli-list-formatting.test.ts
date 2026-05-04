import { describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { stripAnsi } from './fixtures/ansi.js';
import { buildLinearDocumentsTool, cliModulePromise, linearDefinition } from './fixtures/cli-list-fixtures.js';

describe('CLI list formatting', () => {
  it('prints detailed usage for single server listings', async () => {
    const { handleList } = await cliModulePromise;
    const listToolsSpy = vi.fn((_name: string, options?: { includeSchema?: boolean }) =>
      Promise.resolve([
        {
          name: 'add',
          description: 'Add two numbers',
          inputSchema: options?.includeSchema
            ? {
                type: 'object',
                properties: {
                  a: { type: 'number', description: 'First operand' },
                  format: { type: 'string', enum: ['json', 'markdown'], description: 'Output serialization format' },
                  dueBefore: { type: 'string', format: 'date-time', description: 'ISO 8601 timestamp' },
                },
                required: ['a'],
              }
            : undefined,
          outputSchema: options?.includeSchema
            ? {
                type: 'object',
                properties: {
                  result: { type: 'array', description: 'List of calculation results' },
                  total: { type: 'number', description: 'Total results returned' },
                },
              }
            : undefined,
        },
      ])
    );
    const runtime = {
      getDefinition: (name: string) => ({
        name,
        description: 'Test integration server',
        command: { kind: 'http', url: new URL('https://example.com/mcp') },
      }),
      listTools: listToolsSpy,
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleList(runtime, ['calculator']);

    const rawLines = logSpy.mock.calls.map((call) => call.join(' '));
    const lines = rawLines.map(stripAnsi);

    const headerLine = lines.find((line) => line.trim().startsWith('calculator -'));
    expect(headerLine).toBeDefined();
    const summaryLine = lines.find((line) => line.includes('HTTP https://example.com/mcp'));
    expect(summaryLine).toBeDefined();
    expect(summaryLine).toMatch(/1 tool/);
    expect(summaryLine).toMatch(/ms/);
    expect(summaryLine).toContain('HTTP https://example.com/mcp');
    expect(lines.some((line) => line.includes('/**'))).toBe(true);
    const paramLineIndex = lines.findIndex((line) => line.includes('@param a'));
    expect(paramLineIndex).toBeGreaterThan(1);
    expect(lines[paramLineIndex - 1]?.trim()).toBe('*');
    expect(lines.some((line) => line.includes('@param a') && line.includes('First operand'))).toBe(true);
    expect(lines.some((line) => line.includes('function add('))).toBe(true);
    expect(lines.some((line) => line.includes('format?: "json" | "markdown"'))).toBe(true);
    expect(lines.some((line) => line.includes('dueBefore?: string'))).toBe(true);
    expect(lines.some((line) => line.includes('Examples:'))).toBe(true);
    expect(lines.some((line) => line.includes('mcporter call calculator.add(a: 1'))).toBe(true);
    expect(
      lines.some((line) => line.includes('Optional parameters hidden; run with --all-parameters to view all fields'))
    ).toBe(false);
    expect(listToolsSpy).toHaveBeenCalledWith('calculator', expect.objectContaining({ includeSchema: true }));

    logSpy.mockRestore();
  });

  it('emits JSON summaries for multi-server listings when --json is provided', async () => {
    const { handleList } = await cliModulePromise;
    const originalCI = process.env.CI;
    process.env.CI = '1';
    const definitions: ServerDefinition[] = [
      linearDefinition,
      {
        name: 'github',
        command: { kind: 'http', url: new URL('https://example.com/mcp') },
      },
    ];
    const runtime = {
      getDefinitions: () => definitions,
      listTools: (name: string) => {
        if (name === 'linear') {
          return Promise.resolve([{ name: 'list_documents' }]);
        }
        return Promise.reject(new Error('HTTP error 500: upstream unavailable'));
      },
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleList(runtime, ['--json']);
    const payload = JSON.parse(logSpy.mock.calls.at(-1)?.[0] ?? '{}');
    expect(payload.mode).toBe('list');
    expect(payload.servers).toHaveLength(2);
    const github = payload.servers.find((entry: { name: string }) => entry.name === 'github');
    expect(github.status).toBe('http');
    const linear = payload.servers.find((entry: { name: string }) => entry.name === 'linear');
    expect(linear.tools[0].name).toBe('list_documents');
    logSpy.mockRestore();
    process.env.CI = originalCI;
  });

  it('emits JSON payloads for single server listings when --json is provided', async () => {
    const { handleList } = await cliModulePromise;
    const toolCache = await import('../src/cli/tool-cache.js');
    const metadata = [
      {
        tool: {
          name: 'add',
          description: 'Add numbers',
          inputSchema: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] },
          outputSchema: { type: 'number' },
        },
        methodName: 'add',
        options: [],
      },
    ];
    const metadataSpy = vi.spyOn(toolCache, 'loadToolMetadata').mockResolvedValue(metadata as never);
    const definition: ServerDefinition = {
      name: 'linear',
      description: 'Hosted Linear MCP',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
    };
    const runtime = {
      getDefinitions: () => [definition],
      getDefinition: () => definition,
      registerDefinition: vi.fn(),
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleList(runtime, ['--json', 'linear']);

    const payload = JSON.parse(logSpy.mock.calls.at(-1)?.[0] ?? '{}');
    expect(payload.mode).toBe('server');
    expect(payload.status).toBe('ok');
    expect(payload.tools[0].name).toBe('add');

    logSpy.mockRestore();
    metadataSpy.mockRestore();
  });

  it('surfaces initialize instructions in single server text and JSON output', async () => {
    const { handleList } = await cliModulePromise;
    const definition: ServerDefinition = {
      name: 'immich',
      description: 'Immich MCP',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
    };
    const runtime = {
      getDefinitions: () => [definition],
      getDefinition: () => definition,
      listTools: vi.fn().mockResolvedValue([{ name: 'search_assets' }]),
      getInstructions: vi.fn().mockResolvedValue('Use asset IDs from search results when calling mutation tools.'),
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleList(runtime, ['immich']);
    let lines = logSpy.mock.calls.map((call) => stripAnsi(call.join(' ')));
    expect(lines.some((line) => line.includes('Instructions: Use asset IDs from search results'))).toBe(true);

    logSpy.mockClear();
    await handleList(runtime, ['--json', 'immich']);
    const payload = JSON.parse(logSpy.mock.calls.at(-1)?.[0] ?? '{}');
    expect(payload.instructions).toBe('Use asset IDs from search results when calling mutation tools.');

    logSpy.mockRestore();
  });

  it('prints compact signatures for single server listings with --brief', async () => {
    const { handleList } = await cliModulePromise;
    const listToolsSpy = vi.fn((_name: string, options?: { includeSchema?: boolean }) =>
      Promise.resolve([buildLinearDocumentsTool(options?.includeSchema)])
    );
    const runtime = {
      getDefinitions: () => [linearDefinition],
      getDefinition: () => linearDefinition,
      listTools: listToolsSpy,
      getInstructions: vi.fn().mockResolvedValue('Use Linear IDs from list operations in mutation tools.'),
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleList(runtime, ['linear', '--brief']);

    const lines = logSpy.mock.calls.map((call) => stripAnsi(call.join(' ')));
    expect(lines.some((line) => line.includes('Instructions: Use Linear IDs'))).toBe(true);
    expect(lines.some((line) => line.trim().startsWith('/**'))).toBe(false);
    expect(lines.some((line) => line.includes('Examples:'))).toBe(false);
    expect(lines.some((line) => line.includes('@param'))).toBe(false);
    expect(lines.some((line) => line.includes('function list_documents('))).toBe(true);
    expect(
      lines.some((line) => line.includes('// optional (4): projectId, initiativeId, creatorId, includeArchived'))
    ).toBe(true);
    expect(
      lines.some((line) => line.includes('Optional parameters hidden; run with --all-parameters to view all fields'))
    ).toBe(true);
    expect(listToolsSpy).toHaveBeenCalledWith('linear', expect.objectContaining({ includeSchema: true }));

    logSpy.mockRestore();
  });

  it('prints compact signatures for selected tools with --signatures', async () => {
    const { handleList } = await cliModulePromise;
    const listToolsSpy = vi.fn((_name: string, options?: { includeSchema?: boolean }) =>
      Promise.resolve([
        buildLinearDocumentsTool(options?.includeSchema),
        {
          name: 'create_comment',
          description: 'Create a comment on a specific Linear issue',
          inputSchema: options?.includeSchema
            ? {
                type: 'object',
                properties: {
                  issueId: { type: 'string', description: 'The issue ID' },
                  body: { type: 'string', description: 'Comment body as Markdown' },
                },
                required: ['issueId', 'body'],
              }
            : undefined,
        },
      ])
    );
    const runtime = {
      getDefinitions: () => [linearDefinition],
      getDefinition: () => linearDefinition,
      listTools: listToolsSpy,
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleList(runtime, ['linear.create_comment', '--signatures']);

    const lines = logSpy.mock.calls.map((call) => stripAnsi(call.join(' ')));
    expect(lines.some((line) => line.includes('function create_comment('))).toBe(true);
    expect(lines.some((line) => line.includes('function list_documents('))).toBe(false);
    expect(lines.some((line) => line.includes('Examples:'))).toBe(false);
    expect(lines.find((line) => line.includes('HTTP https://example.com/mcp'))).toMatch(/1 tool/);

    logSpy.mockRestore();
  });

  it('prints only the selected tool when listing server.tool with schemas', async () => {
    const { handleList } = await cliModulePromise;
    const listToolsSpy = vi.fn((_name: string, options?: { includeSchema?: boolean }) =>
      Promise.resolve([
        {
          name: 'add',
          description: 'Add numbers',
          inputSchema: options?.includeSchema
            ? { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] }
            : undefined,
          outputSchema: { type: 'number' },
        },
        {
          name: 'subtract',
          description: 'Subtract numbers',
          inputSchema: options?.includeSchema
            ? { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] }
            : undefined,
        },
      ])
    );
    const definition: ServerDefinition = {
      name: 'calculator',
      description: 'Math tools',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
    };
    const runtime = {
      getDefinitions: () => [definition],
      getDefinition: () => definition,
      listTools: listToolsSpy,
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleList(runtime, ['calculator.add', '--schema']);

    const lines = logSpy.mock.calls.map((call) => stripAnsi(call.join(' ')));
    expect(lines.some((line) => line.includes('function add('))).toBe(true);
    expect(lines.some((line) => line.includes('function subtract('))).toBe(false);
    expect(lines.some((line) => line.includes('"properties"'))).toBe(true);
    expect(lines.find((line) => line.includes('HTTP https://example.com/mcp'))).toMatch(/1 tool/);
    expect(listToolsSpy).toHaveBeenCalledWith('calculator', expect.objectContaining({ includeSchema: true }));

    logSpy.mockRestore();
  });

  it('summarizes hidden optional parameters and hints include flag', async () => {
    const { handleList } = await cliModulePromise;
    const listToolsSpy = vi.fn((_name: string, options?: { includeSchema?: boolean }) =>
      Promise.resolve([buildLinearDocumentsTool(options?.includeSchema)])
    );
    const runtime = {
      getDefinition: () => linearDefinition,
      listTools: listToolsSpy,
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleList(runtime, ['linear']);

    const lines = logSpy.mock.calls.map((call) => stripAnsi(call.join(' ')));
    expect(lines.some((line) => line.includes('function list_documents('))).toBe(true);
    expect(
      lines.some((line) => line.includes('// optional (4): projectId, initiativeId, creatorId, includeArchived'))
    ).toBe(true);
    expect(
      lines.some((line) => line.includes('Optional parameters hidden; run with --all-parameters to view all fields'))
    ).toBe(true);
    expect(listToolsSpy).toHaveBeenCalledWith('linear', expect.objectContaining({ includeSchema: true }));

    logSpy.mockRestore();
  });

  it('truncates long examples for readability', async () => {
    const { handleList } = await cliModulePromise;
    const listToolsSpy = vi.fn((_name: string, options?: { includeSchema?: boolean }) =>
      Promise.resolve([buildLinearDocumentsTool(options?.includeSchema)])
    );
    const runtime = {
      getDefinition: () => linearDefinition,
      listTools: listToolsSpy,
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleList(runtime, ['linear']);

    const lines = logSpy.mock.calls.map((call) => stripAnsi(call.join(' ')));
    const exampleLines = lines.filter((line) => line.includes('mcporter call linear.'));
    expect(exampleLines).toHaveLength(1);
    const exampleLine = exampleLines[0] as string;
    expect(exampleLine.length).toBeLessThanOrEqual(90);
    expect(exampleLine).toMatch(/, ...\)$/);

    logSpy.mockRestore();
  });

  it('indents multi-line parameter docs beneath the @param label', async () => {
    const { handleList } = await cliModulePromise;
    const listToolsSpy = vi.fn((_name: string, options?: { includeSchema?: boolean }) =>
      Promise.resolve([
        {
          name: 'list_projects',
          description: 'List Vercel projects',
          inputSchema: options?.includeSchema
            ? {
                type: 'object',
                properties: {
                  teamId: {
                    type: 'string',
                    description: `The team ID to target.\nTeam IDs start with "team_".\n- Read the file .vercel/project.json\n- Use the list_teams tool`,
                  },
                },
                required: ['teamId'],
              }
            : undefined,
        },
      ])
    );
    const runtime = {
      getDefinition: () => linearDefinition,
      listTools: listToolsSpy,
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleList(runtime, ['linear']);

    const lines = logSpy.mock.calls.map((call) => stripAnsi(call.join(' ')));
    expect(lines.some((line) => line.includes('@param teamId'))).toBe(true);
    const continuationLine = lines.find((line) => line.includes('Team IDs start with "team_"'));
    expect(continuationLine).toBeDefined();
    expect(continuationLine?.includes('*               Team IDs start with "team_"')).toBe(true);

    logSpy.mockRestore();
  });

  it('includes optional parameters when --all-parameters is set', async () => {
    const { handleList } = await cliModulePromise;
    const listToolsSpy = vi.fn((_name: string, options?: { includeSchema?: boolean }) =>
      Promise.resolve([buildLinearDocumentsTool(options?.includeSchema)])
    );
    const runtime = {
      getDefinition: () => linearDefinition,
      listTools: listToolsSpy,
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleList(runtime, ['--all-parameters', 'linear']);

    const lines = logSpy.mock.calls.map((call) => stripAnsi(call.join(' ')));

    const headerLine = lines.find((line) => line.trim().startsWith('linear -'));
    expect(headerLine).toBeDefined();
    const summaryLine = lines.find((line) => line.includes('HTTP https://example.com/mcp'));
    expect(summaryLine).toBeDefined();
    expect(summaryLine).toMatch(/1 tool/);
    expect(summaryLine).toMatch(/ms/);
    expect(summaryLine).toContain('HTTP https://example.com/mcp');
    expect(lines.some((line) => line.includes('/**'))).toBe(true);
    expect(lines.some((line) => line.includes('@param limit?') && line.includes('Maximum number of documents'))).toBe(
      true
    );
    expect(lines.some((line) => line.includes('function list_documents('))).toBe(true);
    expect(lines.some((line) => line.includes('limit?: number'))).toBe(true);
    expect(lines.some((line) => line.includes('orderBy?: "createdAt" | "updatedAt"'))).toBe(true);
    expect(lines.some((line) => line.includes('includeArchived?: boolean'))).toBe(true);
    expect(listToolsSpy).toHaveBeenCalledWith('linear', expect.objectContaining({ includeSchema: true }));

    logSpy.mockRestore();
  });

  it('matches the expected formatted snapshot for a complex server', async () => {
    const { handleList } = await cliModulePromise;
    const listToolsSpy = vi.fn((_name: string, options?: { includeSchema?: boolean }) =>
      Promise.resolve([
        buildLinearDocumentsTool(options?.includeSchema),
        {
          name: 'create_comment',
          description: 'Create a comment on a specific Linear issue',
          inputSchema: options?.includeSchema
            ? {
                type: 'object',
                properties: {
                  issueId: { type: 'string', description: 'The issue ID' },
                  parentId: { type: 'string', description: 'Optional parent comment ID' },
                  body: { type: 'string', description: 'Comment body as Markdown' },
                },
                required: ['issueId', 'body'],
              }
            : undefined,
          outputSchema: options?.includeSchema
            ? {
                title: 'Comment',
                type: 'object',
              }
            : undefined,
        },
      ])
    );
    const runtime = {
      getDefinition: () => linearDefinition,
      listTools: listToolsSpy,
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

    await handleList(runtime, ['linear']);

    nowSpy.mockRestore();

    const lines = logSpy.mock.calls.map((call) => stripAnsi(call.join(' ')));
    expect(lines.join('\n')).toMatchInlineSnapshot(`
      "linear - Hosted Linear MCP

        /**
         * List documents in the user's Linear workspace
         *
         * @param query The search query
         * @param limit? Maximum number of documents to return
         * @param before? Cursor to page backwards
         * @param after? Cursor to page forwards
         * @param orderBy? Sort order for the documents
         * @param projectId? Filter by project
         * @param initiativeId? Filter by initiative
         * @param creatorId? Filter by creator
         * @param includeArchived? Whether to include archived documents
         */
        function list_documents(query: string, limit?: number, before?: string, after?: string, orderBy?: "createdAt" | "updatedAt"): DocumentConnection;
        // optional (4): projectId, initiativeId, creatorId, includeArchived

        /**
         * Create a comment on a specific Linear issue
         *
         * @param issueId The issue ID
         * @param parentId? Optional parent comment ID
         * @param body Comment body as Markdown
         */
        function create_comment(issueId: string, parentId?: string, body: string): Comment;

        Examples:
          mcporter call linear.list_documents(query: "value", limit: 1, orderBy: "cr, ...)

        Optional parameters hidden; run with --all-parameters to view all fields.

        2 tools · 0ms · HTTP https://example.com/mcp
      "
    `);

    logSpy.mockRestore();
  });
});
