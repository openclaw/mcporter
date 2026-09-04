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
import { resolveCommandArgument, resolveCommandArguments } from './runtime/utils.js';
import { startChromeDevtoolsRelayProxy, type ChromeDevtoolsRelayProxy } from './chrome-devtools-relay-proxy.js';
import { deriveBrowserRelayKeyId } from './browser-relay-auth-v2.js';
import {
  connectChromeDevtoolsRelayV2,
  type AuthenticatedChromeDevtoolsRelay,
  type ChromeDevtoolsRelayCredential,
  type ChromeDevtoolsRelayV2Result,
} from './chrome-devtools-relay-client.js';
import {
  discoverOpenClawRelayUrl,
  normalizeOpenClawProfile,
  OPENCLAW_RELAY_DISCOVERY_ENV_KEYS,
  type OpenClawRelayDiscoveryFileProbe,
  type OpenClawRelayDiscoveryRunner,
} from './chrome-devtools-relay-discovery.js';

const DEFAULT_RELAY_PROBE_TIMEOUT_MS = 5_000;
const MIN_RELAY_PROBE_TIMEOUT_MS = 100;
const MAX_RELAY_PROBE_TIMEOUT_MS = 30_000;
const DEFAULT_RELAY_URL = 'http://127.0.0.1:18799';
const DEFAULT_RELAY_IDENTITY_URL = new URL(DEFAULT_RELAY_URL).toString();
const RELAY_DEPENDENCY_SENTINEL = '$MCPORTER_CHROME_RELAY_DEPENDENCY:';
const RELAY_DISCOVERY_SENTINEL = '$MCPORTER_CHROME_RELAY_DISCOVERY:';
export const CHROME_DEVTOOLS_RELAY_RUNTIME_IDENTITY_VERSION = 2;
export const CHROME_DEVTOOLS_RELAY_RUNTIME_ENV_KEYS = [
  'MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY',
  'MCPORTER_DISABLE_CHROME_DEVTOOLS_RELAY',
  'MCPORTER_CHROME_DEVTOOLS_RELAY_URL',
  'MCPORTER_CHROME_DEVTOOLS_RELAY_TIMEOUT_MS',
  ...OPENCLAW_RELAY_DISCOVERY_ENV_KEYS,
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

export interface ChromeDevtoolsRelayDiscoveryOptions {
  readonly platform?: NodeJS.Platform;
  readonly isFile?: OpenClawRelayDiscoveryFileProbe;
  readonly cwd?: string;
}

export interface ChromeDevtoolsRelayProbeOptions {
  readonly readToken?: () => string | undefined;
  readonly discover?: OpenClawRelayDiscoveryRunner;
  readonly discovery?: ChromeDevtoolsRelayDiscoveryOptions;
  readonly connect?: (
    baseUrl: URL,
    credential: ChromeDevtoolsRelayCredential,
    timeoutMs: number
  ) => Promise<ChromeDevtoolsRelayProbeResult>;
  readonly startProxy?: (options: { upstream: AuthenticatedChromeDevtoolsRelay }) => Promise<ChromeDevtoolsRelayProxy>;
  readonly onDecision?: (decision: ChromeDevtoolsRelayDecision) => void;
}

export interface ChromeDevtoolsRelayIdentityOptions {
  readonly discover?: OpenClawRelayDiscoveryRunner;
  readonly discovery?: ChromeDevtoolsRelayDiscoveryOptions;
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

function explicitRelayBaseUrl(env: NodeJS.ProcessEnv): { readonly explicit: boolean; readonly url?: URL } {
  const raw = env.MCPORTER_CHROME_DEVTOOLS_RELAY_URL?.trim();
  if (!raw) return { explicit: false };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { explicit: true };
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return { explicit: true };
  }
  return { explicit: true, url };
}

function resolveOpenClawCredentialDir(env: NodeJS.ProcessEnv): string {
  const oauthOverride = env.OPENCLAW_OAUTH_DIR?.trim();
  if (oauthOverride) return resolveOpenClawPath(oauthOverride, env);
  const stateOverride = env.OPENCLAW_STATE_DIR?.trim();
  const profile = normalizeOpenClawProfile(env.OPENCLAW_PROFILE);
  const stateDir = stateOverride
    ? resolveOpenClawPath(stateOverride, env)
    : path.join(resolveOpenClawHome(env), profile ? `.openclaw-${profile}` : '.openclaw');
  return path.join(stateDir, 'credentials');
}

function resolveOpenClawHome(env: NodeJS.ProcessEnv): string {
  const override = env.OPENCLAW_HOME?.trim();
  const osHome = resolveOpenClawOsHome(env);
  if (!override) return osHome;
  if (override === '~') return osHome;
  if (override.startsWith('~/') || override.startsWith('~\\')) {
    return path.resolve(osHome, override.slice(2));
  }
  return path.resolve(override);
}

function resolveOpenClawOsHome(env: NodeJS.ProcessEnv): string {
  for (const value of [env.HOME, env.USERPROFILE]) {
    const normalized = value?.trim();
    if (normalized && normalized !== 'undefined' && normalized !== 'null') return path.resolve(normalized);
  }
  return os.homedir();
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
  const relayEnv = selectChromeDevtoolsRelayRuntimeEnvironment(env);
  return (
    isChromeDevtoolsAutoConnectCommand(command, args) &&
    resolveChromeDevtoolsRelayPolicy(configuredPolicy, relayEnv) !== 'off'
  );
}

export async function rewriteChromeDevtoolsArgsForRelay(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  options: ChromeDevtoolsRelayProbeOptions = {},
  configuredPolicy?: ChromeDevtoolsRelayPolicy
): Promise<ChromeDevtoolsRelayRewrite> {
  const relayEnv = selectChromeDevtoolsRelayRuntimeEnvironment(env);
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
    const ambiguousPolicy = resolveChromeDevtoolsRelayPolicy(configuredPolicy, relayEnv);
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
  const policy = resolveChromeDevtoolsRelayPolicy(configuredPolicy, relayEnv);
  if (policy === 'off') {
    return decide({ args, applied: false, decision: { route: 'legacy', reason: 'disabled', policy } }, options);
  }

  const explicitBase = explicitRelayBaseUrl(relayEnv);
  if (explicitBase.explicit && !explicitBase.url) {
    return unavailableOrLegacy(args, policy, 'invalid-endpoint', undefined, options);
  }

  const loaded = options.readToken
    ? (() => {
        const encoded = options.readToken?.();
        if (!encoded) return { reason: 'missing-credential' as const };
        if (!/^[0-9a-f]{64}$/u.test(encoded)) return { reason: 'invalid-credential' as const };
        const key = Buffer.from(encoded, 'hex');
        return { credential: { key, keyId: deriveBrowserRelayKeyId(key) } };
      })()
    : defaultReadCredential(relayEnv);
  if (!loaded.credential) {
    const base = explicitBase.url ?? new URL(DEFAULT_RELAY_URL);
    const upstreamEndpoint = new URL('/cdp', base);
    upstreamEndpoint.protocol = 'ws:';
    return unavailableOrLegacy(
      args,
      policy,
      loaded.reason ?? 'invalid-credential',
      upstreamEndpoint.toString(),
      options
    );
  }

  const timeoutMs = resolveChromeDevtoolsRelayProbeTimeoutMs(relayEnv);
  try {
    const base =
      explicitBase.url ??
      (
        await discoverOpenClawRelayUrl({
          env: relayEnv,
          keyId: loaded.credential.keyId,
          timeoutMs,
          run: options.discover,
          platform: options.discovery?.platform,
          isFile: options.discovery?.isFile,
          cwd: options.discovery?.cwd,
        })
      ).url ??
      new URL(DEFAULT_RELAY_URL);
    const upstreamEndpoint = new URL('/cdp', base);
    upstreamEndpoint.protocol = 'ws:';
    const endpoint = upstreamEndpoint.toString();
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

export function resolveChromeDevtoolsRelayEnvironment(
  overrides: Readonly<Record<string, string>> | undefined,
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return { ...env, ...resolveRelayDefinitionEnvOverrides(overrides, env) };
}

function selectChromeDevtoolsRelayRuntimeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    CHROME_DEVTOOLS_RELAY_RUNTIME_ENV_KEYS.flatMap((key) => {
      const value = env[key];
      return value === undefined ? [] : [[key, value]];
    })
  );
}

function sanitizeRelayIdentityEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const selected = selectChromeDevtoolsRelayRuntimeEnvironment(env);
  if (selected.MCPORTER_CHROME_DEVTOOLS_RELAY_URL !== undefined) {
    const explicit = explicitRelayBaseUrl(selected);
    selected.MCPORTER_CHROME_DEVTOOLS_RELAY_URL = explicit.explicit
      ? (explicit.url?.toString() ?? 'invalid-endpoint')
      : '';
  }
  return selected;
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
    for (const key of commandEnvironmentKeys) keys.add(`${RELAY_DEPENDENCY_SENTINEL}${key}`);
    const resolvedDefinitionEnv = resolveRelayIdentityEnvOverrides(definition.env, env);
    for (const key of CHROME_DEVTOOLS_RELAY_RUNTIME_ENV_KEYS) {
      const override = definition.env?.[key];
      if (!override) continue;
      for (const referenced of referencedEnvironmentVariables(override))
        keys.add(`${RELAY_DEPENDENCY_SENTINEL}${referenced}`);
    }
    const resolvedCommand = resolveCommandArgument(definition.command.command, env);
    const resolvedArgs = resolveCommandArguments(definition.command.args, env);
    const eligible = isChromeDevtoolsAutoConnectCommand(resolvedCommand, resolvedArgs);
    if (!eligible && !isAmbiguousChromeDevtoolsAutoConnectCommand(resolvedCommand, resolvedArgs)) continue;
    const environment = sanitizeRelayIdentityEnvironment(resolvedDefinitionEnv);
    keys.add(
      `${RELAY_DISCOVERY_SENTINEL}${Buffer.from(
        JSON.stringify({
          server: definition.name,
          eligible,
          environment,
          configuredPolicy: definition.chromeDevtoolsRelay,
        }),
        'utf8'
      ).toString('base64url')}`
    );
  }
  return [...keys].toSorted();
}

