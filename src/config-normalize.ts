import fs from 'node:fs';
import path from 'node:path';
import type { CommandSpec, RawEntry, ServerDefinition, ServerLoggingOptions, ServerSource } from './config-schema.js';
import { expandHome, resolveEnvPlaceholders } from './env.js';
import { resolveLifecycle } from './lifecycle.js';

export function normalizeServerEntry(
  name: string,
  raw: RawEntry,
  baseDir: string,
  source: ServerSource,
  sources: readonly ServerSource[]
): ServerDefinition {
  const entry = resolveEntryEnv(raw, name);
  const description = entry.description;
  const env = entry.env ? { ...entry.env } : undefined;
  const auth = normalizeAuth(entry.auth);
  const tokenCacheDir = normalizePath(entry.tokenCacheDir ?? entry.token_cache_dir);
  const clientName = entry.clientName ?? entry.client_name;
  const oauthClientId = entry.oauthClientId ?? entry.oauth_client_id ?? undefined;
  const oauthClientSecret = entry.oauthClientSecret ?? entry.oauth_client_secret ?? undefined;
  const oauthClientSecretEnv = entry.oauthClientSecretEnv ?? entry.oauth_client_secret_env ?? undefined;
  const oauthTokenEndpointAuthMethod =
    entry.oauthTokenEndpointAuthMethod ?? entry.oauth_token_endpoint_auth_method ?? undefined;
  const oauthRedirectUrl = entry.oauthRedirectUrl ?? entry.oauth_redirect_url ?? undefined;
  const oauthScope = entry.oauthScope ?? entry.oauth_scope ?? undefined;
  const oauthCommandRaw = entry.oauthCommand ?? entry.oauth_command;
  const oauthCommand = oauthCommandRaw ? { args: [...oauthCommandRaw.args] } : undefined;
  const headers = buildHeaders(entry);

  const httpUrl = getUrl(entry);
  const stdio = getCommand(entry, baseDir);

  let command: CommandSpec;

  if (httpUrl) {
    command = {
      kind: 'http',
      url: new URL(httpUrl),
      headers: ensureHttpAcceptHeader(headers),
    };
  } else if (stdio) {
    command = {
      kind: 'stdio',
      command: stdio.command,
      args: stdio.args,
      cwd: resolveCwd(entry.cwd, baseDir),
    };
  } else {
    throw new Error(`Server '${name}' is missing a baseUrl/url or command definition in mcporter.json`);
  }

  const lifecycle = resolveLifecycle(name, entry.lifecycle, command);
  const logging = normalizeLogging(entry.logging);
  const allowedTools = entry.allowedTools ?? entry.allowed_tools;
  const blockedTools = entry.blockedTools ?? entry.blocked_tools;

  const defaultedOauthCommand =
    !oauthCommand && name.toLowerCase() === 'gmail' && command.kind === 'stdio'
      ? { args: ['auth', 'http://localhost:3000/oauth2callback'] }
      : oauthCommand;

  return {
    name,
    description,
    command,
    env,
    auth,
    tokenCacheDir,
    clientName,
    oauthClientId,
    oauthClientSecret,
    oauthClientSecretEnv,
    oauthTokenEndpointAuthMethod,
    oauthRedirectUrl,
    oauthScope,
    oauthCommand: defaultedOauthCommand,
    source,
    sources,
    lifecycle,
    logging,
    ...(allowedTools !== undefined ? { allowedTools: [...allowedTools] } : {}),
    ...(blockedTools !== undefined ? { blockedTools: [...blockedTools] } : {}),
  };
}

export const __configInternals = {
  ensureHttpAcceptHeader,
};

function resolveEntryEnv(raw: RawEntry, serverName: string): RawEntry {
  return resolveConfigValue(raw, serverName, []) as RawEntry;
}

function resolveConfigValue(value: unknown, serverName: string, pathSegments: string[]): unknown {
  if (typeof value === 'string') {
    try {
      return resolveEnvPlaceholders(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const field = pathSegments.length > 0 ? pathSegments.join('.') : '<root>';
      throw new Error(`Failed to resolve config field '${field}' for server '${serverName}': ${message}`, {
        cause: error,
      });
    }
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => resolveConfigValue(item, serverName, [...pathSegments, String(index)]));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveConfigValue(item, serverName, [...pathSegments, key])])
    );
  }

  return value;
}

