import {
  type OAuthClientProvider,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { expect, it, vi } from 'vitest';

it.each(['streamable', 'sse'] as const)(
  '%s correlates a rejected OAuth token when it overrides a configured Authorization header',
  async (kind) => {
    const tokens = { access_token: 'synthetic-oauth-token', token_type: 'Bearer', refresh_token: 'synthetic-refresh' };
    const stopped = new Error('stop after observing the unauthorized request');
    const onUnauthorized = vi.fn<NonNullable<OAuthClientProvider['onOAuthUnauthorized']>>(async () => {
      throw stopped;
    });
    const provider: OAuthClientProvider = {
      redirectUrl: undefined,
      clientMetadata: { redirect_uris: [] },
      clientInformation: () => undefined,
      tokens: () => tokens,
      saveTokens: vi.fn(),
      redirectToAuthorization: vi.fn(),
      saveCodeVerifier: vi.fn(),
      codeVerifier: () => 'synthetic-verifier',
      onOAuthUnauthorized: onUnauthorized,
    };
    const sent: Array<string | null> = [];
    const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get('authorization'));
      return new Response(null, { status: 401 });
    };
    const options = {
      authProvider: provider,
      requestInit: { headers: { Authorization: 'Bearer synthetic-configured-token' } },
      fetch: fetchFn,
    };
    const endpoint = new URL('https://mcp.example.test/mcp');
    const transport =
      kind === 'sse' ? new SSEClientTransport(endpoint, options) : new StreamableHTTPClientTransport(endpoint, options);
    try {
      const request = async () => {
        await transport.start();
        await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      };
      await expect(request()).rejects.toBe(stopped);
      expect(sent).toEqual(['Bearer synthetic-oauth-token']);
      expect(onUnauthorized).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ presentedTokens: tokens }),
        expect.any(Function)
      );
    } finally {
      await transport.close();
    }
  }
);
