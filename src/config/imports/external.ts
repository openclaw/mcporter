import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml } from '@iarna/toml';
import type { ImportKind, RawEntry } from '../../config-schema.js';
import { RawEntrySchema } from '../../config-schema.js';
import { normalizeProjectPath, pathsEqual } from './paths-utils.js';
import { fileExists, isRecord, parseJsonBuffer } from './shared.js';

interface ReadExternalEntryOptions {
  readonly projectRoot?: string;
  readonly importKind?: ImportKind;
}

export async function readExternalEntries(
  filePath: string,
  options: ReadExternalEntryOptions = {}
): Promise<Map<string, RawEntry> | null> {
  if (!(await fileExists(filePath))) {
    return null;
  }

  const buffer = await fs.readFile(filePath, 'utf8');
  if (!buffer.trim()) {
    return new Map<string, RawEntry>();
  }

  try {
    if (filePath.endsWith('.toml')) {
      const parsed = parseToml(buffer) as Record<string, unknown>;
      return extractFromCodexConfig(parsed);
    }

    const parsed = parseJsonBuffer(buffer);
    return extractFromMcpJson(parsed, options, filePath);
  } catch (error) {
    if (shouldIgnoreParseError(error)) {
      return new Map<string, RawEntry>();
    }
    throw error;
  }
}

function extractFromMcpJson(raw: unknown, options: ReadExternalEntryOptions, filePath?: string): Map<string, RawEntry> {
  const map = new Map<string, RawEntry>();
  if (!isRecord(raw)) {
    return map;
  }

  const { importKind, projectRoot } = options;
  const descriptor = resolveContainerDescriptor(importKind, filePath);

  const containers: Record<string, unknown>[] = [];
  if (descriptor.allowMcpServers && isRecord(raw.mcpServers)) {
    containers.push(raw.mcpServers);
  }
  if (descriptor.allowServers && isRecord(raw.servers)) {
    containers.push(raw.servers);
  }
  if (descriptor.allowMcp && isRecord(raw.mcp)) {
    containers.push(raw.mcp);
  }
  if (descriptor.allowRootFallback && containers.length === 0) {
    containers.push(raw);
  }

  for (const container of containers) {
    addEntriesFromContainer(container, map);
  }

  if (projectRoot) {
    const projectEntries = extractClaudeProjectEntries(raw, projectRoot);
    for (const [name, entry] of projectEntries) {
      if (!map.has(name)) {
        map.set(name, entry);
      }
    }
  }

  return map;
}

