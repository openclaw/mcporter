import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleHealth } from '../src/cli/health-command.js';
import type { ServerDefinition } from '../src/config.js';
import type { Runtime, ServerToolInfo } from '../src/runtime.js';

function buildServerDefinition(name: string, overrides: Partial<ServerDefinition> = {}): ServerDefinition {
  return {
    name,
    command: { kind: 'http', url: new URL(`https://${name}.example.com/mcp`) },
    ...overrides,
  };
}

function createRuntime(
  definitions: ServerDefinition[],
  listTools: Runtime['listTools']
): Runtime & { listTools: ReturnType<typeof vi.fn> } {
  const listToolsMock = vi.fn(listTools);
  return {
    listServers: () => definitions.map((entry) => entry.name),
    getDefinitions: () => definitions,
    getDefinition: (name: string): ServerDefinition => {
      const found = definitions.find((entry) => entry.name === name);
      if (!found) {
        throw new Error(`Unknown MCP server '${name}'.`);
      }
      return found;
    },
    registerDefinition: vi.fn(),
    listTools: listToolsMock,
    callTool: vi.fn(async () => undefined),
    listResources: vi.fn(async () => undefined),
    readResource: vi.fn(async () => undefined),
    connect: vi.fn(async () => {
      throw new Error('connect not implemented');
    }),
    close: vi.fn(async () => undefined),
  };
}

function tools(count: number): ServerToolInfo[] {
  return Array.from({ length: count }, (_, index) => ({ name: `tool_${index + 1}` }));
}

describe('handleHealth', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('prints one ok row per reachable server and leaves the exit code successful', async () => {
    const definitions = [buildServerDefinition('alpha'), buildServerDefinition('beta')];
    const runtime = createRuntime(definitions, async (server) => tools(server === 'alpha' ? 1 : 2));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleHealth(runtime, []);

    const output = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(output).toContain('alpha');
    expect(output).toContain('beta');
    expect(output).toContain('ok');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('classifies 401 failures as auth_required and exits non-zero', async () => {
    const definitions = [buildServerDefinition('alpha'), buildServerDefinition('linear', { auth: 'oauth' })];
    const runtime = createRuntime(definitions, async (server) => {
      if (server === 'linear') {
        throw new Error('HTTP error 401: auth required');
      }
      return tools(1);
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleHealth(runtime, []);

    const output = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(output).toContain('linear');
    expect(output).toContain('auth_required');
    expect(process.exitCode).toBe(1);
  });

  it('classifies a per-server timeout as unreachable with an error preview', async () => {
    const definitions = [buildServerDefinition('slow')];
    const runtime = createRuntime(
      definitions,
      async () =>
        await new Promise<ServerToolInfo[]>(() => {
          // Intentionally unresolved; health's per-server timeout rejects first.
        })
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleHealth(runtime, ['--timeout', '1']);

    const output = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(output).toContain('slow');
    expect(output).toContain('unreachable');
    expect(output).toContain('Timeout');
    expect(process.exitCode).toBe(1);
  });

  it('emits valid JSON health rows', async () => {
    const definitions = [buildServerDefinition('alpha')];
    const runtime = createRuntime(definitions, async () => tools(3));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleHealth(runtime, ['--json']);

    const payload = JSON.parse(logSpy.mock.calls.at(-1)?.[0] ?? '[]');
    expect(payload).toEqual([
      expect.objectContaining({
        server: 'alpha',
        status: 'ok',
        tool_count: 3,
        oauth_state: 'not_required',
        error: null,
      }),
    ]);
  });

  it('filters checks to --server', async () => {
    const definitions = [buildServerDefinition('alpha'), buildServerDefinition('beta')];
    const runtime = createRuntime(definitions, async () => tools(1));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleHealth(runtime, ['--server', 'beta']);

    expect(runtime.listTools).toHaveBeenCalledTimes(1);
    expect(runtime.listTools).toHaveBeenCalledWith('beta', { autoAuthorize: false, allowCachedAuth: true });
    const output = logSpy.mock.calls.map((call) => call[0]).join('\n');
    expect(output).not.toContain('alpha');
    expect(output).toContain('beta');
  });

  it('enforces --timeout per server', async () => {
    const definitions = [buildServerDefinition('blocked')];
    const runtime = createRuntime(
      definitions,
      async () =>
        await new Promise<ServerToolInfo[]>(() => {
          // Intentionally unresolved; health's per-server timeout rejects first.
        })
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const startedAt = Date.now();
    await handleHealth(runtime, ['--timeout', '1']);

    expect(Date.now() - startedAt).toBeLessThan(2_500);
    expect(process.exitCode).toBe(1);
    expect(logSpy.mock.calls.map((call) => call[0]).join('\n')).toContain('unreachable');
  });

  it('suppresses output with --quiet but preserves the exit code', async () => {
    const definitions = [buildServerDefinition('linear', { auth: 'oauth' })];
    const runtime = createRuntime(definitions, async () => {
      throw new Error('HTTP status 401 unauthorized');
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleHealth(runtime, ['--quiet']);

    expect(logSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
