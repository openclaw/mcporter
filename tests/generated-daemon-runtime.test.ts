import fs from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createGeneratedKeepAliveRuntime } from '../src/generated-daemon-runtime.js';
import { createRuntime } from '../src/runtime.js';
import { singletonFixture, fixtureResult } from './helpers/singleton.js';
it('registers generated definitions in memory without writing secret-bearing configs and retains the child after close', async () => {
  const f = await singletonFixture();
  try {
    const base = await createRuntime({ servers: [f.definition] });
    const context = await createGeneratedKeepAliveRuntime(base, f.definition);
    const first = fixtureResult(await context.runtime.callTool('fixture', 'identity'));
    await context.close();
    expect(fixtureResult(await f.client().callTool({ server: 'fixture', tool: 'identity' })).id).toBe(first.id);
    const custom = await createGeneratedKeepAliveRuntime(
      await createRuntime({ servers: [f.definition], clientInfo: { name: 'custom-client', version: '1' } }),
      f.definition
    );
    expect(fixtureResult(await custom.runtime.callTool('fixture', 'identity')).id).not.toBe(first.id);
    await custom.close();
    expect((await fs.readdir(f.root)).filter((name) => name.startsWith('generated-'))).toEqual([]);
  } finally {
    await f.close();
  }
});
