import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { ServerDefinition } from './config.js';
import { readJsonFile, writeJsonFile } from './fs-json.js';
import { mcporterDir } from './paths.js';

type VaultKey = string;

export interface VaultEntry {
  serverName: string;
  serverUrl?: string;
  tokens?: OAuthTokens;
  clientInfo?: OAuthClientInformationMixed;
  codeVerifier?: string;
  state?: string;
  updatedAt: string;
}

interface VaultFile {
  version: 1;
  entries: Record<VaultKey, VaultEntry>;
}

export function getOAuthVaultPath(): string {
  return path.join(mcporterDir('data'), 'credentials.json');
}

async function readVault(): Promise<VaultFile> {
  let shouldRewrite = false;
  try {
    const existing = await readJsonFile<VaultFile>(getOAuthVaultPath());
    if (existing && existing.version === 1 && existing.entries && typeof existing.entries === 'object') {
      return existing;
    }
    // Unexpected shape; rewrite.
    shouldRewrite = true;
  } catch {
    // Corrupt or unreadable vault; reset to empty.
    shouldRewrite = true;
  }
  const empty: VaultFile = { version: 1, entries: {} };
  if (shouldRewrite) {
    await writeVault(empty);
  }
  return empty;
}

async function writeVault(contents: VaultFile): Promise<void> {
  const filePath = getOAuthVaultPath();
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await writeJsonFile(filePath, contents);
}

export function vaultKeyForDefinition(definition: ServerDefinition): VaultKey {
  const descriptor = {
    name: definition.name,
    url: definition.command.kind === 'http' ? definition.command.url.toString() : null,
    command:
      definition.command.kind === 'stdio'
        ? { command: definition.command.command, args: definition.command.args ?? [] }
        : null,
  };
  const hash = crypto.createHash('sha256').update(JSON.stringify(descriptor)).digest('hex').slice(0, 16);
  return `${definition.name}|${hash}`;
}

export async function loadVaultEntry(definition: ServerDefinition): Promise<VaultEntry | undefined> {
  const vault = await readVault();
  return vault.entries[vaultKeyForDefinition(definition)];
}

export async function saveVaultEntry(definition: ServerDefinition, patch: Partial<VaultEntry>): Promise<void> {
  const vault = await readVault();
  const key = vaultKeyForDefinition(definition);
  const current = vault.entries[key] ?? {
    serverName: definition.name,
    serverUrl: definition.command.kind === 'http' ? definition.command.url.toString() : undefined,
    updatedAt: new Date().toISOString(),
  };
  vault.entries[key] = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await writeVault(vault);
}

export async function clearVaultEntry(
  definition: ServerDefinition,
  scope: 'all' | 'tokens' | 'client' | 'verifier' | 'state'
): Promise<void> {
  const vault = await readVault();
  const key = vaultKeyForDefinition(definition);
  const existing = vault.entries[key];
  if (!existing) {
    return;
  }
  if (scope === 'all') {
    delete vault.entries[key];
  } else {
    const updated: VaultEntry = { ...existing };
    if (scope === 'tokens') {
      delete updated.tokens;
    }
    if (scope === 'client') {
      delete updated.clientInfo;
    }
    if (scope === 'verifier') {
      delete updated.codeVerifier;
    }
    if (scope === 'state') {
      delete updated.state;
    }
    updated.updatedAt = new Date().toISOString();
    vault.entries[key] = updated;
  }
  await writeVault(vault);
}
