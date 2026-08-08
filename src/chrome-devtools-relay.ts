import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isAmbiguousChromeDevtoolsAutoConnectCommand,
  replaceChromeDevtoolsAutoConnectArgs,
  resolveChromeDevtoolsAutoConnectCommand,
} from './chrome-devtools-command.js';
import type { ServerDefinition } from './config.js';
import { resolveEnvValue } from './env.js';
import { startChromeDevtoolsRelayProxy, type ChromeDevtoolsRelayProxy } from './chrome-devtools-relay-proxy.js';
import { deriveBrowserRelayKeyId } from './browser-relay-auth-v2.js';
import {
  connectChromeDevtoolsRelayV2,
  type AuthenticatedChromeDevtoolsRelay,
  type ChromeDevtoolsRelayCredential,
  type ChromeDevtoolsRelayV2Result,
} from './chrome-devtools-relay-client.js';

const DEFAULT_RELAY_PROBE_TIMEOUT_MS = 5_000;
const MIN_RELAY_PROBE_TIMEOUT_MS = 100;
const MAX_RELAY_PROBE_TIMEOUT_MS = 30_000;
const DEFAULT_RELAY_URL = 'http://127.0.0.1:18799';
const RELAY_CWD_SENTINEL = '$MCPORTER_CHROME_RELAY_CWD';
const RELAY_CREDENTIAL_SENTINEL = '$MCPORTER_CHROME_RELAY_CREDENTIAL:';
const RELAY_ENV_KEYS = [
  'MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY',
  'MCPORTER_DISABLE_CHROME_DEVTOOLS_RELAY',
  'MCPORTER_CHROME_DEVTOOLS_RELAY_URL',
  'MCPORTER_CHROME_DEVTOOLS_RELAY_TIMEOUT_MS',
  'OPENCLAW_HOME',
  'OPENCLAW_STATE_DIR',
  'OPENCLAW_OAUTH_DIR',
] as const;

export type ChromeDevtoolsRelayPolicy = 'off' | 'prefer' | 'require';
export type ChromeDevtoolsRelayRoute = 'relay' | 'legacy' | 'unavailable';
export type ChromeDevtoolsRelayReason =
  | 'disabled'
  | 'not-eligible'
  | 'unsupported-command'
  | 'missing-credential'
  | 'invalid-endpoint'
  | 'invalid-credential'
  | 'unsupported-auth'
  | 'bad-server-proof'
  | 'server-auth-failed'
  | 'replay'
  | 'protocol'
  | 'freshness'
  | 'sequence'
  | 'extension-disconnected'
  | 'timeout'
  | 'network-error'
  | 'handoff-error'
  | 'success';

export interface ChromeDevtoolsRelayDecision {
  readonly route: ChromeDevtoolsRelayRoute;
  readonly reason: ChromeDevtoolsRelayReason;
  readonly policy: ChromeDevtoolsRelayPolicy;
  readonly endpoint?: string;
  readonly probeDurationMs?: number;
  readonly probeStatus?: number;
}

export interface ChromeDevtoolsRelayRewrite {
  readonly args: readonly string[];
  readonly applied: boolean;
  readonly endpoint?: string;
  readonly decision: ChromeDevtoolsRelayDecision;
  readonly proxy?: ChromeDevtoolsRelayProxy;
}

export type ChromeDevtoolsRelayProbeResult = ChromeDevtoolsRelayV2Result;

export interface ChromeDevtoolsRelayProbeOptions {
  readonly readToken?: () => string | undefined;
  readonly connect?: (
    baseUrl: URL,
    credential: ChromeDevtoolsRelayCredential,
    timeoutMs: number
  ) => Promise<ChromeDevtoolsRelayProbeResult>;
  readonly startProxy?: (options: { upstream: AuthenticatedChromeDevtoolsRelay }) => Promise<ChromeDevtoolsRelayProxy>;
  readonly onDecision?: (decision: ChromeDevtoolsRelayDecision) => void;
}

export class ChromeDevtoolsRelayRequiredError extends Error {
  constructor(readonly decision: ChromeDevtoolsRelayDecision) {
    super(
      `Chrome DevTools relay policy 'require' could not use the OpenClaw extension relay (${decision.reason}). ` +
        'No chrome-devtools-mcp process was launched.'
    );
    this.name = 'ChromeDevtoolsRelayRequiredError';
  }
}

const lastDecisions = new Map<string, ChromeDevtoolsRelayDecision>();

export function recordChromeDevtoolsRelayDecision(server: string, decision: ChromeDevtoolsRelayDecision): void {
  lastDecisions.set(server, decision);
}

