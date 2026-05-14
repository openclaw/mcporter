import fs from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import os from 'node:os';
import path from 'node:path';
import { discoverOAuthServerInfo, refreshAuthorization } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthProtectedResourceMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { checkResourceAllowed, resourceUrlFromServerUrl } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import type { ServerDefinition } from './config.js';
import { readJsonFile, writeJsonFile, writeTextFileAtomic } from './fs-json.js';
import type { Logger } from './logging.js';
import { buildStaticClientInformation } from './oauth-client-info.js';
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

type StoredOAuthTokens = OAuthTokens & {
  expires_at?: number;
  expiresAt?: number;
};

const TOKEN_EXPIRY_SKEW_SECONDS = 60;

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

function tokenExpirySeconds(tokens: OAuthTokens): number | undefined {
  const stored = tokens as StoredOAuthTokens;
  for (const candidate of [stored.expires_at, stored.expiresAt]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function shouldRefreshCachedToken(tokens: OAuthTokens, skewSeconds = TOKEN_EXPIRY_SKEW_SECONDS): boolean {
  const expiresAt = tokenExpirySeconds(tokens);
  if (expiresAt !== undefined) {
    return expiresAt <= Math.floor(Date.now() / 1000) + skewSeconds;
  }
  return typeof tokens.expires_in === 'number' && typeof tokens.refresh_token === 'string';
}

function resourceForRefresh(
  serverUrl: URL,
  resourceMetadata: OAuthProtectedResourceMetadata | undefined
): URL | undefined {
  if (!resourceMetadata) {
    return undefined;
  }
  const defaultResource = resourceUrlFromServerUrl(serverUrl);
  if (!checkResourceAllowed({ requestedResource: defaultResource, configuredResource: resourceMetadata.resource })) {
    throw new Error(
      `Protected resource ${resourceMetadata.resource} does not match expected ${defaultResource} (or origin)`
    );
  }
  return new URL(resourceMetadata.resource);
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
    await writeJsonFile(this.tokenPath, withStoredExpiry(tokens));
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
    await writeTextFileAtomic(this.codeVerifierPath, value);
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
    await saveVaultEntry(this.definition, { tokens: withStoredExpiry(tokens) });
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
  if (!tokens || typeof tokens.access_token !== 'string' || tokens.access_token.trim().length === 0) {
    return undefined;
  }
  if (definition.auth === 'refreshable_bearer') {
    return await readExplicitRefreshableBearerToken(definition, persistence, tokens, logger);
  }
  if (!shouldRefreshCachedToken(tokens)) {
    return tokens.access_token;
  }
  if (typeof tokens.refresh_token !== 'string' || tokens.refresh_token.trim().length === 0) {
    return tokens.access_token;
  }
  try {
    const clientInformation = buildStaticClientInformation(definition) ?? (await persistence.readClientInfo());
    if (!clientInformation) {
      logger?.debug?.(
        `Cached OAuth token for '${definition.name}' is expired, but no client information is available.`
      );
      return tokens.access_token;
    }
    if (definition.command.kind !== 'http') {
      return tokens.access_token;
    }
    const serverInfo = await discoverOAuthServerInfo(definition.command.url);
    const resource = resourceForRefresh(definition.command.url, serverInfo.resourceMetadata);
    const refreshed = await refreshAuthorization(serverInfo.authorizationServerUrl, {
      metadata: serverInfo.authorizationServerMetadata,
      clientInformation,
      refreshToken: tokens.refresh_token,
      ...(resource ? { resource } : {}),
    });
    await persistence.saveTokens(refreshed);
    logger?.debug?.(`Refreshed cached OAuth access token for '${definition.name}' (non-interactive).`);
    return refreshed.access_token;
  } catch (error) {
    logger?.debug?.(
      `Failed to refresh cached OAuth token for '${definition.name}' non-interactively: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return tokens.access_token;
  }
}

async function readExplicitRefreshableBearerToken(
  definition: ServerDefinition,
  persistence: OAuthPersistence,
  tokens: OAuthTokens,
  logger?: Logger
): Promise<string> {
  const refresh = definition.refresh;
  const skewSeconds = refresh?.refreshSkewSeconds ?? TOKEN_EXPIRY_SKEW_SECONDS;
  if (!shouldRefreshCachedToken(tokens, skewSeconds)) {
    return tokens.access_token;
  }
  if (!refresh) {
    throw new Error(`Cached bearer token for '${definition.name}' is expired, but refresh is not configured.`);
  }
  if (typeof tokens.refresh_token !== 'string' || tokens.refresh_token.trim().length === 0) {
    throw new Error(`Cached bearer token for '${definition.name}' is expired, but no refresh_token is available.`);
  }
  try {
    const refreshed = await refreshBearerToken(definition, tokens.refresh_token);
    await persistence.saveTokens(refreshed);
    logger?.debug?.(`Refreshed bearer access token for '${definition.name}' (non-interactive).`);
    return refreshed.access_token;
  } catch (error) {
    logger?.debug?.(
      `Failed to refresh bearer token for '${definition.name}' non-interactively: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    throw new Error(
      `Failed to refresh cached bearer token for '${definition.name}': ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }
}

async function refreshBearerToken(definition: ServerDefinition, refreshToken: string): Promise<OAuthTokens> {
  const refresh = definition.refresh;
  if (!refresh) {
    throw new Error('Missing refresh configuration.');
  }
  const clientId = readEnvOrConfig(refresh.clientIdEnv, definition.oauthClientId);
  const method = refresh.clientAuthMethod ?? definition.oauthTokenEndpointAuthMethod ?? 'client_secret_basic';
  const clientSecret = method === 'none' ? undefined : readClientSecret(definition, refresh.clientSecretEnv);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
  };

  if (method === 'client_secret_post') {
    if (clientId) {
      body.set('client_id', clientId);
    }
    if (clientSecret) {
      body.set('client_secret', clientSecret);
    }
  } else if (method === 'none') {
    if (clientId) {
      body.set('client_id', clientId);
    }
  } else {
    if (!clientId || !clientSecret) {
      throw new Error(`Refresh client credentials are required for '${method}'.`);
    }
    headers.authorization = `Basic ${Buffer.from(
      `${formEncodeCredential(clientId)}:${formEncodeCredential(clientSecret)}`
    ).toString('base64')}`;
  }

  const response = await fetch(refresh.tokenEndpoint, {
    method: 'POST',
    headers,
    body,
  });
  if (!response.ok) {
    throw new Error(`Token endpoint returned HTTP ${response.status}.`);
  }
  const payload = normalizeBearerTokenResponse(await response.json());
  return {
    ...payload,
    ...(payload.refresh_token ? {} : { refresh_token: refreshToken }),
  };
}

function normalizeBearerTokenResponse(value: unknown): OAuthTokens {
  if (!value || typeof value !== 'object') {
    throw new Error('Token endpoint did not return a JSON object.');
  }
  const payload = value as Record<string, unknown>;
  if (typeof payload.access_token !== 'string' || payload.access_token.trim().length === 0) {
    throw new Error('Token endpoint did not return an access_token.');
  }
  return {
    access_token: payload.access_token,
    token_type: typeof payload.token_type === 'string' && payload.token_type ? payload.token_type : 'Bearer',
    ...(typeof payload.id_token === 'string' ? { id_token: payload.id_token } : {}),
    ...(typeof payload.scope === 'string' ? { scope: payload.scope } : {}),
    ...(typeof payload.refresh_token === 'string' && payload.refresh_token
      ? { refresh_token: payload.refresh_token }
      : {}),
    ...coerceExpiresIn(payload.expires_in),
  };
}

function coerceExpiresIn(value: unknown): Pick<OAuthTokens, 'expires_in'> {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { expires_in: value };
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return { expires_in: parsed };
    }
  }
  return {};
}

function readEnvOrConfig(envName: string | undefined, fallback: string | undefined): string | undefined {
  if (!envName) {
    return fallback;
  }
  const value = process.env[envName];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Environment variable '${envName}' is required for bearer token refresh.`);
  }
  return value;
}

function formEncodeCredential(value: string): string {
  return new URLSearchParams([['', value]]).toString().slice(1);
}

function readClientSecret(
  definition: ServerDefinition,
  refreshClientSecretEnv: string | undefined
): string | undefined {
  if (refreshClientSecretEnv) {
    return readEnvOrConfig(refreshClientSecretEnv, undefined);
  }
  return resolveOAuthClientSecret(definition);
}

function resolveOAuthClientSecret(definition: ServerDefinition): string | undefined {
  if (definition.oauthClientSecretEnv) {
    const value = process.env[definition.oauthClientSecretEnv];
    if (value === undefined || value.trim().length === 0) {
      throw new Error(`Environment variable '${definition.oauthClientSecretEnv}' is required for OAuth client secret.`);
    }
    return value;
  }
  return definition.oauthClientSecret;
}
