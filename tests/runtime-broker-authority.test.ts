import { expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { createRuntime } from '../src/runtime.js';
import { authorizeBrokerDefinition } from '../src/daemon/transport-authority.js';
import { BrowserOwnerConflict } from '../src/daemon/browser-owner.js';

for (const operation of ['callTool', 'listTools', 'listResources', 'readResource'] as const)
  it(`rechecks authority after the runtime connection await immediately before ${operation} dispatch`, async () => {
    const definition: ServerDefinition = {
      name: 'synthetic',
      command: { kind: 'stdio', command: process.execPath, args: [], cwd: process.cwd() },
      lifecycle: { mode: 'keep-alive' },
    };
    let allowed = true;
    authorizeBrokerDefinition(definition, async () => {
      if (!allowed) throw new BrowserOwnerConflict('synthetic credential revoked');
    });
    const runtime = await createRuntime({ servers: [definition] });
    const held = Promise.withResolvers<Awaited<ReturnType<typeof runtime.connect>>>();
    const effect = vi.fn(async () => ({ tools: [], resources: [], contents: [], content: [] }));
    const context = {
      definition,
      transport: {},
      client: {
        callTool: effect,
        listTools: effect,
        listResources: effect,
        request: effect,
        readResource: effect,
      },
    } as unknown as Awaited<ReturnType<typeof runtime.connect>>;
    const connect = vi.spyOn(runtime, 'connect').mockReturnValue(held.promise);
    const invoke = {
      callTool: () => runtime.callTool('synthetic', 'identity'),
      listTools: () => runtime.listTools('synthetic'),
      listResources: () => runtime.listResources('synthetic'),
      readResource: () => runtime.readResource('synthetic', 'synthetic://resource'),
    }[operation];
    try {
      const rejected = expect(invoke()).rejects.toMatchObject({ code: 'browser_owner_conflict' });
      expect(connect).toHaveBeenCalledTimes(1);
      allowed = false;
      held.resolve(context);
      await rejected;
      expect(effect).not.toHaveBeenCalled();
      allowed = true;
      await invoke();
      expect(effect).toHaveBeenCalledTimes(1);
    } finally {
      held.resolve(context);
      await runtime.close();
    }
  });
