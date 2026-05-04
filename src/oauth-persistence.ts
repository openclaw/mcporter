import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { ServerDefinition } from './config.js';
import { readJsonFile, writeJsonFile } from './fs-json.js';
import type { Logger } from './logging.js';
import { clearVaultEntry, getOAuthVaultPath, loadVaultEntry, saveVaultEntry } from './oauth-vault.js';
import { legacyMcporterDir } from './paths.js';

export type OAuthClearScope = 'all' | 'client' | 'tokens' | 'verifier' | 'state';

export interface OAuthPersistence {
  describe(): string;
  readTokens(): Promise<OAuthTokens | undefined>;
  saveTokens(tokens: OAuthTokens): Promise<void>;
  readClientInfo(): Promise<OAuthClientInformationMixed | undefined>;
  saveClientInfo(info: OAuthClientInformationMixed): Promise<void>;
  readCodeVerifier(): Promise<string | undefined>;
  saveCodeVerifier(value: string): Promise<void>;
  readState(): Promise<string | undefined>;
  saveState(value: string): Promise<void>;
  clear(scope: OAuthClearScope): Promise<void>;
}

class DirectoryPersistence implements OAuthPersistence {
  private readonly tokenPath: string;
  private readonly clientInfoPath: string;
  private readonly codeVerifierPath: string;
  private readonly statePath: string;

  constructor(
    private readonly root: string,
    private readonly logger?: Logger
  ) {
    this.tokenPath = path.join(root, 'tokens.json');
    this.clientInfoPath = path.join(root, 'client.json');
    this.codeVerifierPath = path.join(root, 'code_verifier.txt');
    this.statePath = path.join(root, 'state.txt');
  }

  describe(): string {
    return this.root;
  }

  private async ensureDir() {
    await fs.mkdir(this.root, { recursive: true });
  }

  async readTokens(): Promise<OAuthTokens | undefined> {
    return readJsonFile<OAuthTokens>(this.tokenPath);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.ensureDir();
    await writeJsonFile(this.tokenPath, tokens);
    this.logger?.debug?.(`Saved tokens to ${this.tokenPath}`);
  }

  async readClientInfo(): Promise<OAuthClientInformationMixed | undefined> {
    return readJsonFile<OAuthClientInformationMixed>(this.clientInfoPath);
  }

  async saveClientInfo(info: OAuthClientInformationMixed): Promise<void> {
    await this.ensureDir();
    await writeJsonFile(this.clientInfoPath, info);
  }

