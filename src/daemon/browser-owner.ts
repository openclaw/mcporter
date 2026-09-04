import os from 'node:os';
import path from 'node:path';
import { resolveChromeDevtoolsAutoConnectCommand } from '../chrome-devtools-command.js';
import {
  chromeDevtoolsRelayEnvironmentKeys,
  resolveChromeDevtoolsRelayRuntimeIdentity,
  resolveChromeDevtoolsRelayPolicy,
} from '../chrome-devtools-relay.js';
import { type ServerDefinition } from '../config-schema.js';
import { mcporterConfigCandidates } from '../paths.js';
import { pathExists } from '../config/path-discovery.js';
import { readConfigFile } from '../config/read-config.js';
import { normalizeServerEntry } from '../config-normalize.js';
import {
  connectionIdentity,
  effectiveDefinition,
  isChromeDefinition,
  normalizeChromeEnvironment,
  type ResolvedServerDefinition,
} from './connection-identity.js';
import { daemonBaseDir } from './paths.js';

export class BrowserOwnerConflict extends Error {
  readonly code = 'browser_owner_conflict';
  constructor(reason: string) {
    super(
      `Existing Chrome owner conflict: ${reason}. Use the canonical Chrome definition; drain and stop the daemon before deliberately changing ownership. This request was not retried.`
    );
  }
}

export function isCanonicalChromeNamespace(): boolean {
  return path.resolve(daemonBaseDir()) === path.join(os.userInfo().homedir, '.mcporter');
}

export async function canonicalUserConfiguration(): Promise<{
  definitions: ResolvedServerDefinition[];
  idleTimeoutMs?: number;
}> {
  if (!isCanonicalChromeNamespace()) return { definitions: [] };
  const home = os.userInfo().homedir;
  // Match normal global selection, with OS home and no caller XDG override.
  const file = mcporterConfigCandidates({ home }).find(pathExists);
  if (!file) return { definitions: [] };
  const definitions: ResolvedServerDefinition[] = [];
  const canonicalEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  if (canonicalEnv.USERPROFILE !== undefined) canonicalEnv.USERPROFILE = home;
  for (const name of Object.keys(canonicalEnv))
    if (
      name.startsWith('MCPORTER_CHROME_DEVTOOLS_RELAY_') ||
      name === 'MCPORTER_DISABLE_CHROME_DEVTOOLS_RELAY' ||
      name.startsWith('OPENCLAW_')
    )
      delete canonicalEnv[name];
  const raw = await readConfigFile(file, true);
  for (const [name, entry] of Object.entries(raw.mcpServers)) {
    const launchTokens = [
      name,
      ...(Array.isArray(entry.command) ? entry.command : [entry.command ?? '']),
      ...(entry.args ?? []),
    ];
    if (!launchTokens.some((token) => /chrome[-_]devtools(?:[-_]mcp)?/i.test(token))) continue;
    const definition = normalizeServerEntry(name, entry, path.dirname(file), { kind: 'local', path: file }, [], {
      env: canonicalEnv,
      home,
    });
    if (supportedOwner(definition)) definitions.push(await effectiveDefinition(definition, canonicalEnv));
  }
  return { definitions, idleTimeoutMs: raw.daemonIdleTimeoutMs ?? raw.daemon_idle_timeout_ms };
}

export async function canonicalChromeDefinitions(): Promise<ResolvedServerDefinition[]> {
  return (await canonicalUserConfiguration()).definitions;
}

function supportedOwner(definition: ServerDefinition): boolean {
  return (
    isChromeDefinition(definition) &&
    definition.command.kind === 'stdio' &&
    resolveChromeDevtoolsAutoConnectCommand(definition.command.command, definition.command.args).enabled
  );
}

/** The synchronous reservation also owns asynchronous discovery and every later generation. */
export class BrowserOwner {
  private identity?: string;
  private logicalIdentity?: Promise<string>;
  private readonly canonicalKeys: Set<string>;
  private readonly canonical: readonly ResolvedServerDefinition[];
  get reserved(): boolean {
    return this.identity !== undefined;
  }
  constructor(canonical: readonly ResolvedServerDefinition[]) {
    this.canonical = canonical.filter(supportedOwner);
    this.canonicalKeys = new Set(this.canonical.map(connectionIdentity));
  }

  reserve(definition: ResolvedServerDefinition): ServerDefinition {
    if (!isChromeDefinition(definition)) return definition;
    if (!isCanonicalChromeNamespace())
      throw new BrowserOwnerConflict('existing local Chrome is forbidden in an isolated daemon directory');
    if (definition.command.kind !== 'stdio') return definition;
    if (!resolveChromeDevtoolsAutoConnectCommand(definition.command.command, definition.command.args).enabled)
      throw new BrowserOwnerConflict('direct endpoints, wrappers and profile labels do not prove a distinct browser');
    const configured = this.canonical[0];
    if (this.canonicalKeys.size !== 1 || !configured)
      throw new BrowserOwnerConflict('canonical global Chrome definitions are missing or conflicting');
    const overrides = definition.configuredEnv ?? definition.env;
    if (
      definition.chromeDevtoolsRelay &&
      resolveChromeDevtoolsRelayPolicy(definition.chromeDevtoolsRelay, overrides ?? {}) !==
        resolveChromeDevtoolsRelayPolicy(configured.chromeDevtoolsRelay, configured.env)
    )
      throw new BrowserOwnerConflict('canonical relay policy differs');
    const env = { ...configured.env, ...overrides };
    normalizeChromeEnvironment(definition, env);
    const command =
      configured.command.kind === 'stdio' && definition.command.command === configured.launchCommand
        ? { ...definition.command, command: configured.command.command }
        : definition.command;
    const candidate = { ...definition, command, env };
    const identity = connectionIdentity(candidate);
    if (!this.canonicalKeys.has(identity))
      throw new BrowserOwnerConflict('request does not match the complete canonical global Chrome connection contract');
    const policy = resolveChromeDevtoolsRelayPolicy(definition.chromeDevtoolsRelay, env);
    if (policy !== resolveChromeDevtoolsRelayPolicy(configured.chromeDevtoolsRelay, configured.env))
      throw new BrowserOwnerConflict('canonical relay policy differs');
    if (this.identity && this.identity !== identity)
      throw new BrowserOwnerConflict('an incompatible pending or live connection already owns the browser');
    this.identity = identity;
    return configured;
  }

  async resolveIdentity(definition: ServerDefinition): Promise<string> {
    const resolve = () =>
      resolveChromeDevtoolsRelayRuntimeIdentity(
        chromeDevtoolsRelayEnvironmentKeys([definition], definition.env),
        definition.env
      );
    if (!this.logicalIdentity) this.logicalIdentity = resolve();
    const retained = await this.logicalIdentity;
    const current = await resolve();
    if (retained !== current)
      throw new BrowserOwnerConflict(
        'relay endpoint, credential generation or security context changed; explicit retirement is required'
      );
    return retained;
  }
}
