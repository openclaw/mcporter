import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { DaemonClient, resolveDaemonPaths } from '../daemon/client.js';
import { runDaemonHost } from '../daemon/host.js';
import { launchDaemonDetached } from '../daemon/launch.js';
import { getDaemonLogPath } from '../daemon/paths.js';
import { expandHome } from '../env.js';
import { isKeepAliveServer } from '../lifecycle.js';
import { createRuntime } from '../runtime.js';

interface DaemonCliOptions {
  readonly configPath: string;
  // Whether the config path was explicitly provided (flag/env). If false, runtime should
  // treat config as implicit and allow missing files without throwing ENOENT.
  readonly configExplicit?: boolean;
  readonly rootDir?: string;
}

interface DaemonLoggingOptions {
  readonly enabled: boolean;
  readonly logPath?: string;
  readonly logAllServers: boolean;
  readonly serverFilter: Set<string>;
}

export async function handleDaemonCli(args: string[], options: DaemonCliOptions): Promise<void> {
  const subcommand = args.shift();
  if (!subcommand || subcommand === 'help' || subcommand === '--help') {
    printDaemonHelp();
    return;
  }

  const client = new DaemonClient({
    configPath: options.configPath,
    configExplicit: options.configExplicit,
    rootDir: options.rootDir,
  });

  if (subcommand === 'start') {
    await handleDaemonStart(args, options, client);
    return;
  }
  if (subcommand === 'status') {
    await handleDaemonStatus(client);
    return;
  }
  if (subcommand === 'stop') {
    await client.stop();
    console.log('Daemon stopped (if it was running).');
    return;
  }
  if (subcommand === 'restart') {
    await handleDaemonRestart(args, options, client);
    return;
  }

  throw new Error(`Unknown daemon subcommand '${subcommand}'.`);
}

function printDaemonHelp(): void {
  console.log(`Usage: mcporter daemon <start|status|stop|restart>

Commands:
  start    Start the keep-alive daemon (auto-detects keep-alive servers).
  status   Show whether the daemon is running and which servers are active.
  stop     Shut down the daemon and all managed servers.
  restart  Stop the daemon (if running) and start a fresh instance.

Flags:
  --foreground        Run the daemon in the current process (debug only).
  --log               Enable daemon logging (defaults to ~/.mcporter/daemon/daemon-<hash>.log,
                      or $XDG_STATE_HOME/mcporter/daemon/... when set).
  --log-file <path>   Write daemon stdout/stderr to a specific log file.
  --log-servers <csv> Only log call activity for the listed servers (implies --log).`);
}

async function handleDaemonStart(args: string[], options: DaemonCliOptions, client: DaemonClient): Promise<void> {
  const foregroundFlag = consumeFlag(args, '--foreground');
  const isChildLaunch = process.env.MCPORTER_DAEMON_CHILD === '1';
  const foreground = foregroundFlag || isChildLaunch;

  const paths = resolveDaemonPaths(options.configPath);
  const socketPath = process.env.MCPORTER_DAEMON_SOCKET ?? paths.socketPath;
  const metadataPath = process.env.MCPORTER_DAEMON_METADATA ?? paths.metadataPath;
  const logging = await resolveDaemonLoggingOptions(args, paths.key);

  const runtime = await createRuntime({
    configPath: options.configExplicit ? options.configPath : undefined,
    rootDir: options.rootDir,
  });
  const keepAlive = runtime.getDefinitions().filter(isKeepAliveServer);
  await runtime.close().catch(() => {});
  if (keepAlive.length === 0) {
    console.log('No MCP servers are configured for keep-alive; daemon not started.');
    return;
  }

  if (foreground) {
    await runDaemonHost({
      socketPath,
      metadataPath,
      configPath: options.configPath,
      configExplicit: options.configExplicit,
      rootDir: options.rootDir,
      logPath: logging.enabled ? logging.logPath : undefined,
      logServers: logging.serverFilter,
      logAllServers: logging.logAllServers,
    });
    return;
  }

  const existing = await client.status();
  if (existing) {
    console.log(`Daemon already running (pid ${existing.pid}).`);
    return;
  }

  const forwardedArgs: string[] = [];
  if (logging.enabled && logging.logPath) {
    forwardedArgs.push('--log-file', logging.logPath);
  }
  if (logging.serverFilter.size > 0) {
    forwardedArgs.push('--log-servers', Array.from(logging.serverFilter).join(','));
  }

  launchDaemonDetached({
    configPath: options.configPath,
    configExplicit: options.configExplicit,
    rootDir: options.rootDir,
    metadataPath,
    socketPath,
    extraArgs: forwardedArgs,
  });
  const ready = await waitFor(() => client.status(), 10_000, 100);
  if (!ready) {
    throw new Error('Failed to start daemon before timeout expired.');
  }
  console.log(`Daemon started for ${keepAlive.length} server(s).`);
}