export function hashChromeDevtoolsRelayProcessEnvironment(
  keys: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): string {
  const { values, relays } = relayEnvironmentIdentityValues(keys, env);
  return hashRelayIdentityValues([...values, ...relays.map((relay) => [relay.server, relay.endpoint] as const)]);
}

export async function resolveChromeDevtoolsRelayRuntimeIdentity(
  keys: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  options: ChromeDevtoolsRelayIdentityOptions = {}
): Promise<string> {
  const { values, relays } = relayEnvironmentIdentityValues(keys, env);
  for (const relay of relays) {
    let endpoint = relay.endpoint;
    if (relay.discover && relay.keyId !== 'missing-credential' && relay.keyId !== 'invalid-credential') {
      try {
        const discovered = await discoverOpenClawRelayUrl({
          env: relay.env,
          keyId: relay.keyId,
          timeoutMs: relay.timeoutMs,
          run: options.discover,
          platform: options.discovery?.platform,
          isFile: options.discovery?.isFile,
          cwd: options.discovery?.cwd,
        });
        endpoint = discovered.url?.toString() ?? DEFAULT_RELAY_IDENTITY_URL;
      } catch {
        endpoint = DEFAULT_RELAY_IDENTITY_URL;
      }
    }
    values.push([relay.server, endpoint]);
  }
  return hashRelayIdentityValues(values);
}

