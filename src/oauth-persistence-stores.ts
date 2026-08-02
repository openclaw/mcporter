import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/client';
import type { ServerDefinition } from './config.js';
import { readJsonFile, withFileLock, writeJsonFile, writeTextFileAtomic } from './fs-json.js';
import type { Logger } from './logging.js';
import type { OAuthClearScope, OAuthPersistence, OAuthPersistenceSnapshot } from './oauth-persistence.js';
import {
  sameOAuthClientGeneration,
  sameOAuthClientValue,
  sameOAuthTokenGeneration,
  sameOAuthTokenValue,
  withHiddenOAuthClientGeneration,
  withHiddenOAuthTokenGeneration,
  withOAuthClientGeneration,
  withOAuthTokenGeneration,
} from './oauth-token-generation.js';
import {
  clearVaultEntry,
  clearVaultTokensIfMatching,
  getOAuthVaultPath,
  loadVaultEntryForRecovery,
  reconcileVaultServerUrl,
  saveVaultEntry,
} from './oauth-vault.js';
import { legacyMcporterDir } from './paths.js';

type StoredOAuthTokens = OAuthTokens & {
  expires_at?: number;
  expiresAt?: number;
};

function withStoredExpiry(tokens: OAuthTokens): OAuthTokens {
  const stored = tokens as StoredOAuthTokens;
  if (typeof stored.expires_at === 'number' || typeof stored.expiresAt === 'number') {
    return tokens;
  }
  if (typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in)) {
    return {
      ...tokens,
      expires_at: Math.floor(Date.now() / 1000) + tokens.expires_in,
    } as OAuthTokens;
  }
  return tokens;
}

function prepareStoredTokens(tokens: OAuthTokens): OAuthTokens {
  return withStoredExpiry(withOAuthTokenGeneration(tokens));
}

export class DirectoryPersistence implements OAuthPersistence {
  private readonly tokenPath: string;
  private readonly clientInfoPath: string;
  private readonly codeVerifierPath: string;
  private readonly statePath: string;
  private readonly serverUrlPath: string;

  constructor(
    private readonly root: string,
    private readonly logger?: Logger,
    private readonly serverUrl?: string,
    private readonly skipUrlMarkerWhenMissing = false
  ) {
    this.tokenPath = path.join(root, 'tokens.json');
    this.clientInfoPath = path.join(root, 'client.json');
    this.codeVerifierPath = path.join(root, 'code_verifier.txt');
    this.statePath = path.join(root, 'state.txt');
    this.serverUrlPath = path.join(root, 'server_url.txt');
  }

