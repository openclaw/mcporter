import { spawn } from 'node:child_process';
import path from 'node:path';

export interface DaemonLaunchOptions {
  readonly configPath: string;
  readonly configExplicit?: boolean;
  readonly rootDir?: string;
  readonly socketPath: string;
  readonly metadataPath: string;
  readonly extraArgs?: string[];
}

interface DaemonLaunchProcessInfo {
  readonly argvEntry?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly execArgv: string[];
  readonly execPath: string;
  readonly platform: NodeJS.Platform;
}

interface DaemonLaunchInvocation {
  readonly command: string;
  readonly args: string[];
  readonly env: NodeJS.ProcessEnv;
}

export function launchDaemonDetached(options: DaemonLaunchOptions): void {
  const invocation = buildDaemonLaunchInvocation(options);
  const child = spawn(invocation.command, invocation.args, {
    detached: true,
    stdio: 'ignore',
    env: invocation.env,
  });
  child.unref();
}

export function buildDaemonLaunchInvocation(
  options: DaemonLaunchOptions,
  processInfo: DaemonLaunchProcessInfo = {
    argvEntry: process.argv[1],
    env: process.env,
    execArgv: process.execArgv,
    execPath: process.execPath,
    platform: process.platform,
  }
): DaemonLaunchInvocation {
  const cliEntry = resolveCliEntry(processInfo.argvEntry);
  const configArgs = options.configExplicit ? ['--config', options.configPath] : [];
  const args = [
    ...processInfo.execArgv,
    ...(cliEntry ? [cliEntry] : []),
    ...configArgs,
    ...(options.rootDir ? ['--root', options.rootDir] : []),
    'daemon',
    'start',
    '--foreground',
    ...(options.extraArgs ?? []),
  ];
  const env = {
    ...processInfo.env,
    MCPORTER_DAEMON_CHILD: '1',
    MCPORTER_DAEMON_SOCKET: options.socketPath,
    MCPORTER_DAEMON_METADATA: options.metadataPath,
  };
  if (shouldWrapDetachedLaunchWithNohup(processInfo.platform, cliEntry)) {
    return {
      command: 'nohup',
      args: [processInfo.execPath, ...args],
      env,
    };
  }
  return {
    command: processInfo.execPath,
    args,
    env,
  };
}

function shouldWrapDetachedLaunchWithNohup(platform: NodeJS.Platform, cliEntry: string | undefined): boolean {
  return platform === 'darwin' && cliEntry === undefined;
}

function resolveCliEntry(entry = process.argv[1]): string | undefined {
  if (!entry) {
    throw new Error('Unable to resolve mcporter entry script.');
  }
  // In Bun compiled binaries, argv[1] is a virtual /$bunfs/... path that Bun
  // auto-injects into every spawned child.  Including it explicitly would
  // duplicate it and break CLI argument parsing in the child process.
  if (entry.startsWith('/$bunfs/')) {
    return undefined;
  }
  return path.resolve(entry);
}
