import { createHash } from 'node:crypto';
import { buildOAuthPersistence, readCachedAccessToken } from '../../dist/oauth-persistence.js';
import { withRefreshLock } from '../../dist/oauth-refresh-lock.js';
import { createOAuthSession } from '../../dist/oauth.js';
import { connectWithAuth } from '../../dist/runtime/oauth.js';

const action = process.argv[2];
const endpoint = process.env.MCPORTER_TEST_OAUTH_ENDPOINT;
const tokenCacheDir = process.env.MCPORTER_TEST_OAUTH_CACHE_DIR;
if (!action || !endpoint || !tokenCacheDir) {
  throw new Error('Expected action, MCPORTER_TEST_OAUTH_ENDPOINT, and MCPORTER_TEST_OAUTH_CACHE_DIR.');
}

const serverName = process.env.MCPORTER_TEST_OAUTH_SERVER_NAME ?? 'oauth-refresh-process';
const seedRefreshToken = process.env.MCPORTER_TEST_OAUTH_SEED_REFRESH ?? 'fresh-process-refresh-token';

const definition = {
  name: serverName,
  command: { kind: 'http', url: new URL(endpoint) },
  auth: 'oauth',
  tokenCacheDir,
};
const logger = { info() {}, warn() {}, error() {}, debug() {} };

// Credential values must never reach stdout, CI logs, or failure artifacts, so
// callers compare opaque markers instead of tokens.
function marker(value) {
  return typeof value === 'string' && value.length > 0
    ? createHash('sha256').update(value).digest('hex').slice(0, 12)
    : null;
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function snapshot() {
  return await (await buildOAuthPersistence(definition, logger)).readSnapshot();
}

if (action === 'seed') {
  const persistence = await buildOAuthPersistence(definition, logger);
  await persistence.saveClientInfo({
    client_id: 'fresh-process-client',
    redirect_uris: ['http://127.0.0.1:41000/callback'],
    token_endpoint_auth_method: 'none',
  });
  await persistence.saveTokens({
    access_token: 'expired-process-token',
    token_type: 'Bearer',
    refresh_token: seedRefreshToken,
    expires_at: 1,
  });
  emit({ seeded: true, refreshMarker: marker(seedRefreshToken) });
} else if (action === 'refresh') {
  const accessToken = await readCachedAccessToken(definition, logger);
  let authorizationPrompts = 0;
  const session = await createOAuthSession(definition, logger, {
    suppressBrowserLaunch: true,
    onAuthorizationUrl: () => {
      authorizationPrompts += 1;
    },
  });
  await connectWithAuth({ connect: async () => {} }, { close: async () => {} }, session, logger, {
    serverName: definition.name,
    serverUrl: endpoint,
    fetchFn: fetch,
  });
  const stored = await snapshot();
  emit({
    accessToken,
    authorizationPrompts,
    clientId: stored.clientInfo?.client_id,
    refreshToken: stored.tokens?.refresh_token,
  });
} else if (action === 'refresh-cached') {
  // The cached-read path: the header-injection route every connect takes.
  const accessToken = await readCachedAccessToken(definition, logger);
  const stored = await snapshot();
  emit({
    accessMarker: marker(accessToken),
    persistedAccessMarker: marker(stored.tokens?.access_token),
    persistedRefreshMarker: marker(stored.tokens?.refresh_token),
  });
} else if (action === 'refresh-connect') {
  // The provider path: proactive authorization before an oauth connect.
  let authorizationPrompts = 0;
  const session = await createOAuthSession(definition, logger, {
    suppressBrowserLaunch: true,
    onAuthorizationUrl: () => {
      authorizationPrompts += 1;
    },
  });
  let refreshUnavailable = false;
  try {
    await connectWithAuth({ connect: async () => {} }, { close: async () => {} }, session, logger, {
      serverName: definition.name,
      serverUrl: endpoint,
      fetchFn: fetch,
    });
  } catch (error) {
    // The provider refuses to hand the SDK a redeemable stale token when a due
    // refresh could not land, so the connect fails instead of replaying it.
    if (!/Could not refresh OAuth credentials/.test(String(error?.message ?? error))) {
      throw error;
    }
    refreshUnavailable = true;
  } finally {
    // connectWithAuth only closes the session on its success path, and the
    // callback server would otherwise keep this fixture process alive.
    await session.close().catch(() => {});
  }
  const stored = await snapshot();
  emit({
    authorizationPrompts,
    refreshUnavailable,
    persistedAccessMarker: marker(stored.tokens?.access_token),
    persistedRefreshMarker: marker(stored.tokens?.refresh_token),
  });
} else if (action === 'redeem-without-persisting') {
  // Simulates a process killed between the token response and the persist: the
  // provider has rotated the refresh token, local state still holds the spent
  // one. The next caller replays it, which is what the recovery must absorb.
  const stored = await snapshot();
  const response = await fetch(new URL('/token', endpoint), {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: stored.tokens?.refresh_token ?? '',
      client_id: stored.clientInfo?.client_id ?? '',
    }),
  });
  emit({ redeemed: response.ok, persistSkipped: true });
} else if (action === 'hold-refresh-lock') {
  await withRefreshLock(definition, async () => {
    emit({ holding: true });
    await new Promise(() => {});
  });
} else {
  throw new Error(`Unknown action '${action}'.`);
}
