import fs from 'node:fs/promises';
import path from 'node:path';
import type { CliArtifactMetadata } from '../../cli-metadata.js';
import { type HttpCommand, loadServerDefinitions, type ServerDefinition, type StdioCommand } from '../../config.js';
import type { Runtime, ServerToolInfo } from '../../runtime.js';
import { createRuntime } from '../../runtime.js';
import { extractHttpServerTarget, normalizeHttpUrl } from '../http-utils.js';

export interface ResolvedServer {
  definition: ServerDefinition;
  name: string;
}

type DefinitionInput =
  | ServerDefinition
  | (Record<string, unknown> & {
      name: string;
      command?: unknown;
      args?: unknown;
    });

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function ensureInvocationDefaults(
  invocation: CliArtifactMetadata['invocation'],
  definition: ServerDefinition
): CliArtifactMetadata['invocation'] {
  const serverRef = invocation.serverRef ?? definition.name;
  const configPath =
    invocation.configPath ??
    (definition.source && definition.source.kind === 'local' ? definition.source.path : undefined);
  return {
    ...invocation,
    serverRef,
    configPath,
  };
}

export async function resolveServerDefinition(
  serverRef: string,
  configPath?: string,
  rootDir?: string
): Promise<ResolvedServer> {
  const trimmed = serverRef.trim();

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    // Allow callers to inline a JSON server definition (used by tests + CLI).
    const parsed = JSON.parse(trimmed) as ServerDefinition & { name: string };
    if (!parsed.name) {
      throw new Error("Inline server definition must include a 'name' field.");
    }
    return { definition: normalizeDefinition(parsed), name: parsed.name };
  }

  const possiblePath = path.resolve(trimmed);
  try {
    const buffer = await fs.readFile(possiblePath, 'utf8');
    const parsed = JSON.parse(buffer) as {
      mcpServers?: Record<string, unknown>;
    };
    if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
      throw new Error(`Config file ${possiblePath} does not contain mcpServers.`);
    }
    const entries = Object.entries(parsed.mcpServers);
    if (entries.length === 0) {
      throw new Error(`Config file ${possiblePath} does not define any servers.`);
    }
    const first = entries[0];
    if (!first) {
      throw new Error(`Config file ${possiblePath} does not define any servers.`);
    }
    const [name, value] = first;
    return {
      definition: normalizeDefinition({
        name,
        ...(value as Record<string, unknown>),
      }),
      name,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const definitions = await loadServerDefinitions({
    configPath,
    rootDir,
  });
  const matchByName = definitions.find((def) => def.name === trimmed);
  if (matchByName) {
    return { definition: matchByName, name: matchByName.name };
  }

  const httpTarget = extractHttpServerTarget(trimmed);
  if (httpTarget) {
    const normalizedTarget = normalizeHttpUrl(httpTarget);
    if (normalizedTarget) {
      const matchByUrl = definitions.find((def) => {
        if (def.command.kind !== 'http') {
          return false;
        }
        const normalizedDefinitionUrl = normalizeHttpUrl(def.command.url);
        return normalizedDefinitionUrl === normalizedTarget;
      });
      if (matchByUrl) {
        return { definition: matchByUrl, name: matchByUrl.name };
      }
    }
  }

  throw new Error(
    `Unknown MCP server '${trimmed}'. Provide a name from config, a JSON file, inline JSON, or an HTTP URL that matches a configured server.`
  );
}

export async function fetchTools(
  definition: ServerDefinition,
  serverName: string,
  configPath?: string,
  rootDir?: string
): Promise<{ tools: ServerToolInfo[]; derivedDescription?: string }> {
  // Reuse the runtime helper so bundle builds and CLI generation share the same discovery path.
  const runtime = await createRuntime({
    configPath,
    rootDir,
    servers: configPath ? undefined : [definition],
  });
  try {
    const tools = await runtime.listTools(serverName, { includeSchema: true });
    const derivedDescription = definition.description
      ? undefined
      : await deriveDefinitionDescription(runtime, serverName);
    return { tools, derivedDescription };
  } finally {
    await runtime.close(serverName).catch(() => {});
  }
}

async function deriveDefinitionDescription(runtime: Runtime, serverName: string): Promise<string | undefined> {
  try {
    const context = await runtime.connect(serverName);
    const instructions =
      typeof context.client.getInstructions === 'function' ? context.client.getInstructions() : undefined;
    const serverInfo =
      typeof context.client.getServerVersion === 'function' ? context.client.getServerVersion() : undefined;
    const derived = pickDescription(instructions, serverInfo);
    return derived;
  } catch {
    // Ignore metadata lookup failures; fallback description will be used instead.
    return undefined;
  }
}

