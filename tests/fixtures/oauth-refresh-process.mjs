import { buildOAuthPersistence, readCachedAccessToken } from '../../dist/oauth-persistence.js';
import { createOAuthSession } from '../../dist/oauth.js';
import { connectWithAuth } from '../../dist/runtime/oauth.js';

const action = process.argv[2];
const endpoint = process.env.MCPORTER_TEST_OAUTH_ENDPOINT;
const tokenCacheDir = process.env.MCPORTER_TEST_OAUTH_CACHE_DIR;
if (!action || !endpoint || !tokenCacheDir) {
  throw new Error('Expected action, MCPORTER_TEST_OAUTH_ENDPOINT, and MCPORTER_TEST_OAUTH_CACHE_DIR.');
}

const definition = {
  name: 'oauth-refresh-process',
  command: { kind: 'http', url: new URL(endpoint) },
  auth: 'oauth',
  tokenCacheDir,
};
const logger = { info() {}, warn() {}, error() {}, debug() {} };

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
    refresh_token: 'fresh-process-refresh-token',
    expires_at: 1,
  });
  process.stdout.write('seeded\n');
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
  const snapshot = await (await buildOAuthPersistence(definition, logger)).readSnapshot();
  process.stdout.write(
    `${JSON.stringify({
      accessToken,
      authorizationPrompts,
      clientId: snapshot.clientInfo?.client_id,
      refreshToken: snapshot.tokens?.refresh_token,
    })}\n`
  );
} else {
  throw new Error(`Unknown action '${action}'.`);
}
