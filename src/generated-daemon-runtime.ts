import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type RawEntry, type ServerDefinition, writeRawConfig } from './config.js';
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

  const configPath = await ensureGeneratedDaemonConfig(server);
  const runtime = createKeepAliveRuntime(base, {
    daemonClient: new DaemonClient({ configPath, configExplicit: true }),
    keepAliveServers: new Set([server.name]),
  });
  return {
    runtime,
    close: async () => {
      await base.close();
    },
  };
}

async function ensureGeneratedDaemonConfig(server: ServerDefinition): Promise<string> {
  const rawConfig = {
    imports: [],
    mcpServers: {
      [server.name]: serializeRawEntry(server),
    },
  };
  const payload = `${JSON.stringify(rawConfig, null, 2)}\n`;
  const key = crypto.createHash('sha1').update(payload).digest('hex').slice(0, 12);
  const dir = process.env.MCPORTER_GENERATED_CONFIG_DIR
    ? path.resolve(process.env.MCPORTER_GENERATED_CONFIG_DIR)
    : path.join(os.homedir(), '.mcporter', 'generated');
  const configPath = path.join(dir, `generated-${key}.json`);
  await fs.mkdir(dir, { recursive: true });
  try {
    const existing = await fs.readFile(configPath, 'utf8');
    if (existing === payload) {
      return configPath;
    }
  } catch {
    // Write the generated config below.
  }
  await writeRawConfig(configPath, rawConfig);
  return configPath;
}

function serializeRawEntry(server: ServerDefinition): RawEntry {
  const common = {
    ...(server.description ? { description: server.description } : {}),
    ...(server.env ? { env: server.env } : {}),
    ...(server.auth ? { auth: server.auth } : {}),
    ...(server.tokenCacheDir ? { tokenCacheDir: server.tokenCacheDir } : {}),
    ...(server.clientName ? { clientName: server.clientName } : {}),
    ...(server.oauthRedirectUrl ? { oauthRedirectUrl: server.oauthRedirectUrl } : {}),
    ...(server.oauthScope ? { oauthScope: server.oauthScope } : {}),
    ...(server.oauthCommand ? { oauthCommand: server.oauthCommand } : {}),
    ...(server.lifecycle ? { lifecycle: serializeLifecycle(server.lifecycle) } : {}),
    ...(server.logging ? { logging: server.logging } : {}),
    ...(server.allowedTools ? { allowedTools: [...server.allowedTools] } : {}),
    ...(server.blockedTools ? { blockedTools: [...server.blockedTools] } : {}),
  };
  if (server.command.kind === 'http') {
    return {
      ...common,
      url: server.command.url.toString(),
      ...(server.command.headers ? { headers: server.command.headers } : {}),
    };
  }
  return {
    ...common,
    command: server.command.command,
    args: [...server.command.args],
    cwd: server.command.cwd,
  };
}

function serializeLifecycle(lifecycle: ServerDefinition['lifecycle']): RawEntry['lifecycle'] {
  if (!lifecycle) {
    return undefined;
  }
  if (lifecycle.mode === 'keep-alive' && lifecycle.idleTimeoutMs === undefined) {
    return 'keep-alive';
  }
  if (lifecycle.mode === 'ephemeral') {
    return 'ephemeral';
  }
  return lifecycle;
}