function createRelayCredentialIdResolver(): (credentialPath: string) => string {
  const credentialIds = new Map<string, string>();
  return (credentialPath: string): string => {
    const cached = credentialIds.get(credentialPath);
    if (cached) return cached;
    const loaded = readCredentialPath(credentialPath);
    const value = loaded.credential?.keyId ?? loaded.reason ?? 'missing-credential';
    loaded.credential?.key.fill(0);
    credentialIds.set(credentialPath, value);
    return value;
  };
}

interface RelayDiscoveryIdentity {
  readonly server: string;
  readonly eligible: boolean;
  readonly environment: NodeJS.ProcessEnv;
  readonly configuredPolicy?: ChromeDevtoolsRelayPolicy;
}

interface EffectiveRelayIdentity {
  readonly server: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly keyId: string;
  readonly endpoint: string;
  readonly discover: boolean;
}

type RelayIdentityValue = readonly [string, string | number | null];

function relayEnvironmentIdentityValues(
  keys: readonly string[],
  env: NodeJS.ProcessEnv
): { values: RelayIdentityValue[]; relays: EffectiveRelayIdentity[] } {
  const credentialId = createRelayCredentialIdResolver();
  const values: RelayIdentityValue[] = [];
  const relays: EffectiveRelayIdentity[] = [];
  for (const key of keys) {
    if (key.startsWith(RELAY_DEPENDENCY_SENTINEL)) {
      // Substitution consumes raw bytes even if the same variable is a normalized relay control.
      values.push([key, env[key.slice(RELAY_DEPENDENCY_SENTINEL.length)] ?? null]);
      continue;
    }
    if (!key.startsWith(RELAY_DISCOVERY_SENTINEL)) {
      values.push([key, relayEnvironmentIdentityValue(key, env)]);
      continue;
    }
    const payload = parseRelayDiscoveryIdentity(key.slice(RELAY_DISCOVERY_SENTINEL.length));
    if (!payload) throw new Error('Invalid Chrome DevTools relay identity metadata');
    const effectiveEnv = { ...selectChromeDevtoolsRelayRuntimeEnvironment(env), ...payload.environment };
    const policy = resolveChromeDevtoolsRelayPolicy(payload.configuredPolicy, effectiveEnv);
    const timeoutMs = resolveChromeDevtoolsRelayProbeTimeoutMs(effectiveEnv);
    const explicit = explicitRelayBaseUrl(effectiveEnv);
    const credentialDir = resolveOpenClawCredentialDir(effectiveEnv);
    const keyId = payload.eligible
      ? credentialId(path.join(credentialDir, 'browser-extension-relay.secret'))
      : 'not-eligible';
    const server = `$relay:${payload.server}`;
    values.push([
      server,
      JSON.stringify({
        policy,
        timeoutMs,
        eligible: payload.eligible,
        credentialDir,
        keyId,
        // These values also reach the discovery subprocess; retain inputs whose equivalence it does not guarantee.
        discovery: OPENCLAW_RELAY_DISCOVERY_ENV_KEYS.map((name) => [
          name,
          relayEnvironmentIdentityValue(name, effectiveEnv),
        ]),
        cwd: relayIdentityDependsOnCwd(effectiveEnv) ? process.cwd() : null,
      }),
    ]);
    relays.push({
      server,
      env: effectiveEnv,
      timeoutMs,
      keyId,
      endpoint:
        policy === 'off'
          ? 'disabled'
          : explicit.explicit
            ? (explicit.url?.toString() ?? 'invalid-endpoint')
            : DEFAULT_RELAY_IDENTITY_URL,
      discover: payload.eligible && policy !== 'off' && !explicit.explicit,
    });
  }
  if (keys.length > 0) values.push(['$relayAuth', 'v2-effective-metadata-discovery']);
  return { values, relays };
}

