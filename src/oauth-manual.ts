import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { ServerDefinition } from './config.js';
import type { OAuthPersistence } from './oauth-persistence.js';
import { buildOAuthPersistence } from './oauth-persistence.js';
import type { OAuthLogger, OAuthSession } from './oauth.js';

// Default redirect URI for manual auth code OAuth flows. The server at this address
// echoes the `code` query parameter back to the user so they can paste it into
// the CLI. Configure `manualRedirectUri` per server to use a different URL.
export const MANUAL_DEFAULT_REDIRECT_URI = 'http://localhost:3333/callback';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function promptStdin(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      resolve(answer.trim()); // resolve before close so the 'close' handler doesn't win
      rl.close();
    });
    rl.once('close', () => resolve(''));
    rl.once('error', reject);
  });
}

function firstRedirectUri(client: OAuthClientInformationMixed | undefined): string | undefined {
  if (!client || typeof client !== 'object') {
    return undefined;
  }
  const redirectUris = (client as Record<string, unknown>).redirect_uris;
  if (!Array.isArray(redirectUris)) {
    return undefined;
  }
  const [first] = redirectUris;
  return typeof first === 'string' ? first : undefined;
}

// ManualOAuthClientProvider performs the standard authorization_code+PKCE
// flow without opening a browser. redirectToAuthorization() prints the auth URL
// and prompts the user to paste the code shown at the redirect page.
class ManualOAuthClientProvider implements OAuthClientProvider {
  private readonly metadata: OAuthClientMetadata;
  private readonly persistence: OAuthPersistence;
  private readonly logger: OAuthLogger;
  private readonly redirectUri: string;
  private authorizationDeferred: Deferred<string> | null = null;

  private constructor(
    private readonly definition: ServerDefinition,
    persistence: OAuthPersistence,
    redirectUri: string,
    logger: OAuthLogger
  ) {
    this.persistence = persistence;
    this.logger = logger;
    this.redirectUri = redirectUri;
    this.metadata = {
      client_name: definition.clientName ?? `mcporter (${definition.name})`,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(definition.oauthScope !== undefined ? { scope: definition.oauthScope || undefined } : {}),
    };
  }

  static async create(
    definition: ServerDefinition,
    logger: OAuthLogger
  ): Promise<{ provider: ManualOAuthClientProvider; close: () => Promise<void> }> {
    const persistence = await buildOAuthPersistence(definition, logger);
    const redirectUri = definition.manualRedirectUri ?? MANUAL_DEFAULT_REDIRECT_URI;

    // If a previous client was registered with a different redirect URI, clear
    // it so we re-register with the correct manual auth redirect URI.
    try {
      const cachedClient = await persistence.readClientInfo();
      const cachedRedirect = firstRedirectUri(cachedClient);
      if (cachedRedirect && cachedRedirect !== redirectUri) {
        logger.info(
          `Redirect URI changed for manual auth flow (${cachedRedirect} → ${redirectUri}); clearing stale client registration.`
        );
        await persistence.clear('client');
      }
    } catch {
      // Non-fatal — proceed without cached client info.
    }

    const provider = new ManualOAuthClientProvider(definition, persistence, redirectUri, logger);
    return {
      provider,
      close: async () => {
        if (provider.authorizationDeferred) {
          provider.authorizationDeferred.reject(
            new Error('OAuth session closed before receiving authorization code.')
          );
          provider.authorizationDeferred = null;
        }
      },
    };
  }

  get redirectUrl(): string {
    return this.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return this.metadata;
  }

  async state(): Promise<string> {
    const existing = await this.persistence.readState();
    if (existing) {
      return existing;
    }
    const state = randomUUID();
    await this.persistence.saveState(state);
    return state;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return this.persistence.readClientInfo();
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    await this.persistence.saveClientInfo(clientInformation);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.persistence.readTokens();
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.persistence.saveTokens(tokens);
    const tokenTypes = ['access_token', ...(tokens.refresh_token ? ['refresh_token'] : [])].join(' and ');
    process.stderr.write(
      `\n  Authorization code exchange complete. Received ${tokenTypes}.\n` +
        `  Tokens persisted to: ${this.persistence.describe()}\n\n`
    );
    this.logger.info(`Saved OAuth tokens for '${this.definition.name}' (${this.persistence.describe()})`);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const deferred = this.ensureAuthorizationDeferred();

    process.stderr.write(`\n  Manual OAuth (copy/paste auth code)\n`);
    process.stderr.write(`  Redirect URI: ${this.redirectUri}\n`);
    const urlStr = authorizationUrl.toString();
    process.stderr.write(`\n  Open this URL in your browser:\n\n    ${urlStr}\n\n`);
    process.stderr.write(
      `  After authorizing, the page will display an authorization code.\n\n`
    );

    promptStdin('  Paste the authorization code: ').then(
      (code) => {
        if (code) {
          deferred.resolve(code);
        } else {
          deferred.reject(new Error('No authorization code entered.'));
        }
      },
      (err) => deferred.reject(err)
    );
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.persistence.saveCodeVerifier(codeVerifier);
  }

  async codeVerifier(): Promise<string> {
    const value = await this.persistence.readCodeVerifier();
    if (!value) {
      throw new Error(`Missing PKCE code verifier for ${this.definition.name}`);
    }
    return value.trim();
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): Promise<void> {
    await this.persistence.clear(scope);
  }

  async waitForAuthorizationCode(): Promise<string> {
    const deferred = this.ensureAuthorizationDeferred();
    try {
      return await deferred.promise;
    } finally {
      // Clear the deferred so a future call creates a fresh prompt rather than
      // immediately returning the already-resolved (possibly invalid) value.
      if (this.authorizationDeferred === deferred) {
        this.authorizationDeferred = null;
      }
    }
  }

  private ensureAuthorizationDeferred(): Deferred<string> {
    if (!this.authorizationDeferred) {
      this.authorizationDeferred = createDeferred();
    }
    return this.authorizationDeferred;
  }
}

export async function createManualOAuthSession(
  definition: ServerDefinition,
  logger: OAuthLogger
): Promise<OAuthSession> {
  const { provider, close } = await ManualOAuthClientProvider.create(definition, logger);
  return {
    provider,
    waitForAuthorizationCode: () => provider.waitForAuthorizationCode(),
    close,
    manual: true,
  };
}
