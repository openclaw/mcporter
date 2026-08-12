import {
  Client,
  type ClientOptions,
  DEFAULT_REQUEST_TIMEOUT_MSEC,
  SdkErrorCode,
  type Transport,
  type VersionNegotiationMode,
} from '@modelcontextprotocol/client';
import { applyChromeDevtoolsCompat } from '../chrome-devtools-compat.js';
import { createChromeDevtoolsRelayHandoff, type ChromeDevtoolsRelayHandoff } from '../chrome-devtools-relay-handoff.js';
import {
  type ChromeDevtoolsRelayDecision,
  ChromeDevtoolsRelayRequiredError,
  type ChromeDevtoolsRelayRewrite,
  formatChromeDevtoolsRelayDecision,
  recordChromeDevtoolsRelayDecision,
  resolveChromeDevtoolsRelayEnvironment,
  rewriteChromeDevtoolsArgsForRelay,
} from '../chrome-devtools-relay.js';
import type { ServerDefinition } from '../config.js';
import { withEnvOverrides } from '../env.js';
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
  const wrapped =
    options.recordPath && shouldUseModeForServer(definition, process.env.MCPORTER_RECORD_SERVER)
      ? (new RecordTransport({
          inner: transport,
          recordPath: options.recordPath,
          server: definition.name,
        }) as unknown as TTransport)
      : transport;
  options.onTransportCreated?.(wrapped);
  return wrapped;
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
  if (options.elicitationHandler) {
    registerElicitationHandler(client, options.elicitationHandler, { server: definition.name });
  }
  return client;
}

async function createReplayClientContext(
  definition: ServerDefinition,
  replayPath: string,
  clientInfo: { name: string; version: string },
  options: CreateClientContextOptions
): Promise<ClientContext> {
  const transport = new ReplayTransport({ recordPath: replayPath, server: definition.name });
  options.onTransportCreated?.(transport);
  // Pre-v2 captures start with initialize. Skip a probe those recordings
  // cannot satisfy; captures containing server/discover replay normally.
  const client = createClient(definition, clientInfo, {
    forceLegacy: transport.requiresLegacyNegotiation,
    elicitationHandler: options.elicitationHandler ?? createNonInteractiveElicitationResponder().handler,
  });
  await client.connect(transport, { signal: options.signal });
  return { client, transport, definition, oauthSession: undefined };
}

async function createStdioClientContext(
  client: Client,
  definition: ServerDefinition & { command: Extract<ServerDefinition['command'], { kind: 'stdio' }> },
  logger: Logger,
  options: CreateClientContextOptions
): Promise<ClientContext> {
  const mergedEnv = resolveChromeDevtoolsRelayEnvironment(definition.env);
  const command = resolveCommandArgument(definition.command.command);
  const resolvedArgs = resolveCommandArguments(definition.command.args);
  const publishRelayDecision = (decision: ChromeDevtoolsRelayDecision): void => {
    if (decision.reason === 'not-eligible') return;
    recordChromeDevtoolsRelayDecision(definition.name, decision);
    logger.info(`Chrome DevTools relay decision ${formatChromeDevtoolsRelayDecision(decision)}`);
  };
  let relayDecision: ChromeDevtoolsRelayDecision | undefined;
  let relay: ChromeDevtoolsRelayRewrite;
  try {
    relay = await rewriteChromeDevtoolsArgsForRelay(
      command,
      resolvedArgs,
      mergedEnv as NodeJS.ProcessEnv,
      { onDecision: (decision) => (relayDecision = decision) },
      definition.chromeDevtoolsRelay
    );
  } catch (error) {
    if (relayDecision) publishRelayDecision(relayDecision);
    throw error;
  }
  let commandArgs = [...relay.args];
  let activeProxy = relay.proxy;
  let handoff: ChromeDevtoolsRelayHandoff | undefined;
  let rawTransport: McporterStdioTransport;
  try {
    if (activeProxy) {
      try {
        handoff = createChromeDevtoolsRelayHandoff(
          mergedEnv as Record<string, string>,
          activeProxy.consumeClientAuthorization()
        );
      } catch {
        await activeProxy.close().catch(() => {});
        activeProxy = undefined;
        relayDecision = {
          ...relay.decision,
          route: relay.decision.policy === 'require' ? 'unavailable' : 'legacy',
          reason: 'handoff-error',
        };
        if (relay.decision.policy === 'require') {
          publishRelayDecision(relayDecision);
          throw new ChromeDevtoolsRelayRequiredError(relayDecision);
        }
        commandArgs = [...resolvedArgs];
      }
    }
    const transportEnv = handoff?.env ?? (mergedEnv as Record<string, string>);
    const compat = applyChromeDevtoolsCompat(transportEnv, command, commandArgs);
    if (compat.applied) {
      logger.info(`Injecting chrome-devtools-mcp --autoConnect compatibility patch from ${compat.patchPath}.`);
    }
    if (relayDecision) publishRelayDecision(relayDecision);
    rawTransport = new McporterStdioTransport({
      command,
      args: commandArgs,
      cwd: definition.command.cwd,
      env: compat.env,
      cleanup: activeProxy
        ? async () => {
            await handoff?.close();
            await activeProxy?.close();
          }
        : undefined,
    });
  } catch (error) {
    await handoff?.close().catch(() => {});
    await activeProxy?.close().catch(() => {});
    throw error;
  }
  let transport: ClientContext['transport'];
  try {
    transport = wrapRecordTransport(rawTransport, definition, options);
  } catch (error) {
    await closeTransportAndWait(logger, rawTransport).catch(() => {});
    throw error;
  }
  try {
    await client.connect(transport, { signal: options.signal });
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
    return createReplayClientContext(definition, options.replayPath, clientInfo, options);
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