function relayEnvironmentIdentityValue(key: string, env: NodeJS.ProcessEnv): string | number | null {
  switch (key) {
    case 'MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY':
    case 'MCPORTER_DISABLE_CHROME_DEVTOOLS_RELAY':
      return resolveChromeDevtoolsRelayPolicy(undefined, env);
    case 'MCPORTER_CHROME_DEVTOOLS_RELAY_TIMEOUT_MS':
      return resolveChromeDevtoolsRelayProbeTimeoutMs(env);
    case 'MCPORTER_CHROME_DEVTOOLS_RELAY_URL': {
      const explicit = explicitRelayBaseUrl(env);
      return explicit.explicit ? (explicit.url?.toString() ?? 'invalid-endpoint') : DEFAULT_RELAY_IDENTITY_URL;
    }
    case 'OPENCLAW_PROFILE':
      return normalizeOpenClawProfile(env.OPENCLAW_PROFILE) ?? null;
    default:
      return env[key] ?? null;
  }
}

function relayIdentityDependsOnCwd(env: NodeJS.ProcessEnv): boolean {
  const paths = [
    env.HOME,
    env.USERPROFILE,
    env.OPENCLAW_HOME,
    env.OPENCLAW_STATE_DIR,
    env.OPENCLAW_OAUTH_DIR,
    env.OPENCLAW_CONFIG_PATH,
    ...((env.PATH ?? env.Path)?.split(path.delimiter) ?? []),
  ];
  return paths.some((value) => value !== undefined && !path.isAbsolute(value) && !value.startsWith('~'));
}

