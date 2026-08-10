import fs from 'node:fs/promises';
import type {
  OAuthClientInformationMixed,
  OAuthDiscoveryState,
  OAuthTokens,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import type { ServerDefinition } from './config.js';
import type { Logger } from './logging.js';
import { clearLegacyOAuthArtifacts, createOAuthPersistenceStores } from './oauth-persistence-stores.js';
import { readCachedAccessTokenWithPersistence } from './oauth-token-refresh.js';

export type OAuthClearScope = 'all' | 'client' | 'tokens' | 'verifier' | 'state' | 'discovery';

export interface OAuthPersistenceSnapshot {
  readonly tokens?: StoredOAuthTokens;
  readonly clientInfo?: StoredOAuthClientInformation;
  readonly codeVerifier?: string;
  readonly state?: string;
  readonly discoveryState?: OAuthDiscoveryState;
  readonly authorizationServerUrl?: string;
  readonly resourceUrl?: string;
}

export interface OAuthPersistence {
  describe(): string;
  readSnapshot(): Promise<OAuthPersistenceSnapshot>;
  readTokens(): Promise<StoredOAuthTokens | undefined>;
  // Every backing store's own view of the tokens. readTokens() returns the
  // first store that has any, which hides divergence: a partial save can leave
  // a spent generation in the higher-priority store while a newer one sits
  // behind it. Refresh reconciles across these before redeeming. Only the
  // composite needs it; a single store's readTokens() is already its own view.
  readTokensPerStore?(): Promise<OAuthTokens[]>;
  saveTokens(tokens: StoredOAuthTokens): Promise<void>;
  readClientInfo(): Promise<StoredOAuthClientInformation | undefined>;
  saveClientInfo(info: StoredOAuthClientInformation): Promise<void>;
  readCodeVerifier(): Promise<string | undefined>;
  saveCodeVerifier(value: string): Promise<void>;
  readState(): Promise<string | undefined>;
  saveState(value: string): Promise<void>;
  readDiscoveryState(): Promise<OAuthDiscoveryState | undefined>;
  saveDiscoveryState(value: OAuthDiscoveryState): Promise<void>;
  readAuthorizationServerUrl(): Promise<string | undefined>;
  saveAuthorizationServerUrl(value: string): Promise<void>;
  readResourceUrl(): Promise<string | undefined>;
  saveResourceUrl(value: string): Promise<void>;
  clear(scope: OAuthClearScope): Promise<void>;
  // Clears a rejected token generation and, when supplied, only the exact
  // client registration used by that refresh. Concurrent auth state survives.
  clearRejectedCredentials(
    expectedTokens?: OAuthTokens,
    expectedClientInfo?: OAuthClientInformationMixed
  ): Promise<void>;
}

export async function buildOAuthPersistence(definition: ServerDefinition, logger?: Logger): Promise<OAuthPersistence> {
  return await createOAuthPersistenceStores(definition, logger);
}

export async function clearOAuthCaches(
  definition: ServerDefinition,
  logger?: Logger,
  scope: OAuthClearScope = 'all'
): Promise<void> {
  const persistence = await buildOAuthPersistence(definition, logger);
  await persistence.clear(scope);

  if (definition.tokenCacheDir && scope === 'all') {
    await fs.rm(definition.tokenCacheDir, { recursive: true, force: true });
  }

  await clearLegacyOAuthArtifacts(definition, logger, scope);
}

export async function readCachedAccessToken(
  definition: ServerDefinition,
  logger?: Logger
): Promise<string | undefined> {
  const persistence = await buildOAuthPersistence(definition, logger);
  return await readCachedAccessTokenWithPersistence(definition, persistence, logger);
}
