import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connectWithAuth: vi.fn(),
  createOAuthSession: vi.fn(),
  readCachedAccessToken: vi.fn(),
}));

vi.mock('../src/runtime/oauth.js', async () => {
  const actual = await vi.importActual('../src/runtime/oauth.js');
  return {
    ...actual,
    connectWithAuth: mocks.connectWithAuth,
  };
});

vi.mock('../src/oauth.js', async () => {
  const actual = await vi.importActual('../src/oauth.js');
  return {
    ...actual,
    createOAuthSession: mocks.createOAuthSession,
  };
});

vi.mock('../src/oauth-persistence.js', async () => {
  const actual = await vi.importActual('../src/oauth-persistence.js');
  return {
    ...actual,
    readCachedAccessToken: mocks.readCachedAccessToken,
  };
});

import type { ServerDefinition } from '../src/config.js';
import * as oauthModule from '../src/oauth.js';
import { markOAuthFlowError, markPostAuthConnectError } from '../src/runtime/oauth.js';
import { createClientContext } from '../src/runtime/transport.js';
import {
  clientInfo,
  createLogger,
  createMockOAuthSession,
  createPromotionRecorder,
  resetLogger,
  stubHttpDefinition,
  stubOAuthHttpDefinition,
} from './helpers/runtime-test-helpers.js';

const logger = createLogger();

