import fs from 'node:fs/promises';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/client';
import type { Runtime } from '../runtime.js';
import { clearVaultEntry, getOAuthVaultPath, saveVaultEntry } from '../oauth-vault.js';
import { CliUsageError } from './errors.js';

interface VaultPayload {
  readonly tokens: OAuthTokens;
  readonly clientInfo?: OAuthClientInformationMixed;
}

type VaultPayloadSource = { kind: 'file'; path: string } | { kind: 'stdin' };

export interface VaultCommandOptions {
  readonly readStdin?: () => Promise<string>;
}

export async function handleVault(
  runtime: Pick<Runtime, 'getDefinition'>,
  args: string[],
  options: VaultCommandOptions = {}
): Promise<void> {
  const subcommand = args.shift();
  if (subcommand === 'set') {
    await handleVaultSet(runtime, args, options);
    return;
  }
  if (subcommand === 'clear') {
    await handleVaultClear(runtime, args);
    return;
  }
  throw new CliUsageError('Usage: mcporter vault <set|clear> ...');
}

async function handleVaultSet(
  runtime: Pick<Runtime, 'getDefinition'>,
  args: string[],
  options: VaultCommandOptions
): Promise<void> {
  const server = args.shift();
  if (!server) {
    throw new CliUsageError('Usage: mcporter vault set <server> (--tokens-file <path> | --stdin)');
  }
  const source = consumeVaultPayloadSource(args);
  if (args.length > 0) {
    throw new CliUsageError(`Unknown vault set argument '${args[0]}'.`);
  }
  const definition = runtime.getDefinition(server);
  const payload = validateVaultPayload(parseVaultPayload(await readPayload(source, options), source));
  await saveVaultEntry(definition, {
    tokens: payload.tokens,
    ...(payload.clientInfo ? { clientInfo: payload.clientInfo } : {}),
  });
  console.log(`Saved OAuth credentials for '${definition.name}' to ${getOAuthVaultPath()}`);
}

async function handleVaultClear(runtime: Pick<Runtime, 'getDefinition'>, args: string[]): Promise<void> {
  const server = args.shift();
  if (!server) {
    throw new CliUsageError('Usage: mcporter vault clear <server>');
  }
  if (args.length > 0) {
    throw new CliUsageError(`Unknown vault clear argument '${args[0]}'.`);
  }
  const definition = runtime.getDefinition(server);
  await clearVaultEntry(definition, 'all');
  console.log(`Cleared OAuth vault entry for '${definition.name}'`);
}

function consumeVaultPayloadSource(args: string[]): VaultPayloadSource {
  const fileIndex = args.indexOf('--tokens-file');
  const stdinIndex = args.indexOf('--stdin');
  if (fileIndex !== -1 && stdinIndex !== -1) {
    throw new CliUsageError("Use either '--tokens-file' or '--stdin', not both.");
  }
  if (fileIndex !== -1) {
    const filePath = args[fileIndex + 1];
    if (!filePath) {
      throw new CliUsageError("Flag '--tokens-file' requires a path.");
    }
    args.splice(fileIndex, 2);
    return { kind: 'file', path: filePath };
  }
  if (stdinIndex !== -1) {
    args.splice(stdinIndex, 1);
    return { kind: 'stdin' };
  }
  throw new CliUsageError('Usage: mcporter vault set <server> (--tokens-file <path> | --stdin)');
}

