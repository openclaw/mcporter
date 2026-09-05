import { expect, it, vi } from 'vitest';
import { DaemonBroker } from '../src/daemon/broker.js';
import { effectiveDefinition } from '../src/daemon/connection-identity.js';
import { createRuntime } from '../src/runtime.js';

vi.mock('../src/runtime.js', () => ({ createRuntime: vi.fn() }));

it('keeps metadata in the view and HTTP auth-policy connection, without widening discovery authority', async () => {
  const connects = vi.fn();
  vi.mocked(createRuntime).mockImplementation(
    async () =>
      ({
        connect: connects.mockImplementation(async (_server, policy) => ({
          transport: {},
          client: {
            getInstructions: () => JSON.stringify(policy),
            getServerVersion: () => ({ name: 'synthetic', version: '1' }),
          },
        })),
        listTools: async () => [],
        close: async () => {},
      }) as unknown as Awaited<ReturnType<typeof createRuntime>>
  );
  const broker = new DaemonBroker();
  const definition = await effectiveDefinition(
    {
      name: 'fixture',
      command: { kind: 'http', url: new URL('https://synthetic.invalid/mcp') },
      lifecycle: { mode: 'keep-alive' },
    },
    {}
  );
  const handle = broker.register(JSON.parse(JSON.stringify({ definitions: [definition] })));
  const request = { id: 'metadata', method: 'getServerMetadata' as const, ...handle };
  try {
    await expect(broker.invoke({ ...request, params: { server: 'outside' } })).rejects.toMatchObject({
      code: 'server_not_in_view',
    });
    expect(connects).not.toHaveBeenCalled();
    for (const params of [
      { server: 'fixture', autoAuthorize: false, allowCachedAuth: false },
      { server: 'fixture', disableOAuth: true, allowCachedAuth: false },
      { server: 'fixture', disableOAuth: true, allowCachedAuth: true },
      { server: 'fixture', disableOAuth: false, allowCachedAuth: true },
    ])
      await broker.invoke({ ...request, params });
    expect(connects.mock.calls.map((call) => call[1])).toEqual([
      { disableOAuth: true, allowCachedAuth: false },
      { disableOAuth: true, allowCachedAuth: true },
      { disableOAuth: false, allowCachedAuth: true },
    ]);
    await broker.invoke({
      ...request,
      method: 'listTools',
      params: { server: 'fixture', autoAuthorize: false, allowCachedAuth: false },
    });
    expect(connects).toHaveBeenCalledTimes(3);
    await expect(
      broker.invoke({ ...request, generation: 'stale', params: { server: 'fixture' } })
    ).rejects.toMatchObject({ code: 'daemon_generation_changed' });
    broker.release({ ...request, method: 'releaseView', params: {} });
    await expect(broker.invoke({ ...request, params: { server: 'fixture' } })).rejects.toMatchObject({
      code: 'view_expired',
    });
  } finally {
    await broker.close();
  }
});
