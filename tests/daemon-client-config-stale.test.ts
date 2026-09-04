import fs from 'node:fs/promises';
import { expect, it } from 'vitest';
import { singletonFixture, fixtureResult } from './helpers/singleton.js';
it('replaces immutable views without mtime restarts, shared child shutdown or in-flight interruption', async () => {
  const f = await singletonFixture();
  try {
    const a = f.client(),
      b = f.client({ ...f.definition, name: 'alias' });
    const first = fixtureResult(await a.callTool({ server: 'fixture', tool: 'identity' }));
    const flight = b.callTool({ server: 'alias', tool: 'delayed' });
    for (let i = 0; i < 100; i++) {
      if (await fs.stat(`${f.root}/effects`).catch(() => undefined)) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    a.setDefinitions([{ ...f.definition, env: { VALUE: 'replacement' } }]);
    const replacement = fixtureResult(await a.callTool({ server: 'fixture', tool: 'identity' }));
    expect(replacement.id).not.toBe(first.id);
    expect(replacement.value).toBe('replacement');
    expect(fixtureResult(await flight).id).toBe(first.id);
    expect(fixtureResult(await b.callTool({ server: 'alias', tool: 'identity' })).id).toBe(first.id);
    await a.release();
    expect((await b.status())?.pid).toBe(process.pid);
  } finally {
    await f.close();
  }
});
