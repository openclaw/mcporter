import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadServerDefinitions, type ServerDefinition } from '../src/config.js';
import { createRuntime } from '../src/runtime.js';

function httpDefinition(name: string, filters: Partial<Pick<ServerDefinition, 'allowedTools' | 'blockedTools'>> = {}) {
  return {
    name,
    command: { kind: 'http', url: new URL(`https://example.com/${name}`) },
    ...filters,
  } satisfies ServerDefinition;
}

async function writeConfig(config: unknown): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-tool-filters-'));
  const configPath = path.join(tempDir, 'mcporter.json');
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return configPath;
}

describe('tool filter config', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes camelCase and snake_case filter fields', async () => {
    const configPath = await writeConfig({
      imports: [],
      mcpServers: {
        allow: {
          url: 'https://example.com/allow',
          allowed_tools: ['read'],
        },
        block: {
          url: 'https://example.com/block',
          blockedTools: ['write'],
        },
        none: {
          url: 'https://example.com/none',
          allowedTools: [],
        },
      },
    });

    const definitions = await loadServerDefinitions({ configPath });
    expect(definitions.find((entry) => entry.name === 'allow')?.allowedTools).toEqual(['read']);
    expect(definitions.find((entry) => entry.name === 'block')?.blockedTools).toEqual(['write']);
    expect(definitions.find((entry) => entry.name === 'none')?.allowedTools).toEqual([]);
  });

  it('rejects ambiguous allowlist and blocklist config', async () => {
    const configPath = await writeConfig({
      imports: [],
      mcpServers: {
        unsafe: {
          url: 'https://example.com/unsafe',
          allowedTools: ['read'],
          blockedTools: ['write'],
        },
      },
    });

    await expect(loadServerDefinitions({ configPath })).rejects.toThrow(
      'Specify either allowedTools or blockedTools, not both.'
    );
  });
});

describe('runtime tool filtering', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('filters listTools with an allowlist, including an empty allowlist', async () => {
    const runtime = await createRuntime({
      servers: [httpDefinition('allow', { allowedTools: ['read'] }), httpDefinition('empty', { allowedTools: [] })],
    });
    type ClientContext = Awaited<ReturnType<typeof runtime.connect>>;
    const listTools = vi.fn().mockResolvedValue({
      tools: [{ name: 'read' }, { name: 'write' }, { name: 'delete' }],
    });
    vi.spyOn(runtime, 'connect').mockResolvedValue({
      client: { listTools },
      transport: { close: vi.fn().mockResolvedValue(undefined) },
      definition: runtime.getDefinition('allow'),
      oauthSession: undefined,
    } as unknown as ClientContext);

    await expect(runtime.listTools('allow')).resolves.toEqual([{ name: 'read' }]);
    await expect(runtime.listTools('empty')).resolves.toEqual([]);
  });

  it('filters listTools and rejects callTool with a blocklist before connecting', async () => {
    const runtime = await createRuntime({
      servers: [httpDefinition('filtered', { blockedTools: ['write'] })],
    });
    type ClientContext = Awaited<ReturnType<typeof runtime.connect>>;
    const listTools = vi.fn().mockResolvedValue({
      tools: [{ name: 'read' }, { name: 'write' }, { name: 'delete' }],
    });
    const callTool = vi.fn().mockResolvedValue({ ok: true });
    const connect = vi.spyOn(runtime, 'connect').mockResolvedValue({
      client: { listTools, callTool },
      transport: { close: vi.fn().mockResolvedValue(undefined) },
      definition: runtime.getDefinition('filtered'),
      oauthSession: undefined,
    } as unknown as ClientContext);

    await expect(runtime.listTools('filtered')).resolves.toEqual([{ name: 'read' }, { name: 'delete' }]);
    connect.mockClear();

    await expect(runtime.callTool('filtered', 'write')).rejects.toThrow(
      "Tool 'write' is not accessible on server 'filtered'"
    );
    expect(connect).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it('rejects programmatic definitions that specify both filter modes', async () => {
    await expect(
      createRuntime({
        servers: [httpDefinition('both', { allowedTools: ['read'], blockedTools: ['write'] })],
      })
    ).rejects.toThrow("Server 'both' cannot specify both allowedTools and blockedTools.");
  });
});
