import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { URL } from 'node:url';
import type {
  OAuthClientInformationMixed,
  OAuthDiscoveryState,
  OAuthClientMetadata,
  OAuthClientProvider,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { validateClientMetadataUrl } from '@modelcontextprotocol/client';
import type { ServerDefinition } from './config.js';
import { suppressBrowserLaunchFromEnv } from './oauth-browser-suppression.js';
import { buildStaticClientInformation } from './oauth-client-info.js';
import type { OAuthPersistence, OAuthPersistenceSnapshot } from './oauth-persistence.js';
import { buildOAuthPersistence } from './oauth-persistence.js';
import { readCachedAccessTokenWithPersistence } from './oauth-token-refresh.js';

const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PATH = '/callback';
// Mirrors DEFAULT_OAUTH_CODE_TIMEOUT_MS in src/runtime/oauth.ts: a pending interactive
// authorization older than this is treated as abandoned so a later request can prompt again.
const INTERACTIVE_AUTHORIZATION_TTL_MS = 300_000;

export interface OAuthAuthorizationRequest {
  authorizationUrl: string;
  redirectUrl: string;
}

export interface OAuthAuthorizationResponse {
  code: string;
  iss?: string;
}

export interface OAuthSessionOptions {
  suppressBrowserLaunch?: boolean;
  onAuthorizationUrl?: (request: OAuthAuthorizationRequest) => void | Promise<void>;
}

// Thrown when interactive authorization is needed but browser launch is suppressed
// and no onAuthorizationUrl consumer exists (headless serve/daemon): callers get a
// prompt server-named failure instead of waiting out the authorization timeout.
export class BrowserLaunchSuppressedError extends Error {
  readonly serverName: string;
  constructor(serverName: string) {
    super(
      `Authorization required for '${serverName}' but browser launch is suppressed (MCPORTER_OAUTH_NO_BROWSER); run 'mcporter auth ${serverName} --no-browser' to authorize.`
    );
    this.name = 'BrowserLaunchSuppressedError';
    this.serverName = serverName;
  }
}

export class OAuthRedirectUriMismatchError extends Error {
  constructor(serverName: string) {
    super(`OAuth client registration for '${serverName}' used an obsolete redirect URI.`);
    this.name = 'OAuthRedirectUriMismatchError';
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

// createDeferred produces a minimal promise wrapper for async coordination.
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// openExternal attempts to launch the system browser cross-platform.
function openExternal(url: string, platform: NodeJS.Platform = process.platform, launch: typeof spawn = spawn) {
  const stdio = 'ignore';
  try {
    if (platform === 'darwin') {
      const child = launch('open', [url], { stdio, detached: true });
      child.unref();
    } else if (platform === 'win32') {
      // Shell-free: do not pass the OAuth URL through cmd.exe. Command metacharacters
      // such as `&` in query strings are still parsed by cmd even when argv is split.
      // rundll32 FileProtocolHandler treats the URL as a document path, not command text.
      const child = launch('rundll32', ['url.dll,FileProtocolHandler', url], {
        stdio,
        detached: true,
        windowsHide: true,
      });
      child.unref();
    } else {
      try {
        const child = launch('xdg-open', [url], { stdio, detached: true });
        child.on('error', () => {}); // swallow ENOENT on headless servers
        child.unref();
      } catch {
        // headless server — no browser available
      }
    }
  } catch {
    // best-effort: fall back to printing URL
  }
}

// PersistentOAuthClientProvider persists OAuth session artifacts to disk and captures callback redirects.
class PersistentOAuthClientProvider implements OAuthClientProvider {
  private readonly metadata: OAuthClientMetadata;
  private readonly logger: OAuthLogger;
  private readonly persistence: OAuthPersistence;
  private redirectUrlValue: URL;
  private authorizationDeferred: Deferred<OAuthAuthorizationResponse> | null = null;
  private authorizationRedirectStarted = false;
  // One interactive authorization transaction per provider: concurrent SDK auth() flows
  // (background GET reconnect + bridged POST both hitting 401) must not each open a
  // prompt, because only one persisted PKCE verifier can complete (issue #247).
  private interactiveAuthorization: { challenge: string | null; claimedAt: number } | null = null;
  private readonly pendingVerifiersByChallenge = new Map<string, string>();
  private server?: http.Server;

  private constructor(
    private readonly definition: ServerDefinition,
    persistence: OAuthPersistence,
    redirectUrl: URL,
    logger: OAuthLogger,
    private readonly usesDynamicPort: boolean,
    private readonly options: OAuthSessionOptions = {}
  ) {
    this.redirectUrlValue = redirectUrl;
    this.logger = logger;
    this.persistence = persistence;
    this.metadata = {
      client_name: definition.clientName ?? `mcporter (${definition.name})`,
      redirect_uris: [this.redirectUrlValue.toString()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      // Omit scope so the MCP SDK can derive it from the server's metadata
      // (resource metadata scopes_supported or auth server scopes_supported).
      // Hardcoding 'mcp:tools' breaks providers like Granola whose auth server
      // does not recognise that scope value.
      // If oauthScope is explicitly configured, prefer that exact value.
      ...(definition.oauthScope !== undefined ? { scope: definition.oauthScope || undefined } : {}),
    };
  }

  static async create(
    definition: ServerDefinition,
    logger: OAuthLogger,
    options: OAuthSessionOptions = {}
  ): Promise<{
    provider: PersistentOAuthClientProvider;
    close: () => Promise<void>;
  }> {
    validateClientMetadataUrl(definition.oauthClientMetadataUrl);
    const persistence = await buildOAuthPersistence(definition, logger);

    const server = http.createServer();
    const overrideRedirect = definition.oauthRedirectUrl ? new URL(definition.oauthRedirectUrl) : null;
    const listenHost = overrideRedirect?.hostname ?? CALLBACK_HOST;
    const overridePort = overrideRedirect?.port ?? '';
    const usesDynamicPort = !overrideRedirect || overridePort === '' || overridePort === '0';
    const desiredPort = usesDynamicPort ? undefined : Number.parseInt(overridePort, 10);
    const callbackPath =
      overrideRedirect?.pathname && overrideRedirect.pathname !== '/' ? overrideRedirect.pathname : CALLBACK_PATH;
    const port = await new Promise<number>((resolve, reject) => {
      server.listen(desiredPort ?? 0, listenHost, () => {
        const address = server.address();
        if (typeof address === 'object' && address && 'port' in address) {
          resolve(address.port);
        } else {
          reject(new Error('Failed to determine callback port'));
        }
      });
      server.once('error', (error) => reject(error));
    });

    const redirectUrl = overrideRedirect
      ? new URL(overrideRedirect.toString())
      : new URL(`http://${listenHost}:${port}${callbackPath}`);
    if (usesDynamicPort) {
      redirectUrl.port = String(port);
    }
    if (!overrideRedirect || overrideRedirect.pathname === '/' || overrideRedirect.pathname === '') {
      redirectUrl.pathname = callbackPath;
    }

    const provider = new PersistentOAuthClientProvider(
      definition,
      persistence,
      redirectUrl,
      logger,
      usesDynamicPort,
      options
    );
    provider.attachServer(server);
    return {
      provider,
      close: async () => {
        await provider.close();
      },
    };
  }

  // attachServer listens for the OAuth redirect and resolves/rejects the deferred code promise.
  private attachServer(server: http.Server) {
    this.server = server;
    server.on('request', async (req, res) => {
      try {
        const url = req.url ?? '';
        const parsed = new URL(url, this.redirectUrlValue);
        const expectedPath = this.redirectUrlValue.pathname || '/callback';
        if (parsed.pathname !== expectedPath) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }
        const code = parsed.searchParams.get('code');
        const error = parsed.searchParams.get('error');
        const receivedState = parsed.searchParams.get('state');
        const iss = parsed.searchParams.get('iss') ?? undefined;
        const expectedState = await this.persistence.readState();
        if (expectedState && receivedState !== expectedState) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'text/html');
          res.end('<html><body><h1>Authorization failed</h1><p>Invalid OAuth state</p></body></html>');
          this.authorizationDeferred?.reject(new Error('Invalid OAuth state'));
          this.authorizationDeferred = null;
          this.clearInteractiveAuthorization();
          return;
        }
        if (code) {
          this.logger.info(`Received OAuth authorization code for ${this.definition.name}`);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/html');
          res.end('<html><body><h1>Authorization successful</h1><p>You can return to the CLI.</p></body></html>');
          this.authorizationDeferred?.resolve({ code, iss });
          this.authorizationDeferred = null;
          this.clearInteractiveAuthorization();
        } else if (error) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'text/html');
          res.end('<html><body><h1>Authorization failed</h1><p>Return to the CLI for details.</p></body></html>');
          this.authorizationDeferred?.reject(new Error('OAuth authorization failed.'));
          this.authorizationDeferred = null;
          this.clearInteractiveAuthorization();
        } else {
          res.statusCode = 400;
          res.end('Missing authorization code');
          this.authorizationDeferred?.reject(new Error('Missing authorization code'));
          this.authorizationDeferred = null;
          this.clearInteractiveAuthorization();
        }
      } catch (error) {
        this.authorizationDeferred?.reject(error);
        this.authorizationDeferred = null;
        this.clearInteractiveAuthorization();
      }
    });
  }

  get redirectUrl(): string | URL {
    return this.redirectUrlValue;
  }

  get clientMetadata(): OAuthClientMetadata {
    return this.metadata;
  }

  get clientMetadataUrl(): string | undefined {
    return this.definition.oauthClientMetadataUrl;
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

  async clientInformation(ctx?: { issuer: string }): Promise<StoredOAuthClientInformation | undefined> {
    const staticClient = buildStaticClientInformation(this.definition, { redirectUrl: this.redirectUrlValue });
    if (staticClient) {
      return { ...staticClient, ...(ctx ? { issuer: ctx.issuer } : {}) };
    }
    const stored = await this.persistence.readClientInfo();
    if (ctx && stored?.issuer && !issuersMatch(stored.issuer, ctx.issuer)) {
      await this.persistence.clear('client');
      this.logger.info(`Discarded OAuth client registration for ${this.definition.name} after issuer changed.`);
      return undefined;
    }
    return stored;
  }

  async saveClientInformation(clientInformation: StoredOAuthClientInformation): Promise<void> {
    await this.persistence.saveClientInfo(clientInformation);
  }

  async tokens(ctx?: { issuer: string }): Promise<StoredOAuthTokens | undefined> {
    const stored = await this.persistence.readTokens();
    if (ctx && stored?.issuer && !issuersMatch(stored.issuer, ctx.issuer)) {
      await this.persistence.clear('tokens');
      this.logger.info(`Discarded OAuth tokens for ${this.definition.name} after issuer changed.`);
      return undefined;
    }
    return await this.refreshedTokens(stored);
  }

  /**
   * Refreshes an expiring token under the cross-process refresh lock before the
   * SDK sees it.
   *
   * This is the interception point for SDK-driven refresh. The SDK redeems a
   * rotating refresh token itself whenever tokens() hands it an expired one —
   * proactively before connect and internally on a 401 — and neither call site
   * is wrappable from here. Returning an already-refreshed token starves that
   * branch, so the redemption happens once, under the lock, instead of racing
   * every other process that shares the credential.
   *
   * The locked transaction is re-entrant per call chain, so an SDK auth() flow
   * that already holds the lock does not deadlock on this read.
   *
   * Known and accepted limit (issue #305): this covers the proactive connect
   * path, not the SDK's internal 401-driven auth(). That branch runs inside the
   * SDK's own fetch handling with no seam to wrap, it redeems whenever this
   * method returns any refresh token — it never checks expiry — and it
   * re-persists this method's return value when `issuer` is unset, so
   * withholding the refresh token here would destroy it instead of protecting
   * it. Two processes taking a 401 at the same instant can therefore still
   * redeem concurrently; the rejected-refresh recovery in oauth-token-refresh.ts
   * remains the backstop for that case.
   */
  private async refreshedTokens(stored: StoredOAuthTokens | undefined): Promise<StoredOAuthTokens | undefined> {
    if (!stored || this.definition.auth === 'refreshable_bearer') {
      return stored;
    }
    try {
      await readCachedAccessTokenWithPersistence(this.definition, this.persistence);
    } catch (error) {
      // A refresh that discarded credentials (issuer change, rejected grant)
      // must surface as "no tokens" so the SDK reauthorizes interactively.
      this.logger.warn(
        `Could not refresh OAuth tokens for ${this.definition.name}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    return await this.persistence.readTokens();
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    await this.persistence.saveTokens(tokens);
    this.logger.info(`Saved OAuth tokens for ${this.definition.name} (${this.persistence.describe()})`);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.invalidateObsoleteDynamicRegistration();
    this.authorizationRedirectStarted = true;
    this.ensureAuthorizationDeferred();
    const challenge = authorizationUrl.searchParams.get('code_challenge');
    if (this.hasActiveInteractiveAuthorization()) {
      // Join the in-flight transaction: drop this flow's redirect (and its unclaimed
      // verifier) so exactly one completable prompt exists for this provider.
      if (challenge) {
        this.pendingVerifiersByChallenge.delete(challenge);
      }
      this.logger.info(`Authorization already pending for ${this.definition.name}; suppressing duplicate prompt.`);
      return;
    }
    // Claim synchronously, before any await, so a concurrent redirect sees the claim.
    this.interactiveAuthorization = { challenge, claimedAt: Date.now() };
    const claimedVerifier = challenge ? this.pendingVerifiersByChallenge.get(challenge) : undefined;
    if (challenge) {
      this.pendingVerifiersByChallenge.delete(challenge);
    }
    if (claimedVerifier) {
      // Re-persist the claimed flow's verifier: a concurrent flow may have saved its own
      // between this flow's saveCodeVerifier and this claim.
      await this.persistence.saveCodeVerifier(claimedVerifier);
    }
    const request = {
      authorizationUrl: authorizationUrl.toString(),
      redirectUrl: this.redirectUrlValue.toString(),
    } satisfies OAuthAuthorizationRequest;
    if (this.options.suppressBrowserLaunch ?? suppressBrowserLaunchFromEnv()) {
      if (this.options.onAuthorizationUrl) {
        await this.options.onAuthorizationUrl(request);
        return;
      }
      // No callback registered (serve/daemon path): reject the pending
      // authorization so waiters fail fast with a server-named
      // error instead of waiting out the timeout on a browser handshake nobody
      // will complete. Never throw here: the SDK invokes this from unawaited send
      // paths, where a throw becomes an unhandled rejection that kills the daemon.
      const suppressed = new BrowserLaunchSuppressedError(this.definition.name);
      this.logger.warn(suppressed.message);
      const deferred = this.ensureAuthorizationDeferred();
      // Mark the rejection handled: waiters that attach later still observe it.
      deferred.promise.catch(() => {});
      deferred.reject(suppressed);
      this.clearInteractiveAuthorization();
      return;
    }
    this.logger.info(`Authorization required for ${this.definition.name}. Opening browser...`);
    __oauthInternals.openExternal(request.authorizationUrl);
    this.logger.warn(`If the browser did not open, visit ${request.authorizationUrl} manually.`);
  }

  hasAuthorizationRedirectStarted(): boolean {
    return this.authorizationRedirectStarted;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    // Remember every verifier by its S256 challenge so redirectToAuthorization can
    // re-persist the one belonging to the flow that wins the interactive claim.
    this.pendingVerifiersByChallenge.set(challengeForVerifier(codeVerifier), codeVerifier);
    if (this.hasActiveInteractiveAuthorization()) {
      // A concurrent flow owns the pending prompt; don't clobber its persisted verifier.
      return;
    }
    await this.persistence.saveCodeVerifier(codeVerifier);
  }

  async codeVerifier(): Promise<string> {
    const value = await this.persistence.readCodeVerifier();
    if (!value) {
      throw new Error(`Missing PKCE code verifier for ${this.definition.name}`);
    }
    return value.trim();
  }

  // invalidateCredentials removes cached files to force the next OAuth flow.
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all' || scope === 'verifier') {
      // The pending transaction's verifier is gone; let the next flow claim a new prompt.
      this.clearInteractiveAuthorization();
    }
    await this.persistence.clear(scope);
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.persistence.saveDiscoveryState(state);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return this.persistence.readDiscoveryState();
  }

  async saveAuthorizationServerUrl(url: string): Promise<void> {
    await this.persistence.saveAuthorizationServerUrl(url);
  }

  async authorizationServerUrl(): Promise<string | undefined> {
    return this.persistence.readAuthorizationServerUrl();
  }

  async saveResourceUrl(url: string): Promise<void> {
    await this.persistence.saveResourceUrl(url);
  }

  async resourceUrl(): Promise<string | undefined> {
    return this.persistence.readResourceUrl();
  }

  // waitForAuthorizationCode resolves once the local callback server captures a redirect.
  // The same deferred is shared with redirectToAuthorization so callback resolution is stable.
  async waitForAuthorizationCode(): Promise<string> {
    return (await this.waitForAuthorizationResponse()).code;
  }

  async waitForAuthorizationResponse(): Promise<OAuthAuthorizationResponse> {
    return this.ensureAuthorizationDeferred().promise;
  }

  // close stops the temporary callback server created for the OAuth session.
  async close(): Promise<void> {
    if (this.authorizationDeferred) {
      // If the CLI is tearing down mid-flow, reject the pending wait promise so runtime shutdown isn't blocked.
      this.authorizationDeferred.reject(new Error('OAuth session closed before receiving authorization code.'));
      this.authorizationDeferred = null;
      this.clearInteractiveAuthorization();
    }
    if (!this.server) {
      return;
    }
    this.server.closeAllConnections?.();
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private ensureAuthorizationDeferred(): Deferred<OAuthAuthorizationResponse> {
    if (!this.authorizationDeferred) {
      this.authorizationDeferred = createDeferred<OAuthAuthorizationResponse>();
    }
    return this.authorizationDeferred;
  }

  private hasActiveInteractiveAuthorization(): boolean {
    if (!this.interactiveAuthorization) {
      return false;
    }
    if (Date.now() - this.interactiveAuthorization.claimedAt > INTERACTIVE_AUTHORIZATION_TTL_MS) {
      // The prompt outlived the authorization-code timeout; treat it as abandoned.
      this.interactiveAuthorization = null;
      return false;
    }
    return true;
  }

  private clearInteractiveAuthorization(): void {
    this.interactiveAuthorization = null;
    this.pendingVerifiersByChallenge.clear();
  }

  private async invalidateObsoleteDynamicRegistration(): Promise<void> {
    if (!this.usesDynamicPort || this.definition.oauthClientId) {
      return;
    }
    let snapshot: OAuthPersistenceSnapshot;
    try {
      snapshot = await this.persistence.readSnapshot();
    } catch (error) {
      await this.close();
      throw error;
    }
    const cachedClient = snapshot.clientInfo;
    // Configuring a metadata URL does not mean the authorization server accepted
    // URL-based client IDs. The SDK falls back to DCR when support is absent, so
    // only preserve the registration when that URL is the client identity in use.
    if (cachedClient?.client_id === this.definition.oauthClientMetadataUrl) {
      return;
    }
    const cachedRedirect = firstRedirectUri(cachedClient);
    if (!cachedClient || !cachedRedirect || cachedRedirect === this.redirectUrlValue.toString()) {
      return;
    }
    this.logger.info(
      `Redirect URI changed (${cachedRedirect} → ${this.redirectUrlValue.toString()}); replacing obsolete client registration before interactive authorization.`
    );
    try {
      // A failed refresh makes this exact token/client pair unusable for the
      // upcoming callback. Generation checks preserve any concurrent winner.
      await this.persistence.clearRejectedCredentials(snapshot.tokens, cachedClient);
    } catch (error) {
      await this.close();
      throw error;
    }
    throw new OAuthRedirectUriMismatchError(this.definition.name);
  }
}

export interface OAuthSession {
  provider: OAuthClientProvider & {
    waitForAuthorizationCode: () => Promise<string>;
    waitForAuthorizationResponse?: () => Promise<OAuthAuthorizationResponse>;
    hasAuthorizationRedirectStarted?: () => boolean;
  };
  waitForAuthorizationCode: () => Promise<string>;
  waitForAuthorizationResponse?: () => Promise<OAuthAuthorizationResponse>;
  hasAuthorizationRedirectStarted?: () => boolean;
  close: () => Promise<void>;
}

// createOAuthSession spins up a file-backed OAuth provider and callback server for the target definition.
export async function createOAuthSession(
  definition: ServerDefinition,
  logger: OAuthLogger,
  options: OAuthSessionOptions = {}
): Promise<OAuthSession> {
  const { provider, close } = await PersistentOAuthClientProvider.create(definition, logger, options);
  const waitForAuthorizationCode = () => provider.waitForAuthorizationCode();
  const waitForAuthorizationResponse = () => provider.waitForAuthorizationResponse();
  const hasAuthorizationRedirectStarted = () => provider.hasAuthorizationRedirectStarted();
  return {
    provider,
    waitForAuthorizationCode,
    waitForAuthorizationResponse,
    hasAuthorizationRedirectStarted,
    close,
  };
}
export interface OAuthLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

function challengeForVerifier(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
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

function issuersMatch(first: string, second: string): boolean {
  return (
    first === second ||
    (first.endsWith('/') && first.slice(0, -1) === second) ||
    (second.endsWith('/') && second.slice(0, -1) === first)
  );
}

export const __oauthInternals = {
  openExternal,
};
