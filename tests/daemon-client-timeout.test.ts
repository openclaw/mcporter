import fs from 'node:fs/promises';
import { expect, it } from 'vitest';
import { singletonFixture, fixtureResult } from './helpers/singleton.js';
it('does not replay timed-out side effects, quarantine application errors, or replace a healthy child', async () => {
  const f = await singletonFixture();
  try {
    const c = f.client();
    const before = fixtureResult(await c.callTool({ server: 'fixture', tool: 'identity' }));
    await expect(c.callTool({ server: 'fixture', tool: 'delayed', timeoutMs: 30 })).rejects.toMatchObject({
      code: 'operation_timeout',
    });
    expect((await fs.readFile(`${f.root}/effects`, 'utf8')).trim().split('\n')).toEqual(['once']);
    expect(fixtureResult(await c.callTool({ server: 'fixture', tool: 'identity' })).id).toBe(before.id);
    expect(await c.callTool({ server: 'fixture', tool: 'application_error' })).toMatchObject({ isError: true });
    expect(fixtureResult(await c.callTool({ server: 'fixture', tool: 'identity' })).id).toBe(before.id);
  } finally {
    await f.close();
  }
});
