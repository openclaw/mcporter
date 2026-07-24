import { describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config-schema.js';
import { createRuntime } from '../src/runtime.js';

type TestRuntime = Awaited<ReturnType<typeof createRuntime>>;
type ClientContext = Awaited<ReturnType<TestRuntime['connect']>>;

function fakeListToolsContext(listTools: ReturnType<typeof vi.fn>): ClientContext {
  return {
    client: {
      listTools,
      close: vi.fn().mockResolvedValue(undefined),
    },
    transport: { close: vi.fn().mockResolvedValue(undefined) },
    definition: {
      name: 'alpha',
      description: 'test server',
      command: { kind: 'http', url: new URL('https://alpha.example.com') },
      source: { kind: 'local', path: '/tmp' },
    },
    oauthSession: undefined,
  } as unknown as ClientContext;
}

describe('runtime.listTools request timeout forwarding', () => {
  const definitions: ServerDefinition[] = [
    {
      name: 'alpha',
      description: 'test server',
      command: { kind: 'http', url: new URL('https://alpha.example.com') },
      source: { kind: 'local', path: '/tmp' },
    },
  ];

  it('forwards timeoutMs to the MCP client so listings (and OAuth during auth) avoid the 60s SDK cap', async () => {
    const runtime = await createRuntime({ servers: definitions });
    const listTools = vi.fn().mockResolvedValue({ tools: [] });
    const connect = vi.spyOn(runtime, 'connect').mockResolvedValue(fakeListToolsContext(listTools));

    await runtime.listTools('alpha', { timeoutMs: 5_000 });

    expect(connect).toHaveBeenCalledWith('alpha', expect.objectContaining({ oauthTimeoutMs: 5_000 }));
    expect(listTools).toHaveBeenCalledWith(undefined, {
      timeout: 5_000,
      resetTimeoutOnProgress: true,
      maxTotalTimeout: 5_000,
    });
  });

  it('omits SDK timeout options when timeoutMs is not provided (preserves prior behavior)', async () => {
    const runtime = await createRuntime({ servers: definitions });
    const listTools = vi.fn().mockResolvedValue({ tools: [] });
    vi.spyOn(runtime, 'connect').mockResolvedValue(fakeListToolsContext(listTools));

    await runtime.listTools('alpha');

    expect(listTools).toHaveBeenCalledWith(undefined, undefined);
  });

  it('normalizes invalid timeoutMs before OAuth connection setup', async () => {
    const runtime = await createRuntime({ servers: definitions });
    const listTools = vi.fn().mockResolvedValue({ tools: [] });
    const connect = vi.spyOn(runtime, 'connect').mockResolvedValue(fakeListToolsContext(listTools));

    await runtime.listTools('alpha', { timeoutMs: 0 });

    expect(connect).toHaveBeenCalledWith('alpha', expect.objectContaining({ oauthTimeoutMs: undefined }));
    expect(listTools).toHaveBeenCalledWith(undefined, undefined);
  });
});
