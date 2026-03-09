import { describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { cliModulePromise, linearDefinition } from './fixtures/cli-list-fixtures.js';

describe('CLI list classification and routing', () => {
  it('identifies auth and offline failures and suggests remediation', async () => {
    const originalCI = process.env.CI;
    process.env.CI = '1';

    const { handleList } = await cliModulePromise;
    const definitions: ServerDefinition[] = [
      {
        name: 'healthy',
        command: { kind: 'stdio', command: 'noop', args: [], cwd: process.cwd() },
        source: { kind: 'local', path: '/tmp/config.json' },
      },
      {
        name: 'vercel',
        description: 'Vercel MCP',
        command: { kind: 'http', url: new URL('https://example.com') },
      },
      {
        name: 'github',
        command: { kind: 'http', url: new URL('https://example.com') },
        source: { kind: 'import', path: '/tmp/import.json' },
      },
      {
        name: 'next-devtools',
        command: { kind: 'http', url: new URL('https://localhost') },
      },
      {
        name: 'obsidian',
        command: { kind: 'http', url: new URL('https://localhost') },
      },
    ];

    const runtime = {
      getDefinitions: () => definitions,
      listTools: (name: string) => {
        switch (name) {
          case 'healthy':
            return Promise.resolve([{ name: 'ok' }]);
          case 'vercel':
            return Promise.reject(new Error('SSE error: Non-200 status code (401)'));
          case 'github':
            return Promise.reject(new Error('SSE error: Non-200 status code (405)'));
          case 'next-devtools':
            return Promise.reject(new Error('SSE error: fetch failed: connect ECONNREFUSED 127.0.0.1:3000'));
          case 'obsidian':
            return Promise.reject(new Error('MCP error -32000: Connection closed'));
          default:
            return Promise.resolve([]);
        }
      },
    } as unknown as Awaited<ReturnType<typeof import('../src/runtime.js')['createRuntime']>>;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await handleList(runtime, []);

    const logLines = logSpy.mock.calls.map((call) => call.join(' '));
    expect(
      logLines.some((line) => line.includes("vercel — Vercel MCP (auth required — run 'mcporter auth vercel'"))
    ).toBe(true);
    expect(logLines.some((line) => line.includes('github') && line.includes('HTTP 405'))).toBe(true);
    const nextDevtoolsLineFound = logLines.some(
      (line) => line.startsWith('- next-devtools') && line.includes('offline — unable to reach server')
    );
    expect(nextDevtoolsLineFound).toBe(true);
    expect(
      logLines.some((line) => line.includes('obsidian') && line.includes('offline — unable to reach server'))
    ).toBe(true);

    const summaryLine = logLines.find((line) => line.startsWith('✔ Listed'));
    expect(summaryLine).toBeDefined();
    expect(summaryLine).toContain('auth required');
    expect(summaryLine).toContain('http errors');
    expect(summaryLine).toContain('offline');

    logSpy.mockRestore();
    warnSpy.mockRestore();
    process.env.CI = originalCI;
  });

  it('suggests URL-based auth for ad-hoc HTTP servers', async () => {
    const { handleList } = await cliModulePromise;
    const definitions = new Map<string, ServerDefinition>();
    const runtime = {
      registerDefinition: vi.fn((definition: ServerDefinition) => {
        definitions.set(definition.name, definition);
      }),
      getDefinition: vi.fn((name: string) => {
        const entry = definitions.get(name);
        if (!entry) {
          throw new Error(`Unknown MCP server '${name}'.`);
        }
        return entry;
      }),
      getDefinitions: () => Array.from(definitions.values()),
      listTools: vi.fn().mockRejectedValue(new Error('SSE error: Non-200 status code (401)')),
    } as unknown as Awaited<ReturnType<typeof import('../src/runtime.js')['createRuntime']>>;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleList(runtime, ['https://mcp.supabase.com/mcp']);

    const hinted = warnSpy.mock.calls.some((call) =>
      (call[0]?.toString() ?? '').includes("Next: run 'mcporter auth https://mcp.supabase.com/mcp'")
    );
    expect(hinted).toBe(true);

    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('reuses configured servers when listing by URL', async () => {
    const { handleList } = await cliModulePromise;
    const definition: ServerDefinition = {
      name: 'vercel',
      description: 'Vercel MCP',
      command: { kind: 'http', url: new URL('https://mcp.vercel.com') },
      source: { kind: 'local', path: '/tmp/config.json' },
    };
    const registerDefinition = vi.fn();
    const listTools = vi.fn().mockResolvedValue([{ name: 'ok' }]);
    const runtime = {
      getDefinitions: () => [definition],
      registerDefinition,
      getDefinition: () => definition,
      listTools,
    } as unknown as Awaited<ReturnType<typeof import('../src/runtime.js')['createRuntime']>>;

    await handleList(runtime, ['https://mcp.vercel.com']);

    expect(listTools).toHaveBeenCalledWith('vercel', expect.anything());
    expect(registerDefinition).not.toHaveBeenCalled();
  });

  it('reuses configured servers when listing by HTTP tool selector', async () => {
    const { handleList } = await cliModulePromise;
    const definition: ServerDefinition = {
      name: 'shadcn',
      description: 'shadcn/ui registry MCP',
      command: { kind: 'http', url: new URL('https://shadcn.io/api/mcp') },
      source: { kind: 'local', path: '/tmp/config.json' },
    };
    const registerDefinition = vi.fn();
    const listTools = vi.fn().mockResolvedValue([{ name: 'getComponents' }]);
    const runtime = {
      getDefinitions: () => [definition],
      registerDefinition,
      getDefinition: () => definition,
      listTools,
    } as unknown as Awaited<ReturnType<typeof import('../src/runtime.js')['createRuntime']>>;

    await handleList(runtime, ['https://www.shadcn.io/api/mcp.getComponents']);

    expect(listTools).toHaveBeenCalledWith('shadcn', expect.anything());
    expect(registerDefinition).not.toHaveBeenCalled();
  });

  it('reuses configured servers for scheme-less HTTP tool selectors', async () => {
    const { handleList } = await cliModulePromise;
    const definition: ServerDefinition = {
      name: 'shadcn',
      description: 'shadcn/ui registry MCP',
      command: { kind: 'http', url: new URL('https://shadcn.io/api/mcp') },
      source: { kind: 'local', path: '/tmp/config.json' },
    };
    const listTools = vi.fn().mockResolvedValue([{ name: 'getComponents' }]);
    const runtime = {
      getDefinitions: () => [definition],
      registerDefinition: vi.fn(),
      getDefinition: () => definition,
      listTools,
    } as unknown as Awaited<ReturnType<typeof import('../src/runtime.js')['createRuntime']>>;

    await handleList(runtime, ['shadcn.io/api/mcp.getComponents']);

    expect(listTools).toHaveBeenCalledWith('shadcn', expect.anything());
  });

  it('enables cached OAuth when listing all servers', async () => {
    const { handleList } = await cliModulePromise;
    const definition: ServerDefinition = {
      name: 'linear',
      description: 'Linear MCP',
      auth: 'oauth',
      command: { kind: 'http', url: new URL('https://mcp.linear.app/sse') },
      source: { kind: 'local', path: '/tmp/config.json' },
    };
    const listTools = vi.fn().mockResolvedValue([{ name: 'ok' }]);
    const runtime = {
      getDefinitions: () => [definition],
      listTools,
    } as unknown as Awaited<ReturnType<typeof import('../src/runtime.js')['createRuntime']>>;

    await handleList(runtime, []);

    expect(listTools).toHaveBeenCalledWith('linear', {
      autoAuthorize: false,
      allowCachedAuth: true,
    });
  });

  it('registers an ad-hoc HTTP server when URL is provided', async () => {
    const { handleList } = await cliModulePromise;
    const definitions = new Map<string, ServerDefinition>();
    const registerDefinition = vi.fn((definition: ServerDefinition) => {
      definitions.set(definition.name, definition);
    });
    const listTools = vi.fn(() => Promise.resolve([]));
    const runtime = {
      getDefinitions: () => Array.from(definitions.values()),
      getDefinition: (name: string) => {
        const definition = definitions.get(name);
        if (!definition) {
          throw new Error('missing');
        }
        return definition;
      },
      listTools,
      registerDefinition,
    } as unknown as Awaited<ReturnType<typeof import('../src/runtime.js')['createRuntime']>>;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleList(runtime, ['https://mcp.example.com/mcp']);

    expect(registerDefinition).toHaveBeenCalled();
    expect(definitions.get('mcp-example-com-mcp')).toBeDefined();
    expect(listTools).toHaveBeenCalledWith('mcp-example-com-mcp', expect.objectContaining({ includeSchema: true }));

    logSpy.mockRestore();
  });

  it('auto-corrects unknown server names when the edit distance is small', async () => {
    const { handleList } = await cliModulePromise;
    const definition = linearDefinition;
    const getDefinition = vi.fn().mockImplementation((name: string) => {
      if (name === 'linear') {
        return definition;
      }
      throw new Error(`Unknown MCP server '${name}'.`);
    });
    const listTools = vi.fn(() => Promise.resolve([]));
    const runtime = {
      getDefinition,
      getDefinitions: () => [definition],
      listTools,
    } as unknown as Awaited<ReturnType<typeof import('../src/runtime.js')['createRuntime']>>;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleList(runtime, ['linera']);

    expect(getDefinition).toHaveBeenCalledTimes(2);
    expect(listTools).toHaveBeenCalledWith('linear', expect.objectContaining({ includeSchema: true }));
    const messages = logSpy.mock.calls.map((call) => call.join(' '));
    expect(messages.some((line) => line.includes('Auto-corrected server name to linear'))).toBe(true);

    logSpy.mockRestore();
  });

  it('suggests a server name when the typo is large', async () => {
    const { handleList } = await cliModulePromise;
    const definition = linearDefinition;
    const listTools = vi.fn();
    const runtime = {
      getDefinition: () => {
        throw new Error("Unknown MCP server 'zzz'");
      },
      getDefinitions: () => [definition],
      listTools,
    } as unknown as Awaited<ReturnType<typeof import('../src/runtime.js')['createRuntime']>>;

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleList(runtime, ['zzz']);

    const errorLines = errorSpy.mock.calls.map((call) => call.join(' '));
    expect(errorLines.some((line) => line.includes('Did you mean linear?'))).toBe(true);
    expect(listTools).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    logSpy.mockRestore();
  });
});
