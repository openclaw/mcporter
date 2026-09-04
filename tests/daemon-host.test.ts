import { expect, it } from 'vitest';
import { DaemonBroker } from '../src/daemon/broker.js';
import { singletonFixture, fixtureResult } from './helpers/singleton.js';
it('starts an empty global host and enforces per-view filters on advertisements and direct calls', async () => {
  const f = await singletonFixture();
  try {
    expect(f.host.status().servers).toHaveLength(0);
    const limited = f.client({ ...f.definition, name: 'limited', blockedTools: ['secret'] });
    const allowed = f.client();
    expect(
      ((await limited.listTools({ server: 'limited' })) as Array<{ name: string }>).map((t) => t.name)
    ).not.toContain('secret');
    await expect(limited.callTool({ server: 'limited', tool: 'secret' })).rejects.toMatchObject({
      code: 'tool_not_allowed',
    });
    const first = fixtureResult(await allowed.callTool({ server: 'fixture', tool: 'secret' }));
    expect(fixtureResult(await limited.callTool({ server: 'limited', tool: 'identity' })).id).toBe(first.id);
    expect(f.host.status().servers).toHaveLength(1);
  } finally {
    await f.close();
  }
});
it('rejects malformed snapshots, expired bindings and stale generation handles', async () => {
  const b = new DaemonBroker();
  expect(() => b.register({ definitions: [{ name: 'bad' }] })).toThrow();
  const handle = b.register({ definitions: [] });
  b.release({ id: 'a', method: 'releaseView', params: {}, ...handle });
  await expect(b.invoke({ id: 'b', method: 'listTools', params: { server: 'x' }, ...handle })).rejects.toMatchObject({
    code: 'view_expired',
  });
  await expect(
    b.invoke({ id: 'b', method: 'listTools', params: { server: 'x' }, ...handle, generation: 'old' })
  ).rejects.toMatchObject({ code: 'daemon_generation_changed' });
});
