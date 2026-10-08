import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isExistingChromeDevtoolsCommand } from '../chrome-devtools-command.js';
import {
  resolveChromeDevtoolsRelayEnvironment,
  resolveChromeDevtoolsRelayPolicy,
  resolveChromeDevtoolsRelayProbeTimeoutMs,
} from '../chrome-devtools-relay.js';
import type { ServerDefinition } from '../config.js';
import { stableJsonStringify } from '../stable-json.js';
import { resolveCommandArgument, resolveCommandArguments } from '../runtime/utils.js';
import { childEnvWithoutVaultSecrets } from '../oauth-vault-encryption.js';

// These are broker controls, never child inputs. Other environment differences remain meaningful.
const BROKER_ENV = new Set([
  'MCPORTER_DAEMON_DIR',
  'MCPORTER_DAEMON_CHILD',
  'MCPORTER_DAEMON_SOCKET',
  'MCPORTER_DAEMON_METADATA',
  'MCPORTER_CONFIG',
  'MCPORTER_DISABLE_AUTORUN',
  'MCPORTER_DAEMON_LOG',
  'MCPORTER_DAEMON_LOG_PATH',
  'MCPORTER_DAEMON_LOG_SERVERS',
  'MCPORTER_NO_FORCE_EXIT',
]);

export interface ResolvedServerDefinition extends ServerDefinition {
  /** Resolved explicit overrides, before adding inherited launch environment. */
  readonly configuredEnv?: Record<string, string>;
  /** Requested executable before canonical PATH resolution; never a pooling input. */
  readonly launchCommand?: string;
}

export async function effectiveDefinition(
  definition: ServerDefinition,
  inherited: NodeJS.ProcessEnv = process.env,
  purpose: 'connection' | 'view' = 'connection'
): Promise<ResolvedServerDefinition> {
  // The inherited environment loses the vault password and policy before it
  // reaches any daemon-managed child; an explicit `env` entry still wins.
  const env = Object.fromEntries(
    Object.entries(
      resolveChromeDevtoolsRelayEnvironment(definition.env, childEnvWithoutVaultSecrets(inherited))
    ).filter(([key, value]) => value !== undefined && !BROKER_ENV.has(key))
  ) as Record<string, string>;
  const configuredEnv = Object.fromEntries(
    Object.keys(definition.env ?? {})
      .filter((key) => !BROKER_ENV.has(key))
      .map((key) => [key, env[key] ?? ''])
  );
  normalizeChromeEnvironment(definition, env);
  const chrome = isExistingChromeDefinition(definition, env);
  const launchCommand =
    definition.command.kind === 'stdio' ? resolveCommandArgument(definition.command.command, env) : undefined;
  const command =
    definition.command.kind === 'stdio'
      ? {
          ...definition.command,
          command:
            chrome && purpose === 'view'
              ? launchCommand!
              : await resolveExecutable(launchCommand!, env, definition.command.cwd),
          args: resolveCommandArguments(definition.command.args, env),
          cwd: await fs.realpath(definition.command.cwd),
        }
      : { ...definition.command, url: new URL(definition.command.url) };
  // Shell location and nesting describe the caller, not the configured child.
  if (command.kind === 'stdio') {
    if (!Object.hasOwn(configuredEnv, 'PWD')) env.PWD = command.cwd;
    if (!Object.hasOwn(configuredEnv, 'SHLVL')) delete env.SHLVL;
  }
  return { ...definition, command, env, configuredEnv, ...(chrome ? { launchCommand } : {}) };
}

export function normalizeChromeEnvironment(definition: ServerDefinition, env: Record<string, string>): void {
  if (isExistingChromeDefinition(definition, env)) {
    env.MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY = resolveChromeDevtoolsRelayPolicy(definition.chromeDevtoolsRelay, env);
    env.MCPORTER_CHROME_DEVTOOLS_RELAY_TIMEOUT_MS = String(resolveChromeDevtoolsRelayProbeTimeoutMs(env));
    delete env.MCPORTER_DISABLE_CHROME_DEVTOOLS_RELAY;
    if (!env.OPENCLAW_PROFILE?.trim() || env.OPENCLAW_PROFILE.trim() === 'default') delete env.OPENCLAW_PROFILE;
    if (env.MCPORTER_CHROME_DEVTOOLS_RELAY_URL?.trim())
      env.MCPORTER_CHROME_DEVTOOLS_RELAY_URL = new URL(env.MCPORTER_CHROME_DEVTOOLS_RELAY_URL.trim()).toString();
    else delete env.MCPORTER_CHROME_DEVTOOLS_RELAY_URL;
  }
}

async function resolveExecutable(command: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  const roots = /[/\\]/.test(command)
    ? [path.resolve(cwd, command)]
    : (env.PATH ?? env.Path ?? '').split(path.delimiter).map((dir) => path.resolve(cwd, dir, command));
  const extensions =
    process.platform === 'win32' && !path.extname(command)
      ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')]
      : [''];
  const candidates = roots.flatMap((root) => extensions.map((extension) => root + extension));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return path.join(await fs.realpath(path.dirname(candidate)), path.basename(candidate));
    } catch {
      /* Try the next PATH entry. */
    }
  }
  throw new Error('Unable to resolve configured executable from the effective PATH.');
}

export function connectionIdentity(definition: ResolvedServerDefinition): string {
  const {
    name,
    description: _description,
    source: _source,
    sources: _sources,
    allowedTools: _allowed,
    blockedTools: _blocked,
    lifecycle: _lifecycle,
    configuredEnv: _configuredEnv,
    launchCommand: _launchCommand,
    logging: _logging,
    ...connection
  } = definition;
  // HTTP cached credentials are alias-owned even when auth was inferred on first use.
  const credentialOwner = definition.auth || definition.command.kind === 'http' ? name : undefined;
  const env = { ...definition.env };
  const chrome = isExistingChromeDefinition(definition);
  if (chrome) {
    env.MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY = resolveChromeDevtoolsRelayPolicy(definition.chromeDevtoolsRelay, env);
    delete env.MCPORTER_DISABLE_CHROME_DEVTOOLS_RELAY;
    env.MCPORTER_CHROME_DEVTOOLS_RELAY_TIMEOUT_MS = String(resolveChromeDevtoolsRelayProbeTimeoutMs(env));
  }
  return createHash('sha256')
    .update(
      stableJsonStringify({
        ...connection,
        env,
        credentialOwner,
        idleTimeoutMs:
          !chrome && definition.lifecycle?.mode === 'keep-alive' ? definition.lifecycle.idleTimeoutMs : undefined,
        protocolVersion: definition.protocolVersion ?? 'auto',
        httpFetch: definition.httpFetch ?? 'default',
        chromeDevtoolsRelay: chrome ? env.MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY : undefined,
      })
    )
    .digest('hex');
}

/** Plain launches own their browser; connection selectors and ambiguous wrappers do not prove isolation. */
export function isExistingChromeDefinition(definition: ServerDefinition, env?: NodeJS.ProcessEnv): boolean {
  if (definition.command.kind !== 'stdio') return false;
  const effectiveEnv = env ?? resolveChromeDevtoolsRelayEnvironment(definition.env);
  const command = resolveCommandArgument(definition.command.command, effectiveEnv);
  const args = resolveCommandArguments(definition.command.args, effectiveEnv);
  return (
    [definition.name, command, ...args].some((value) => /chrome[-_]devtools(?:[-_]mcp)?/i.test(value)) &&
    isExistingChromeDevtoolsCommand(command, args)
  );
}
