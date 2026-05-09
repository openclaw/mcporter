#!/usr/bin/env node
import { buildGlobalContext } from './cli/cli-factory.js';
import { inferCommandRouting } from './cli/command-inference.js';
import { CliUsageError } from './cli/errors.js';
import { consumeHelpTokens, isHelpToken, isVersionToken, printHelp, printVersion } from './cli/help-output.js';
import { logError, logInfo } from './cli/logger-context.js';
import { DEBUG_HANG, dumpActiveHandles, terminateChildProcesses } from './cli/runtime-debug.js';
import { resolveConfigPath } from './config.js';
import type { Runtime, RuntimeOptions } from './runtime.js';

export { parseCallArguments } from './cli/call-arguments.js';
export { extractListFlags } from './cli/list-flags.js';
export { resolveCallTimeout } from './cli/timeouts.js';

const FORCE_EXIT_GRACE_MS = 50;
const DAEMON_FAST_PATH_SERVERS = new Set(['chrome-devtools', 'mobile-mcp', 'playwright']);

export async function handleAuth(
  ...args: Parameters<typeof import('./cli/auth-command.js').handleAuth>
): ReturnType<typeof import('./cli/auth-command.js').handleAuth> {
  const { handleAuth: imported } = await import('./cli/auth-command.js');
  return imported(...args);
}

export async function printAuthHelp(): Promise<void> {
  const { printAuthHelp: imported } = await import('./cli/auth-command.js');
  imported();
}

export async function handleCall(
  ...args: Parameters<typeof import('./cli/call-command.js').handleCall>
): ReturnType<typeof import('./cli/call-command.js').handleCall> {
  const { handleCall: imported } = await import('./cli/call-command.js');
  return imported(...args);
}

export async function handleGenerateCli(
  ...args: Parameters<typeof import('./cli/generate-cli-runner.js').handleGenerateCli>
): ReturnType<typeof import('./cli/generate-cli-runner.js').handleGenerateCli> {
  const { handleGenerateCli: imported } = await import('./cli/generate-cli-runner.js');
  return imported(...args);
}

export async function handleInspectCli(
  ...args: Parameters<typeof import('./cli/inspect-cli-command.js').handleInspectCli>
): ReturnType<typeof import('./cli/inspect-cli-command.js').handleInspectCli> {
  const { handleInspectCli: imported } = await import('./cli/inspect-cli-command.js');
  return imported(...args);
}

export async function handleList(
  ...args: Parameters<typeof import('./cli/list-command.js').handleList>
): ReturnType<typeof import('./cli/list-command.js').handleList> {
  const { handleList: imported } = await import('./cli/list-command.js');
  return imported(...args);
}

export async function handleResource(
  ...args: Parameters<typeof import('./cli/resource-command.js').handleResource>
): ReturnType<typeof import('./cli/resource-command.js').handleResource> {
  const { handleResource: imported } = await import('./cli/resource-command.js');
  return imported(...args);
}

