import type { CommandSpec, RawEntry, ServerDefinition, ServerLoggingOptions, ServerSource } from './config-schema.js';
import { expandHome } from './env.js';
import { resolveLifecycle } from './lifecycle.js';

export function normalizeServerEntry(
  name: string,
  raw: RawEntry,
  baseDir: string,
  source: ServerSource,
  sources: readonly ServerSource[],
): ServerDefinition {
  const description = raw.description;
  const env = raw.env ? { ...raw.env } : undefined;
  const auth = normalizeAuth(raw.auth);
  const tokenCacheDir = normalizePath(raw.tokenCacheDir ?? raw.token_cache_dir);
  const clientName = raw.clientName ?? raw.client_name;
  const oauthRedirectUrl = raw.oauthRedirectUrl ?? raw.oauth_redirect_url ?? undefined;
  const oauthScope = raw.oauthScope ?? raw.oauth_scope ?? undefined;
  const oauthCommandRaw = raw.oauthCommand ?? raw.oauth_command;
  const oauthCommand = oauthCommandRaw ? { args: [...oauthCommandRaw.args] } : undefined;
  const headers = buildHeaders(
    raw.bearerToken,
    raw.bearer_token,
    raw.bearerTokenEnv,
    raw.bearer_token_env,
    raw.headers,
  );

  const httpUrl = getUrl(raw);
  const stdio = getCommand(raw.command, raw.executable, raw.args);

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
      cwd: baseDir,
    };
  } else {
    throw new Error(`Server '${name}' is missing a baseUrl/url or command definition in mcporter.json`);
  }

  const lifecycle = resolveLifecycle(name, raw.lifecycle, command);
  const logging = normalizeLogging(raw.logging);

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
    oauthRedirectUrl,
    oauthScope,
    oauthCommand: defaultedOauthCommand,
    source,
    sources,
    lifecycle,
    logging,
  };
}

export const __configInternals = {
  ensureHttpAcceptHeader,
};

export function normalizeAuth(auth: string | undefined): string | undefined {
  if (!auth) {
    return undefined;
  }
  if (auth.toLowerCase() === 'oauth') {
    return 'oauth';
  }
  return undefined;
}

export function normalizePath(input: string | undefined): string | undefined {
  if (!input) {
    return undefined;
  }
  return expandHome(input);
}

export function getUrl(rawUrls: RawEntry): string | undefined {
  return rawUrls.baseUrl ?? rawUrls.base_url ?? rawUrls.url ?? rawUrls.serverUrl ?? rawUrls.server_url ?? undefined;
}

export function getCommand(
  command: RawEntry['command'],
  executable: RawEntry['executable'],
  args: RawEntry['args'] = [],
): { command: string; args: string[] } | undefined {
  const commandValue = command ?? executable;
  if (Array.isArray(commandValue)) {
    if (commandValue.length === 0 || typeof commandValue[0] !== 'string') {
      return undefined;
    }

    return { command: commandValue[0], args: commandValue.slice(1) };
  }

  if (typeof commandValue === 'string' && commandValue.length > 0) {
    if (args.length > 0) {
      return { command: commandValue, args };
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

export function buildHeaders(
  bearerToken?: string,
  bearer_token?: string,
  bearerTokenEnv?: string,
  bearer_token_env?: string,
  customHeaders?: Record<string, string>,
): Record<string, string> | undefined {
  const httpHeaders: Record<string, string> = {};

  if (customHeaders) {
    Object.assign(httpHeaders, customHeaders);
  }

  const token = bearerToken ?? bearer_token;
  if (token) {
    httpHeaders.Authorization = `Bearer ${token}`;
  }

  const tokenEnv = bearerTokenEnv ?? bearer_token_env;
  if (tokenEnv) {
    httpHeaders.Authorization = `$env:${tokenEnv}`;
  }

  return Object.keys(httpHeaders).length > 0 ? httpHeaders : undefined;
}

export function ensureHttpAcceptHeader(headers?: Record<string, string>): Record<string, string> | undefined {
  const requiredAccept = 'application/json, text/event-stream';
  const normalized = headers ? { ...headers } : {};
  const acceptKey = Object.keys(normalized).find((key) => key.toLowerCase() === 'accept');
  const currentValue = acceptKey ? normalized[acceptKey] : undefined;
  if (!currentValue || !hasRequiredAcceptTokens(currentValue)) {
    normalized[acceptKey ?? 'accept'] = requiredAccept;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function hasRequiredAcceptTokens(acceptTokens: string): boolean {
  const lower = acceptTokens.toLowerCase();
  return lower.includes('application/json') && lower.includes('text/event-stream');
}

export function parseCommandString(commandString: string): string[] {
  const result: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escapeNext = false;

  for (const char of commandString.trim()) {
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

export function normalizeLogging(logginValue?: { daemon?: { enabled?: boolean } }): ServerLoggingOptions | undefined {
  if (!logginValue) {
    return undefined;
  }

  if (logginValue.daemon) {
    const logging: ServerLoggingOptions = { daemon: { enabled: logginValue.daemon.enabled } };
    return logging;
  }

  return undefined;
}
