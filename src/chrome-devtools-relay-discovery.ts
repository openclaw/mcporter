import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import { statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { parseTree, type Node as JsonNode, type ParseError } from 'jsonc-parser';
import {
  BROWSER_RELAY_AUTH_CHALLENGE_PATH,
  BROWSER_RELAY_AUTH_COMPLETE_PATH,
  BROWSER_RELAY_AUTH_LABEL,
  BROWSER_RELAY_AUTH_VERSION,
  BROWSER_RELAY_CDP_FLOW,
  BROWSER_RELAY_CDP_METHOD,
  BROWSER_RELAY_CDP_PATH,
  BROWSER_RELAY_CDP_RESOURCE,
  BROWSER_RELAY_CDP_ROLE,
  BROWSER_RELAY_CDP_TRANSPORT,
} from './browser-relay-auth-v2.js';

const OPENCLAW_CDP_ARGS = ['browser', 'extension', 'cdp', '--json'] as const;
const OPENCLAW_WINDOWS_COMMAND_SUFFIX = 'browser extension cdp --json';
const OPENCLAW_WINDOWS_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const OPENCLAW_WINDOWS_TREE_KILL_TIMEOUT_MS = 1_000;
// Mirrors OpenClaw's root CLI profile contract; keep ASCII case-folding and the 64-byte limit exact.
const OPENCLAW_PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
export const OPENCLAW_RELAY_DISCOVERY_MAX_OUTPUT_BYTES = 64 * 1024;
export const OPENCLAW_RELAY_DISCOVERY_ENV_KEYS = [
  'APPDATA',
  'COMSPEC',
  'ComSpec',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'OPENCLAW_CONFIG_PATH',
  'OPENCLAW_GATEWAY_PORT',
  'OPENCLAW_HOME',
  'OPENCLAW_OAUTH_DIR',
  'OPENCLAW_PROFILE',
  'OPENCLAW_STATE_DIR',
  'PATH',
  'Path',
  'PATHEXT',
  'SYSTEMROOT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WINDIR',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
] as const;

export type OpenClawRelayDiscoveryCommandFailure = 'unavailable' | 'timeout' | 'overflow' | 'nonzero';

export type OpenClawRelayDiscoveryCommandResult =
  | { readonly kind: 'success'; readonly stdout: Buffer }
  | { readonly kind: OpenClawRelayDiscoveryCommandFailure };

export interface OpenClawRelayDiscoveryCommandOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly platform: NodeJS.Platform;
  readonly taskkillExecutable?: string;
  readonly shell: false;
}

export interface OpenClawRelayDiscoveryCommandPlan {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly platform: NodeJS.Platform;
  readonly taskkillExecutable?: string;
}

export type OpenClawRelayDiscoveryFileProbe = (candidate: string) => boolean;

export type OpenClawRelayDiscoveryTerminationPlan =
  | {
      readonly kind: 'posix-sigkill';
      readonly pid: number;
      readonly signal: 'SIGKILL';
    }
  | {
      readonly kind: 'windows-taskkill';
      readonly pid: number;
      readonly executable: string;
      readonly args: readonly ['/PID', string, '/T', '/F'];
      readonly shell: false;
      readonly windowsHide: true;
    };

export type OpenClawRelayDiscoveryTreeTerminator = (
  plan: OpenClawRelayDiscoveryTerminationPlan,
  child: ChildProcessByStdio<null, Readable, Readable>
) => Promise<void>;

export interface OpenClawRelayDiscoveryRuntime {
  readonly spawn?: typeof spawn;
  readonly terminateProcessTree?: OpenClawRelayDiscoveryTreeTerminator;
}

export function normalizeOpenClawProfile(raw: string | undefined): string | undefined {
  const profile = raw?.trim();
  if (!profile || profile.toLowerCase() === 'default' || !OPENCLAW_PROFILE_PATTERN.test(profile)) {
    return undefined;
  }
  return profile;
}

export type OpenClawRelayDiscoveryRunner = (
  options: OpenClawRelayDiscoveryCommandOptions
) => Promise<OpenClawRelayDiscoveryCommandResult>;

