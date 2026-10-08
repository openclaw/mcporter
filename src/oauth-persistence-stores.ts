import fs from 'node:fs/promises';
import path from 'node:path';
import type { OAuthClientInformationMixed, OAuthDiscoveryState, OAuthTokens } from '@modelcontextprotocol/client';
import type { ServerDefinition } from './config.js';
import type { VaultEncryptionPolicy } from './config-schema.js';
import { readJsonFile, withFileLock, writeJsonFile, writeTextFileAtomic } from './fs-json.js';
import type { Logger } from './logging.js';
import { isStoredOAuthClientInformation, isStoredOAuthTokens } from './oauth-credential-validation.js';
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
import {
  VAULT_PASSWORD_ENV,
  VaultEncryptionError,
  isVaultSecretJwe,
  openVaultSecret,
  readVaultEncryptionSettings,
  sealVaultSecret,
} from './oauth-vault-encryption.js';
import { runtimeHome } from './runtime/environment.js';

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

export function prepareStoredTokens(tokens: OAuthTokens): OAuthTokens {
  return withStoredExpiry(withOAuthTokenGeneration(tokens));
}

const TOKEN_SECRET_FIELDS = ['access_token', 'refresh_token'] as const;
const CLIENT_SECRET_FIELDS = ['client_secret'] as const;

export class DirectoryPersistence implements OAuthPersistence {
  private readonly tokenPath: string;
  private readonly clientInfoPath: string;
  private readonly codeVerifierPath: string;
  private readonly statePath: string;
  private readonly serverUrlPath: string;
  private readonly discoveryStatePath: string;
  private readonly authorizationServerUrlPath: string;
  private readonly resourceUrlPath: string;

  constructor(
    private readonly root: string,
    private readonly logger?: Logger,
    private readonly serverUrl?: string,
    private readonly skipUrlMarkerWhenMissing = false,
    private readonly vaultPolicy?: VaultEncryptionPolicy
  ) {
    this.tokenPath = path.join(root, 'tokens.json');
    this.clientInfoPath = path.join(root, 'client.json');
    this.codeVerifierPath = path.join(root, 'code_verifier.txt');
    this.statePath = path.join(root, 'state.txt');
    this.serverUrlPath = path.join(root, 'server_url.txt');
    this.discoveryStatePath = path.join(root, 'discovery.json');
    this.authorizationServerUrlPath = path.join(root, 'authorization_server_url.txt');
    this.resourceUrlPath = path.join(root, 'resource_url.txt');
  }

