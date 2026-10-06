import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createRuntime } from '../src/runtime.js';
import { createServerProxy } from '../src/server-proxy.js';

it('preserves named arguments when real MCP discovery fails but tool calls work', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-proxy-discovery-'));
  const config = path.join(dir, 'mcporter.json');
  await fs.writeFile(
    config,
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [fileURLToPath(new URL('./fixtures/stdio-unavailable-discovery.mjs', import.meta.url))],
          protocolVersion: 'legacy',
        },
      },
    })
  );
  const runtime = await createRuntime({ configPath: config });
  const proxy = createServerProxy(runtime, 'fixture', { cacheSchemas: false }) as unknown as Record<
    string,
    (...args: unknown[]) => Promise<{ json(): unknown }>
  >;
  try {
    await expect(runtime.listTools('fixture')).rejects.toThrow('Discovery unavailable');
    expect((await proxy.echo!({ query: 'real input', count: 0 })).json()).toEqual({ query: 'real input', count: 0 });
    expect((await proxy.echo!({ args: { query: 'explicit envelope' }, timeout: 1000 })).json()).toEqual({
      query: 'explicit envelope',
    });
    expect((await proxy.echo!({ timeout: 1000 })).json()).toEqual({});
  } finally {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