  async readCodeVerifier(): Promise<string | undefined> {
    try {
      return (await fs.readFile(this.codeVerifierPath, 'utf8')).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  async saveCodeVerifier(value: string): Promise<void> {
    await this.ensureDir();
    await fs.writeFile(this.codeVerifierPath, value, 'utf8');
  }

  async readState(): Promise<string | undefined> {
    return readJsonFile<string>(this.statePath);
  }

  async saveState(value: string): Promise<void> {
    await this.ensureDir();
    await writeJsonFile(this.statePath, value);
  }

  async clear(scope: OAuthClearScope): Promise<void> {
    const files: string[] = [];
    if (scope === 'all' || scope === 'tokens') {
      files.push(this.tokenPath);
    }
    if (scope === 'all' || scope === 'client') {
      files.push(this.clientInfoPath);
    }
    if (scope === 'all' || scope === 'verifier') {
      files.push(this.codeVerifierPath);
    }
    if (scope === 'all' || scope === 'state') {
      files.push(this.statePath);
    }
    await Promise.all(
      files.map(async (file) => {
        try {
          await fs.unlink(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
        }
      })
    );
  }
}

class VaultPersistence implements OAuthPersistence {
  constructor(private readonly definition: ServerDefinition) {}

  describe(): string {
    return `${getOAuthVaultPath()} (vault)`;
  }

  async readTokens(): Promise<OAuthTokens | undefined> {
    return (await loadVaultEntry(this.definition))?.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await saveVaultEntry(this.definition, { tokens });
  }

  async readClientInfo(): Promise<OAuthClientInformationMixed | undefined> {
    return (await loadVaultEntry(this.definition))?.clientInfo;
  }

  async saveClientInfo(info: OAuthClientInformationMixed): Promise<void> {
    await saveVaultEntry(this.definition, { clientInfo: info });
  }

  async readCodeVerifier(): Promise<string | undefined> {
    return (await loadVaultEntry(this.definition))?.codeVerifier;
  }

  async saveCodeVerifier(value: string): Promise<void> {
    await saveVaultEntry(this.definition, { codeVerifier: value });
  }

  async readState(): Promise<string | undefined> {
    return (await loadVaultEntry(this.definition))?.state;
  }

  async saveState(value: string): Promise<void> {
    await saveVaultEntry(this.definition, { state: value });
  }

  async clear(scope: OAuthClearScope): Promise<void> {
    await clearVaultEntry(this.definition, scope);
  }
}

class CompositePersistence implements OAuthPersistence {
  constructor(private readonly stores: OAuthPersistence[]) {}

  describe(): string {
    return this.stores.map((store) => store.describe()).join(' + ');
  }

  async readTokens(): Promise<OAuthTokens | undefined> {
    for (const store of this.stores) {
      const result = await store.readTokens();
      if (result) {
        return result;
      }
    }
    return undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await Promise.all(this.stores.map((store) => store.saveTokens(tokens)));
  }

  async readClientInfo(): Promise<OAuthClientInformationMixed | undefined> {
    for (const store of this.stores) {
      const result = await store.readClientInfo();
      if (result) {
        return result;
      }
    }
    return undefined;
  }

  async saveClientInfo(info: OAuthClientInformationMixed): Promise<void> {
    await Promise.all(this.stores.map((store) => store.saveClientInfo(info)));
  }

  async readCodeVerifier(): Promise<string | undefined> {
    for (const store of this.stores) {
      const result = await store.readCodeVerifier();
      if (result) {
        return result;
      }
    }
    return undefined;
  }

  async saveCodeVerifier(value: string): Promise<void> {
    await Promise.all(this.stores.map((store) => store.saveCodeVerifier(value)));
  }

  async readState(): Promise<string | undefined> {
    for (const store of this.stores) {
      const result = await store.readState();
      if (result) {
        return result;
      }
    }
    return undefined;
  }

  async saveState(value: string): Promise<void> {
    await Promise.all(this.stores.map((store) => store.saveState(value)));
  }

  async clear(scope: OAuthClearScope): Promise<void> {
    await Promise.all(this.stores.map((store) => store.clear(scope)));
  }
}

export async function buildOAuthPersistence(definition: ServerDefinition, logger?: Logger): Promise<OAuthPersistence> {
  const vault = new VaultPersistence(definition);
  const stores: OAuthPersistence[] = [vault];

  if (definition.tokenCacheDir) {
    stores.unshift(new DirectoryPersistence(definition.tokenCacheDir, logger));
  }

  // Migrate legacy default per-server cache (~/.mcporter/<name>) into the vault if present.
  const legacyDir = path.join(legacyMcporterDir(), definition.name);
  if (!definition.tokenCacheDir && legacyDir) {
    const legacy = new DirectoryPersistence(legacyDir, logger);
    const legacyTokens = await legacy.readTokens();
    const legacyClient = await legacy.readClientInfo();
    const legacyVerifier = await legacy.readCodeVerifier();
    const legacyState = await legacy.readState();
    if (legacyTokens || legacyClient || legacyVerifier || legacyState) {
      if (legacyTokens) {
        await vault.saveTokens(legacyTokens);
      }
      if (legacyClient) {
        await vault.saveClientInfo(legacyClient);
      }
      if (legacyVerifier) {
        await vault.saveCodeVerifier(legacyVerifier);
      }
      if (legacyState) {
        await vault.saveState(legacyState);
      }
      logger?.info?.(`Migrated legacy OAuth cache for '${definition.name}' into vault.`);
    }
  }

  return stores.length === 1 ? vault : new CompositePersistence(stores);
}

export async function clearOAuthCaches(
  definition: ServerDefinition,
  logger?: Logger,
  scope: OAuthClearScope = 'all'
): Promise<void> {
  const persistence = await buildOAuthPersistence(definition, logger);
  await persistence.clear(scope);

  const legacyDir = path.join(legacyMcporterDir(), definition.name);
  if (legacyDir && (!definition.tokenCacheDir || legacyDir !== definition.tokenCacheDir)) {
    const legacy = new DirectoryPersistence(legacyDir, logger);
    await legacy.clear(scope);
  }

  if (definition.tokenCacheDir) {
    await fs.rm(definition.tokenCacheDir, { recursive: true, force: true });
  }

  // Known provider-specific legacy paths (gmail server writes to ~/.gmail-mcp/credentials.json).
  const legacyFiles: string[] = [];
  if (definition.name.toLowerCase() === 'gmail') {
    legacyFiles.push(path.join(os.homedir(), '.gmail-mcp', 'credentials.json'));
  }
  await Promise.all(
    legacyFiles.map(async (file) => {
      try {
        await fs.unlink(file);
        logger?.info?.(`Cleared legacy OAuth cache file ${file}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    })
  );
}

export async function readCachedAccessToken(
  definition: ServerDefinition,
  logger?: Logger
): Promise<string | undefined> {
  const persistence = await buildOAuthPersistence(definition, logger);
  const tokens = await persistence.readTokens();
  if (tokens && typeof tokens.access_token === 'string' && tokens.access_token.trim().length > 0) {
    return tokens.access_token;
  }
  return undefined;
}
