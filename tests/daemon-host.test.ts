import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
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

it.each([
  ['selected alias', ['selected'], 0],
  ['all aliases', [], 4],
] as const)('logs activity for %s when views share a connection', async (_label, logServers, excludedLogCount) => {
  const f = await singletonFixture({ logServers: [...logServers] });
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const excluded = f.client({ ...f.definition, name: 'excluded' });
    const selected = f.client({ ...f.definition, name: 'selected' });
    await excluded.listTools({ server: 'excluded' });
    await excluded.callTool({ server: 'excluded', tool: 'identity' });
    expect(output).toHaveBeenCalledTimes(excludedLogCount);
    output.mockClear();
    await selected.listTools({ server: 'selected' });
    await selected.callTool({ server: 'selected', tool: 'identity' });
    expect(output).toHaveBeenCalledTimes(4);
    expect(f.host.status().servers).toHaveLength(1);
    await f.host.close();
    const log = await fs.readFile(path.join(f.root, 'daemon.log'), 'utf8');
    expect(log.trim().split('\n')).toHaveLength(4 + excludedLogCount);
  } finally {
    await f.close().finally(() => output.mockRestore());
  }
});