function hashRelayIdentityValues(values: ReadonlyArray<RelayIdentityValue>): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        values.toSorted((a, b) => a[0].localeCompare(b[0]) || JSON.stringify(a[1]).localeCompare(JSON.stringify(b[1])))
      )
    )
    .digest('hex')
    .slice(0, 16);
}

function parseRelayDiscoveryIdentity(encoded: string): RelayDiscoveryIdentity | undefined {
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const candidate = value as {
      server?: unknown;
      eligible?: unknown;
      environment?: unknown;
      configuredPolicy?: unknown;
    };
    if (
      typeof candidate.server !== 'string' ||
      typeof candidate.eligible !== 'boolean' ||
      !candidate.environment ||
      typeof candidate.environment !== 'object'
    )
      return undefined;
    if (
      candidate.configuredPolicy !== undefined &&
      !['off', 'prefer', 'require'].includes(candidate.configuredPolicy as string)
    )
      return undefined;
    const environment: NodeJS.ProcessEnv = {};
    for (const [key, raw] of Object.entries(candidate.environment)) {
      if (!(CHROME_DEVTOOLS_RELAY_RUNTIME_ENV_KEYS as readonly string[]).includes(key) || typeof raw !== 'string')
        return undefined;
      environment[key] = raw;
    }
    return {
      server: candidate.server,
      eligible: candidate.eligible,
      environment,
      configuredPolicy: candidate.configuredPolicy as ChromeDevtoolsRelayPolicy | undefined,
    };
  } catch {
    return undefined;
  }
}

function referencedEnvironmentVariables(value: string): string[] {
  const names = new Set<string>();
  if (value.startsWith('$env:')) names.add(value.slice('$env:'.length));
  for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/gu)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

function resolveRelayDefinitionEnvOverrides(
  overrides: Readonly<Record<string, string>> | undefined,
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const resolved: NodeJS.ProcessEnv = {};
  for (const [key, raw] of Object.entries(overrides ?? {})) {
    const value = resolveEnvValue(raw, env);
    if (value !== '') resolved[key] = value;
  }
  return resolved;
}

function resolveRelayIdentityEnvOverrides(
  overrides: Readonly<Record<string, string>> | undefined,
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const relevant = Object.fromEntries(
    CHROME_DEVTOOLS_RELAY_RUNTIME_ENV_KEYS.flatMap((key) => {
      const value = overrides?.[key];
      return value === undefined ? [] : [[key, value]];
    })
  );
  return resolveRelayDefinitionEnvOverrides(relevant, env);
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code);
}
