import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connectWithAuth: vi.fn(),
  createOAuthSession: vi.fn(),
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

import type { ServerDefinition } from '../src/config.js';
import * as oauthModule from '../src/oauth.js';
import { markOAuthFlowError, markPostAuthConnectError } from '../src/runtime/oauth.js';
import { createClientContext } from '../src/runtime/transport.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const clientInfo = { name: 'mcporter', version: '0.0.0-test' };

beforeEach(() => {
  mocks.connectWithAuth.mockReset();
  mocks.connectWithAuth.mockImplementation(async (client, transport) => {
    await client.connect(transport);
    return transport;
  });
  mocks.createOAuthSession.mockReset();
  mocks.createOAuthSession.mockResolvedValue({
    provider: {
      waitForAuthorizationCode: vi.fn(),
    },
    waitForAuthorizationCode: vi.fn(),
    close: vi.fn(async () => {}),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function stubHttpDefinition(url: string): ServerDefinition {
  return {
    name: 'http-server',
    command: { kind: 'http', url: new URL(url) },
    source: { kind: 'local', path: '<adhoc>' },
  };
}

describe('createClientContext (HTTP)', () => {
  it('falls back to SSE when primary connect fails', async () => {
    const definition = stubHttpDefinition('https://example.com/mcp');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

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
    const definition: ServerDefinition = {
      ...stubHttpDefinition('https://example.com/secure'),
      auth: 'oauth',
    };
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

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
    const definition: ServerDefinition = {
      ...stubHttpDefinition('https://example.com/legacy-sse'),
      auth: 'oauth',
    };
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

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
    const definition: ServerDefinition = {
      ...stubHttpDefinition('https://example.com/provider-405'),
      auth: 'oauth',
    };
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

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
    const definition: ServerDefinition = {
      ...stubHttpDefinition('https://example.com/legacy-sse-proxy'),
      auth: 'oauth',
    };
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

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
    const definition: ServerDefinition = {
      ...stubHttpDefinition('https://example.com/sse-only'),
      auth: 'oauth',
    };
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

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

  it('promotes ad-hoc HTTP servers after generic 401 errors from Streamable HTTP', async () => {
    const definition = stubHttpDefinition('https://example.com/secure');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

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

    const promotedDefinitions: ServerDefinition[] = [];
    const context = await createClientContext(definition, logger, clientInfo, {
      maxOAuthAttempts: 1,
      onDefinitionPromoted: (promoted) => {
        promotedDefinitions.push(promoted);
      },
    });

    expect(context.definition.auth).toBe('oauth');
    expect(mocks.createOAuthSession).toHaveBeenCalledTimes(1);
    expect(promotedDefinitions).toEqual([expect.objectContaining({ auth: 'oauth' })]);
    expect(mocks.connectWithAuth).toHaveBeenCalledTimes(2);
  });

  it('promotes ad-hoc HTTP servers after generic 401 errors from the SSE fallback path', async () => {
    const definition = stubHttpDefinition('https://example.com/sse-auth');
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

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

    const promotedDefinitions: ServerDefinition[] = [];
    const context = await createClientContext(definition, logger, clientInfo, {
      maxOAuthAttempts: 1,
      onDefinitionPromoted: (promoted) => {
        promotedDefinitions.push(promoted);
      },
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
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
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