export function getChromeDevtoolsRelayDecision(server: string): ChromeDevtoolsRelayDecision | undefined {
  return lastDecisions.get(server);
}

export function formatChromeDevtoolsRelayDecision(decision: ChromeDevtoolsRelayDecision): string {
  return JSON.stringify(decision);
}

export function resolveChromeDevtoolsRelayProbeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MCPORTER_CHROME_DEVTOOLS_RELAY_TIMEOUT_MS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_RELAY_PROBE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_RELAY_PROBE_TIMEOUT_MS;
  return Math.min(MAX_RELAY_PROBE_TIMEOUT_MS, Math.max(MIN_RELAY_PROBE_TIMEOUT_MS, parsed));
}

export function resolveChromeDevtoolsRelayPolicy(
  configured: ChromeDevtoolsRelayPolicy | undefined,
  env: NodeJS.ProcessEnv = process.env
): ChromeDevtoolsRelayPolicy {
  if (env.MCPORTER_DISABLE_CHROME_DEVTOOLS_RELAY === '1') return 'off';
  const raw = env.MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY?.trim().toLowerCase();
  if (!raw) return configured ?? 'prefer';
  if (raw === 'off' || raw === 'prefer' || raw === 'require') return raw;
  throw new Error(`Invalid MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY '${raw}'. Expected off, prefer, or require.`);
}

export function isChromeDevtoolsAutoConnectCommand(command: string, args: readonly string[]): boolean {
  return resolveChromeDevtoolsAutoConnectCommand(command, args).enabled;
}

function relayBaseUrl(env: NodeJS.ProcessEnv): URL | undefined {
  const raw = env.MCPORTER_CHROME_DEVTOOLS_RELAY_URL?.trim() || DEFAULT_RELAY_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return undefined;
  }
  return url;
}

function resolveOpenClawCredentialDir(env: NodeJS.ProcessEnv): string {
  const oauthOverride = env.OPENCLAW_OAUTH_DIR?.trim();
  if (oauthOverride) return resolveOpenClawPath(oauthOverride, env);
  const stateOverride = env.OPENCLAW_STATE_DIR?.trim();
  const stateDir = stateOverride
    ? resolveOpenClawPath(stateOverride, env)
    : path.join(resolveOpenClawHome(env), '.openclaw');
  return path.join(stateDir, 'credentials');
}

function resolveOpenClawHome(env: NodeJS.ProcessEnv): string {
  const override = env.OPENCLAW_HOME?.trim();
  if (!override) return os.homedir();
  if (override === '~') return os.homedir();
  if (override.startsWith('~/') || override.startsWith('~\\')) {
    return path.resolve(os.homedir(), override.slice(2));
  }
  return path.resolve(override);
}

function resolveOpenClawPath(value: string, env: NodeJS.ProcessEnv): string {
  if (value === '~') return resolveOpenClawHome(env);
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.resolve(resolveOpenClawHome(env), value.slice(2));
  }
  return path.resolve(value);
}

function defaultReadCredential(env: NodeJS.ProcessEnv): {
  credential?: ChromeDevtoolsRelayCredential;
  reason?: ChromeDevtoolsRelayReason;
} {
  const secretPath = path.join(resolveOpenClawCredentialDir(env), 'browser-extension-relay.secret');
  return readCredentialPath(secretPath);
}

function readCredentialPath(secretPath: string): {
  credential?: ChromeDevtoolsRelayCredential;
  reason?: ChromeDevtoolsRelayReason;
} {
  let descriptor: number;
  try {
    descriptor = fs.openSync(secretPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    return { reason: isErrno(error, 'ENOENT') ? 'missing-credential' : 'invalid-credential' };
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) return { reason: 'invalid-credential' };
    if (process.platform !== 'win32') {
      if ((stat.mode & 0o077) !== 0) return { reason: 'invalid-credential' };
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid())
        return { reason: 'invalid-credential' };
    }
    const encoded = fs.readFileSync(descriptor, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/.test(encoded)) return { reason: 'invalid-credential' };
    const key = Buffer.from(encoded, 'hex');
    return { credential: { key, keyId: deriveBrowserRelayKeyId(key) } };
  } catch {
    return { reason: 'invalid-credential' };
  } finally {
    fs.closeSync(descriptor);
  }
}

async function defaultConnect(
  baseUrl: URL,
  credential: ChromeDevtoolsRelayCredential,
  timeoutMs: number
): Promise<ChromeDevtoolsRelayProbeResult> {
  return await connectChromeDevtoolsRelayV2({ baseUrl, credential, timeoutMs });
}