export async function runCli(argv: string[]): Promise<void> {
  const args = [...argv];
  if (args.length === 0) {
    printHelp();
    process.exit(1);
    return;
  }

  const context = buildGlobalContext(args);
  if ('exit' in context) {
    process.exit(context.code);
    return;
  }
  const { globalFlags, runtimeOptions } = context;
  const command = args.shift();

  if (!command) {
    printHelp();
    process.exit(1);
    return;
  }

  if (isHelpToken(command)) {
    printHelp();
    process.exitCode = 0;
    return;
  }

  if (isVersionToken(command)) {
    await printVersion();
    return;
  }

  // Early-exit command handlers that don't require runtime inference.
  if (command === 'generate-cli') {
    const { handleGenerateCli: importedHandleGenerateCli } = await import('./cli/generate-cli-runner.js');
    await importedHandleGenerateCli(args, globalFlags);
    return;
  }
  if (command === 'inspect-cli') {
    const { handleInspectCli: importedHandleInspectCli } = await import('./cli/inspect-cli-command.js');
    await importedHandleInspectCli(args);
    return;
  }
  const rootOverride = globalFlags['--root'];
  const configPath = runtimeOptions.configPath ?? globalFlags['--config'];
  const configResolution = resolveConfigPath(globalFlags['--config'], rootOverride ?? process.cwd());
  const configPathResolved = configPath ?? configResolution.path;
  // Only pass configPath to runtime options if it was explicitly provided (via --config flag or env var).
  // If not explicit, let loadConfigLayers handle the default resolution to avoid ENOENT on missing config.
  const runtimeOptionsWithPath = {
    ...runtimeOptions,
    configPath: configResolution.explicit ? configPathResolved : runtimeOptions.configPath,
  };

  if (command === 'daemon') {
    const { handleDaemonCli } = await import('./cli/daemon-command.js');
    await handleDaemonCli(args, {
      configPath: configPathResolved,
      configExplicit: configResolution.explicit,
      rootDir: rootOverride,
    });
    return;
  }

  if (command === 'config') {
    const { handleConfigCli } = await import('./cli/config-command.js');
    await handleConfigCli(
      {
        loadOptions: { configPath, rootDir: rootOverride },
        invokeAuth: (authArgs) => invokeAuthCommand(runtimeOptionsWithPath, authArgs),
      },
      args
    );
    return;
  }

  if (command === 'emit-ts') {
    const [{ createRuntime }, { handleEmitTs }] = await Promise.all([
      import('./runtime.js'),
      import('./cli/emit-ts-command.js'),
    ]);
    const runtime = await createRuntime(runtimeOptionsWithPath);
    try {
      await handleEmitTs(runtime, args);
    } finally {
      await runtime.close().catch(() => {});
    }
    return;
  }

  if (await maybeHandleDaemonFastCall(command, args, configResolution, rootOverride)) {
    return;
  }

  const [{ createRuntime }, { DaemonClient }, { createKeepAliveRuntime }, { isKeepAliveServer }] = await Promise.all([
    import('./runtime.js'),
    import('./daemon/client.js'),
    import('./daemon/runtime-wrapper.js'),
    import('./lifecycle.js'),
  ]);
  const baseRuntime = await createRuntime(runtimeOptionsWithPath);
  const keepAliveServers = new Set(
    baseRuntime
      .getDefinitions()
      .filter(isKeepAliveServer)
      .map((entry) => entry.name)
  );
  const daemonClient =
    keepAliveServers.size > 0
      ? new DaemonClient({
          configPath: configResolution.path,
          configExplicit: configResolution.explicit,
          rootDir: rootOverride,
        })
      : null;
  const runtime = createKeepAliveRuntime(baseRuntime, { daemonClient, keepAliveServers });

  const inference = inferCommandRouting(command, args, runtime.getDefinitions());
  if (inference.kind === 'abort') {
    process.exitCode = inference.exitCode;
    return;
  }
  const resolvedCommand = inference.command;
  const resolvedArgs = inference.args;

  try {
    if (resolvedCommand === 'list') {
      if (consumeHelpTokens(resolvedArgs)) {
        const { printListHelp } = await import('./cli/list-command.js');
        printListHelp();
        process.exitCode = 0;
        return;
      }
      const { handleList: importedHandleList } = await import('./cli/list-command.js');
      await importedHandleList(runtime, resolvedArgs);
      return;
    }

    if (resolvedCommand === 'call') {
      if (consumeHelpTokens(resolvedArgs)) {
        const { printCallHelp } = await import('./cli/call-command.js');
        printCallHelp();
        process.exitCode = 0;
        return;
      }
      const { handleCall: runHandleCall } = await import('./cli/call-command.js');
      await runHandleCall(runtime, resolvedArgs);
      return;
    }

    if (resolvedCommand === 'auth') {
      if (consumeHelpTokens(resolvedArgs)) {
        const { printAuthHelp: importedPrintAuthHelp } = await import('./cli/auth-command.js');
        importedPrintAuthHelp();
        process.exitCode = 0;
        return;
      }
      const { handleAuth: importedHandleAuth } = await import('./cli/auth-command.js');
      await importedHandleAuth(runtime, resolvedArgs);
      return;
    }

    if (resolvedCommand === 'resource' || resolvedCommand === 'resources') {
      if (consumeHelpTokens(resolvedArgs)) {
        const { printResourceHelp } = await import('./cli/resource-command.js');
        printResourceHelp();
        process.exitCode = 0;
        return;
      }
      const { handleResource: importedHandleResource } = await import('./cli/resource-command.js');
      await importedHandleResource(runtime, resolvedArgs);
      return;
    }
  } finally {
    const closeStart = Date.now();
    if (DEBUG_HANG) {
      logInfo('[debug] beginning runtime.close()');
      dumpActiveHandles('before runtime.close');
    }
    try {
      await runtime.close();
      if (DEBUG_HANG) {
        const duration = Date.now() - closeStart;
        logInfo(`[debug] runtime.close() completed in ${duration}ms`);
        dumpActiveHandles('after runtime.close');
      }
    } catch (error) {
      if (DEBUG_HANG) {
        logError('[debug] runtime.close() failed', error);
      }
    } finally {
      terminateChildProcesses('runtime.finally');
      // By default we force an exit after cleanup so Node doesn't hang on lingering stdio handles
      // (see typescript-sdk#579/#780/#1049). Opt out by exporting MCPORTER_NO_FORCE_EXIT=1.
      const disableForceExit = process.env.MCPORTER_NO_FORCE_EXIT === '1';
      const shouldForceExit = !disableForceExit || process.env.MCPORTER_FORCE_EXIT === '1';
      const scheduleForcedExit = () => {
        if (shouldForceExit) {
          setTimeout(() => {
            process.exit(process.exitCode ?? 0);
          }, FORCE_EXIT_GRACE_MS);
        }
      };
      if (DEBUG_HANG) {
        dumpActiveHandles('after terminateChildProcesses');
        scheduleForcedExit();
      } else {
        setImmediate(scheduleForcedExit);
      }
    }
  }
  printHelp(`Unknown command '${resolvedCommand}'.`);
  process.exit(1);
}