  describe(): string {
    return this.root;
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  private async reconcileServerUrl(): Promise<void> {
    if (!this.serverUrl) {
      return;
    }
    const serverUrl = this.serverUrl;
    if (this.skipUrlMarkerWhenMissing) {
      try {
        await fs.access(this.root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return;
        }
        throw error;
      }
    }
    await this.ensureDir();
    await withFileLock(this.tokenPath, async () => {
      let previousUrl: string | undefined;
      try {
        previousUrl = (await fs.readFile(this.serverUrlPath, 'utf8')).trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
      if (previousUrl === serverUrl) {
        return;
      }
      // Keep the marker after invalidation so A -> B -> A cannot revive A's
      // old directory-backed credentials.
      if (previousUrl !== undefined) {
        await this.clearFiles('all');
      }
      await writeTextFileAtomic(this.serverUrlPath, serverUrl);
    });
  }

  async readSnapshot(): Promise<OAuthPersistenceSnapshot> {
    await this.reconcileServerUrl();
    const [tokens, clientInfo, codeVerifier, state] = await Promise.all([
      this.readTokensAfterReconcile(),
      this.readClientInfoAfterReconcile(),
      this.readCodeVerifierAfterReconcile(),
      this.readStateAfterReconcile(),
    ]);
    return { tokens, clientInfo, codeVerifier, state };
  }

  async readTokens(): Promise<OAuthTokens | undefined> {
    await this.reconcileServerUrl();
    return await this.readTokensAfterReconcile();
  }

  private async readTokensAfterReconcile(): Promise<OAuthTokens | undefined> {
    const tokens = await this.readJsonOrUndefined<OAuthTokens>(this.tokenPath);
    return tokens ? withHiddenOAuthTokenGeneration(tokens) : undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.reconcileServerUrl();
    await this.ensureDir();
    // Locked so clearRejectedCredentials cannot compare-then-unlink across a
    // concurrent write.
    await withFileLock(this.tokenPath, async () => {
      await writeJsonFile(this.tokenPath, prepareStoredTokens(tokens));
    });
    this.logger?.debug?.(`Saved tokens to ${this.tokenPath}`);
  }

  async clearRejectedCredentials(
    expectedTokens?: OAuthTokens,
    expectedClientInfo?: OAuthClientInformationMixed
  ): Promise<void> {
    await this.reconcileServerUrl();
    await withFileLock(this.tokenPath, async () => {
      if (expectedTokens) {
        const current = await this.readJsonOrUndefined<OAuthTokens>(this.tokenPath);
        if (sameOAuthTokenGeneration(current, expectedTokens)) {
          await this.unlinkIfPresent(this.tokenPath);
        }
      }
      if (expectedClientInfo) {
        const currentClientInfo = await this.readJsonOrUndefined<OAuthClientInformationMixed>(this.clientInfoPath);
        if (sameOAuthClientGeneration(currentClientInfo, expectedClientInfo)) {
          await this.unlinkIfPresent(this.clientInfoPath);
        }
      }
    });
  }

  private async unlinkIfPresent(file: string): Promise<void> {
    try {
      await fs.unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async readClientInfo(): Promise<OAuthClientInformationMixed | undefined> {
    await this.reconcileServerUrl();
    return await this.readClientInfoAfterReconcile();
  }

  private async readClientInfoAfterReconcile(): Promise<OAuthClientInformationMixed | undefined> {
    const info = await this.readJsonOrUndefined<OAuthClientInformationMixed>(this.clientInfoPath);
    return info ? withHiddenOAuthClientGeneration(info) : undefined;
  }

  async saveClientInfo(info: OAuthClientInformationMixed): Promise<void> {
    await this.reconcileServerUrl();
    await this.ensureDir();
    await withFileLock(this.tokenPath, async () => {
      await writeJsonFile(this.clientInfoPath, withOAuthClientGeneration(info));
    });
  }

  async readCodeVerifier(): Promise<string | undefined> {
    await this.reconcileServerUrl();
    return await this.readCodeVerifierAfterReconcile();
  }

  private async readCodeVerifierAfterReconcile(): Promise<string | undefined> {
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
    await this.reconcileServerUrl();
    await this.ensureDir();
    await writeTextFileAtomic(this.codeVerifierPath, value);
  }

  async readState(): Promise<string | undefined> {
    await this.reconcileServerUrl();
    return await this.readStateAfterReconcile();
  }

  private async readStateAfterReconcile(): Promise<string | undefined> {
    // Deliberately NOT corrupt-tolerant: a corrupt OAuth state must fail the
    // flow closed. Returning undefined here would skip the CSRF state check on
    // the authorization callback (see oauth.ts), so only the credential caches
    // (tokens/client) degrade to re-auth.
    return readJsonFile<string>(this.statePath);
  }

  // A present-but-corrupt credential cache (tokens/client) means "no usable
  // credentials": degrade to re-auth instead of crashing the connection,
  // mirroring VaultPersistence and the daemon/server-proxy readers. Genuine I/O
  // faults still propagate (readJsonFile re-throws everything except ENOENT).
  // OAuth state is intentionally excluded so its CSRF check still fails closed.
  private async readJsonOrUndefined<T>(filePath: string): Promise<T | undefined> {
    try {
      return await readJsonFile<T>(filePath);
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      this.logger?.debug?.(`Ignoring corrupt OAuth cache file ${filePath}: ${error.message}`);
      return undefined;
    }
  }

  async saveState(value: string): Promise<void> {
    await this.reconcileServerUrl();
    await this.ensureDir();
    await writeJsonFile(this.statePath, value);
  }

  async clear(scope: OAuthClearScope): Promise<void> {
    await this.reconcileServerUrl();
    await this.clearFiles(scope);
  }

  private async clearFiles(scope: OAuthClearScope): Promise<void> {
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
    await Promise.all(files.map((file) => this.unlinkIfPresent(file)));
  }
}

export class VaultPersistence implements OAuthPersistence {
  private tokenSnapshots: ReadonlyMap<string, OAuthTokens> | undefined;
  private clientSnapshots: ReadonlyMap<string, OAuthClientInformationMixed> | undefined;

  constructor(private readonly definition: ServerDefinition) {}

  describe(): string {
    return `${getOAuthVaultPath()} (vault)`;
  }

  private async reconcileServerUrl(): Promise<void> {
    await reconcileVaultServerUrl(this.definition);
  }

  async readSnapshot(): Promise<OAuthPersistenceSnapshot> {
    await this.reconcileServerUrl();
    const recovery = await loadVaultEntryForRecovery(this.definition);
    this.tokenSnapshots = recovery.tokenSnapshots;
    this.clientSnapshots = recovery.clientSnapshots;
    return {
      tokens: recovery.entry?.tokens,
      clientInfo: recovery.entry?.clientInfo,
      codeVerifier: recovery.entry?.codeVerifier,
      state: recovery.entry?.state,
    };
  }

  async readTokens(): Promise<OAuthTokens | undefined> {
    const snapshot = await this.readSnapshot();
    return snapshot.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.reconcileServerUrl();
    await saveVaultEntry(this.definition, { tokens: prepareStoredTokens(tokens) });
  }

  async readClientInfo(): Promise<OAuthClientInformationMixed | undefined> {
    const snapshot = await this.readSnapshot();
    return snapshot.clientInfo;
  }

  async saveClientInfo(info: OAuthClientInformationMixed): Promise<void> {
    await this.reconcileServerUrl();
    await saveVaultEntry(this.definition, { clientInfo: info });
  }

  async readCodeVerifier(): Promise<string | undefined> {
    const snapshot = await this.readSnapshot();
    return snapshot.codeVerifier;
  }

  async saveCodeVerifier(value: string): Promise<void> {
    await this.reconcileServerUrl();
    await saveVaultEntry(this.definition, { codeVerifier: value });
  }

  async readState(): Promise<string | undefined> {
    const snapshot = await this.readSnapshot();
    return snapshot.state;
  }

  async saveState(value: string): Promise<void> {
    await this.reconcileServerUrl();
    await saveVaultEntry(this.definition, { state: value });
  }

  async clear(scope: OAuthClearScope): Promise<void> {
    await this.reconcileServerUrl();
    await clearVaultEntry(this.definition, scope);
  }

  async clearRejectedCredentials(
    expectedTokens?: OAuthTokens,
    expectedClientInfo?: OAuthClientInformationMixed
  ): Promise<void> {
    await this.reconcileServerUrl();
    await clearVaultTokensIfMatching(
      this.definition,
      expectedTokens,
      expectedClientInfo,
      expectedTokens ? this.tokenSnapshots : undefined,
      expectedClientInfo ? this.clientSnapshots : undefined
    );
  }
}

export class CompositePersistence implements OAuthPersistence {
  private readonly recoveryTokenSnapshots = new Map<OAuthPersistence, OAuthTokens | undefined>();
  private readonly recoveryClientSnapshots = new Map<OAuthPersistence, OAuthClientInformationMixed | undefined>();
  private recoveryTokenSource: OAuthPersistence | undefined;
  private recoveryClientSource: OAuthPersistence | undefined;

  constructor(private readonly stores: OAuthPersistence[]) {}

  describe(): string {
    return this.stores.map((store) => store.describe()).join(' + ');
  }

  async readSnapshot(): Promise<OAuthPersistenceSnapshot> {
    const snapshots = await Promise.all(this.stores.map((store) => store.readSnapshot()));
    const tokens = this.firstSnapshotValue(snapshots, 'tokens');
    const clientInfo = this.firstSnapshotValue(snapshots, 'clientInfo');
    this.recoveryTokenSnapshots.clear();
    this.recoveryClientSnapshots.clear();
    for (const [index, snapshot] of snapshots.entries()) {
      const store = this.stores[index]!;
      this.recoveryTokenSnapshots.set(store, snapshot.tokens);
      this.recoveryClientSnapshots.set(store, snapshot.clientInfo);
    }
    this.recoveryTokenSource = tokens.source;
    this.recoveryClientSource = clientInfo.source;
    return {
      tokens: tokens.value,
      clientInfo: clientInfo.value,
      codeVerifier: this.firstSnapshotValue(snapshots, 'codeVerifier').value,
      state: this.firstSnapshotValue(snapshots, 'state').value,
    };
  }

  private firstSnapshotValue<K extends keyof OAuthPersistenceSnapshot>(
    snapshots: readonly OAuthPersistenceSnapshot[],
    field: K
  ): { value: OAuthPersistenceSnapshot[K]; source: OAuthPersistence | undefined } {
    for (const [index, snapshot] of snapshots.entries()) {
      if (snapshot[field] !== undefined) {
        return { value: snapshot[field], source: this.stores[index] };
      }
    }
    return { value: undefined, source: undefined };
  }

  async readTokens(): Promise<OAuthTokens | undefined> {
    const result = await this.readRecoveryValues((store) => store.readTokens(), this.recoveryTokenSnapshots);
    this.recoveryTokenSource = result.source;
    return result.value;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    // Compute the absolute expiry once so every backing store records the same
    // generation value even at a wall-clock second boundary.
    const stored = prepareStoredTokens(tokens);
    await Promise.all(this.stores.map((store) => store.saveTokens(stored)));
  }

  async clearRejectedCredentials(
    expectedTokens?: OAuthTokens,
    expectedClientInfo?: OAuthClientInformationMixed
  ): Promise<void> {
    await Promise.all(
      this.stores.map((store) => {
        const storedTokenSnapshot = expectedTokens ? this.recoveryTokenSnapshots.get(store) : undefined;
        const tokenSnapshot =
          expectedTokens &&
          storedTokenSnapshot &&
          (store === this.recoveryTokenSource || sameOAuthTokenValue(storedTokenSnapshot, expectedTokens))
            ? storedTokenSnapshot
            : undefined;
        const storedClientSnapshot = expectedClientInfo ? this.recoveryClientSnapshots.get(store) : undefined;
        const clientSnapshot =
          expectedClientInfo &&
          storedClientSnapshot &&
          (store === this.recoveryClientSource || sameOAuthClientValue(storedClientSnapshot, expectedClientInfo))
            ? storedClientSnapshot
            : undefined;
        return tokenSnapshot || clientSnapshot
          ? store.clearRejectedCredentials(tokenSnapshot, clientSnapshot)
          : Promise.resolve();
      })
    );
  }

  async readClientInfo(): Promise<OAuthClientInformationMixed | undefined> {
    const result = await this.readRecoveryValues((store) => store.readClientInfo(), this.recoveryClientSnapshots);
    this.recoveryClientSource = result.source;
    return result.value;
  }

  private async readRecoveryValues<T>(
    read: (store: OAuthPersistence) => Promise<T | undefined>,
    snapshots: Map<OAuthPersistence, T | undefined>
  ): Promise<{ value: T | undefined; source: OAuthPersistence | undefined }> {
    const results = await Promise.allSettled(this.stores.map((store) => read(store)));
    snapshots.clear();
    let value: T | undefined;
    let source: OAuthPersistence | undefined;
    for (const [index, result] of results.entries()) {
      const store = this.stores[index]!;
      if (result.status === 'rejected') {
        // Preserve ordered fallback semantics: a lower-priority store cannot
        // invalidate an already-readable primary cache, while failures before
        // the first usable value still surface.
        if (!source) {
          throw result.reason;
        }
        continue;
      }
      snapshots.set(store, result.value);
      if (!source && result.value !== undefined) {
        source = store;
        value = result.value;
      }
    }
    return { value, source };
  }

  async saveClientInfo(info: OAuthClientInformationMixed): Promise<void> {
    const stored = withOAuthClientGeneration(info);
    await Promise.all(this.stores.map((store) => store.saveClientInfo(stored)));
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

export async function createOAuthPersistenceStores(
  definition: ServerDefinition,
  logger?: Logger
): Promise<OAuthPersistence> {
  const vault = new VaultPersistence(definition);
  const stores: OAuthPersistence[] = [vault];
  const serverUrl = definition.command.kind === 'http' ? definition.command.url.toString() : undefined;

  if (definition.tokenCacheDir) {
    stores.unshift(new DirectoryPersistence(definition.tokenCacheDir, logger, serverUrl));
  }

  // Migrate legacy default per-server cache (~/.mcporter/<name>) into the vault if present.
  const legacyDir = path.join(legacyMcporterDir(), definition.name);
  if (!definition.tokenCacheDir) {
    const legacy = new DirectoryPersistence(legacyDir, logger, serverUrl, true);
    const snapshot = await legacy.readSnapshot();
    if (snapshot.tokens || snapshot.clientInfo || snapshot.codeVerifier || snapshot.state) {
      if (snapshot.tokens) {
        await vault.saveTokens(snapshot.tokens);
      }
      if (snapshot.clientInfo) {
        await vault.saveClientInfo(snapshot.clientInfo);
      }
      if (snapshot.codeVerifier) {
        await vault.saveCodeVerifier(snapshot.codeVerifier);
      }
      if (snapshot.state) {
        await vault.saveState(snapshot.state);
      }
      logger?.info?.(`Migrated legacy OAuth cache for '${definition.name}' into vault.`);
    }
  }

  return stores.length === 1 ? vault : new CompositePersistence(stores);
}

// Legacy artifacts are never written by live refresh winners, so clearing
// them cannot race a concurrent token save.
export async function clearLegacyOAuthArtifacts(
  definition: ServerDefinition,
  logger: Logger | undefined,
  scope: OAuthClearScope
): Promise<void> {
  const legacyDir = path.join(legacyMcporterDir(), definition.name);
  if (!definition.tokenCacheDir || legacyDir !== definition.tokenCacheDir) {
    const legacy = new DirectoryPersistence(legacyDir, logger);
    await legacy.clear(scope);
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
