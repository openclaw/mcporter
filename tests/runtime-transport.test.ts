import {
  Client,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
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
import { budget } from './helpers/timing.js';
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
const STDIO_NEGOTIATION_FIXTURE = fileURLToPath(new URL('./servers/stdio-negotiation.mjs', import.meta.url));

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
  it('advertises both elicitation modes and registers the supplied handler', async () => {
    const definition = stubHttpDefinition('https://example.com/mcp');
    const elicitationHandler = vi.fn(async () => ({ action: 'decline' as const }));
    vi.spyOn(Client.prototype, 'connect').mockResolvedValueOnce(undefined);

    const context = await createClientContext(definition, logger, clientInfo, {
      maxOAuthAttempts: 0,
      elicitationHandler,
    });
    const internal = context.client as unknown as {
      _capabilities: { elicitation?: unknown };
      _getRequestHandler(method: string): unknown;
    };

    expect(internal._capabilities.elicitation).toEqual({ form: {}, url: {} });
    expect(internal._getRequestHandler('elicitation/create')).toBeTypeOf('function');
  });

  it.each([
    [undefined, 'auto'],
    ['auto', 'auto'],
    ['legacy', 'legacy'],
    ['2026-07-28', { pin: '2026-07-28' }],
  ] as const)('maps protocolVersion %s to the SDK negotiation mode', async (protocolVersion, expectedMode) => {
    const definition: ServerDefinition = {
      ...stubHttpDefinition('https://example.com/mcp'),
      protocolVersion,
    };
    vi.spyOn(Client.prototype, 'connect').mockResolvedValueOnce(undefined);

    const context = await createClientContext(definition, logger, clientInfo, { maxOAuthAttempts: 0 });
    const negotiation = (
      context.client as unknown as {
        _versionNegotiation?: { mode?: unknown; probe?: { timeoutMs?: number } };
      }
    )._versionNegotiation;
    expect(negotiation?.mode).toEqual(expectedMode);
    expect(negotiation?.probe).toBeUndefined();
  });

  it('uses the SDK default timeout for in-place stdio probes', async () => {
    const definition: ServerDefinition = {
      name: 'stdio-auto',
      command: { kind: 'stdio', command: 'node', args: ['unused.js'], cwd: '/tmp' },
    };
    vi.spyOn(Client.prototype, 'connect').mockResolvedValueOnce(undefined);

    const context = await createClientContext(definition, logger, clientInfo);
    const negotiation = (
      context.client as unknown as {
        _versionNegotiation?: { probe?: { timeoutMs?: number } };
      }
    )._versionNegotiation;
    expect(negotiation?.probe?.timeoutMs).toBe(60_000);
    expect(context.transport).toBeInstanceOf(StdioClientTransport);
  });

  it('accepts an environment override for the stdio probe timeout', async () => {
    const definition: ServerDefinition = {
      name: 'stdio-auto',
      command: { kind: 'stdio', command: 'node', args: ['unused.js'], cwd: '/tmp' },
    };
    vi.stubEnv('MCPORTER_STDIO_PROBE_TIMEOUT_MS', '12345');
    vi.spyOn(Client.prototype, 'connect').mockResolvedValueOnce(undefined);

    try {
      const context = await createClientContext(definition, logger, clientInfo);
      const negotiation = (
        context.client as unknown as {
          _versionNegotiation?: { probe?: { timeoutMs?: number } };
        }
      )._versionNegotiation;
      expect(negotiation?.probe?.timeoutMs).toBe(12_345);
    } finally {
      vi.unstubAllEnvs();
    }
  });

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

  it('uses a newly created legacy client for the SSE fallback', async () => {
    const definition = stubHttpDefinition('https://example.com/legacy-sse');
    const connectedClients: Client[] = [];

    mocks.connectWithAuth
      .mockImplementationOnce(async (client, transport) => {
        connectedClients.push(client);
        expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
        throw new Error('streamable transport unavailable');
      })
      .mockImplementationOnce(async (client, transport) => {
        connectedClients.push(client);
        expect(transport).toBeInstanceOf(SSEClientTransport);
        return transport;
      });

    const context = await createClientContext(definition, logger, clientInfo, { maxOAuthAttempts: 0 });
    const fallbackNegotiation = (connectedClients[1] as unknown as { _versionNegotiation?: { mode?: unknown } })
      ._versionNegotiation;

    expect(connectedClients).toHaveLength(2);
    expect(connectedClients[1]).not.toBe(connectedClients[0]);
    expect(fallbackNegotiation?.mode).toBe('legacy');
    expect(context.client).toBe(connectedClients[1]);
  });

  it.each([
    [
      'SdkError',
      new SdkError(
        SdkErrorCode.EraNegotiationFailed,
        'Version negotiation failed: the server did not offer pinned protocol version 2026-07-28 (no fallback in pin mode)'
      ),
    ],
    [
      'SdkHttpError',
      new SdkHttpError(
        SdkErrorCode.EraNegotiationFailed,
        'Version negotiation failed: the server did not offer pinned protocol version 2026-07-28 (no fallback in pin mode)',
        { status: 400 }
      ),
    ],
  ])('preserves pinned negotiation failures from %s without trying SSE', async (_kind, negotiationError) => {
    const definition: ServerDefinition = {
      ...stubHttpDefinition('https://example.com/legacy-only'),
      protocolVersion: '2026-07-28',
    };
    const clientConnect = vi
      .spyOn(Client.prototype, 'connect')
      .mockRejectedValueOnce(negotiationError)
      .mockRejectedValueOnce(new Error('SSE error: Non-200 status code (405)'));

    await expect(createClientContext(definition, logger, clientInfo, { maxOAuthAttempts: 0 })).rejects.toBe(
      negotiationError
    );

    expect(clientConnect).toHaveBeenCalledTimes(1);
    expect(clientConnect.mock.calls[0]?.[0]).toBeInstanceOf(StreamableHTTPClientTransport);
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
        throw markPostAuthConnectError(
          new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'Failed to open SSE stream: Method Not Allowed', {
            status: 405,
          })
        );
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

  it('isolates the standalone SSE channel from the default fetch pool', async () => {
    const definition = stubHttpDefinition('https://example.com/mcp');

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
      expect(fetchOverride).toEqual(expect.any(Function));
    });

    await createClientContext(definition, logger, clientInfo, { maxOAuthAttempts: 0 });
  });

  it('honors explicit default fetch mode for other HTTP servers', async () => {
    const definition: ServerDefinition = {
      ...stubHttpDefinition('https://example.com/mcp'),
      httpFetch: 'default',
    };

    vi.spyOn(Client.prototype, 'connect').mockImplementationOnce(async (transport) => {
      expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
      const fetchOverride = (transport as { _fetch?: unknown })._fetch;
      expect(fetchOverride).toEqual(expect.any(Function));
    });

    await createClientContext(definition, logger, clientInfo, { maxOAuthAttempts: 0 });
  });

  it('does not create OAuth sessions for OAuth HTTP servers when disableOAuth is true', async () => {
    const definition = stubOAuthHttpDefinition('https://example.com/secure');

    mocks.connectWithAuth.mockImplementationOnce(async (_client, transport, session) => {
      expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
      expect(session).toBeUndefined();
      return transport;
    });

    const context = await createClientContext(definition, logger, clientInfo, {
      disableOAuth: true,
      allowCachedAuth: true,
    });

    expect(context.definition.auth).toBe('oauth');
    expect(mocks.createOAuthSession).not.toHaveBeenCalled();
    expect(mocks.connectWithAuth).toHaveBeenCalledTimes(1);
  });

  it('does not promote ad-hoc HTTP servers after Streamable 401 when disableOAuth is true', async () => {
    const definition = stubHttpDefinition('https://example.com/secure');

    mocks.connectWithAuth
      .mockImplementationOnce(async (_client, transport, session) => {
        expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
        expect(session).toBeUndefined();
        throw new Error('SSE error: Non-200 status code (401)');
      })
      .mockImplementationOnce(async (_client, transport, session) => {
        expect(transport).toBeInstanceOf(SSEClientTransport);
        expect(session).toBeUndefined();
        return transport;
      });

    const { promotedDefinitions, onDefinitionPromoted } = createPromotionRecorder();
    const context = await createClientContext(definition, logger, clientInfo, {
      disableOAuth: true,
      onDefinitionPromoted,
    });

    expect(context.definition.auth).toBeUndefined();
    expect(mocks.createOAuthSession).not.toHaveBeenCalled();
    expect(promotedDefinitions).toEqual([]);
    expect(mocks.connectWithAuth).toHaveBeenCalledTimes(2);
  });

  it('does not promote ad-hoc HTTP servers after SSE 401 when disableOAuth is true', async () => {
    const definition = stubHttpDefinition('https://example.com/sse-auth');

    mocks.connectWithAuth
      .mockImplementationOnce(async (_client, transport, session) => {
        expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
        expect(session).toBeUndefined();
        throw new Error('HTTP error 405: Method Not Allowed');
      })
      .mockImplementationOnce(async (_client, transport, session) => {
        expect(transport).toBeInstanceOf(SSEClientTransport);
        expect(session).toBeUndefined();
        throw new Error('SSE error: Non-200 status code (401)');
      });

    const { promotedDefinitions, onDefinitionPromoted } = createPromotionRecorder();
    await expect(
      createClientContext(definition, logger, clientInfo, {
        disableOAuth: true,
        onDefinitionPromoted,
      })
    ).rejects.toThrow('Non-200 status code (401)');

    expect(mocks.createOAuthSession).not.toHaveBeenCalled();
    expect(promotedDefinitions).toEqual([]);
    expect(mocks.connectWithAuth).toHaveBeenCalledTimes(2);
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

describe('createClientContext (stdio negotiation)', () => {
  function stdioDefinition(mode: 'legacy-exit' | 'modern'): ServerDefinition {
    return {
      name: `stdio-${mode}`,
      command: {
        kind: 'stdio',
        command: process.execPath,
        args: [STDIO_NEGOTIATION_FIXTURE, mode],
        cwd: process.cwd(),
      },
    };
  }

  it('retries with a fresh legacy process when the discovery probe kills the first process', async () => {
    const context = await createClientContext(stdioDefinition('legacy-exit'), logger, clientInfo);
    try {
      expect(context.client.getProtocolEra()).toBe('legacy');
      await expect(context.client.listTools()).resolves.toMatchObject({
        tools: [expect.objectContaining({ name: 'legacy_ping' })],
      });
    } finally {
      await context.client.close();
    }
  });

  it('keeps a modern stdio server on the discovered modern connection', async () => {
    const context = await createClientContext(stdioDefinition('modern'), logger, clientInfo);
    try {
      expect(context.client.getProtocolEra()).toBe('modern');
      await expect(context.client.listTools()).resolves.toMatchObject({
        tools: [expect.objectContaining({ name: 'modern_ping' })],
      });
    } finally {
      await context.client.close();
    }
  });

  it(
    'waits longer than three seconds for a slow modern discovery response',
    async () => {
      const baseDefinition = stdioDefinition('modern');
      if (baseDefinition.command.kind !== 'stdio') throw new Error('Expected stdio fixture definition.');
      const definition: ServerDefinition = {
        ...baseDefinition,
        command: {
          ...baseDefinition.command,
          args: [...(baseDefinition.command.args ?? []), '3200'],
        },
      };

      const context = await createClientContext(definition, logger, clientInfo);
      try {
        expect(context.client.getProtocolEra()).toBe('modern');
        await expect(context.client.listTools()).resolves.toMatchObject({
          tools: [expect.objectContaining({ name: 'modern_ping' })],
        });
      } finally {
        await context.client.close();
      }
    },
    budget(10_000)
  );
});