async function handleDaemonRestart(args: string[], options: DaemonCliOptions, client: DaemonClient): Promise<void> {
  await client.stop();
  console.log('Daemon stopped (if it was running).');

  const stopped = await waitFor(
    async () => {
      const status = await client.status();
      return status ? null : true;
    },
    5_000,
    100
  );
  if (!stopped) {
    throw new Error('Daemon did not stop before restart could begin.');
  }

  await handleDaemonStart(args, options, client);
}

async function handleDaemonStatus(client: DaemonClient): Promise<void> {
  const status = await client.status();
  if (!status) {
    console.log('Daemon is not running.');
    return;
  }
  console.log(`Daemon pid ${status.pid} — socket: ${status.socketPath}`);
  if (status.logPath) {
    console.log(`Log file: ${status.logPath}`);
  }
  if (status.servers.length === 0) {
    console.log('No keep-alive servers registered.');
    return;
  }
  status.servers.forEach((server) => {
    const state = server.connected ? 'connected' : 'idle';
    const lastUsed = server.lastUsedAt ? ` (last used ${new Date(server.lastUsedAt).toISOString()})` : '';
    console.log(`- ${server.name}: ${state}${lastUsed}`);
  });
}

function consumeFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index === -1) {
    return false;
  }
  args.splice(index, 1);
  return true;
}

function consumeValueFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  if (index + 1 >= args.length) {
    throw new Error(`Flag '${flag}' requires a value.`);
  }
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number, intervalMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) {
      return result;
    }
    await delay(intervalMs);
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function resolveDaemonLoggingOptions(args: string[], configKey: string): Promise<DaemonLoggingOptions> {
  const logFlag = consumeFlag(args, '--log');
  const logFileValue = consumeValueFlag(args, '--log-file');
  const logServersValue = consumeValueFlag(args, '--log-servers');
  const envLogEnabled = process.env.MCPORTER_DAEMON_LOG === '1';
  const envLogPath = process.env.MCPORTER_DAEMON_LOG_PATH;
  const envLogServers = process.env.MCPORTER_DAEMON_LOG_SERVERS;
  const serverFilter = parseServerList(logServersValue ?? envLogServers);
  const explicitServerLogging = serverFilter.size > 0;
  const resolvedFileFlag = logFileValue ? path.resolve(expandHome(logFileValue)) : undefined;
  const resolvedEnvFile = envLogPath ? path.resolve(expandHome(envLogPath)) : undefined;
  const enabled =
    logFlag || Boolean(resolvedFileFlag) || envLogEnabled || Boolean(resolvedEnvFile) || explicitServerLogging;
  if (!enabled) {
    return {
      enabled: false,
      logPath: undefined,
      logAllServers: false,
      serverFilter,
    };
  }
  const logPath = resolvedFileFlag ?? resolvedEnvFile ?? getDaemonLogPath(configKey);
  await fsPromises.mkdir(path.dirname(logPath), { recursive: true });
  return {
    enabled: true,
    logPath,
    logAllServers: serverFilter.size === 0,
    serverFilter,
  };
}

function parseServerList(value: string | undefined): Set<string> {
  if (!value) {
    return new Set();
  }
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return new Set(entries);
}
