import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { createKeepAliveRuntime } from '../src/daemon/runtime-wrapper.js';
import { createOAuthSession } from '../src/oauth.js';
import type { Runtime } from '../src/runtime.js';
import { createBridgeServer } from '../src/serve.js';

describe('bridged Streamable HTTP reauthorization concurrency', () => {
  let dataHome: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (dataHome) {
      await fs.rm(dataHome, { recursive: true, force: true });
    }
  });

  it('keeps a background GET 401 and bridged tools/list 401 in one pending authorization transaction', async () => {
    dataHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-get-post-oauth-'));
    vi.stubEnv('XDG_DATA_HOME', dataHome);
    installFakeCallbackServer();

    const resourceUrl = 'https://mcp.example.test/mcp';
    const authorizationServer = 'https://auth.example.test';
    const definition: ServerDefinition = {
      name: 'test-service-shape',
      command: { kind: 'http', url: new URL(resourceUrl) },
      auth: 'oauth',
      oauthClientId: 'test-client',
      oauthScope: 'mcp',
      lifecycle: { mode: 'keep-alive' },
      source: { kind: 'local', path: '/tmp/mcporter-get-post-oauth.json' },
    };
    const authorizationUrls: URL[] = [];
    const session = await createOAuthSession(
      definition,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      {
        suppressBrowserLaunch: true,
        onAuthorizationUrl: ({ authorizationUrl }) => {
          authorizationUrls.push(new URL(authorizationUrl));
        },
      }
    );
    const pendingCallback = session.waitForAuthorizationCode().catch(() => undefined);
    await session.provider.state?.();
    await session.provider.saveTokens({
      access_token: 'synthetic-initial-token',
      token_type: 'Bearer',
      expires_in: 3600,
    });

    let rejectProtectedResource = false;
    let normalGetCount = 0;
    let protectedRequestCount = 0;
    let releaseProtectedRequests!: () => void;
    const protectedRequestsReady = new Promise<void>((resolve) => {
      releaseProtectedRequests = resolve;
    });
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');

      if (url.href === resourceUrl && rejectProtectedResource) {
        protectedRequestCount += 1;
        if (protectedRequestCount === 2) {
          releaseProtectedRequests();
        }
        await protectedRequestsReady;
        return Response.json(
          { error: 'unauthorized' },
          {
            status: 401,
            headers: {
              'WWW-Authenticate': `Bearer resource_metadata="${authorizationServer}/.well-known/oauth-protected-resource"`,
            },
          }
        );
      }

      if (url.href === resourceUrl && method === 'GET') {
        normalGetCount += 1;
        return new Response(null, { status: 405 });
      }

      if (url.href === resourceUrl && method === 'POST') {
        const message = JSON.parse(init?.body as string) as { id?: number; method?: string };
        if (message.method === 'initialize') {
          return Response.json({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'synthetic-upstream', version: '1' },
            },
          });
        }
        if (message.method === 'notifications/initialized') {
          return new Response(null, { status: 202 });
        }
        if (message.method === 'tools/list') {
          return Response.json({
            jsonrpc: '2.0',
            id: message.id,
            result: { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] },
          });
        }
      }

      if (url.pathname.includes('oauth-protected-resource')) {
        return Response.json({
          resource: resourceUrl,
          authorization_servers: [authorizationServer],
          scopes_supported: ['mcp'],
        });
      }
      if (url.pathname.includes('oauth-authorization-server') || url.pathname.includes('openid-configuration')) {
        return Response.json({
          issuer: authorizationServer,
          authorization_endpoint: `${authorizationServer}/authorize`,
          token_endpoint: `${authorizationServer}/token`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          scopes_supported: ['mcp'],
        });
      }
      if (url.href === `${authorizationServer}/token` && method === 'POST') {
        return Response.json({
          access_token: 'synthetic-recovered-token',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      throw new Error(`Unexpected synthetic request: ${method} ${url}`);
    });

    const upstreamTransport = new StreamableHTTPClientTransport(new URL(resourceUrl), {
      authProvider: session.provider,
      fetch: fetchFn as unknown as typeof fetch,
    });
    const upstreamClient = new Client({ name: 'mcporter-daemon-shape', version: '0.12.4' });
    await upstreamClient.connect(upstreamTransport);
    await vi.waitFor(() => expect(normalGetCount).toBe(1));
    await session.provider.invalidateCredentials?.('tokens');

    const baseRuntime = makeBaseRuntime(definition);
    let daemonListCalls = 0;
    const daemon = {
      listTools: vi.fn(async () => {
        daemonListCalls += 1;
        if (rejectProtectedResource && daemonListCalls > 1) {
          throw new McpError(ErrorCode.InvalidParams, 'stop after the first bridged attempt');
        }
        return (await upstreamClient.listTools()).tools;
      }),
      callTool: vi.fn(),
      listResources: vi.fn(),
      readResource: vi.fn(),
      closeServer: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = createKeepAliveRuntime(baseRuntime, {
      daemonClient: daemon as never,
      keepAliveServers: new Set([definition.name]),
    });
    const bridge = createBridgeServer({ runtime, definitions: [definition], servers: [definition.name], bare: true });
    const codexClient = new Client({ name: 'codex-shape', version: '1' });
    const [codexTransport, bridgeTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([bridge.connect(bridgeTransport), codexClient.connect(codexTransport)]);

    rejectProtectedResource = true;
    const backgroundGet = (
      upstreamTransport as unknown as {
        _startOrAuthSse(options: { resumptionToken: undefined }): Promise<void>;
      }
    )._startOrAuthSse({ resumptionToken: undefined });
    const bridgedList = codexClient.listTools();

    try {
      await expect(Promise.allSettled([backgroundGet, bridgedList])).resolves.toEqual([
        expect.objectContaining({ status: 'rejected' }),
        expect.objectContaining({ status: 'rejected' }),
      ]);

      const persistedVerifier = await session.provider.codeVerifier();
      const persistedChallenge = crypto.createHash('sha256').update(persistedVerifier).digest('base64url');
      const summary = {
        authorizationCount: authorizationUrls.length,
        uniqueStates: new Set(authorizationUrls.map((url) => url.searchParams.get('state'))).size,
        uniqueRedirects: new Set(authorizationUrls.map((url) => url.searchParams.get('redirect_uri'))).size,
        uniqueClientIds: new Set(authorizationUrls.map((url) => url.searchParams.get('client_id'))).size,
        uniqueChallenges: new Set(authorizationUrls.map((url) => url.searchParams.get('code_challenge'))).size,
        challengesMatchingPersistedVerifier: authorizationUrls.filter(
          (url) => url.searchParams.get('code_challenge') === persistedChallenge
        ).length,
      };

      expect(summary).toEqual({
        authorizationCount: 1,
        uniqueStates: 1,
        uniqueRedirects: 1,
        uniqueClientIds: 1,
        uniqueChallenges: 1,
        challengesMatchingPersistedVerifier: 1,
      });

      rejectProtectedResource = false;
      await upstreamTransport.finishAuth('synthetic-authorization-code');
      await expect(codexClient.listTools()).resolves.toMatchObject({
        tools: [{ name: 'ping' }],
      });
    } finally {
      await codexClient.close().catch(() => {});
      await bridge.close().catch(() => {});
      await upstreamClient.close().catch(() => {});
      await session.close().catch(() => {});
      await pendingCallback;
    }
  });
});

function installFakeCallbackServer(): void {
  let fakeServer: http.Server;
  fakeServer = {
    listen: vi.fn((_port?: number, _host?: string, callback?: () => void) => {
      queueMicrotask(() => callback?.());
      return fakeServer;
    }),
    once: vi.fn(() => fakeServer),
    on: vi.fn(() => fakeServer),
    off: vi.fn(() => fakeServer),
    address: vi.fn(() => ({ address: '127.0.0.1', family: 'IPv4', port: 43123 })),
    closeAllConnections: vi.fn(),
    close: vi.fn((callback?: () => void) => {
      callback?.();
      return fakeServer;
    }),
  } as unknown as http.Server;
  vi.spyOn(http, 'createServer').mockReturnValue(fakeServer);
}

function makeBaseRuntime(definition: ServerDefinition): Runtime {
  return {
    listServers: () => [definition.name],
    getDefinitions: () => [definition],
    getDefinition: () => definition,
    registerDefinition: vi.fn(),
    getInstructions: vi.fn(),
    listTools: vi.fn(),
    callTool: vi.fn(),
    listResources: vi.fn(),
    readResource: vi.fn(),
    connect: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Runtime;
}
