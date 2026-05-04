import path from 'node:path';
import type { LoadConfigOptions, RawEntry } from '../../config.js';
import { writeRawConfig } from '../../config.js';
import { pathsForImport, readExternalEntries } from '../../config-imports.js';
import { expandHome } from '../../env.js';
import { mcporterDir } from '../../paths.js';
import { CliUsageError } from '../errors.js';
import { cloneConfig, loadOrCreateConfig } from './shared.js';
import type { ConfigCliOptions } from './types.js';

export type AddFlags = {
  transport?: 'http' | 'sse' | 'stdio';
  url?: string;
  command?: string;
  stdio?: string;
  args: string[];
  description?: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  tokenCacheDir?: string;
  clientName?: string;
  oauthClientId?: string;
  oauthClientSecretEnv?: string;
  oauthTokenEndpointAuthMethod?: string;
  oauthRedirectUrl?: string;
  auth?: string;
  copyFrom?: string;
  persistPath?: string;
  scope?: 'home' | 'project';
  dryRun?: boolean;
};

export async function handleAddCommand(options: ConfigCliOptions, args: string[]): Promise<void> {
  const name = args.shift();
  if (!name) {
    throw new CliUsageError('Usage: mcporter config add <name> [target]');
  }
  let positionalTarget: string | undefined;
  if (args[0] && !args[0].startsWith('--')) {
    positionalTarget = args.shift();
  }
  const flags = extractAddFlags(args);

  const targetPath = resolveWriteTarget(flags, options.loadOptions, options.loadOptions.rootDir ?? process.cwd());
  const effectiveLoadOptions: LoadConfigOptions = { ...options.loadOptions, configPath: targetPath };

  const { config, path: configPath } = await loadOrCreateConfig(effectiveLoadOptions);
  const nextConfig = cloneConfig(config);

  const baseEntry = await resolveBaseEntry(flags.copyFrom, options.loadOptions);
  const entry: RawEntry = baseEntry ? { ...baseEntry } : {};

  applyTargetToEntry(entry, positionalTarget, flags);
  applyFlagsToEntry(entry, flags);
  validateTransportChoice(entry, flags.transport);

  const hasHttpTarget =
    Boolean(entry.baseUrl) ||
    Boolean(entry.base_url) ||
    Boolean(entry.url) ||
    Boolean(entry.serverUrl) ||
    Boolean(entry.server_url);
  const hasCommandTarget = Boolean(entry.command ?? entry.executable);

  if (flags.args.length > 0 && !hasCommandTarget) {
    throw new CliUsageError(
      '--arg/--args requires a stdio command (use --command, --stdio, or provide a positional target).'
    );
  }

  if (!hasHttpTarget && !hasCommandTarget) {
    throw new CliUsageError('Server definitions require either a --url/target or a stdio command.');
  }

  if (!nextConfig.mcpServers) {
    nextConfig.mcpServers = {};
  }
  nextConfig.mcpServers[name] = entry;

  if (flags.dryRun) {
    console.log(JSON.stringify({ [name]: entry }, null, 2));
    console.log('(dry-run) No changes were written.');
    return;
  }

  await writeRawConfig(configPath, nextConfig);
  console.log(`Added '${name}' to ${configPath}`);
}

export function resolveWriteTarget(flags: AddFlags, loadOptions: LoadConfigOptions, rootDir: string): string {
  if (flags.persistPath) {
    return path.resolve(expandHome(flags.persistPath));
  }
  if (flags.scope === 'home') {
    return path.join(mcporterDir('config'), 'mcporter.json');
  }
  if (flags.scope === 'project') {
    return path.resolve(rootDir, 'config', 'mcporter.json');
  }
  if (loadOptions.configPath) {
    return path.resolve(expandHome(loadOptions.configPath));
  }
  return path.resolve(rootDir, 'config', 'mcporter.json');
}

function extractAddFlags(args: string[]): AddFlags {
  const flags: AddFlags = { args: [], env: {}, headers: {} };
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    switch (token) {
      case '--transport':
        flags.transport = parseTransport(requireValue(args, index, token));
        args.splice(index, 2);
        continue;
      case '--url':
        flags.url = requireValue(args, index, token);
        args.splice(index, 2);
        continue;
      case '--command':
        flags.command = requireValue(args, index, token);
        args.splice(index, 2);
        continue;
      case '--stdio':
        flags.stdio = requireValue(args, index, token);
        args.splice(index, 2);
        continue;
      case '--arg':
      case '--args':
        flags.args.push(requireValue(args, index, token));
        args.splice(index, 2);
        continue;
      case '--description':
        flags.description = requireValue(args, index, token);
        args.splice(index, 2);
        continue;
      case '--env':
        parseKeyValue(requireValue(args, index, token), flags.env, '--env');
        args.splice(index, 2);
        continue;
      case '--header':
        parseKeyValue(requireValue(args, index, token), flags.headers, '--header');
        args.splice(index, 2);
        continue;
      case '--token-cache-dir':
        flags.tokenCacheDir = requireValue(args, index, token);
        args.splice(index, 2);
        continue;
      case '--client-name':
        flags.clientName = requireValue(args, index, token);
        args.splice(index, 2);
        continue;
      case '--oauth-client-id':
        flags.oauthClientId = requireValue(args, index, token);
        args.splice(index, 2);
        continue;
      case '--oauth-client-secret-env':
        flags.oauthClientSecretEnv = requireValue(args, index, token);
        args.splice(index, 2);
        continue;
      case '--oauth-token-endpoint-auth-method':
        flags.oauthTokenEndpointAuthMethod = requireValue(args, index, token);
        args.splice(index, 2);
        continue;
      case '--oauth-redirect-url':
        flags.oauthRedirectUrl = requireValue(args, index, token);
        args.splice(index, 2);
        continue;
      case '--auth':
        flags.auth = requireValue(args, index, token);
        args.splice(index, 2);
        continue;
      case '--copy-from':
        flags.copyFrom = requireValue(args, index, token);
        args.splice(index, 2);
        continue;
      case '--persist':
        flags.persistPath = requireValue(args, index, token);
        args.splice(index, 2);
        continue;
      case '--scope': {
        const scopeValue = requireValue(args, index, token);
        if (scopeValue !== 'home' && scopeValue !== 'project') {
          throw new CliUsageError('--scope must be either "home" or "project".');
        }
        flags.scope = scopeValue;
        args.splice(index, 2);
        continue;
      }
      case '--dry-run':
        flags.dryRun = true;
        args.splice(index, 1);
        continue;
      case '--':
        args.splice(index, 1);
        while (index < args.length) {
          const value = args[index];
          if (value !== undefined) {
            flags.args.push(value);
          }
          args.splice(index, 1);
        }
        continue;
      default:
        index += 1;
        break;
    }
  }
  return flags;
}

