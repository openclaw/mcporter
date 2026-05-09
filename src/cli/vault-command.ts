import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { loadServerDefinitions, type LoadConfigOptions } from '../config.js';
import { buildOAuthPersistence, clearOAuthCaches } from '../oauth-persistence.js';
import { CliUsageError } from './errors.js';
import { resolveServerDefinition } from './config/shared.js';

type VaultSubcommand = 'set' | 'clear';

export interface VaultCliOptions {
  readonly loadOptions: LoadConfigOptions;
}

interface ParsedSetArgs {
  readonly server: string;
  readonly input: { kind: 'file'; path: string } | { kind: 'stdin' };
}

interface VaultSeedPayload {
  readonly tokens: OAuthTokens;
  readonly clientInfo?: OAuthClientInformationMixed;
}

export async function handleVaultCommand(options: VaultCliOptions, args: string[]): Promise<void> {
  const subcommand = args.shift() as VaultSubcommand | undefined;
  switch (subcommand) {
    case 'set':
      await handleVaultSet(options, args);
      return;
    case 'clear':
      await handleVaultClear(options, args);
      return;
    default:
      throw new CliUsageError("Usage: mcporter vault <set|clear>. Run 'mcporter vault --help'.");
  }
}

async function handleVaultSet(options: VaultCliOptions, args: string[]): Promise<void> {
  const parsed = parseSetArgs(args);
  const servers = await loadServerDefinitions(options.loadOptions);
  const target = resolveServerDefinition(parsed.server, servers);
  const payload = parseSeedPayload(await readPayload(parsed.input));
  const persistence = await buildOAuthPersistence(target);
  await persistence.saveTokens(payload.tokens);
  if (payload.clientInfo) {
    await persistence.saveClientInfo(payload.clientInfo);
  }
  console.log(`Seeded OAuth credentials for '${target.name}'.`);
}

async function handleVaultClear(options: VaultCliOptions, args: string[]): Promise<void> {
  const server = args.shift();
  if (!server || args.length > 0) {
    throw new CliUsageError('Usage: mcporter vault clear <server>');
  }
  const servers = await loadServerDefinitions(options.loadOptions);
  const target = resolveServerDefinition(server, servers);
  await clearOAuthCaches(target);
  console.log(`Cleared cached credentials for '${target.name}'.`);
}

function parseSetArgs(args: string[]): ParsedSetArgs {
  const server = args.shift();
  if (!server) {
    throw new CliUsageError('Usage: mcporter vault set <server> --tokens-file <path> | --stdin');
  }

  let input: ParsedSetArgs['input'] | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--tokens-file') {
      if (input) {
        throw new CliUsageError("Specify exactly one of '--tokens-file <path>' or '--stdin'.");
      }
      const filePath = args[index + 1];
      if (!filePath) {
        throw new CliUsageError("Flag '--tokens-file' requires a path.");
      }
      input = { kind: 'file', path: filePath };
      index += 1;
      continue;
    }
    if (token === '--stdin') {
      if (input) {
        throw new CliUsageError("Specify exactly one of '--tokens-file <path>' or '--stdin'.");
      }
      input = { kind: 'stdin' };
      continue;
    }
    if (token?.startsWith('--tokens-file=')) {
      if (input) {
        throw new CliUsageError("Specify exactly one of '--tokens-file <path>' or '--stdin'.");
      }
      const filePath = token.slice('--tokens-file='.length);
      if (!filePath) {
        throw new CliUsageError("Flag '--tokens-file' requires a path.");
      }
      input = { kind: 'file', path: filePath };
      continue;
    }
    throw new CliUsageError(`Unknown vault set flag '${token}'.`);
  }

  if (!input) {
    throw new CliUsageError('Usage: mcporter vault set <server> --tokens-file <path> | --stdin');
  }
  return { server, input };
}

async function readPayload(input: ParsedSetArgs['input']): Promise<string> {
  if (input.kind === 'stdin') {
    return fsSync.readFileSync(0, 'utf8');
  }
  return await fs.readFile(input.path, 'utf8');
}

function parseSeedPayload(raw: string): VaultSeedPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliUsageError('Invalid vault payload: expected JSON object.');
  }
  if (!isRecord(parsed)) {
    throw new CliUsageError('Invalid vault payload: expected JSON object.');
  }
  if (!('tokens' in parsed)) {
    throw new CliUsageError("Invalid vault payload: missing required 'tokens' object.");
  }

  const tokensResult = OAuthTokensSchema.safeParse(parsed.tokens);
  if (!tokensResult.success) {
    throw new CliUsageError("Invalid vault payload: 'tokens' must match mcporter OAuth token storage shape.");
  }

  const clientInfo = parsed.clientInfo;
  if (clientInfo === undefined) {
    return { tokens: tokensResult.data };
  }

  const fullClientResult = OAuthClientInformationFullSchema.safeParse(clientInfo);
  if (fullClientResult.success) {
    return { tokens: tokensResult.data, clientInfo: fullClientResult.data };
  }
  const clientResult = OAuthClientInformationSchema.safeParse(clientInfo);
  if (clientResult.success) {
    return { tokens: tokensResult.data, clientInfo: clientResult.data };
  }
  throw new CliUsageError("Invalid vault payload: 'clientInfo' must match mcporter OAuth client storage shape.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function printVaultHelp(): void {
  const lines = [
    'Usage: mcporter vault <command>',
    '',
    'Purpose:',
    '  Seed or clear OAuth credentials without launching a browser flow.',
    '',
    'Commands:',
    '  set <server> --tokens-file <path>  Seed credentials from a JSON file.',
    '  set <server> --stdin               Seed credentials from stdin.',
    '  clear <server>                     Clear cached credentials for a server.',
    '',
    'Payload:',
    '  { "tokens": { "access_token": "...", "token_type": "Bearer" }, "clientInfo": { "client_id": "..." } }',
    '',
    'Examples:',
    '  mcporter vault set linear --tokens-file ./linear-oauth.json',
    '  cat ./linear-oauth.json | mcporter vault set linear --stdin',
    '  mcporter vault clear linear',
  ];
  console.error(lines.join('\n'));
}

export const __vaultCommandInternals = {
  parseSetArgs,
  parseSeedPayload,
};
