import type { ServerDefinition } from './config.js';
import { DaemonClient } from './daemon/client.js';
import { createKeepAliveRuntime } from './daemon/runtime-wrapper.js';
import { isKeepAliveServer } from './lifecycle.js';
import type { Runtime } from './runtime.js';

export interface GeneratedRuntimeContext {
  readonly runtime: Runtime;
  close(server?: string): Promise<void>;
}

export async function createGeneratedKeepAliveRuntime(
  base: Runtime,
  server: ServerDefinition
): Promise<GeneratedRuntimeContext> {
  if (!isKeepAliveServer(server)) {
    return {
      runtime: base,
      close: async (target?: string) => {
        await base.close(target);
      },
    };
  }

  const runtime = createKeepAliveRuntime(base, {
    daemonClient: new DaemonClient({ configPath: '', configExplicit: false }),
    keepAliveServers: new Set([server.name]),
  });
  return { runtime, close: () => runtime.close() };
}