beforeEach(() => {
  resetLogger(logger);
  mocks.connectWithAuth.mockReset();
  mocks.connectWithAuth.mockImplementation(async (client, transport) => {
    await client.connect(transport);
    return transport;
  });
  mocks.createOAuthSession.mockReset();
  mocks.createOAuthSession.mockResolvedValue(createMockOAuthSession());
  mocks.readCachedAccessToken.mockReset();
  mocks.readCachedAccessToken.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createClientContext (HTTP)', () => {
  it('falls back to SSE when primary connect fails', async () => {
    const definition = stubHttpDefinition('https://example.com/mcp');

    const clientConnect = vi
      .spyOn(Client.prototype, 'connect')
      .mockImplementationOnce(async (transport) => {
        expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
        throw new Error('network down');
      })
      .mockImplementationOnce(async (transport) => {
        expect(transport).toBeInstanceOf(SSEClientTransport);
      });

    const context = await createClientContext(definition, logger, clientInfo, { maxOAuthAttempts: 0 });

    expect(context.transport).toBeInstanceOf(SSEClientTransport);
    expect(clientConnect).toHaveBeenCalledTimes(2);
  });

  it('does not fall back to SSE after the OAuth flow fails', async () => {
    const definition = stubOAuthHttpDefinition('https://example.com/secure');

    mocks.connectWithAuth
      .mockImplementationOnce(async (_client, transport) => {
        expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
        throw markOAuthFlowError(new Error('OAuth error: invalid_client'));
      })
      .mockImplementationOnce(async (_client, transport) => {
        expect(transport).toBeInstanceOf(SSEClientTransport);
        return transport;
      });

    await expect(createClientContext(definition, logger, clientInfo, { maxOAuthAttempts: 1 })).rejects.toThrow(
      'OAuth error: invalid_client'
    );

    expect(mocks.connectWithAuth).toHaveBeenCalledTimes(1);
    const transports = mocks.connectWithAuth.mock.calls.map((call) => call[1]);
    expect(transports.every((transport) => transport instanceof StreamableHTTPClientTransport)).toBe(true);
    expect(transports.some((transport) => transport instanceof SSEClientTransport)).toBe(false);
  });

  it('still falls back to SSE after auth when Streamable HTTP reveals a 405 transport mismatch', async () => {
    const definition = stubOAuthHttpDefinition('https://example.com/legacy-sse');

    mocks.connectWithAuth
      .mockImplementationOnce(async (_client, transport) => {
        expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
        throw markPostAuthConnectError(new StreamableHTTPError(405, 'Failed to open SSE stream: Method Not Allowed'));
      })
      .mockImplementationOnce(async (_client, transport) => {
        expect(transport).toBeInstanceOf(SSEClientTransport);
        return transport;
      });

    const context = await createClientContext(definition, logger, clientInfo, { maxOAuthAttempts: 1 });

    expect(context.transport).toBeInstanceOf(SSEClientTransport);
    expect(mocks.connectWithAuth).toHaveBeenCalledTimes(2);
  });

  it('surfaces provider 405 errors after auth instead of falling back to SSE', async () => {
    const definition = stubOAuthHttpDefinition('https://example.com/provider-405');

    mocks.connectWithAuth
      .mockImplementationOnce(async (_client, transport) => {
        expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
        const error = new Error('token endpoint returned 405') as Error & { code: number };
        error.code = 405;
        throw markOAuthFlowError(error);
      })
      .mockImplementationOnce(async (_client, transport) => {
        expect(transport).toBeInstanceOf(SSEClientTransport);
        return transport;
      });

    await expect(createClientContext(definition, logger, clientInfo, { maxOAuthAttempts: 1 })).rejects.toThrow(
      'token endpoint returned 405'
    );

    expect(mocks.connectWithAuth).toHaveBeenCalledTimes(1);
  });

  it('still falls back to SSE after auth for generic 405 transport errors', async () => {
    const definition = stubOAuthHttpDefinition('https://example.com/legacy-sse-proxy');

    mocks.connectWithAuth
      .mockImplementationOnce(async (_client, transport) => {
        expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
        const error = new Error('proxy returned method not allowed') as Error & { status: number };
        error.status = 405;
        throw markPostAuthConnectError(error);
      })
      .mockImplementationOnce(async (_client, transport) => {
        expect(transport).toBeInstanceOf(SSEClientTransport);
        return transport;
      });

    const context = await createClientContext(definition, logger, clientInfo, { maxOAuthAttempts: 1 });

    expect(context.transport).toBeInstanceOf(SSEClientTransport);
    expect(mocks.connectWithAuth).toHaveBeenCalledTimes(2);
  });

  it('still falls back to SSE for oauth servers when no Streamable auth challenge was observed', async () => {
    const definition = stubOAuthHttpDefinition('https://example.com/sse-only');

    mocks.connectWithAuth
      .mockImplementationOnce(async (_client, transport) => {
        expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
        throw new Error('HTTP error 405: Method Not Allowed');
      })
      .mockImplementationOnce(async (_client, transport) => {
        expect(transport).toBeInstanceOf(SSEClientTransport);
        return transport;
      });

    const context = await createClientContext(definition, logger, clientInfo, { maxOAuthAttempts: 1 });

    expect(context.transport).toBeInstanceOf(SSEClientTransport);
    expect(mocks.connectWithAuth).toHaveBeenCalledTimes(2);
  });

  it('uses cached OAuth tokens for non-interactive HTTP connects even when auth is missing from config', async () => {
    const definition = stubHttpDefinition('https://example.com/secure');
    mocks.readCachedAccessToken.mockResolvedValue('cached-token');

    vi.spyOn(Client.prototype, 'connect').mockImplementationOnce(async (transport) => {
      expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
      const requestInit = (transport as { _requestInit?: RequestInit })._requestInit;
      expect(requestInit?.headers).toEqual({
        Authorization: 'Bearer cached-token',
      });
    });

    await createClientContext(definition, logger, clientInfo, {
      maxOAuthAttempts: 0,
      allowCachedAuth: true,
    });

    expect(mocks.createOAuthSession).not.toHaveBeenCalled();
    expect(mocks.readCachedAccessToken).toHaveBeenCalledWith(definition, logger);
  });

  it('preserves explicit Authorization headers for refreshable bearer HTTP servers', async () => {
    const definition: ServerDefinition = {
      ...stubHttpDefinition('https://example.com/secure'),
      auth: 'refreshable_bearer',
      refresh: { tokenEndpoint: 'https://auth.example.com/token' },
      command: {
        kind: 'http',
        url: new URL('https://example.com/secure'),
        headers: { Authorization: 'Bearer configured-token' },
      },
    };
    mocks.readCachedAccessToken.mockRejectedValue(new Error('invalid_grant'));

    vi.spyOn(Client.prototype, 'connect').mockImplementationOnce(async (transport) => {
      expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
      const requestInit = (transport as { _requestInit?: RequestInit })._requestInit;
      expect(requestInit?.headers).toEqual({ Authorization: 'Bearer configured-token' });
    });

    await createClientContext(definition, logger, clientInfo, { maxOAuthAttempts: 0 });

    expect(mocks.readCachedAccessToken).not.toHaveBeenCalled();
  });

  it('fails refreshable bearer HTTP configs with no cached token', async () => {
    const definition: ServerDefinition = {
      ...stubHttpDefinition('https://example.com/secure'),
      auth: 'refreshable_bearer',
      refresh: { tokenEndpoint: 'https://auth.example.com/token' },
    };
    mocks.readCachedAccessToken.mockResolvedValue(undefined);

    await expect(createClientContext(definition, logger, clientInfo, { maxOAuthAttempts: 0 })).rejects.toThrow(
      'no cached access token'
    );
  });

  it('injects refreshed bearer tokens into configured stdio env', async () => {
    const definition: ServerDefinition = {
      name: 'stdio-refresh',
      command: { kind: 'stdio', command: 'node', args: ['server.js'], cwd: '/tmp' },
      auth: 'refreshable_bearer',
      refresh: {
        tokenEndpoint: 'https://auth.example.com/token',
        accessTokenEnv: 'EXAMPLE_ACCESS_TOKEN',
      },
      env: { STATIC_ENV: '1' },
    };
    mocks.readCachedAccessToken.mockResolvedValue('cached-token');

    vi.spyOn(Client.prototype, 'connect').mockImplementationOnce(async (transport) => {
      expect(transport).toBeInstanceOf(StdioClientTransport);
      const params = (transport as { _serverParams?: { env?: Record<string, string> } })._serverParams;
      expect(params?.env).toEqual(expect.objectContaining({ STATIC_ENV: '1', EXAMPLE_ACCESS_TOKEN: 'cached-token' }));
    });

    await createClientContext(definition, logger, clientInfo, {
      maxOAuthAttempts: 0,
    });
  });

  it('fails refreshable bearer stdio configs that do not name the token env var', async () => {
    const definition: ServerDefinition = {
      name: 'stdio-refresh',
      command: { kind: 'stdio', command: 'node', args: ['server.js'], cwd: '/tmp' },
      auth: 'refreshable_bearer',
      refresh: {
        tokenEndpoint: 'https://auth.example.com/token',
      },
    };

    await expect(createClientContext(definition, logger, clientInfo, { maxOAuthAttempts: 0 })).rejects.toThrow(
      'missing refresh.accessTokenEnv'
    );
    expect(mocks.readCachedAccessToken).not.toHaveBeenCalled();
  });

  it('does not promote explicit refreshable bearer HTTP servers to OAuth after 401 errors', async () => {
    const definition: ServerDefinition = {
      ...stubHttpDefinition('https://example.com/secure'),
      auth: 'refreshable_bearer',
      refresh: { tokenEndpoint: 'https://auth.example.com/token' },
    };
    mocks.readCachedAccessToken.mockResolvedValue('cached-token');

    mocks.connectWithAuth.mockImplementationOnce(async (_client, transport) => {
      expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
      throw new Error('SSE error: Non-200 status code (401)');
    });

    await expect(createClientContext(definition, logger, clientInfo, { maxOAuthAttempts: 1 })).rejects.toThrow(
      'Non-200 status code (401)'
    );

    expect(mocks.createOAuthSession).not.toHaveBeenCalled();
    expect(mocks.connectWithAuth).toHaveBeenCalledTimes(1);
  });

  it('uses the HTTP/1.1 fetch compatibility path when configured', async () => {
    const definition: ServerDefinition = {
      ...stubHttpDefinition('https://example.com/mcp'),
      httpFetch: 'node-http1',
    };

    vi.spyOn(Client.prototype, 'connect').mockImplementationOnce(async (transport) => {
      expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
      const fetchOverride = (transport as { _fetch?: unknown })._fetch;
      expect(fetchOverride).toEqual(expect.any(Function));
    });

    await createClientContext(definition, logger, clientInfo, { maxOAuthAttempts: 0 });
  });

  it('uses the HTTP/1.1 fetch compatibility path for Sunsama by default', async () => {
    const definition = stubHttpDefinition('https://api.sunsama.com/mcp');

    vi.spyOn(Client.prototype, 'connect').mockImplementationOnce(async (transport) => {
      expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
      const fetchOverride = (transport as { _fetch?: unknown })._fetch;
      expect(fetchOverride).toEqual(expect.any(Function));
    });

    await createClientContext(definition, logger, clientInfo, { maxOAuthAttempts: 0 });
  });

  it('honors explicit default fetch mode for Sunsama', async () => {
    const definition: ServerDefinition = {
      ...stubHttpDefinition('https://api.sunsama.com/mcp'),
      httpFetch: 'default',
    };

    vi.spyOn(Client.prototype, 'connect').mockImplementationOnce(async (transport) => {
      expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
      const fetchOverride = (transport as { _fetch?: unknown })._fetch;
      expect(fetchOverride).toBeUndefined();
    });

    await createClientContext(definition, logger, clientInfo, { maxOAuthAttempts: 0 });
  });

  it('promotes ad-hoc HTTP servers after generic 401 errors from Streamable HTTP', async () => {
    const definition = stubHttpDefinition('https://example.com/secure');

    mocks.connectWithAuth
      .mockImplementationOnce(async (_client, transport) => {
        expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
        throw new Error('SSE error: Non-200 status code (401)');
      })
      .mockImplementationOnce(async (_client, transport, session) => {
        expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
        expect(session).toBeDefined();
        return transport;
      });

    const { promotedDefinitions, onDefinitionPromoted } = createPromotionRecorder();
    const context = await createClientContext(definition, logger, clientInfo, {
      maxOAuthAttempts: 1,
      onDefinitionPromoted,
    });

    expect(context.definition.auth).toBe('oauth');
    expect(mocks.createOAuthSession).toHaveBeenCalledTimes(1);
    expect(promotedDefinitions).toEqual([expect.objectContaining({ auth: 'oauth' })]);
    expect(mocks.connectWithAuth).toHaveBeenCalledTimes(2);
  });

  it('promotes ad-hoc HTTP servers after generic 401 errors from the SSE fallback path', async () => {
    const definition = stubHttpDefinition('https://example.com/sse-auth');

    mocks.connectWithAuth
      .mockImplementationOnce(async (_client, transport) => {
        expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
        throw new Error('HTTP error 405: Method Not Allowed');
      })
      .mockImplementationOnce(async (_client, transport) => {
        expect(transport).toBeInstanceOf(SSEClientTransport);
        throw new Error('SSE error: Non-200 status code (401)');
      })
      .mockImplementationOnce(async (_client, transport, session) => {
        expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
        expect(session).toBeDefined();
        return transport;
      });

    const { promotedDefinitions, onDefinitionPromoted } = createPromotionRecorder();
    const context = await createClientContext(definition, logger, clientInfo, {
      maxOAuthAttempts: 1,
      onDefinitionPromoted,
    });

    expect(context.definition.auth).toBe('oauth');
    expect(mocks.createOAuthSession).toHaveBeenCalledTimes(1);
    expect(promotedDefinitions).toEqual([expect.objectContaining({ auth: 'oauth' })]);
    expect(mocks.connectWithAuth).toHaveBeenCalledTimes(3);
  });

  it('drops static Authorization headers for oauth servers but preserves other headers', async () => {
    const definition: ServerDefinition = {
      ...stubHttpDefinition('https://example.com/secure'),
      auth: 'oauth',
      command: {
        kind: 'http',
        url: new URL('https://example.com/secure'),
        headers: {
          Authorization: 'Bearer static-token',
          'X-Trace': 'keep-me',
        },
      },
    };
    const createOAuthSessionSpy = vi.spyOn(oauthModule, 'createOAuthSession').mockResolvedValue({
      provider: {} as never,
      waitForAuthorizationCode: vi.fn(),
      close: vi.fn(async () => {}),
    });

    const clientConnect = vi.spyOn(Client.prototype, 'connect').mockImplementationOnce(async (transport) => {
      expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
      const requestInit = (transport as { _requestInit?: RequestInit })._requestInit;
      expect(requestInit?.headers).toEqual({ 'X-Trace': 'keep-me' });
    });

    const context = await createClientContext(definition, logger, clientInfo, { maxOAuthAttempts: 1 });

    expect(createOAuthSessionSpy).toHaveBeenCalledTimes(1);
    expect(clientConnect).toHaveBeenCalledTimes(1);
    await context.transport.close();
  });
});