function pickDescription(
  instructions: unknown,
  serverInfo: { title?: unknown; name?: unknown } | undefined
): string | undefined {
  const ordered = [instructions, serverInfo?.title, serverInfo?.name];
  for (const candidate of ordered) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return undefined;
}

export function normalizeDefinition(def: DefinitionInput): ServerDefinition {
  if (isServerDefinition(def)) {
    return def;
  }

  const name = def.name;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('Server definition must include a name.');
  }

  const description = typeof def.description === 'string' ? def.description : undefined;
  const env = toStringRecord(def.env);
  const auth = typeof def.auth === 'string' ? def.auth : undefined;
  const tokenCacheDir = typeof def.tokenCacheDir === 'string' ? def.tokenCacheDir : undefined;
  const clientName = typeof def.clientName === 'string' ? def.clientName : undefined;
  const headers = toStringRecord((def as Record<string, unknown>).headers);
  const record = def as Record<string, unknown>;
  const allowedTools = getOptionalStringArray(record.allowedTools ?? record.allowed_tools, 'allowedTools');
  const blockedTools = getOptionalStringArray(record.blockedTools ?? record.blocked_tools, 'blockedTools');
  if (allowedTools !== undefined && blockedTools !== undefined) {
    throw new Error(`Server definition '${name}' cannot specify both allowedTools and blockedTools.`);
  }
  const filters = {
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(blockedTools !== undefined ? { blockedTools } : {}),
  };

  const commandValue = def.command;
  if (isCommandSpec(commandValue)) {
    return {
      name,
      description,
      command: normalizeCommand(commandValue, headers),
      env,
      auth,
      tokenCacheDir,
      clientName,
      ...filters,
    };
  }
  if (typeof commandValue === 'string' && commandValue.trim().length > 0) {
    return {
      name,
      description,
      command: toCommandSpec(commandValue, getStringArray(def.args), headers ? { headers } : undefined),
      env,
      auth,
      tokenCacheDir,
      clientName,
      ...filters,
    };
  }
  if (Array.isArray(commandValue) && commandValue.length > 0) {
    const [first, ...rest] = commandValue;
    if (typeof first !== 'string' || !rest.every((entry) => typeof entry === 'string')) {
      throw new Error('Command array must contain only strings.');
    }
    return {
      name,
      description,
      command: toCommandSpec(first, rest as string[], headers ? { headers } : undefined),
      env,
      auth,
      tokenCacheDir,
      clientName,
      ...filters,
    };
  }
  throw new Error('Server definition must include command information.');
}

function isServerDefinition(value: unknown): value is ServerDefinition {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== 'string') {
    return false;
  }
  return isCommandSpec(record.command);
}

function isCommandSpec(value: unknown): value is ServerDefinition['command'] {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { kind?: unknown };
  if (candidate.kind === 'http') {
    return 'url' in candidate;
  }
  if (candidate.kind === 'stdio') {
    return 'command' in candidate;
  }
  return false;
}

function normalizeCommand(
  command: ServerDefinition['command'],
  headers?: Record<string, string>
): ServerDefinition['command'] {
  if (command.kind === 'http') {
    const urlValue = command.url;
    const url = urlValue instanceof URL ? urlValue : new URL(String(urlValue));
    const mergedHeaders = command.headers ? (headers ? { ...command.headers, ...headers } : command.headers) : headers;
    const normalized: HttpCommand = {
      kind: 'http',
      url,
      ...(mergedHeaders ? { headers: mergedHeaders } : {}),
    };
    return normalized;
  }
  return {
    kind: 'stdio',
    command: command.command,
    args: [...command.args],
    cwd: command.cwd ?? process.cwd(),
  };
}

function toCommandSpec(
  command: string,
  args?: string[],
  extra?: { headers?: Record<string, string> }
): ServerDefinition['command'] {
  if (command.startsWith('http://') || command.startsWith('https://')) {
    const httpCommand: HttpCommand = {
      kind: 'http',
      url: new URL(command),
      ...(extra?.headers ? { headers: extra.headers } : {}),
    };
    return httpCommand;
  }
  const stdio: StdioCommand = {
    kind: 'stdio',
    command,
    args: args ?? [],
    cwd: '',
  };
  return stdio;
}

function getStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value.filter((item): item is string => typeof item === 'string');
  return entries.length > 0 ? entries : undefined;
}

function getOptionalStringArray(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${fieldName} must be an array of strings.`);
  }
  return [...value];
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      result[key] = entry;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
