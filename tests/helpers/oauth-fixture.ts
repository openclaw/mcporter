import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** Synthetic OAuth discovery/DCR server; no provider accounts or browser required. */
export async function startOAuthFixture(
  options: {
    redirectUris?: (requested: string[]) => string[];
    scopes?: string[];
  } = {}
) {
  let origin = '';
  const registrations: Record<string, unknown>[] = [];
  const tokenRequests: URLSearchParams[] = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', origin);
    const json = (body: unknown, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname.includes('.well-known/oauth-protected-resource')) {
      json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: options.scopes });
    } else if (url.pathname.includes('.well-known/oauth-authorization-server')) {
      json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: options.scopes,
      });
    } else if (url.pathname === '/register' && request.method === 'POST') {
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      registrations.push(body);
      json(
        {
          ...body,
          client_id: `synthetic-client-${registrations.length}`,
          redirect_uris: options.redirectUris?.(body.redirect_uris as string[]) ?? body.redirect_uris,
        },
        201
      );
    } else if (url.pathname === '/token' && request.method === 'POST') {
      tokenRequests.push(new URLSearchParams(await readBody(request)));
      json({ access_token: 'synthetic-access-token', token_type: 'Bearer', expires_in: 3600 });
    } else {
      json({ error: 'not_found' }, 404);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    serverUrl: `${origin}/mcp`,
    registrations,
    tokenRequests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