export type OpenClawRelayDiscoveryReason =
  | OpenClawRelayDiscoveryCommandFailure
  | 'malformed'
  | 'unsafe'
  | 'incompatible'
  | 'key-id-mismatch'
  | 'success';

export interface OpenClawRelayDiscoveryResult {
  readonly url?: URL;
  readonly reason: OpenClawRelayDiscoveryReason;
}

export async function discoverOpenClawRelayUrl(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly keyId: string;
  readonly timeoutMs: number;
  readonly run?: OpenClawRelayDiscoveryRunner;
  readonly platform?: NodeJS.Platform;
  readonly isFile?: OpenClawRelayDiscoveryFileProbe;
  readonly cwd?: string;
}): Promise<OpenClawRelayDiscoveryResult> {
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? process.cwd();
  const filteredEnv = openClawDiscoveryEnvironment(options.env);
  const command = resolveOpenClawRelayDiscoveryCommandPlan(filteredEnv, platform, options.isFile, cwd);
  if (!command) return { reason: 'unavailable' };
  const env = sanitizeOpenClawDiscoveryCommandEnvironment(filteredEnv, command, platform, cwd);
  const result = await (options.run ?? runOpenClawRelayDiscovery)({
    ...command,
    env,
    timeoutMs: options.timeoutMs,
    maxOutputBytes: OPENCLAW_RELAY_DISCOVERY_MAX_OUTPUT_BYTES,
    shell: false,
  });
  return validateDiscoveryCommandResult(result, options.keyId);
}

export function runOpenClawRelayDiscovery(
  options: OpenClawRelayDiscoveryCommandOptions,
  runtime: OpenClawRelayDiscoveryRuntime = {}
): Promise<OpenClawRelayDiscoveryCommandResult> {
  return new Promise((resolve) => {
    const child = (runtime.spawn ?? spawn)(options.executable, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments: options.platform === 'win32',
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let terminating = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: OpenClawRelayDiscoveryCommandResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const terminate = (kind: 'timeout' | 'overflow'): void => {
      if (settled || terminating) return;
      terminating = true;
      child.stdout.destroy();
      child.stderr.destroy();
      const plan = createOpenClawRelayDiscoveryTerminationPlan(options, child.pid);
      const terminateProcessTree = runtime.terminateProcessTree ?? terminateOpenClawRelayDiscoveryProcessTree;
      let termination = Promise.resolve();
      if (plan) {
        try {
          termination = terminateProcessTree(plan, child);
        } catch {
          // Classification remains timeout/overflow when an injected terminator throws.
        }
      }
      void boundedTreeTermination(termination).finally(() => {
        child.unref();
        finish({ kind });
      });
    };
    const collect = (chunk: Buffer, keep: boolean): void => {
      if (settled || terminating) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > options.maxOutputBytes) {
        terminate('overflow');
        return;
      }
      if (keep) stdout.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, true));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, false));
    child.once('error', (error) => {
      if (!terminating) finish({ kind: classifyCommandError(error) });
    });
    child.once('close', (code) => {
      if (!terminating) {
        finish(code === 0 ? { kind: 'success', stdout: Buffer.concat(stdout) } : { kind: 'nonzero' });
      }
    });
    timer = setTimeout(() => terminate('timeout'), options.timeoutMs);
    timer.unref();
  });
}

export function resolveOpenClawRelayDiscoveryCommandPlan(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  isFile: OpenClawRelayDiscoveryFileProbe = isRegularFile,
  cwd: string = process.cwd()
): OpenClawRelayDiscoveryCommandPlan | undefined {
  if (platform !== 'win32') return { executable: 'openclaw', args: OPENCLAW_CDP_ARGS, platform };
  const executable = resolveWindowsCommandInterpreter(env);
  const openClawShim = resolveWindowsOpenClawShim(env, isFile, cwd);
  if (!executable || !openClawShim) return undefined;
  const taskkillExecutable = path.win32.join(path.win32.dirname(executable), 'taskkill.exe');
  if (!isSafeWindowsSystemToolPath(taskkillExecutable, 'taskkill.exe')) return undefined;
  return {
    executable,
    // The only variable bytes are the validated absolute shim path. No config,
    // profile, URL, metadata, or unresolved command name reaches cmd.exe.
    args: ['/d', '/s', '/c', `""${openClawShim}" ${OPENCLAW_WINDOWS_COMMAND_SUFFIX}"`],
    cwd: path.win32.dirname(openClawShim),
    platform,
    taskkillExecutable,
  };
}

