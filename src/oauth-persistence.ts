import fs from 'node:fs/promises';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/client';
import type { ServerDefinition } from './config.js';
import type { Logger } from './logging.js';
import { clearLegacyOAuthArtifacts, createOAuthPersistenceStores } from './oauth-persistence-stores.js';
import { readCachedAccessTokenWithPersistence } from './oauth-token-refresh.js';

export type OAuthClearScope = 'all' | 'client' | 'tokens' | 'verifier' | 'state';

export interface OAuthPersistenceSnapshot {
  readonly tokens?: OAuthTokens;
  readonly clientInfo?: OAuthClientInformationMixed;
  readonly codeVerifier?: string;
  readonly state?: string;
}

export interface OAuthPersistence {
  describe(): string;
  readSnapshot(): Promise<OAuthPersistenceSnapshot>;
  readTokens(): Promise<OAuthTokens | undefined>;
  saveTokens(tokens: OAuthTokens): Promise<void>;
  readClientInfo(): Promise<OAuthClientInformationMixed | undefined>;
  saveClientInfo(info: OAuthClientInformationMixed): Promise<void>;
  readCodeVerifier(): Promise<string | undefined>;
  saveCodeVerifier(value: string): Promise<void>;
  readState(): Promise<string | undefined>;
  saveState(value: string): Promise<void>;
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
