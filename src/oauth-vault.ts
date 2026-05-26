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

interface SameUrlCredentials {
  tokens?: OAuthTokens;
  clientInfo?: OAuthClientInformationMixed;
  sourceKeys: VaultKey[];
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
  const key = vaultKeyForDefinition(definition);
  const exact = isVaultEntry(vault.entries[key]) ? vault.entries[key] : undefined;
  const fallback = findSameUrlCredentials(vault, definition, key, exact);
  if (!fallback.tokens && !fallback.clientInfo) {
    return exact;
  }
  if (!exact) {
    return {
      serverName: definition.name,
      serverUrl: definition.command.kind === 'http' ? definition.command.url.toString() : undefined,
      updatedAt: new Date().toISOString(),
      tokens: fallback.tokens,
      clientInfo: fallback.clientInfo,
    };
  }
  return {
    ...exact,
    tokens: exact.tokens ?? fallback.tokens,
    clientInfo: exact.clientInfo ?? (exact.tokens ? undefined : fallback.clientInfo),
  };
}

function findSameUrlCredentials(
  vault: VaultFile,
  definition: ServerDefinition,
  exactKey: VaultKey,
  exact: VaultEntry | undefined
): SameUrlCredentials {
  if (definition.command.kind !== 'http') {
    return { sourceKeys: [] };
  }
  const serverUrl = definition.command.url.toString();
  const candidates = Object.entries(vault.entries)
    .filter(
      ([key, entry]) =>
        key !== exactKey &&
        isVaultEntry(entry) &&
        entry.serverUrl === serverUrl &&
        isLegacyOAuthRenameCandidate(definition, entry) &&
        (entry.tokens || entry.clientInfo)
    )
    .map(([key, entry]) => ({ key, entry }))
    .sort((a, b) => Date.parse(b.entry.updatedAt) - Date.parse(a.entry.updatedAt));
  const requiredClientId = definition.oauthClientId ?? clientIdFromEntry(exact);
  if (requiredClientId) {
    const tokenSource = candidates.find(
      ({ entry }) => (entry.tokens || entry.clientInfo) && clientIdFromEntry(entry) === requiredClientId
    );
    return {
      tokens: tokenSource?.entry.tokens,
      clientInfo: exact?.clientInfo ? undefined : tokenSource?.entry.clientInfo,
      sourceKeys: tokenSource ? [tokenSource.key] : [],
    };
  }

  const source = candidates.find(({ entry }) => entry.clientInfo && clientIdFromEntry(entry));
  return {
    tokens: source?.entry.tokens,
    clientInfo: source?.entry.clientInfo,
    sourceKeys: source ? [source.key] : [],
  };
}

function isLegacyOAuthRenameCandidate(definition: ServerDefinition, entry: VaultEntry): boolean {
  return entry.serverName === `${definition.name}-oauth`;
}

function legacyOAuthRenameKeys(vault: VaultFile, definition: ServerDefinition, exactKey: VaultKey): VaultKey[] {
  if (definition.command.kind !== 'http') {
    return [];
  }
  const serverUrl = definition.command.url.toString();
  return Object.entries(vault.entries)
    .filter(
      ([key, entry]) =>
        key !== exactKey &&
        isVaultEntry(entry) &&
        entry.serverUrl === serverUrl &&
        isLegacyOAuthRenameCandidate(definition, entry)
    )
    .map(([key]) => key);
}

function isVaultEntry(entry: unknown): entry is VaultEntry {
  return Boolean(
    entry &&
      typeof entry === 'object' &&
      typeof (entry as VaultEntry).serverName === 'string' &&
      typeof (entry as VaultEntry).updatedAt === 'string'
  );
}

function clientIdFromEntry(entry: VaultEntry | undefined): string | undefined {
  const clientId = entry?.clientInfo?.client_id;
  return typeof clientId === 'string' && clientId.length > 0 ? clientId : undefined;
}

export async function saveVaultEntry(definition: ServerDefinition, patch: Partial<VaultEntry>): Promise<void> {
  await withFileLock(getOAuthVaultPath(), async () => {
    const vault = await readVault();
    const key = vaultKeyForDefinition(definition);
    const existing = isVaultEntry(vault.entries[key]) ? vault.entries[key] : undefined;
    const fallback = findSameUrlCredentials(vault, definition, key, existing);
    const current = existing ?? {
      serverName: definition.name,
      serverUrl: definition.command.kind === 'http' ? definition.command.url.toString() : undefined,
      updatedAt: new Date().toISOString(),
    };
    vault.entries[key] = {
      ...current,
      ...patch,
      clientInfo: patch.clientInfo ?? current.clientInfo ?? (patch.tokens && !current.tokens ? fallback.clientInfo : undefined),
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
    const existing = isVaultEntry(vault.entries[key]) ? vault.entries[key] : undefined;
    const fallback = findSameUrlCredentials(vault, definition, key, existing);
    const inheritedKeys = scope === 'all' ? legacyOAuthRenameKeys(vault, definition, key) : fallback.sourceKeys;
    if (!existing && inheritedKeys.length === 0) {
      if (needsRepair) {
        await writeVault(vault);
      }
      return;
    }
    if (scope === 'all') {
      delete vault.entries[key];
    } else if (existing) {
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
    for (const fallbackKey of inheritedKeys) {
      const inherited = vault.entries[fallbackKey];
      if (!inherited) {
        continue;
      }
      if (scope === 'all') {
        delete vault.entries[fallbackKey];
        continue;
      }
      const updated: VaultEntry = { ...inherited };
      if (scope === 'tokens') {
        delete updated.tokens;
      }
      if (scope === 'client') {
        delete updated.clientInfo;
      }
      updated.updatedAt = new Date().toISOString();
      vault.entries[fallbackKey] = updated;
    }
    await writeVault(vault);
  });
}