function resolveWindowsCommandInterpreter(env: NodeJS.ProcessEnv): string | undefined {
  const systemRoot = env.SYSTEMROOT?.trim() || env.SystemRoot?.trim();
  const systemCmd =
    systemRoot && isSafeWindowsSystemRoot(systemRoot) ? path.win32.join(systemRoot, 'System32', 'cmd.exe') : undefined;
  const comSpec = env.COMSPEC?.trim() || env.ComSpec?.trim();
  if (comSpec && isSafeWindowsCmdPath(comSpec)) {
    const normalizedComSpec = path.win32.normalize(comSpec);
    if (
      (systemCmd && normalizedComSpec.toLowerCase() === systemCmd.toLowerCase()) ||
      (!systemCmd && isConventionalWindowsSystemCmd(normalizedComSpec))
    ) {
      return normalizedComSpec;
    }
  }
  return systemCmd;
}

function resolveWindowsOpenClawShim(
  env: NodeJS.ProcessEnv,
  isFile: OpenClawRelayDiscoveryFileProbe,
  cwd: string
): string | undefined {
  const pathEntries = safeWindowsPathEntries(env.PATH ?? env.Path, cwd);
  const extensions = windowsPathExtensions(env.PATHEXT);
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      if (extension.toLowerCase() !== '.cmd') continue;
      const candidate = path.win32.join(directory, `openclaw${extension}`);
      if (isSafeWindowsCommandPath(candidate) && isFile(candidate)) return path.win32.normalize(candidate);
    }
  }
  return undefined;
}

function isSafeWindowsCmdPath(value: string): boolean {
  return isSafeWindowsSystemToolPath(value, 'cmd.exe');
}

function isSafeWindowsSystemToolPath(value: string, basename: string): boolean {
  const parent = path.win32.dirname(value);
  const root = path.win32.dirname(parent);
  return (
    isSafeWindowsCommandPath(value) &&
    path.win32.basename(value).toLowerCase() === basename &&
    path.win32.basename(parent).toLowerCase() === 'system32' &&
    ['windows', 'winnt'].includes(path.win32.basename(root).toLowerCase())
  );
}

function isSafeWindowsSystemRoot(value: string): boolean {
  const basename = path.win32.basename(value).toLowerCase();
  return isSafeWindowsAbsolutePath(value) && basename !== 'cmd.exe' && basename !== 'system32';
}

function isConventionalWindowsSystemCmd(value: string): boolean {
  const parent = path.win32.dirname(value);
  const root = path.win32.dirname(parent);
  return (
    path.win32.basename(parent).toLowerCase() === 'system32' &&
    ['windows', 'winnt'].includes(path.win32.basename(root).toLowerCase())
  );
}

function isSafeWindowsAbsolutePath(value: string): boolean {
  if (
    !/^[a-z]:[\\/]/i.test(value) ||
    /["<>|?*]/u.test(value) ||
    hasControlCharacter(value) ||
    value.slice(2).includes(':')
  ) {
    return false;
  }
  const segments = value.replaceAll('/', '\\').split('\\');
  return !segments.some((segment) => segment === '.' || segment === '..');
}

function isSafeWindowsCommandPath(value: string): boolean {
  return isSafeWindowsAbsolutePath(value) && !/["%&|<>^!]/u.test(value) && !hasControlCharacter(value);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 0x20) return true;
  }
  return false;
}

function safeWindowsPathEntries(value: string | undefined, excludedDirectory?: string): string[] {
  if (!value) return [];
  const excluded =
    excludedDirectory && isSafeWindowsCommandPath(excludedDirectory)
      ? path.win32.resolve(excludedDirectory).toLowerCase()
      : undefined;
  return value
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '' && path.win32.isAbsolute(entry) && isSafeWindowsCommandPath(entry))
    .map((entry) => path.win32.resolve(entry))
    .filter((entry) => entry.toLowerCase() !== excluded);
}

