import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startService, waitForServiceExit } from './service-manager.js';
import { readLifecycle } from './lifecycle-state.js';

export interface DaemonLaunchOptions {
  readonly configPath: string;
  readonly configExplicit?: boolean;
  readonly rootDir?: string;
  readonly socketPath: string;
  readonly metadataPath: string;
  readonly extraArgs?: string[];
  readonly generation?: string;
  readonly foreground?: boolean;
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

export async function launchDaemonDetached(
  options: DaemonLaunchOptions,
  launch: typeof spawn = spawn
): Promise<ChildProcess & { waitForExit?: () => Promise<number> }> {
  const invocation = buildDaemonLaunchInvocation(options);
  try {
    if (process.platform !== 'win32' && options.generation) {
      const owner = (await readLifecycle()).active;
      if (owner?.generation !== options.generation) throw new Error('Daemon launch reservation expired.');
      if (!existsSync(process.execPath))
        throw Object.assign(new Error('ENOENT: daemon executable missing'), { code: 'ENOENT', path: process.execPath });
      const command = invocation.command === 'nohup' ? invocation.args[0]! : invocation.command;
      const args = invocation.command === 'nohup' ? invocation.args.slice(1) : invocation.args;
      await startService(owner, command, args, invocation.env);
      return {
        exitCode: null,
        signalCode: null,
        waitForExit: () => waitForServiceExit(owner, options.foreground),
      } as ChildProcess & { waitForExit: () => Promise<number> };
    }
    return await new Promise<ChildProcess>((resolve, reject) => {
      const child = launch(invocation.command, invocation.args, {
        detached: true,
        stdio: options.foreground ? 'inherit' : 'ignore',
        env: invocation.env,
      });
      // Keep handling late errors after spawn; readiness is checked by the caller.
      child.on('error', reject);
      child.once('spawn', () => resolve(child));
      if (!options.foreground) child.unref();
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to start MCPorter daemon (${invocation.command}): ${message}`, { cause: error });
  }
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
  const args = [
    ...resolveDaemonExecArgs(processInfo.execArgv),
    ...(cliEntry ? [cliEntry] : []),
    'daemon',
    'start',
    '--foreground',
    ...(options.extraArgs ?? []),
  ];
  const env: NodeJS.ProcessEnv = {
    ...processInfo.env,
    MCPORTER_DAEMON_CHILD: '1',
    ...(options.generation ? { MCPORTER_DAEMON_GENERATION: options.generation, MCPORTER_DAEMON_WORKER: '' } : {}),
    MCPORTER_DISABLE_AUTORUN: '0',
    MCPORTER_DAEMON_SOCKET: options.socketPath,
    MCPORTER_DAEMON_METADATA: options.metadataPath,
  };
  delete env.MCPORTER_VAULT_PASSWORD;
  delete env.MCPORTER_VAULT_ENCRYPTION;
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
  if (entry.startsWith('/$bunfs/') || /^[a-z]:[\\/][~$]BUN[\\/]/i.test(entry)) {
    return undefined;
  }
  const candidate = fileURLToPath(new URL('../cli.js', import.meta.url));
  if (existsSync(candidate)) return candidate;
  const sourceBuild = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
  if (existsSync(sourceBuild)) return sourceBuild;
  return path.resolve(entry);
}

export function resolveDaemonExecArgs(args: readonly string[]): string[] {
  const require = createRequire(path.join(process.cwd(), 'package.json'));
  const modulePath = (value: string) => {
    if (/^(?:file|data|node):/.test(value)) return value;
    if (path.isAbsolute(value) || value.startsWith('./') || value.startsWith('../')) return path.resolve(value);
    try {
      return require.resolve(value);
    } catch {
      return value;
    }
  };
  let nextModule = false;
  return args.map((arg) => {
    if (nextModule) {
      nextModule = false;
      return modulePath(arg);
    }
    if (['--require', '-r', '--import', '--loader', '--experimental-loader', '--preload'].includes(arg)) {
      nextModule = true;
      return arg;
    }
    const match = /^(--(?:require|import|loader|experimental-loader|preload))=(.+)$/.exec(arg);
    return match ? `${match[1]}=${modulePath(match[2]!)}` : arg;
  });
}