// main parses CLI flags and dispatches to list/call commands.
async function main(): Promise<void> {
  await runCli(process.argv.slice(2));
}

if (process.env.MCPORTER_DISABLE_AUTORUN !== '1') {
  main().catch((error) => {
    if (error instanceof CliUsageError) {
      logError(error.message);
      process.exit(1);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    logError(message, error instanceof Error ? error : undefined);
    process.exit(1);
  });
}

async function invokeAuthCommand(runtimeOptions: RuntimeOptions, args: string[]): Promise<void> {
  const [{ createRuntime }, { handleAuth: importedHandleAuth }] = await Promise.all([
    import('./runtime.js'),
    import('./cli/auth-command.js'),
  ]);
  const runtime = await createRuntime(runtimeOptions);
  try {
    await importedHandleAuth(runtime, args);
  } finally {
    await runtime.close().catch(() => {});
  }
}

async function maybeHandleDaemonFastCall(
  command: string,
  args: string[],
  configResolution: { path: string; explicit: boolean },
  rootDir: string | undefined
): Promise<boolean> {
  const callArgs = resolveDaemonFastCallArgs(command, args);
  if (!callArgs) {
    return false;
  }
  const server = resolveExplicitCallServer(callArgs);
  if (!server || !DAEMON_FAST_PATH_SERVERS.has(server) || isFastPathKeepAliveDisabled(server)) {
    return false;
  }
  const [{ DaemonClient }, { handleCall: importedHandleCall }] = await Promise.all([
    import('./daemon/client.js'),
    import('./cli/call-command.js'),
  ]);
  const daemonClient = new DaemonClient({
    configPath: configResolution.path,
    configExplicit: configResolution.explicit,
    rootDir,
  });
  await importedHandleCall(createDaemonOnlyRuntime(daemonClient), callArgs);
  return true;
}

function resolveDaemonFastCallArgs(command: string, args: string[]): string[] | undefined {
  if (command === 'call') {
    return args;
  }
  if (isExplicitNonCallCommand(command) || command.includes('://')) {
    return undefined;
  }
  if (!/[.(]/.test(command)) {
    return undefined;
  }
  return [command, ...args];
}

function isExplicitNonCallCommand(command: string): boolean {
  return (
    command === 'list' ||
    command === 'auth' ||
    command === 'resource' ||
    command === 'resources' ||
    command === 'daemon' ||
    command === 'config' ||
    command === 'emit-ts' ||
    command === 'generate-cli' ||
    command === 'inspect-cli' ||
    command === 'describe'
  );
}

function resolveExplicitCallServer(args: readonly string[]): string | undefined {
  let serverFlag: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) {
      continue;
    }
    if (isHelpToken(token)) {
      return undefined;
    }
    if (token === '--http-url' || token === '--stdio') {
      return undefined;
    }
    if (token === '--server') {
      serverFlag = args[index + 1];
      index += 1;
      continue;
    }
    if (token.startsWith('--server=')) {
      serverFlag = token.slice('--server='.length);
      continue;
    }
    if (token.startsWith('-')) {
      continue;
    }
    if (token.includes('://')) {
      return undefined;
    }
    const separator = token.indexOf('.');
    if (separator > 0) {
      return token.slice(0, separator);
    }
    return serverFlag;
  }
  return serverFlag;
}

function isFastPathKeepAliveDisabled(server: string): boolean {
  const raw = process.env.MCPORTER_DISABLE_KEEPALIVE ?? process.env.MCPORTER_NO_KEEPALIVE;
  if (!raw) {
    return false;
  }
  const disabled = new Set(
    raw
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
  return disabled.has('*') || disabled.has(server.toLowerCase());
}

function createDaemonOnlyRuntime(daemonClient: import('./daemon/client.js').DaemonClient): Runtime {
  return {
    listServers: () => [],
    getDefinitions: () => [],
    getDefinition: (server: string) => {
      throw new Error(`Server '${server}' is only available through the keep-alive daemon fast path.`);
    },
    registerDefinition: () => {
      throw new Error('Ad-hoc servers are not supported by the keep-alive daemon fast path.');
    },
    getInstructions: async () => undefined,
    listTools: async (server, options) =>
      (await daemonClient.listTools({
        server,
        includeSchema: options?.includeSchema,
        autoAuthorize: options?.autoAuthorize,
      })) as Awaited<ReturnType<Runtime['listTools']>>,
    callTool: (server, toolName, options) =>
      daemonClient.callTool({
        server,
        tool: toolName,
        args: options?.args,
        timeoutMs: options?.timeoutMs,
      }),
    listResources: (server, options) => daemonClient.listResources({ server, params: options ?? {} }),
    readResource: (server, uri) => daemonClient.readResource({ server, uri }),
    connect: async (server) => {
      throw new Error(`Server '${server}' is only available through daemon request methods.`);
    },
    close: async (server?: string) => {
      if (server) {
        await daemonClient.closeServer({ server }).catch(() => {});
      }
    },
  };
}
