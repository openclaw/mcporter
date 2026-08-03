import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntime } from '../src/runtime.js';

describe('runtime listTools timeouts', () => {
  afterEach(() => vi.restoreAllMocks());

  it('forwards the deadline to OAuth connection setup and the MCP request', async () => {
    const runtime = await createRuntime({ servers: [] });
    const listTools = vi.fn().mockResolvedValue({ tools: [{ name: 'one' }] });
    type ClientContext = Awaited<ReturnType<typeof runtime.connect>>;
    const context = {
      client: { listTools },
      transport: { close: vi.fn().mockResolvedValue(undefined) },
      definition: {
        name: 'temp',
        command: { kind: 'stdio', command: 'node', args: [], cwd: process.cwd() },
      },
    } as unknown as ClientContext;
    const connect = vi.spyOn(runtime, 'connect').mockResolvedValue(context);

    await expect(runtime.listTools('temp', { timeoutMs: 5_000 })).resolves.toEqual([{ name: 'one' }]);

    expect(connect).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ oauthTimeoutMs: 5_000 }));
    expect(listTools).toHaveBeenCalledWith(undefined, {
      timeout: 5_000,
      resetTimeoutOnProgress: true,
      maxTotalTimeout: 5_000,
    });
  });

  it('preserves the SDK defaults when no timeout is supplied', async () => {
    const runtime = await createRuntime({ servers: [] });
    const listTools = vi.fn().mockResolvedValue({ tools: [] });
    type ClientContext = Awaited<ReturnType<typeof runtime.connect>>;
    vi.spyOn(runtime, 'connect').mockResolvedValue({
      client: { listTools },
      transport: { close: vi.fn().mockResolvedValue(undefined) },
      definition: { name: 'temp' },
    } as unknown as ClientContext);

    await runtime.listTools('temp');

    expect(listTools).toHaveBeenCalledWith(undefined, undefined);
  });
});