function normalizeAuth(auth: string | undefined): string | undefined {
  if (!auth) {
    return undefined;
  }
  if (auth.toLowerCase() === 'oauth') {
    return 'oauth';
  }
  return undefined;
}

function normalizePath(input: string | undefined): string | undefined {
  if (!input) {
    return undefined;
  }
  return expandHome(input);
}

function resolveCwd(input: string | undefined, baseDir: string): string {
  if (!input) {
    return baseDir;
  }
  return path.resolve(baseDir, expandHome(input));
}

function getUrl(raw: RawEntry): string | undefined {
  return raw.baseUrl ?? raw.base_url ?? raw.url ?? raw.serverUrl ?? raw.server_url ?? undefined;
}

function getCommand(raw: RawEntry, baseDir: string): { command: string; args: string[] } | undefined {
  const commandValue = raw.command ?? raw.executable;
  if (Array.isArray(commandValue)) {
    if (commandValue.length === 0 || typeof commandValue[0] !== 'string') {
      return undefined;
    }
    return { command: commandValue[0], args: commandValue.slice(1) };
  }
  if (typeof commandValue === 'string' && commandValue.length > 0) {
    const args = Array.isArray(raw.args) ? raw.args : [];
    if (args.length > 0) {
      return { command: commandValue, args };
    }
    if (isExistingCommandPath(commandValue, baseDir)) {
      return { command: commandValue, args: [] };
    }
    const tokens = parseCommandString(commandValue);
    if (tokens.length === 0) {
      return undefined;
    }
    const [commandToken, ...rest] = tokens;
    if (!commandToken) {
      return undefined;
    }
    return { command: commandToken, args: rest };
  }
  return undefined;
}

function isExistingCommandPath(value: string, baseDir: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.includes(' ')) {
    return false;
  }
  if (!looksLikePath(trimmed)) {
    return false;
  }
  const expanded = expandHome(trimmed);
  const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
  try {
    return fs.statSync(resolved).isFile();
  } catch {
    return false;
  }
}

function looksLikePath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || value.startsWith('~/');
}

function buildHeaders(raw: RawEntry): Record<string, string> | undefined {
  const headers: Record<string, string> = {};

  if (raw.headers) {
    Object.assign(headers, raw.headers);
  }

  const bearerToken = raw.bearerToken ?? raw.bearer_token;
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }

  const bearerTokenEnv = raw.bearerTokenEnv ?? raw.bearer_token_env;
  if (bearerTokenEnv) {
    headers.Authorization = `$env:${bearerTokenEnv}`;
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

function ensureHttpAcceptHeader(headers?: Record<string, string>): Record<string, string> | undefined {
  const requiredAccept = 'application/json, text/event-stream';
  const normalized = headers ? { ...headers } : {};
  const acceptKey = Object.keys(normalized).find((key) => key.toLowerCase() === 'accept');
  const currentValue = acceptKey ? normalized[acceptKey] : undefined;
  if (!currentValue || !hasRequiredAcceptTokens(currentValue)) {
    normalized[acceptKey ?? 'accept'] = requiredAccept;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function hasRequiredAcceptTokens(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes('application/json') && lower.includes('text/event-stream');
}

function parseCommandString(value: string): string[] {
  const result: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escapeNext = false;

  for (const char of value.trim()) {
    if (escapeNext) {
      current += char;
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char === ' ' && !inSingleQuote && !inDoubleQuote) {
      if (current.length > 0) {
        result.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escapeNext) {
    current += '\\';
  }

  if (current.length > 0) {
    result.push(current);
  }

  return result;
}

export { ensureHttpAcceptHeader };

function normalizeLogging(raw?: { daemon?: { enabled?: boolean } }): ServerLoggingOptions | undefined {
  if (!raw) {
    return undefined;
  }
  if (raw.daemon) {
    const logging: ServerLoggingOptions = { daemon: { enabled: raw.daemon.enabled } };
    return logging;
  }
  return undefined;
}
