import crypto from 'node:crypto';
import path from 'node:path';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { ServerDefinition } from './config.js';
import { readJsonFile, withFileLock, writeJsonFile } from './fs-json.js';
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

interface VaultReadState {
  vault: VaultFile;
  needsRepair: boolean;
}

export function getOAuthVaultPath(): string {
  return path.join(mcporterDir('data'), 'credentials.json');
}

async function readVaultState(): Promise<VaultReadState> {
  try {
    const existing = await readJsonFile<VaultFile>(getOAuthVaultPath());
    if (existing && existing.version === 1 && existing.entries && typeof existing.entries === 'object') {
      return { vault: existing, needsRepair: false };
    }
    if (existing !== undefined) {
      return { vault: emptyVault(), needsRepair: true };
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    return { vault: emptyVault(), needsRepair: true };
  }
  return { vault: emptyVault(), needsRepair: false };
}

async function readVault(): Promise<VaultFile> {
  return (await readVaultState()).vault;
}

function emptyVault(): VaultFile {
  return { version: 1, entries: {} };
}

async function writeVault(contents: VaultFile): Promise<void> {
  await writeJsonFile(getOAuthVaultPath(), contents);
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
  await withFileLock(getOAuthVaultPath(), async () => {
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
  });
}

export async function clearVaultEntry(
  definition: ServerDefinition,
  scope: 'all' | 'tokens' | 'client' | 'verifier' | 'state'
): Promise<void> {
  const key = vaultKeyForDefinition(definition);
  await withFileLock(getOAuthVaultPath(), async () => {
    const { vault, needsRepair } = await readVaultState();
    const existing = vault.entries[key];
    if (!existing) {
      if (needsRepair) {
        await writeVault(vault);
      }
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
  });
}
