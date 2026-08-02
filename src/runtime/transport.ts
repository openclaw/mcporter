import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { applyChromeDevtoolsCompat } from '../chrome-devtools-compat.js';
import type { ServerDefinition } from '../config.js';
import { resolveEnvValue, withEnvOverrides } from '../env.js';
import type { Logger } from '../logging.js';
import { closeTransportAndWait } from '../runtime-process-utils.js';
import { applyCachedAuthIfAvailable } from './cached-auth.js';
import { createHttpClientContext } from './http-transport.js';
import { RecordTransport } from './record-transport.js';
import { ReplayTransport } from './replay-transport.js';
import type { ClientContext, CreateClientContextOptions, WrapRecordTransport } from './transport-types.js';
import { resolveCommandArgument, resolveCommandArguments } from './utils.js';

export type { ClientContext, CreateClientContextOptions } from './transport-types.js';

function shouldUseModeForServer(definition: ServerDefinition, serverFilter: string | undefined): boolean {
  return !serverFilter || serverFilter === definition.name;
}

const wrapRecordTransport: WrapRecordTransport = <TTransport extends Transport>(
  transport: TTransport,
  definition: ServerDefinition,
  options: CreateClientContextOptions
): TTransport => {
  if (!options.recordPath || !shouldUseModeForServer(definition, process.env.MCPORTER_RECORD_SERVER)) {
    return transport;
  }
  return new RecordTransport({
    inner: transport,
    recordPath: options.recordPath,
    server: definition.name,
  }) as unknown as TTransport;
};

async function createReplayClientContext(
  client: Client,
  definition: ServerDefinition,
  replayPath: string
): Promise<ClientContext> {
  const transport = new ReplayTransport({ recordPath: replayPath, server: definition.name });
  await client.connect(transport);
  return { client, transport, definition, oauthSession: undefined };
}

async function createStdioClientContext(
  client: Client,
  definition: ServerDefinition & { command: Extract<ServerDefinition['command'], { kind: 'stdio' }> },
  logger: Logger,
  options: CreateClientContextOptions
): Promise<ClientContext> {
  const resolvedEnvOverrides =
    definition.env && Object.keys(definition.env).length > 0
      ? Object.fromEntries(
          Object.entries(definition.env)
            .map(([key, raw]) => [key, resolveEnvValue(raw)])
            .filter(([, value]) => value !== '')
        )
      : undefined;
  const mergedEnv =
    resolvedEnvOverrides && Object.keys(resolvedEnvOverrides).length > 0
      ? { ...process.env, ...resolvedEnvOverrides }
      : { ...process.env };
  const command = resolveCommandArgument(definition.command.command);
  const commandArgs = resolveCommandArguments(definition.command.args);
  const compat = applyChromeDevtoolsCompat(mergedEnv as Record<string, string>, command, commandArgs);
  if (compat.applied) {
    logger.info(`Injecting chrome-devtools-mcp --autoConnect compatibility patch from ${compat.patchPath}.`);
  }
  const rawTransport = new StdioClientTransport({
    command,
    args: commandArgs,
    cwd: definition.command.cwd,
    env: compat.env,
  });
  const transport = wrapRecordTransport(rawTransport, definition, options);
  try {
    await client.connect(transport);
  } catch (error) {
    await closeTransportAndWait(logger, transport).catch(() => {});
    throw error;
  }
  return { client, transport, definition, oauthSession: undefined };
}

export async function createClientContext(
  definition: ServerDefinition,
  logger: Logger,
  clientInfo: { name: string; version: string },
  options: CreateClientContextOptions = {}
): Promise<ClientContext> {
  const client = new Client(clientInfo);
  if (options.replayPath && shouldUseModeForServer(definition, process.env.MCPORTER_REPLAY_SERVER)) {
    return createReplayClientContext(client, definition, options.replayPath);
  }
  const activeDefinition = await applyCachedAuthIfAvailable(definition, logger, options.allowCachedAuth);

  return withEnvOverrides(activeDefinition.env, async () => {
    if (activeDefinition.command.kind === 'stdio') {
      return createStdioClientContext(
        client,
        activeDefinition as ServerDefinition & { command: Extract<ServerDefinition['command'], { kind: 'stdio' }> },
        logger,
        options
      );
    }
    return createHttpClientContext(client, activeDefinition, logger, options, wrapRecordTransport);
  });
}
