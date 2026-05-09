import fs from 'node:fs/promises';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Runtime } from '../runtime.js';
import { clearVaultEntry, getOAuthVaultPath, saveVaultEntry } from '../oauth-vault.js';
import { CliUsageError } from './errors.js';

interface VaultPayload {
  readonly tokens: OAuthTokens;
  readonly clientInfo?: OAuthClientInformationMixed;
}

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
  const payload = validateVaultPayload(JSON.parse(await readPayload(source, options)));
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

function consumeVaultPayloadSource(args: string[]): { kind: 'file'; path: string } | { kind: 'stdin' } {
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

async function readPayload(
  source: { kind: 'file'; path: string } | { kind: 'stdin' },
  options: VaultCommandOptions
): Promise<string> {
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
  return {
    tokens: record.tokens as OAuthTokens,
    ...(record.clientInfo ? { clientInfo: record.clientInfo as OAuthClientInformationMixed } : {}),
  };
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
  ];
  console.error(lines.join('\n'));
}