function extractFromCodexConfig(raw: Record<string, unknown>): Map<string, RawEntry> {
  const map = new Map<string, RawEntry>();
  const serversRaw = raw.mcp_servers;
  if (!serversRaw || typeof serversRaw !== 'object') {
    return map;
  }

  for (const [name, value] of Object.entries(serversRaw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    const entry = convertExternalEntry(value as Record<string, unknown>);
    if (entry) {
      map.set(name, entry);
    }
  }

  return map;
}

function convertExternalEntry(value: Record<string, unknown>): RawEntry | null {
  const result: Record<string, unknown> = {};

  if (typeof value.description === 'string') {
    result.description = value.description;
  }

  const env = asStringRecord(value.env);
  if (env) {
    result.env = env;
  }

  const headers = buildExternalHeaders(value);
  if (headers) {
    result.headers = headers;
  }

  const auth = asString(value.auth);
  if (auth) {
    result.auth = auth;
  }

  const tokenCacheDir = asString(value.tokenCacheDir ?? value.token_cache_dir ?? value.token_cacheDir);
  if (tokenCacheDir) {
    result.tokenCacheDir = tokenCacheDir;
  }

  const clientName = asString(value.clientName ?? value.client_name);
  if (clientName) {
    result.clientName = clientName;
  }

  const oauthClientId = asString(value.oauthClientId ?? value.oauth_client_id);
  if (oauthClientId) {
    result.oauthClientId = oauthClientId;
  }

  const oauthClientSecret = asString(value.oauthClientSecret ?? value.oauth_client_secret);
  if (oauthClientSecret) {
    result.oauthClientSecret = oauthClientSecret;
  }

  const oauthClientSecretEnv = asString(value.oauthClientSecretEnv ?? value.oauth_client_secret_env);
  if (oauthClientSecretEnv) {
    result.oauthClientSecretEnv = oauthClientSecretEnv;
  }

  const oauthTokenEndpointAuthMethod = asString(
    value.oauthTokenEndpointAuthMethod ?? value.oauth_token_endpoint_auth_method
  );
  if (oauthTokenEndpointAuthMethod) {
    result.oauthTokenEndpointAuthMethod = oauthTokenEndpointAuthMethod;
  }

  const httpFetch = asString(value.httpFetch ?? value.http_fetch);
  if (httpFetch) {
    result.httpFetch = httpFetch;
  }

  const url = asString(value.baseUrl ?? value.base_url ?? value.url ?? value.serverUrl ?? value.server_url);
  if (url) {
    result.baseUrl = url;
  }

  const commandValue = value.command ?? value.executable;
  if (Array.isArray(commandValue) && commandValue.every((item) => typeof item === 'string')) {
    result.command = commandValue;
  } else if (typeof commandValue === 'string') {
    result.command = commandValue;
  }

  if (Array.isArray(value.args) && value.args.every((item) => typeof item === 'string')) {
    result.args = value.args;
  }

  const hasHttpTarget = typeof result.baseUrl === 'string';
  const hasCommandTarget =
    typeof result.command === 'string' || (Array.isArray(result.command) && result.command.length > 0);
  if (!hasHttpTarget && !hasCommandTarget) {
    return null;
  }

  const parsed = RawEntrySchema.safeParse(result);
  return parsed.success ? parsed.data : null;
}

function buildExternalHeaders(record: Record<string, unknown>): Record<string, string> | undefined {
  const headers: Record<string, string> = {};

  const literalHeaders = asStringRecord(record.headers);
  if (literalHeaders) {
    Object.assign(headers, literalHeaders);
  }

  const bearerToken = asString(record.bearerToken ?? record.bearer_token);
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }

  const bearerTokenEnv = asString(record.bearerTokenEnv ?? record.bearer_token_env);
  if (bearerTokenEnv) {
    headers.Authorization = `$env:${bearerTokenEnv}`;
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

function extractClaudeProjectEntries(raw: Record<string, unknown>, projectRoot: string): Map<string, RawEntry> {
  const map = new Map<string, RawEntry>();
  if (!isRecord(raw.projects)) {
    return map;
  }
  const projects = raw.projects as Record<string, unknown>;
  const targetPath = normalizeProjectPath(projectRoot);
  for (const [projectKey, value] of Object.entries(projects)) {
    if (!isRecord(value) || !isRecord(value.mcpServers)) {
      continue;
    }
    const normalizedKey = normalizeProjectPath(projectKey);
    if (!pathsEqual(normalizedKey, targetPath)) {
      continue;
    }
    addEntriesFromContainer(value.mcpServers as Record<string, unknown>, map);
  }
  return map;
}

function addEntriesFromContainer(container: Record<string, unknown>, target: Map<string, RawEntry>): void {
  for (const [name, value] of Object.entries(container)) {
    if (!isRecord(value)) {
      continue;
    }
    if (target.has(name)) {
      continue;
    }
    const entry = convertExternalEntry(value);
    if (entry) {
      target.set(name, entry);
    }
  }
}

function resolveContainerDescriptor(
  importKind: ImportKind | undefined,
  filePath?: string
): {
  allowMcpServers: boolean;
  allowServers: boolean;
  allowMcp: boolean;
  allowRootFallback: boolean;
} {
  if (importKind === 'opencode') {
    return {
      allowMcpServers: false,
      allowServers: false,
      allowMcp: true,
      allowRootFallback: false,
    };
  }

  // For claude-code, only allow root fallback for legacy root-style files (.claude.json, .claude/mcp.json).
  // Settings files like .claude/settings.json require proper mcpServers/servers/mcp containers.
  if (importKind === 'claude-code' && filePath) {
    const normalized = path.normalize(filePath);
    const allowRootFallback =
      normalized.endsWith('.claude.json') || normalized.endsWith(`${path.sep}.claude${path.sep}mcp.json`);
    return {
      allowMcpServers: true,
      allowServers: true,
      allowMcp: true,
      allowRootFallback,
    };
  }

  return {
    allowMcpServers: true,
    allowServers: true,
    allowMcp: true,
    allowRootFallback: true,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asStringRecord(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === 'string') {
      record[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      record[key] = String(value);
    }
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

function shouldIgnoreParseError(error: unknown): boolean {
  if (error instanceof SyntaxError) {
    return true;
  }
  if (!error || typeof error !== 'object') {
    return false;
  }
  return 'fromTOML' in error;
}
