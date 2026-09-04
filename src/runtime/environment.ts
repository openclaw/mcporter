import { AsyncLocalStorage } from 'node:async_hooks';
import os from 'node:os';
import path from 'node:path';

const connectionEnvironment = new AsyncLocalStorage<NodeJS.ProcessEnv>();

/** Async-scoped context also follows OAuth callbacks without mutating the host environment. */
export function runtimeEnvironment(): NodeJS.ProcessEnv {
  return connectionEnvironment.getStore() ?? process.env;
}

export function withRuntimeEnvironment<T>(env: NodeJS.ProcessEnv, action: () => T): T {
  return connectionEnvironment.run(env, action);
}

export function runtimeHome(): string {
  if (!connectionEnvironment.getStore()) return os.homedir();
  const env = runtimeEnvironment();
  return env.HOME ?? env.USERPROFILE ?? os.userInfo().homedir;
}

export function runtimeStateDir(kind: 'data' | 'cache'): string {
  const env = runtimeEnvironment();
  const root = env[kind === 'data' ? 'XDG_DATA_HOME' : 'XDG_CACHE_HOME'];
  return root && path.isAbsolute(root) ? path.join(root, 'mcporter') : path.join(runtimeHome(), '.mcporter');
}
