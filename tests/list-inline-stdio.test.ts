import { describe, expect, it, vi } from 'vitest';
import { handleList } from '../src/cli/list-command.js';
import type { ServerDefinition } from '../src/config.js';
import type { Runtime, ServerToolInfo } from '../src/runtime.js';

function createRuntimeStub() {
  const definitions: ServerDefinition[] = [];
  const listTools = vi.fn(
    async (_server: string, _options?: unknown): Promise<ServerToolInfo[]> => [
      {
        name: 'doctor',
        description: 'Runs diagnostics',
        inputSchema: { type: 'object', properties: {}, required: [] },
        outputSchema: undefined,
      },
    ]
  );

  const getDefinition = (name: string): ServerDefinition => {
    const found = definitions.find((entry) => entry.name === name);
    if (!found) {
      throw new Error(`Unknown MCP server '${name}'.`);
    }
    return found;
  };

  const runtime: Runtime = {
    listServers: () => definitions.map((entry) => entry.name).sort(),
    getDefinitions: () => definitions,
    getDefinition,
    registerDefinition: (definition: ServerDefinition, _options?: { overwrite?: boolean }): void => {
      const index = definitions.findIndex((entry) => entry.name === definition.name);
      if (index === -1) {
        definitions.push(definition);
      } else {
        definitions[index] = definition;
      }
    },
    listTools,
    callTool: vi.fn(async () => undefined),
    listResources: vi.fn(async () => undefined),
    readResource: vi.fn(async () => undefined),
    connect: vi.fn(async () => {
      throw new Error('connect not implemented');
    }),
    close: vi.fn(async () => undefined),
  };

  return { runtime, listTools };
}

describe('handleList inline STDIO detection', () => {
  it('treats quoted npx commands as ad-hoc STDIO servers', async () => {
    const { runtime, listTools } = createRuntimeStub();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let logCalls: unknown[][] = [];
    try {
      await handleList(runtime, ['--json', 'npx -y xcodebuildmcp']);
      logCalls = [...logSpy.mock.calls];
    } finally {
      logSpy.mockRestore();
    }
    expect(listTools).toHaveBeenCalledWith('xcodebuildmcp', expect.objectContaining({ includeSchema: true }));
    expect(runtime.getDefinitions()).toHaveLength(1);
    expect(logCalls.length).toBeGreaterThan(0);
    const lastCall = logCalls.at(-1)?.[0];
    expect(lastCall).toBeDefined();
    const payload = JSON.parse(String(lastCall));
    expect(payload.name).toBe('xcodebuildmcp');
    expect(payload.transport).toContain('STDIO npx -y xcodebuildmcp');
  });
});
