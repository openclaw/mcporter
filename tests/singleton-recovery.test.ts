import fs from 'node:fs/promises';
import { expect, it } from 'vitest';
import { singletonFixture, fixtureResult } from './helpers/singleton.js';
it('reconnects once after definitive child exit while retaining the broker generation', async () => {
  const f = await singletonFixture();
  try {
    const c = f.client();
    const first = fixtureResult(await c.callTool({ server: 'fixture', tool: 'identity' }));
    const generation = f.host.status().generation;
    await c.callTool({ server: 'fixture', tool: 'disconnect' });
    for (let i = 0; i < 100 && f.host.status().servers[0]?.connected; i++) await new Promise((r) => setTimeout(r, 10));
    expect(f.host.status().servers[0]?.connected).toBe(false);
    const values = await Promise.all(
      [f.client(), f.client()].map((client) =>
        client.callTool({ server: 'fixture', tool: 'identity' }).then(fixtureResult)
      )
    );
    expect(values[0]?.id).not.toBe(first.id);
    expect(values[0]?.id).toBe(values[1]?.id);
    expect(f.host.status().generation).toBe(generation);
    expect(f.host.status().servers[0]?.connectionGeneration).toBe(2);
    expect((await fs.readFile(`${f.root}/instances`, 'utf8')).trim().split('\n')).toHaveLength(2);
  } finally {
    await f.close();
  }
});