async function readPayload(source: VaultPayloadSource, options: VaultCommandOptions): Promise<string> {
  if (source.kind === 'file') {
    return fs.readFile(source.path, 'utf8');
  }
  if (options.readStdin) {
    return options.readStdin();
  }
  return new Promise<string>((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function parseVaultPayload(raw: string, source: VaultPayloadSource): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // V8 parser diagnostics can quote a prefix of the credential input. Name
    // only the source so secrets and token fragments cannot reach logs.
    throw new CliUsageError(
      source.kind === 'file'
        ? `Vault payload file '${source.path}' is not valid JSON.`
        : 'Vault payload from stdin is not valid JSON.'
    );
  }
}

function validateVaultPayload(value: unknown): VaultPayload {
  if (!value || typeof value !== 'object') {
    throw new CliUsageError('Vault payload must be a JSON object.');
  }
  const record = value as Record<string, unknown>;
  if (!record.tokens || typeof record.tokens !== 'object' || Array.isArray(record.tokens)) {
    throw new CliUsageError("Vault payload must include a 'tokens' object.");
  }
  if (
    record.clientInfo !== undefined &&
    (!record.clientInfo || typeof record.clientInfo !== 'object' || Array.isArray(record.clientInfo))
  ) {
    throw new CliUsageError("Vault payload 'clientInfo' must be an object.");
  }
  validateOAuthTokens(record.tokens as Record<string, unknown>);
  if (record.clientInfo !== undefined) {
    validateOAuthClientInfo(record.clientInfo as Record<string, unknown>);
  }
  return {
    tokens: record.tokens as OAuthTokens,
    ...(record.clientInfo ? { clientInfo: record.clientInfo as OAuthClientInformationMixed } : {}),
  };
}

function validateOAuthTokens(tokens: Record<string, unknown>): void {
  if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
    throw new CliUsageError('Vault payload tokens.access_token must be a non-empty string.');
  }
  if (typeof tokens.token_type !== 'string' || tokens.token_type.length === 0) {
    throw new CliUsageError('Vault payload tokens.token_type must be a non-empty string.');
  }
  for (const key of ['refresh_token', 'scope', 'issuer'] as const) {
    if (tokens[key] !== undefined && typeof tokens[key] !== 'string') {
      throw new CliUsageError(`Vault payload tokens.${key} must be a string.`);
    }
  }
  // Keep the write boundary aligned with isStoredOAuthTokens: zero, negative,
  // and fractional values remain valid, but every accepted alias is finite.
  for (const key of ['expires_in', 'expires_at', 'expiresAt'] as const) {
    const value = tokens[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new CliUsageError(`Vault payload tokens.${key} must be a finite number.`);
    }
  }
}

const OAUTH_CLIENT_STRING_FIELDS = [
  'client_id',
  'client_secret',
  'token_endpoint_auth_method',
  'application_type',
  'client_name',
  'client_uri',
  'logo_uri',
  'scope',
  'tos_uri',
  'policy_uri',
  'jwks_uri',
  'software_id',
  'software_version',
  'software_statement',
  'issuer',
] as const;

const OAUTH_CLIENT_STRING_ARRAY_FIELDS = ['redirect_uris', 'grant_types', 'response_types', 'contacts'] as const;

const OAUTH_CLIENT_NUMBER_FIELDS = ['client_id_issued_at', 'client_secret_expires_at'] as const;

function validateOAuthClientInfo(clientInfo: Record<string, unknown>): void {
  for (const key of OAUTH_CLIENT_STRING_FIELDS) {
    if (clientInfo[key] !== undefined && clientInfo[key] !== null && typeof clientInfo[key] !== 'string') {
      throw new CliUsageError(`Vault payload clientInfo.${key} must be a string.`);
    }
  }
  for (const key of OAUTH_CLIENT_STRING_ARRAY_FIELDS) {
    const value = clientInfo[key];
    if (
      value !== undefined &&
      value !== null &&
      (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    ) {
      throw new CliUsageError(`Vault payload clientInfo.${key} must be an array of strings.`);
    }
  }
  for (const key of OAUTH_CLIENT_NUMBER_FIELDS) {
    const value = clientInfo[key];
    if (value !== undefined && value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new CliUsageError(`Vault payload clientInfo.${key} must be a finite number.`);
    }
  }
}

export function printVaultHelp(): void {
  const lines = [
    'Usage: mcporter vault <set|clear> ...',
    '',
    'Commands:',
    '  vault set <server> --tokens-file <path>   Seed OAuth tokens from JSON.',
    '  vault set <server> --stdin                Seed OAuth tokens from stdin JSON.',
    '  vault clear <server>                      Remove the server entry from the OAuth vault.',
    '',
    'Payload:',
    '  { "tokens": { "access_token": "...", "token_type": "Bearer" }, "clientInfo": { "client_id": "..." } }',
    '',
    '  clientInfo accepts a full dynamic client registration response, including the',
    '  redirect_uris, grant_types, response_types and contacts arrays, the',
    '  client_id_issued_at and client_secret_expires_at timestamps, and provider',
    '  metadata outside RFC 7591.',
  ];
  console.error(lines.join('\n'));
}