  describe(): string {
    return this.root;
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  private password(): string | undefined {
    return readVaultEncryptionSettings(process.env, this.vaultPolicy).password;
  }

  // Seals the named plaintext string fields of a record when a password is set.
  private async sealFields<T extends object>(record: T, file: string, fields: readonly string[]): Promise<T> {
    const password = this.password();
    if (password === undefined) return record;
    const copy: Record<string, unknown> = { ...(record as Record<string, unknown>) };
    for (const field of fields) {
      const value = copy[field];
      if (typeof value === 'string' && value.length > 0 && !isVaultSecretJwe(value)) {
        copy[field] = await sealVaultSecret(value, `${file}/${field}`, password);
      }
    }
    return copy as T;
  }

  // Every write goes through here, under the tokens.json lock: without a
  // password a directory that holds sealed values is refused and left as it
  // is, as the vault is; with one, the files this write does not touch are
  // sealed too, so the first write seals the whole directory.
  private async save(written: string, write: () => Promise<void>): Promise<void> {
    await this.reconcileServerUrl();
    await this.ensureDir();
    await withFileLock(this.tokenPath, async () => {
      if (this.password() === undefined && (await this.holdsSealedValues())) this.requirePassword();
      await write();
      await this.sealOtherFiles(written);
    });
  }

  private async holdsSealedValues(): Promise<boolean> {
    for (const [file, fields] of [
      [this.tokenPath, TOKEN_SECRET_FIELDS],
      [this.clientInfoPath, CLIENT_SECRET_FIELDS],
    ] as const) {
      const record = await this.readJsonOrUndefined<Record<string, unknown>>(file);
      if (record && typeof record === 'object' && fields.some((field) => isVaultSecretJwe(record[field]))) return true;
    }
    return (
      isVaultSecretJwe(await this.readTextAfterReconcile(this.codeVerifierPath)) ||
      isVaultSecretJwe(await this.readJsonOrUndefined<unknown>(this.statePath))
    );
  }

  // The secret files this save did not write are sealed too.
  private async sealOtherFiles(written: string): Promise<void> {
    if (this.password() === undefined) return;
    if (written !== this.tokenPath) await this.sealJsonFile(this.tokenPath, 'tokens.json', TOKEN_SECRET_FIELDS);
    if (written !== this.clientInfoPath) {
      await this.sealJsonFile(this.clientInfoPath, 'client.json', CLIENT_SECRET_FIELDS);
    }
    if (written !== this.codeVerifierPath) {
      const verifier = await this.readTextAfterReconcile(this.codeVerifierPath);
      if (verifier && !isVaultSecretJwe(verifier)) {
        await writeTextFileAtomic(this.codeVerifierPath, await this.sealValue(verifier, 'code_verifier.txt'));
      }
    }
    if (written !== this.statePath) {
      const state = await this.readJsonOrUndefined<unknown>(this.statePath);
      if (typeof state === 'string' && state && !isVaultSecretJwe(state)) {
        await writeJsonFile(this.statePath, await this.sealValue(state, 'state.txt'));
      }
    }
  }

  private async sealJsonFile(file: string, name: string, fields: readonly string[]): Promise<void> {
    const record = await this.readJsonOrUndefined<Record<string, unknown>>(file);
    if (!record || typeof record !== 'object') return;
    const sealed = await this.sealFields(record, name, fields);
    if (fields.some((field) => sealed[field] !== record[field])) await writeJsonFile(file, sealed);
  }

  // Opens the named fields that are sealed; plaintext fields are left as they are.
  private async openFields<T extends object>(
    record: T | undefined,
    file: string,
    fields: readonly string[]
  ): Promise<T | undefined> {
    if (!record) return record;
    const copy: Record<string, unknown> = { ...(record as Record<string, unknown>) };
    for (const field of fields) {
      if (!isVaultSecretJwe(copy[field])) continue;
      copy[field] = await openVaultSecret(copy[field] as string, `${file}/${field}`, this.requirePassword());
    }
    return copy as T;
  }

  private async sealValue(value: string, kid: string): Promise<string> {
    const password = this.password();
    return password === undefined ? value : await sealVaultSecret(value, kid, password);
  }

  private async openValue(value: string | undefined, kid: string): Promise<string | undefined> {
    return isVaultSecretJwe(value) ? await openVaultSecret(value, kid, this.requirePassword()) : value;
  }

  private requirePassword(): string {
    const password = this.password();
    if (password === undefined) {
      throw new VaultEncryptionError(
        'password_missing',
        `${this.root} holds encrypted values; set ${VAULT_PASSWORD_ENV} to use it.`
      );
    }
    return password;
  }

  private async reconcileServerUrl(): Promise<void> {
    // Every operation starts here: a `required` policy without a password
    // refuses the directory, as readVaultState refuses the vault.
    readVaultEncryptionSettings(process.env, this.vaultPolicy);
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
      // old directory-backed credentials. Without a password a sealed
      // directory is refused instead of wiped, as the vault is.
      if (previousUrl !== undefined) {
        if (this.password() === undefined && (await this.holdsSealedValues())) this.requirePassword();
        await this.clearFiles('all');
      }
      await writeTextFileAtomic(this.serverUrlPath, serverUrl);
    });
  }

  async readSnapshot(): Promise<OAuthPersistenceSnapshot> {
    await this.reconcileServerUrl();
    const [tokens, clientInfo, codeVerifier, state, discoveryState, authorizationServerUrl, resourceUrl] =
      await Promise.all([
        this.readTokensAfterReconcile(),
        this.readClientInfoAfterReconcile(),
        this.readCodeVerifierAfterReconcile(),
        this.readStateAfterReconcile(),
        this.readDiscoveryStateAfterReconcile(),
        this.readTextAfterReconcile(this.authorizationServerUrlPath),
        this.readTextAfterReconcile(this.resourceUrlPath),
      ]);
    return { tokens, clientInfo, codeVerifier, state, discoveryState, authorizationServerUrl, resourceUrl };
  }

  async readTokens(): Promise<OAuthTokens | undefined> {
    await this.reconcileServerUrl();
    return await this.readTokensAfterReconcile();
  }

  private async readTokensAfterReconcile(): Promise<OAuthTokens | undefined> {
    const tokens = await this.openFields(
      await this.readJsonOrUndefined<OAuthTokens>(this.tokenPath),
      'tokens.json',
      TOKEN_SECRET_FIELDS
    );
    return isStoredOAuthTokens(tokens) ? withHiddenOAuthTokenGeneration(tokens) : undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    // Locked (in save) so clearRejectedCredentials cannot compare-then-unlink
    // across a concurrent write.
    await this.save(this.tokenPath, async () => {
      await writeJsonFile(
        this.tokenPath,
        await this.sealFields(prepareStoredTokens(tokens), 'tokens.json', TOKEN_SECRET_FIELDS)
      );
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
        const current = await this.openFields(
          await this.readJsonOrUndefined<OAuthTokens>(this.tokenPath),
          'tokens.json',
          TOKEN_SECRET_FIELDS
        );
        if (sameOAuthTokenGeneration(current, expectedTokens)) {
          await this.unlinkIfPresent(this.tokenPath);
        }
      }
      if (expectedClientInfo) {
        const currentClientInfo = await this.openFields(
          await this.readJsonOrUndefined<OAuthClientInformationMixed>(this.clientInfoPath),
          'client.json',
          CLIENT_SECRET_FIELDS
        );
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
    const info = await this.openFields(
      await this.readJsonOrUndefined<OAuthClientInformationMixed>(this.clientInfoPath),
      'client.json',
      CLIENT_SECRET_FIELDS
    );
    return isStoredOAuthClientInformation(info) ? withHiddenOAuthClientGeneration(info) : undefined;
  }

  async saveClientInfo(info: OAuthClientInformationMixed): Promise<void> {
    await this.save(this.clientInfoPath, async () => {
      await writeJsonFile(
        this.clientInfoPath,
        await this.sealFields(withOAuthClientGeneration(info), 'client.json', CLIENT_SECRET_FIELDS)
      );
    });
  }

  async readCodeVerifier(): Promise<string | undefined> {
    await this.reconcileServerUrl();
    return await this.readCodeVerifierAfterReconcile();
  }

  private async readCodeVerifierAfterReconcile(): Promise<string | undefined> {
    try {
      return await this.openValue((await fs.readFile(this.codeVerifierPath, 'utf8')).trim(), 'code_verifier.txt');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  async saveCodeVerifier(value: string): Promise<void> {
    await this.save(this.codeVerifierPath, async () => {
      await writeTextFileAtomic(this.codeVerifierPath, await this.sealValue(value, 'code_verifier.txt'));
    });
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
    return await this.openValue(await readJsonFile<string>(this.statePath), 'state.txt');
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
    await this.save(this.statePath, async () => {
      await writeJsonFile(this.statePath, await this.sealValue(value, 'state.txt'));
    });
  }

  async readDiscoveryState(): Promise<OAuthDiscoveryState | undefined> {
    await this.reconcileServerUrl();
    return this.readDiscoveryStateAfterReconcile();
  }

  private async readDiscoveryStateAfterReconcile(): Promise<OAuthDiscoveryState | undefined> {
    return readJsonFile<OAuthDiscoveryState>(this.discoveryStatePath);
  }

  async saveDiscoveryState(value: OAuthDiscoveryState): Promise<void> {
    await this.save(this.discoveryStatePath, () => writeJsonFile(this.discoveryStatePath, value));
  }

  async readAuthorizationServerUrl(): Promise<string | undefined> {
    await this.reconcileServerUrl();
    return this.readTextAfterReconcile(this.authorizationServerUrlPath);
  }

  async saveAuthorizationServerUrl(value: string): Promise<void> {
    await this.save(this.authorizationServerUrlPath, () => writeTextFileAtomic(this.authorizationServerUrlPath, value));
  }

  async readResourceUrl(): Promise<string | undefined> {
    await this.reconcileServerUrl();
    return this.readTextAfterReconcile(this.resourceUrlPath);
  }

  async saveResourceUrl(value: string): Promise<void> {
    await this.save(this.resourceUrlPath, () => writeTextFileAtomic(this.resourceUrlPath, value));
  }

  private async readTextAfterReconcile(filePath: string): Promise<string | undefined> {
    try {
      return (await fs.readFile(filePath, 'utf8')).trim() || undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async clear(scope: OAuthClearScope): Promise<void> {
    await this.reconcileServerUrl();
    // Same lock as the saves, so a first-sealing sweep cannot write a file
    // back after this unlinked it. Deleting is a modification: without a
    // password a sealed directory is refused here too, as the vault is.
    await withFileLock(this.tokenPath, async () => {
      if (this.password() === undefined && (await this.holdsSealedValues())) this.requirePassword();
      await this.clearFiles(scope);
    });
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
    if (scope === 'all' || scope === 'discovery') {
      files.push(this.discoveryStatePath, this.authorizationServerUrlPath, this.resourceUrlPath);
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
      discoveryState: recovery.entry?.discoveryState,
      authorizationServerUrl: recovery.entry?.authorizationServerUrl,
      resourceUrl: recovery.entry?.resourceUrl,
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

  async readDiscoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.readSnapshot()).discoveryState;
  }

  async saveDiscoveryState(value: OAuthDiscoveryState): Promise<void> {
    await this.reconcileServerUrl();
    await saveVaultEntry(this.definition, { discoveryState: value });
  }

  async readAuthorizationServerUrl(): Promise<string | undefined> {
    return (await this.readSnapshot()).authorizationServerUrl;
  }

  async saveAuthorizationServerUrl(value: string): Promise<void> {
    await this.reconcileServerUrl();
    await saveVaultEntry(this.definition, { authorizationServerUrl: value });
  }

  async readResourceUrl(): Promise<string | undefined> {
    return (await this.readSnapshot()).resourceUrl;
  }

  async saveResourceUrl(value: string): Promise<void> {
    await this.reconcileServerUrl();
    await saveVaultEntry(this.definition, { resourceUrl: value });
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
      discoveryState: this.firstSnapshotValue(snapshots, 'discoveryState').value,
      authorizationServerUrl: this.firstSnapshotValue(snapshots, 'authorizationServerUrl').value,
      resourceUrl: this.firstSnapshotValue(snapshots, 'resourceUrl').value,
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

  async readTokensPerStore(): Promise<OAuthTokens[]> {
    const perStore = await Promise.all(this.stores.map((store) => store.readTokens()));
    return perStore.filter((tokens): tokens is OAuthTokens => tokens !== undefined);
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
    for (const result of results) {
      // A policy or password refusal is about this process, not one store: a
      // plaintext primary cache must not hide it.
      if (result.status === 'rejected' && result.reason instanceof VaultEncryptionError) throw result.reason;
    }
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

  async readDiscoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return this.readFirst((store) => store.readDiscoveryState());
  }

  async saveDiscoveryState(value: OAuthDiscoveryState): Promise<void> {
    await Promise.all(this.stores.map((store) => store.saveDiscoveryState(value)));
  }

  async readAuthorizationServerUrl(): Promise<string | undefined> {
    return this.readFirst((store) => store.readAuthorizationServerUrl());
  }

  async saveAuthorizationServerUrl(value: string): Promise<void> {
    await Promise.all(this.stores.map((store) => store.saveAuthorizationServerUrl(value)));
  }

  async readResourceUrl(): Promise<string | undefined> {
    return this.readFirst((store) => store.readResourceUrl());
  }

  async saveResourceUrl(value: string): Promise<void> {
    await Promise.all(this.stores.map((store) => store.saveResourceUrl(value)));
  }

  private async readFirst<T>(read: (store: OAuthPersistence) => Promise<T | undefined>): Promise<T | undefined> {
    for (const store of this.stores) {
      const value = await read(store);
      if (value !== undefined) return value;
    }
    return undefined;
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
    stores.unshift(
      new DirectoryPersistence(definition.tokenCacheDir, logger, serverUrl, false, definition.oauthVaultEncryption)
    );
  }

  // Migrate legacy default per-server cache (~/.mcporter/<name>) into the vault if present.
  const legacyDir = path.join(path.join(runtimeHome(), '.mcporter'), definition.name);
  if (!definition.tokenCacheDir) {
    const legacy = new DirectoryPersistence(legacyDir, logger, serverUrl, true, definition.oauthVaultEncryption);
    const snapshot = await legacy.readSnapshot();
    if (
      snapshot.tokens ||
      snapshot.clientInfo ||
      snapshot.codeVerifier ||
      snapshot.state ||
      snapshot.discoveryState ||
      snapshot.authorizationServerUrl ||
      snapshot.resourceUrl
    ) {
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
      if (snapshot.discoveryState) {
        await vault.saveDiscoveryState(snapshot.discoveryState);
      }
      if (snapshot.authorizationServerUrl) {
        await vault.saveAuthorizationServerUrl(snapshot.authorizationServerUrl);
      }
      if (snapshot.resourceUrl) {
        await vault.saveResourceUrl(snapshot.resourceUrl);
      }
      logger?.info?.(`Migrated legacy OAuth cache for '${definition.name}' into vault.`);
      // With a password set the legacy plaintext files are removed once they
      // are in the vault; without one they are kept as before.
      if (readVaultEncryptionSettings(process.env, definition.oauthVaultEncryption).password !== undefined) {
        await legacy.clear('all');
      }
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
  const legacyDir = path.join(path.join(runtimeHome(), '.mcporter'), definition.name);
  if (!definition.tokenCacheDir || legacyDir !== definition.tokenCacheDir) {
    const legacy = new DirectoryPersistence(legacyDir, logger, undefined, false, definition.oauthVaultEncryption);
    await legacy.clear(scope);
  }

  // Known provider-specific legacy paths (gmail server writes to ~/.gmail-mcp/credentials.json).
  const legacyFiles: string[] = [];
  if (definition.name.toLowerCase() === 'gmail') {
    legacyFiles.push(path.join(runtimeHome(), '.gmail-mcp', 'credentials.json'));
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