function windowsPathExtensions(value: string | undefined): string[] {
  const raw = value?.trim() || OPENCLAW_WINDOWS_DEFAULT_PATHEXT;
  return raw
    .split(';')
    .map((extension) => extension.trim())
    .filter((extension) => /^\.[a-z0-9]+$/iu.test(extension));
}

function isRegularFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function sanitizeOpenClawDiscoveryCommandEnvironment(
  env: NodeJS.ProcessEnv,
  command: OpenClawRelayDiscoveryCommandPlan,
  platform: NodeJS.Platform,
  sourceCwd: string
): NodeJS.ProcessEnv {
  if (platform !== 'win32') return env;
  const sanitized = { ...env };
  delete sanitized.ComSpec;
  delete sanitized.COMSPEC;
  sanitized.ComSpec = command.executable;
  const safePath = safeWindowsPathEntries(sanitized.PATH ?? sanitized.Path, sourceCwd).join(';');
  delete sanitized.Path;
  delete sanitized.PATH;
  if (safePath) sanitized.Path = safePath;
  const systemRoot = sanitized.SYSTEMROOT?.trim() || sanitized.SystemRoot?.trim();
  if (systemRoot && !isSafeWindowsSystemRoot(systemRoot)) {
    delete sanitized.SystemRoot;
    delete sanitized.SYSTEMROOT;
  }
  return sanitized;
}

function createOpenClawRelayDiscoveryTerminationPlan(
  options: OpenClawRelayDiscoveryCommandOptions,
  pid: number | undefined
): OpenClawRelayDiscoveryTerminationPlan | undefined {
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0) return undefined;
  if (options.platform !== 'win32') return { kind: 'posix-sigkill', pid, signal: 'SIGKILL' };
  if (!options.taskkillExecutable || !isSafeWindowsSystemToolPath(options.taskkillExecutable, 'taskkill.exe')) {
    return undefined;
  }
  return {
    kind: 'windows-taskkill',
    pid,
    executable: options.taskkillExecutable,
    args: ['/PID', String(pid), '/T', '/F'],
    shell: false,
    windowsHide: true,
  };
}

async function terminateOpenClawRelayDiscoveryProcessTree(
  plan: OpenClawRelayDiscoveryTerminationPlan,
  child: ChildProcessByStdio<null, Readable, Readable>
): Promise<void> {
  if (plan.kind === 'posix-sigkill') {
    try {
      child.kill(plan.signal);
    } catch {
      // The child may have exited between the timeout and termination request.
    }
    return;
  }
  await new Promise<void>((resolve) => {
    let killer: ChildProcess;
    try {
      killer = spawn(plan.executable, [...plan.args], {
        shell: plan.shell,
        stdio: 'ignore',
        windowsHide: plan.windowsHide,
      });
    } catch {
      resolve();
      return;
    }
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    killer.once('error', finish);
    killer.once('close', finish);
    const timer = setTimeout(() => {
      try {
        killer.kill('SIGKILL');
      } catch {
        // A failed taskkill helper must not extend the discovery timeout.
      }
      finish();
    }, OPENCLAW_WINDOWS_TREE_KILL_TIMEOUT_MS);
    timer.unref();
  });
}

async function boundedTreeTermination(termination: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      termination.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, OPENCLAW_WINDOWS_TREE_KILL_TIMEOUT_MS + 250);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function classifyCommandError(error: unknown): OpenClawRelayDiscoveryCommandFailure {
  const details = error as { readonly code?: string | number; readonly killed?: boolean };
  if (details.code === 'ENOENT') return 'unavailable';
  if (details.code === 'ETIMEDOUT' || details.killed === true) return 'timeout';
  if (details.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || details.code === 'ENOBUFS') return 'overflow';
  return 'nonzero';
}

