import {
  Client,
  type ClientOptions,
  DEFAULT_REQUEST_TIMEOUT_MSEC,
  SdkErrorCode,
  type Transport,
  type VersionNegotiationMode,
} from '@modelcontextprotocol/client';
import { applyChromeDevtoolsCompat } from '../chrome-devtools-compat.js';
import { rewriteChromeDevtoolsArgsForRelay } from '../chrome-devtools-relay.js';
import type { ServerDefinition } from '../config.js';
import { resolveEnvValue, withEnvOverrides } from '../env.js';
import type { Logger } from '../logging.js';
import { closeTransportAndWait } from '../runtime-process-utils.js';
import { applyCachedAuthIfAvailable } from './cached-auth.js';
import {
  createNonInteractiveElicitationResponder,
  type ElicitationHandler,
  registerElicitationHandler,
} from './elicitation.js';
import { createHttpClientContext, type HttpClientFactory } from './http-transport.js';
import { RecordTransport } from './record-transport.js';
import { ReplayTransport } from './replay-transport.js';
import { McporterStdioTransport } from './stdio-transport.js';
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

const LIST_MAX_PAGES = 100;

function resolveStdioProbeTimeoutMs(): number {
  const raw = process.env.MCPORTER_STDIO_PROBE_TIMEOUT_MS;
  if (!raw || !/^[1-9]\d*$/.test(raw)) return DEFAULT_REQUEST_TIMEOUT_MSEC;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_REQUEST_TIMEOUT_MSEC;
}

function resolveNegotiationMode(definition: ServerDefinition): VersionNegotiationMode {
  switch (definition.protocolVersion) {
    case 'legacy':
      return 'legacy';
    case '2026-07-28':
      return { pin: '2026-07-28' };
    default:
      return 'auto';
  }
}

function shouldRetryStdioAsLegacy(error: unknown, definition: ServerDefinition): boolean {
  return (
    resolveNegotiationMode(definition) === 'auto' &&
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === SdkErrorCode.EraNegotiationFailed
  );
}

function createClient(
  definition: ServerDefinition,
  clientInfo: { name: string; version: string },
  options: { stdio?: boolean; forceLegacy?: boolean; elicitationHandler?: ElicitationHandler } = {}
): Client {
  const mode = options.forceLegacy ? 'legacy' : resolveNegotiationMode(definition);
  const clientOptions: ClientOptions = {
    capabilities: { elicitation: { form: {}, url: {} } },
    listMaxPages: LIST_MAX_PAGES,
    versionNegotiation: {
      mode,
      ...(options.stdio && mode !== 'legacy' ? { probe: { timeoutMs: resolveStdioProbeTimeoutMs() } } : {}),
    },
  };
  const client = new Client(clientInfo, clientOptions);
  if (options.elicitationHandler) registerElicitationHandler(client, options.elicitationHandler);
  return client;
}

async function createReplayClientContext(
  definition: ServerDefinition,
  replayPath: string,
  clientInfo: { name: string; version: string }
): Promise<ClientContext> {
  const transport = new ReplayTransport({ recordPath: replayPath, server: definition.name });
  // Pre-v2 captures start with initialize. Skip a probe those recordings
  // cannot satisfy; captures containing server/discover replay normally.
  const client = createClient(definition, clientInfo, {
    forceLegacy: transport.requiresLegacyNegotiation,
    elicitationHandler: createNonInteractiveElicitationResponder().handler,
  });
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
  const resolvedArgs = resolveCommandArguments(definition.command.args);
  const relay = await rewriteChromeDevtoolsArgsForRelay(command, resolvedArgs, mergedEnv as NodeJS.ProcessEnv);
  if (relay.applied) {
    logger.info(`Routing chrome-devtools-mcp through the OpenClaw extension relay at ${relay.endpoint} (no dialog).`);
  }
  const commandArgs = [...relay.args];
  const compat = applyChromeDevtoolsCompat(mergedEnv as Record<string, string>, command, commandArgs);
  if (compat.applied) {
    logger.info(`Injecting chrome-devtools-mcp --autoConnect compatibility patch from ${compat.patchPath}.`);
  }
  const rawTransport = new McporterStdioTransport({
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
  if (options.replayPath && shouldUseModeForServer(definition, process.env.MCPORTER_REPLAY_SERVER)) {
    return createReplayClientContext(definition, options.replayPath, clientInfo);
  }
  const activeDefinition = await applyCachedAuthIfAvailable(definition, logger, options.allowCachedAuth);

  return withEnvOverrides(activeDefinition.env, async () => {
    if (activeDefinition.command.kind === 'stdio') {
      const stdioDefinition = activeDefinition as ServerDefinition & {
        command: Extract<ServerDefinition['command'], { kind: 'stdio' }>;
      };
      try {
        return await createStdioClientContext(
          createClient(stdioDefinition, clientInfo, { stdio: true, elicitationHandler: options.elicitationHandler }),
          stdioDefinition,
          logger,
          options
        );
      } catch (error) {
        if (!shouldRetryStdioAsLegacy(error, stdioDefinition)) throw error;
        logger.info(
          `Retrying '${stdioDefinition.name}' in legacy mode after its stdio process exited during version negotiation.`
        );
        return createStdioClientContext(
          createClient(stdioDefinition, clientInfo, {
            stdio: true,
            forceLegacy: true,
            elicitationHandler: options.elicitationHandler,
          }),
          stdioDefinition,
          logger,
          options
        );
      }
    }
    const httpClientFactory: HttpClientFactory = {
      create: (httpDefinition) =>
        createClient(httpDefinition, clientInfo, { elicitationHandler: options.elicitationHandler }),
      createLegacy: (httpDefinition) =>
        createClient(httpDefinition, clientInfo, {
          forceLegacy: true,
          elicitationHandler: options.elicitationHandler,
        }),
    };
    return createHttpClientContext(activeDefinition, logger, options, wrapRecordTransport, httpClientFactory);
  });
}