export function shouldAttemptChromeDevtoolsRelay(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  configuredPolicy?: ChromeDevtoolsRelayPolicy
): boolean {
  return (
    isChromeDevtoolsAutoConnectCommand(command, args) &&
    resolveChromeDevtoolsRelayPolicy(configuredPolicy, env) !== 'off'
  );
}

export async function rewriteChromeDevtoolsArgsForRelay(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  options: ChromeDevtoolsRelayProbeOptions = {},
  configuredPolicy?: ChromeDevtoolsRelayPolicy
): Promise<ChromeDevtoolsRelayRewrite> {
  const eligible = isChromeDevtoolsAutoConnectCommand(command, args);
  if (!eligible) {
    const ambiguous = isAmbiguousChromeDevtoolsAutoConnectCommand(command, args);
    if (!ambiguous) {
      return decide(
        {
          args,
          applied: false,
          decision: { route: 'legacy', reason: 'not-eligible', policy: configuredPolicy ?? 'prefer' },
        },
        options
      );
    }
    const ambiguousPolicy = resolveChromeDevtoolsRelayPolicy(configuredPolicy, env);
    if (ambiguousPolicy === 'require') {
      return unavailableOrLegacy(args, ambiguousPolicy, 'unsupported-command', undefined, options);
    }
    return decide(
      {
        args,
        applied: false,
        decision: { route: 'legacy', reason: 'not-eligible', policy: ambiguousPolicy },
      },
      options
    );
  }
  const policy = resolveChromeDevtoolsRelayPolicy(configuredPolicy, env);
  if (policy === 'off') {
    return decide({ args, applied: false, decision: { route: 'legacy', reason: 'disabled', policy } }, options);
  }

  const base = relayBaseUrl(env);
  if (!base) return unavailableOrLegacy(args, policy, 'invalid-endpoint', undefined, options);
  const upstreamEndpoint = new URL('/cdp', base);
  upstreamEndpoint.protocol = 'ws:';
  const endpoint = upstreamEndpoint.toString();

  const loaded = options.readToken
    ? (() => {
        const encoded = options.readToken?.();
        if (!encoded) return { reason: 'missing-credential' as const };
        if (!/^[0-9a-f]{64}$/u.test(encoded)) return { reason: 'invalid-credential' as const };
        const key = Buffer.from(encoded, 'hex');
        return { credential: { key, keyId: deriveBrowserRelayKeyId(key) } };
      })()
    : defaultReadCredential(env);
  if (!loaded.credential) {
    return unavailableOrLegacy(args, policy, loaded.reason ?? 'invalid-credential', endpoint, options);
  }

  const timeoutMs = resolveChromeDevtoolsRelayProbeTimeoutMs(env);
  try {
    let probe: ChromeDevtoolsRelayProbeResult;
    try {
      probe = await (options.connect ?? defaultConnect)(base, loaded.credential, timeoutMs);
    } catch {
      return unavailableOrLegacy(args, policy, 'network-error', endpoint, options);
    }
    const probeDetails = { probeDurationMs: probe.durationMs, probeStatus: probe.status };
    if (probe.reason !== 'success' || !probe.upstream) {
      probe.upstream?.socket.destroy();
      const reason = probe.reason === 'success' ? 'protocol' : probe.reason;
      return unavailableOrLegacy(args, policy, reason, endpoint, options, probeDetails);
    }

    let proxy: ChromeDevtoolsRelayProxy;
    try {
      proxy = await (options.startProxy ?? startChromeDevtoolsRelayProxy)({ upstream: probe.upstream });
    } catch {
      probe.upstream.socket.destroy();
      return unavailableOrLegacy(args, policy, 'network-error', endpoint, options, probeDetails);
    }

    const rewritten = replaceChromeDevtoolsAutoConnectArgs(command, args, ['--wsEndpoint', proxy.endpoint]);
    try {
      return decide(
        {
          args: rewritten,
          applied: true,
          endpoint: proxy.endpoint,
          proxy,
          decision: { route: 'relay', reason: 'success', policy, endpoint, ...probeDetails },
        },
        options
      );
    } catch (error) {
      await proxy.close().catch(() => {});
      throw error;
    }
  } finally {
    loaded.credential.key.fill(0);
  }
}