function validateDiscoveryCommandResult(
  result: OpenClawRelayDiscoveryCommandResult,
  expectedKeyId: string
): OpenClawRelayDiscoveryResult {
  if (result.kind !== 'success') return { reason: result.kind };
  if (result.stdout.byteLength > OPENCLAW_RELAY_DISCOVERY_MAX_OUTPUT_BYTES) return { reason: 'overflow' };
  const encoded = result.stdout.toString('utf8').trim();
  const parseErrors: ParseError[] = [];
  const tree = parseTree(encoded, parseErrors, { allowTrailingComma: false, disallowComments: true });
  if (!tree || parseErrors.length > 0 || hasDuplicateObjectKeys(tree)) return { reason: 'malformed' };
  let metadata: unknown;
  try {
    metadata = JSON.parse(encoded) as unknown;
  } catch {
    return { reason: 'malformed' };
  }
  if (!isPlainObject(metadata) || !hasExactKeys(metadata, ['auth', 'browserUrl', 'wsEndpoint'])) {
    return { reason: 'incompatible' };
  }
  if (
    !isPlainObject(metadata.auth) ||
    !hasExactKeys(metadata.auth, [
      'challengeUrl',
      'completeUrl',
      'flow',
      'keyId',
      'label',
      'method',
      'resource',
      'role',
      'transport',
      'version',
    ])
  ) {
    return { reason: 'incompatible' };
  }
  const browserUrl = parseBrowserUrl(metadata.browserUrl);
  if (!browserUrl) return { reason: 'unsafe' };
  const wsEndpoint = parseWebSocketUrl(metadata.wsEndpoint);
  if (!wsEndpoint || wsEndpoint.host !== browserUrl.host) return { reason: 'unsafe' };
  const auth = metadata.auth;
  if (
    auth.label !== BROWSER_RELAY_AUTH_LABEL ||
    auth.version !== BROWSER_RELAY_AUTH_VERSION ||
    auth.role !== BROWSER_RELAY_CDP_ROLE ||
    auth.transport !== BROWSER_RELAY_CDP_TRANSPORT ||
    auth.method !== BROWSER_RELAY_CDP_METHOD ||
    auth.resource !== BROWSER_RELAY_CDP_RESOURCE ||
    auth.flow !== BROWSER_RELAY_CDP_FLOW ||
    auth.challengeUrl !== new URL(BROWSER_RELAY_AUTH_CHALLENGE_PATH, browserUrl).toString() ||
    auth.completeUrl !== new URL(BROWSER_RELAY_AUTH_COMPLETE_PATH, browserUrl).toString()
  ) {
    return { reason: 'incompatible' };
  }
  if (auth.keyId !== expectedKeyId) return { reason: 'key-id-mismatch' };
  return { reason: 'success', url: browserUrl };
}

function parseBrowserUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string') return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'http:' ||
    !isLoopbackHostname(url.hostname) ||
    url.username !== '' ||
    url.password !== '' ||
    !hasValidPort(url) ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return undefined;
  }
  return new URL(url.origin);
}

function parseWebSocketUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string') return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'ws:' ||
    !isLoopbackHostname(url.hostname) ||
    url.username !== '' ||
    url.password !== '' ||
    !hasValidPort(url) ||
    url.pathname !== BROWSER_RELAY_CDP_PATH ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return undefined;
  }
  return url;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[(.*)\]$/u, '$1').toLowerCase();
  if (normalized === 'localhost' || normalized === '::1') return true;
  if (net.isIPv4(normalized)) return normalized.startsWith('127.');
  if (!net.isIPv6(normalized)) return false;
  return normalized.startsWith('::ffff:127.') || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/u.test(normalized);
}

function hasValidPort(url: URL): boolean {
  if (url.port === '') return true;
  const port = Number(url.port);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasDuplicateObjectKeys(node: JsonNode): boolean {
  if (node.type === 'object') {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value;
      if (typeof key !== 'string' || seen.has(key)) return true;
      seen.add(key);
    }
  }
  return (node.children ?? []).some(hasDuplicateObjectKeys);
}

function openClawDiscoveryEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const filtered = Object.fromEntries(
    OPENCLAW_RELAY_DISCOVERY_ENV_KEYS.flatMap((key) => {
      const value = env[key];
      return value === undefined ? [] : [[key, value]];
    })
  );
  const profile = normalizeOpenClawProfile(filtered.OPENCLAW_PROFILE);
  if (profile) filtered.OPENCLAW_PROFILE = profile;
  else delete filtered.OPENCLAW_PROFILE;
  return filtered;
}
