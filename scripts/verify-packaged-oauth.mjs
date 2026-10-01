import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = path.resolve(process.argv[2]);
const requirePackage = createRequire(path.join(packageRoot, 'package.json'));
const { SSEClientTransport, StreamableHTTPClientTransport } = await import(
  pathToFileURL(requirePackage.resolve('@modelcontextprotocol/client')).href
);

for (const Transport of [StreamableHTTPClientTransport, SSEClientTransport]) {
  const tokens = { access_token: 'synthetic-oauth-token', token_type: 'Bearer', refresh_token: 'synthetic-refresh' };
  const stopped = new Error('synthetic unauthorized callback');
  let observed;
  const provider = {
    redirectUrl: undefined,
    clientMetadata: { redirect_uris: [] },
    clientInformation: () => undefined,
    tokens: () => tokens,
    saveTokens() {},
    redirectToAuthorization() {},
    saveCodeVerifier() {},
    codeVerifier: () => 'synthetic-verifier',
    async onOAuthUnauthorized(context) {
      observed = context.presentedTokens;
      throw stopped;
    },
  };
  const sent = [];
  const transport = new Transport(new URL('https://mcp.example.test/mcp'), {
    authProvider: provider,
    requestInit: { headers: { Authorization: 'Bearer synthetic-configured-token' } },
    fetch: async (_input, init) => {
      sent.push(new Headers(init?.headers).get('authorization'));
      return new Response(null, { status: 401 });
    },
  });
  try {
    await assert.rejects(async () => {
      await transport.start();
      await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    });
    assert.deepEqual(sent, ['Bearer synthetic-oauth-token']);
    assert.deepEqual(observed, tokens, `${Transport.name}: installed package lost OAuth token correlation`);
  } finally {
    await transport.close();
  }
}
console.log('Installed npm package preserves OAuth token correlation for HTTP and SSE.');