function unavailableOrLegacy(
  args: readonly string[],
  policy: ChromeDevtoolsRelayPolicy,
  reason: ChromeDevtoolsRelayReason,
  endpoint: string | undefined,
  options: ChromeDevtoolsRelayProbeOptions,
  probe: Pick<ChromeDevtoolsRelayDecision, 'probeDurationMs' | 'probeStatus'> = {}
): ChromeDevtoolsRelayRewrite {
  const decision: ChromeDevtoolsRelayDecision = {
    route: policy === 'require' ? 'unavailable' : 'legacy',
    reason,
    policy,
    endpoint,
    ...probe,
  };
  options.onDecision?.(decision);
  if (policy === 'require') throw new ChromeDevtoolsRelayRequiredError(decision);
  return { args, applied: false, decision };
}

function decide(
  result: ChromeDevtoolsRelayRewrite,
  options: ChromeDevtoolsRelayProbeOptions
): ChromeDevtoolsRelayRewrite {
  options.onDecision?.(result.decision);
  return result;
}

export function hashChromeDevtoolsRelayEnvironment(
  definitions: readonly ServerDefinition[],
  env: NodeJS.ProcessEnv = process.env
): string {
  return hashChromeDevtoolsRelayProcessEnvironment(chromeDevtoolsRelayEnvironmentKeys(definitions, env), env);
}

export function chromeDevtoolsRelayEnvironmentKeys(
  definitions: readonly ServerDefinition[],
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const keys = new Set<string>();
  for (const definition of definitions) {
    if (definition.command.kind !== 'stdio') continue;
    const commandValues = [definition.command.command, ...definition.command.args];
    const commandEnvironmentKeys = new Set(commandValues.flatMap(referencedEnvironmentVariables));
    const relevant =
      commandEnvironmentKeys.size > 0 ||
      isChromeDevtoolsAutoConnectCommand(definition.command.command, definition.command.args) ||
      isAmbiguousChromeDevtoolsAutoConnectCommand(definition.command.command, definition.command.args);
    if (!relevant) {
      continue;
    }
    for (const key of commandEnvironmentKeys) keys.add(key);
    const definitionEnvEntries = Object.entries(definition.env ?? {});
    const resolutionEnv = { ...env };
    for (const [key, raw] of definitionEnvEntries) {
      if (resolutionEnv[key]) continue;
      const resolved = resolveRelayDefinitionEnvValue(raw, resolutionEnv);
      if (resolved !== '') resolutionEnv[key] = resolved;
    }
    const resolvedDefinitionEnv: NodeJS.ProcessEnv = {};
    for (const [key, raw] of definitionEnvEntries) {
      const resolved = resolveRelayDefinitionEnvValue(raw, resolutionEnv);
      if (resolved !== '') resolvedDefinitionEnv[key] = resolved;
    }
    for (const pathKey of ['OPENCLAW_HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_OAUTH_DIR'] as const) {
      const override = resolvedDefinitionEnv[pathKey]?.trim();
      if (
        override &&
        override !== '~' &&
        !override.startsWith('~/') &&
        !override.startsWith('~\\') &&
        !path.isAbsolute(override)
      ) {
        keys.add(RELAY_CWD_SENTINEL);
      }
    }
    for (const key of RELAY_ENV_KEYS) {
      keys.add(key);
      const override = definition.env?.[key];
      if (!override) continue;
      for (const referenced of referencedEnvironmentVariables(override)) keys.add(referenced);
    }
    const effectiveEnv = { ...env, ...resolvedDefinitionEnv };
    const credentialPath = path.join(resolveOpenClawCredentialDir(effectiveEnv), 'browser-extension-relay.secret');
    keys.add(`${RELAY_CREDENTIAL_SENTINEL}${credentialPath}`);
  }
  return [...keys].toSorted();
}

export function hashChromeDevtoolsRelayProcessEnvironment(
  keys: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): string {
  const values = keys.map((key) => {
    if (key === RELAY_CWD_SENTINEL) return [key, process.cwd()];
    if (key.startsWith(RELAY_CREDENTIAL_SENTINEL)) {
      const credentialPath = key.slice(RELAY_CREDENTIAL_SENTINEL.length);
      const loaded = readCredentialPath(credentialPath);
      const value = [key, loaded.credential?.keyId ?? loaded.reason ?? 'missing-credential'];
      loaded.credential?.key.fill(0);
      return value;
    }
    return [key, env[key] ?? null];
  });
  if (keys.length > 0) {
    values.push(['$relayAuth', 'v2']);
  }
  return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 16);
}

function referencedEnvironmentVariables(value: string): string[] {
  const names = new Set<string>();
  if (value.startsWith('$env:')) names.add(value.slice('$env:'.length));
  for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/gu)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

function resolveRelayDefinitionEnvValue(raw: string, env: NodeJS.ProcessEnv): string {
  try {
    return resolveEnvValue(raw, env);
  } catch {
    return raw;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code);
}
