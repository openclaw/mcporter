import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleList } from '../src/cli/list-command.js';
import type { ServerDefinition } from '../src/config.js';
import type { Runtime } from '../src/runtime.js';

const definition: ServerDefinition = {
  name: 'linear',
  description: 'Linear issues',
  command: { kind: 'http', url: new URL('https://example.com/mcp') },
  source: { kind: 'local', path: '/tmp/mcporter.json' },
  sources: [{ kind: 'local', path: '/tmp/mcporter.json' }],
};

const issueTool = {
  name: 'search_issues',
  description: 'Search issues',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      limit: { type: 'number', description: 'Maximum results' },
      cursor: { type: 'string', description: 'Page cursor' },
      project: { type: 'string', description: 'Project id' },
      team: { type: 'string', description: 'Team id' },
      state: { type: 'string', description: 'Issue state' },
    },
    required: ['query'],
  },
  outputSchema: { type: 'object', title: 'IssueSearchResult' },
};

function runtimeWith(
  options: {
    definitions?: ServerDefinition[];
    listTools?: (name: string) => Promise<unknown[]>;
    instructions?: string;
    connectionInfo?: { protocolVersion: string; era: 'legacy' | 'modern' };
  } = {}
): Runtime {
  const definitions = options.definitions ?? [definition];
  return {
    getDefinitions: () => definitions,
    getDefinition: (name: string) => {
      const match = definitions.find((entry) => entry.name === name);
      if (!match) throw new Error(`Unknown MCP server '${name}'.`);
      return match;
    },
    listTools: vi.fn(options.listTools ?? (async () => [issueTool])),
    getInstructions: options.instructions === undefined ? undefined : async () => options.instructions,
    getConnectionInfo: options.connectionInfo === undefined ? undefined : async () => options.connectionInfo as never,
  } as unknown as Runtime;
}

describe('CLI list output modes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('handles an empty registry in quiet and JSON modes and rejects targetless brief output', async () => {
    const runtime = runtimeWith({ definitions: [] });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(handleList(runtime, ['--brief'])).rejects.toThrow('--brief requires a server target');
    await handleList(runtime, ['--quiet']);
    expect(logSpy).not.toHaveBeenCalled();

    await handleList(runtime, ['--json']);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual({
      mode: 'list',
      counts: { ok: 0, auth: 0, offline: 0, http: 0, error: 0 },
      servers: [],
    });
  });

  it.each([
    ['HTTP error 401: authenticate', 'auth required'],
    ['connect ECONNREFUSED 127.0.0.1:3000', 'offline'],
    ['HTTP error 503: unavailable', 'http error'],
    ['unexpected protocol failure', 'error'],
  ])('renders status-only failures as %s', async (message, label) => {
    const runtime = runtimeWith({ listTools: async () => Promise.reject(new Error(message)) });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleList(runtime, ['linear', '--status']);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain(label);
    expect(output).toContain('Listed 1 server');
  });

  it('emits a structured JSON error when discovery fails', async () => {
    const runtime = runtimeWith({ listTools: async () => Promise.reject(new Error('HTTP error 401: sign in')) });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleList(runtime, ['linear', '--json', '--sources']);

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(payload).toMatchObject({
      mode: 'server',
      name: 'linear',
      status: 'auth',
      authCommand: 'mcporter auth linear',
      error: 'auth required',
    });
    expect(payload.sources).toEqual(definition.sources);
    expect(process.exitCode).toBe(1);
  });

  it('reports missing selected tools in both JSON and text output', async () => {
    const runtime = runtimeWith();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await handleList(runtime, ['linear.missing', '--json']);
    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(payload.tools).toEqual([]);
    expect(payload.error).toBe("Tool 'missing' not found on 'linear'.");

    process.exitCode = undefined;
    await handleList(runtime, ['linear.missing']);
    expect(warnSpy).toHaveBeenCalledWith("  Tool 'missing' not found on 'linear'.");
    expect(process.exitCode).toBe(1);
  });

  it('renders empty, brief, and verbose tool views from runtime metadata', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const emptyRuntime = runtimeWith({ listTools: async () => [] });
    await handleList(emptyRuntime, ['linear']);
    expect(logSpy.mock.calls.map((call) => call.join(' ')).join('\n')).toContain('Tools: <none>');

    logSpy.mockClear();
    const runtime = runtimeWith({
      instructions: 'Use project keys when searching.',
      connectionInfo: { protocolVersion: '2026-07-28', era: 'modern' },
    });
    await handleList(runtime, ['linear', '--brief']);
    const brief = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(brief).toContain('search_issues');
    expect(brief).toContain('Optional parameters hidden');

    logSpy.mockClear();
    await handleList(runtime, ['linear', '--verbose', '--schema']);
    const verbose = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(verbose).toContain('Protocol: 2026-07-28 (modern)');
    expect(verbose).toContain('Instructions: Use project keys when searching.');
    expect(verbose).toContain('IssueSearchResult');
    expect(verbose).toContain('Examples:');
  });

  it('keeps quiet single-server success and failure probes silent', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await handleList(runtimeWith(), ['linear', '--quiet']);
    await handleList(runtimeWith({ listTools: async () => Promise.reject(new Error('offline')) }), [
      'linear',
      '--quiet',
    ]);

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