function parseTransport(value: string | undefined): 'http' | 'sse' | 'stdio' {
  if (value !== 'http' && value !== 'sse' && value !== 'stdio') {
    throw new CliUsageError("--transport must be one of 'http', 'sse', or 'stdio'.");
  }
  return value;
}

function parseKeyValue(input: string | undefined, target: Record<string, string>, flagName: string): void {
  if (!input?.includes('=')) {
    throw new CliUsageError(`${flagName} requires KEY=value.`);
  }
  const [key, ...rest] = input.split('=');
  if (!key) {
    throw new CliUsageError(`${flagName} requires KEY=value.`);
  }
  target[key] = rest.join('=');
}

function requireValue(args: string[], index: number, flagName: string): string {
  const value = args[index + 1];
  if (!value) {
    throw new CliUsageError(`Flag '${flagName}' requires a value.`);
  }
  return value;
}

async function resolveBaseEntry(copyFrom: string | undefined, options: LoadConfigOptions): Promise<RawEntry | null> {
  if (!copyFrom) {
    return null;
  }
  const [kind, ...rest] = copyFrom.split(':');
  const name = rest.join(':');
  if (!kind || !name) {
    throw new CliUsageError("--copy-from requires the format '<import>:<name>'.");
  }
  const rootDir = options.rootDir ?? process.cwd();
  const paths = pathsForImport(kind as never, rootDir);
  for (const candidate of paths) {
    const resolved = expandHome(candidate);
    const entries = await readExternalEntries(resolved, { projectRoot: rootDir, importKind: kind as never });
    if (!entries) {
      continue;
    }
    const entry = entries.get(name);
    if (entry) {
      return structuredClone(entry);
    }
  }
  throw new CliUsageError(`Unable to find '${name}' in import '${kind}'.`);
}

function applyTargetToEntry(entry: RawEntry, positionalTarget: string | undefined, flags: AddFlags): void {
  if (flags.url) {
    entry.baseUrl = flags.url;
    return;
  }
  if (flags.command) {
    entry.command = flags.command;
  }
  if (flags.stdio) {
    entry.command = flags.stdio;
  }
  if (positionalTarget) {
    if (looksLikeHttp(positionalTarget)) {
      entry.baseUrl = positionalTarget;
    } else {
      entry.command = positionalTarget;
    }
  }
}

function applyFlagsToEntry(entry: RawEntry, flags: AddFlags): void {
  if (flags.args.length > 0) {
    entry.args = flags.args;
  }
  if (flags.description) {
    entry.description = flags.description;
  }
  if (Object.keys(flags.env).length > 0) {
    entry.env = entry.env ? { ...entry.env, ...flags.env } : { ...flags.env };
  }
  if (Object.keys(flags.headers).length > 0) {
    entry.headers = entry.headers ? { ...entry.headers, ...flags.headers } : { ...flags.headers };
  }
  if (flags.tokenCacheDir) {
    entry.tokenCacheDir = flags.tokenCacheDir;
  }
  if (flags.clientName) {
    entry.clientName = flags.clientName;
  }
  if (flags.oauthClientId) {
    entry.oauthClientId = flags.oauthClientId;
  }
  if (flags.oauthClientSecretEnv) {
    entry.oauthClientSecretEnv = flags.oauthClientSecretEnv;
  }
  if (flags.oauthTokenEndpointAuthMethod) {
    entry.oauthTokenEndpointAuthMethod = flags.oauthTokenEndpointAuthMethod;
  }
  if (flags.oauthRedirectUrl) {
    entry.oauthRedirectUrl = flags.oauthRedirectUrl;
  }
  if (flags.auth) {
    entry.auth = flags.auth;
  }
}

function validateTransportChoice(entry: RawEntry, transport: AddFlags['transport']): void {
  if (!transport) {
    return;
  }
  const isHttp = Boolean(entry.baseUrl ?? entry.url ?? entry.serverUrl);
  const isStdio = Boolean(entry.command ?? entry.args);
  if (transport === 'stdio' && !isStdio) {
    throw new CliUsageError("Transport 'stdio' requires a stdio command.");
  }
  if ((transport === 'http' || transport === 'sse') && !isHttp) {
    throw new CliUsageError(`Transport '${transport}' requires a URL target.`);
  }
}

function looksLikeHttp(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}
