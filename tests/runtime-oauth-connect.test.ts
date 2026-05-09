import type { Client } from '@modelcontextprotocol/sdk/client';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthSession } from '../src/oauth.js';
import {
  connectWithAuth,
  isOAuthFlowError,
  isPostAuthConnectError,
  OAuthAuthorizationNotStartedError,
} from '../src/runtime/oauth.js';
import {
  createLogger,
  createPendingAuthorizationSession,
  flushAuthLoop,
  MockTransport,
} from './helpers/runtime-test-helpers.js';

const mocks = vi.hoisted(() => ({
  sdkAuth: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/auth.js', async () => {
  const actual = await vi.importActual('@modelcontextprotocol/sdk/client/auth.js');
  return {
    ...actual,
    auth: mocks.sdkAuth,
  };
});

describe('connectWithAuth', () => {
  beforeEach(() => {
    mocks.sdkAuth.mockReset();
    mocks.sdkAuth.mockResolvedValue('AUTHORIZED');
  });

  it('waits for authorization code and retries connection', async () => {
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new UnauthorizedError('auth needed'))
      .mockResolvedValueOnce(undefined);
    const client = { connect } as unknown as Client;

    const { session, waitForAuthorizationCode, resolveNextCode } = createPendingAuthorizationSession();

    const transport = new MockTransport();
    const logger = createLogger();

    const promise = connectWithAuth(client, transport, session, logger, {
      serverName: 'test-server',
      maxAttempts: 1,
      oauthTimeoutMs: 5000,
    });

    await flushAuthLoop();
    resolveNextCode('oauth-code-123');

    const connectedTransport = await promise;

    expect(waitForAuthorizationCode).toHaveBeenCalledTimes(1);
    expect(transport.calls).toEqual(['oauth-code-123']);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connectedTransport).toBe(transport);
  });

  it('treats generic 401 transport errors as OAuth challenges', async () => {
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error('SSE error: Non-200 status code (401)'))
      .mockResolvedValueOnce(undefined);
    const client = { connect } as unknown as Client;

    const { session, waitForAuthorizationCode, resolveNextCode } = createPendingAuthorizationSession();

    const transport = new MockTransport();
    const logger = createLogger();

    const promise = connectWithAuth(client, transport, session, logger, {
      serverName: 'test-server',
      maxAttempts: 1,
      oauthTimeoutMs: 5000,
    });

    await flushAuthLoop();
    resolveNextCode('oauth-code-123');

    const connectedTransport = await promise;

    expect(waitForAuthorizationCode).toHaveBeenCalledTimes(1);
    expect(transport.calls).toEqual(['oauth-code-123']);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connectedTransport).toBe(transport);
  });

  it('recreates the transport after finishAuth when requested', async () => {
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new UnauthorizedError('auth needed'))
      .mockResolvedValueOnce(undefined);
    const client = { connect } as unknown as Client;

    const { session, resolveNextCode } = createPendingAuthorizationSession();

    const transport = new MockTransport();
    const replacement = new MockTransport();
    const recreateTransport = vi.fn(async () => replacement);
    const logger = createLogger();

    const promise = connectWithAuth(client, transport, session, logger, {
      serverName: 'test-server',
      maxAttempts: 1,
      oauthTimeoutMs: 5000,
      recreateTransport,
    });

    await flushAuthLoop();
    resolveNextCode('oauth-code-123');

    const connectedTransport = await promise;

    expect(recreateTransport).toHaveBeenCalledWith(transport);
    expect(transport.calls).toEqual(['oauth-code-123']);
    expect(connect).toHaveBeenNthCalledWith(1, transport);
    expect(connect).toHaveBeenNthCalledWith(2, replacement);
    expect(connectedTransport).toBe(replacement);
  });

  it('marks reconnect failures after auth as post-auth transport errors', async () => {
    const reconnectError = new Error('HTTP error 405: Method Not Allowed');
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new UnauthorizedError('auth needed'))
      .mockRejectedValueOnce(reconnectError);
    const client = { connect } as unknown as Client;

    const { session, resolveNextCode } = createPendingAuthorizationSession();

    const transport = new MockTransport();
    const logger = createLogger();

    const promise = connectWithAuth(client, transport, session, logger, {
      serverName: 'test-server',
      maxAttempts: 1,
      oauthTimeoutMs: 5000,
    });

    await flushAuthLoop();
    resolveNextCode('oauth-code-123');

    await expect(promise).rejects.toSatisfy(
      (error: unknown) => error === reconnectError && isPostAuthConnectError(error)
    );
  });

  it('retries unauthorized reconnects after completing auth', async () => {
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new UnauthorizedError('initial auth needed'))
      .mockRejectedValueOnce(new UnauthorizedError('token not active yet'))
      .mockResolvedValueOnce(undefined);
    const client = { connect } as unknown as Client;

    const { session, waitForAuthorizationCode, pendingResolvers, resolveNextCode } =
      createPendingAuthorizationSession();

    const transport = new MockTransport();
    const logger = createLogger();

    const promise = connectWithAuth(client, transport, session, logger, {
      serverName: 'test-server',
      maxAttempts: 2,
      oauthTimeoutMs: 5000,
    });

    await flushAuthLoop();
    expect(pendingResolvers).toHaveLength(1);
    resolveNextCode('oauth-code-1');

    await flushAuthLoop();
    expect(pendingResolvers).toHaveLength(1);
    resolveNextCode('oauth-code-2');

    const connectedTransport = await promise;

    expect(waitForAuthorizationCode).toHaveBeenCalledTimes(2);
    expect(transport.calls).toEqual(['oauth-code-1', 'oauth-code-2']);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(connectedTransport).toBe(transport);
  });

  it('runs proactive OAuth after unauthenticated connect succeeds', async () => {
    const connect = vi.fn().mockResolvedValueOnce(undefined);
    const client = { connect } as unknown as Client;
    const { session, waitForAuthorizationCode, resolveNextCode } = createPendingAuthorizationSession();
    mocks.sdkAuth.mockResolvedValueOnce('REDIRECT');

    const transport = new MockTransport();
    const logger = createLogger();

    const promise = connectWithAuth(client, transport, session, logger, {
      serverName: 'calendar',
      maxAttempts: 1,
      oauthTimeoutMs: 5000,
      serverUrl: new URL('https://calendar.example/mcp'),
    });

    await flushAuthLoop();
    resolveNextCode('proactive-code');

    const connectedTransport = await promise;

    expect(mocks.sdkAuth).toHaveBeenCalledWith(session.provider, {
      serverUrl: new URL('https://calendar.example/mcp'),
      fetchFn: undefined,
    });
    expect(waitForAuthorizationCode).toHaveBeenCalledTimes(1);
    expect(transport.calls).toEqual(['proactive-code']);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(session.close).toHaveBeenCalled();
    expect(connectedTransport).toBe(transport);
  });

  it('closes proactive OAuth sessions when cached tokens already authorize', async () => {
    const connect = vi.fn().mockResolvedValueOnce(undefined);
    const client = { connect } as unknown as Client;
    const { session, waitForAuthorizationCode } = createPendingAuthorizationSession();
    mocks.sdkAuth.mockResolvedValueOnce('AUTHORIZED');

    const transport = new MockTransport();
    const logger = createLogger();

    const connectedTransport = await connectWithAuth(client, transport, session, logger, {
      serverName: 'calendar',
      maxAttempts: 1,
      oauthTimeoutMs: 5000,
      serverUrl: 'https://calendar.example/mcp',
    });

    expect(waitForAuthorizationCode).not.toHaveBeenCalled();
    expect(transport.calls).toEqual([]);
    expect(session.close).toHaveBeenCalled();
    expect(connectedTransport).toBe(transport);
  });

  it('marks proactive OAuth failures as OAuth flow errors', async () => {
    const connect = vi.fn().mockResolvedValueOnce(undefined);
    const client = { connect } as unknown as Client;
    const { session } = createPendingAuthorizationSession();
    const authError = new Error('dynamic client registration rejected');
    mocks.sdkAuth.mockRejectedValueOnce(authError);

    const transport = new MockTransport();
    const logger = createLogger();

    await expect(
      connectWithAuth(client, transport, session, logger, {
        serverName: 'calendar',
        maxAttempts: 1,
        oauthTimeoutMs: 5000,
        serverUrl: 'https://calendar.example/mcp',
      })
    ).rejects.toSatisfy((error: unknown) => error === authError && isOAuthFlowError(error));
  });

  it('marks finishAuth failures as oauth flow errors', async () => {
    const connect = vi.fn().mockRejectedValueOnce(new UnauthorizedError('auth needed'));
    const client = { connect } as unknown as Client;

    const { session, resolveNextCode } = createPendingAuthorizationSession();

    const finishAuthError = new Error('token endpoint returned 405');
    const transport = new MockTransport(async () => {
      throw finishAuthError;
    });
    const logger = createLogger();

    const promise = connectWithAuth(client, transport, session, logger, {
      serverName: 'test-server',
      maxAttempts: 1,
      oauthTimeoutMs: 5000,
    });

    await flushAuthLoop();
    resolveNextCode('oauth-code-123');

    await expect(promise).rejects.toSatisfy((error: unknown) => error === finishAuthError && isOAuthFlowError(error));
  });

  it('fails immediately when OAuth never produced an authorization URL', async () => {
    const connectError = new UnauthorizedError('dynamic client registration rejected');
    const connect = vi.fn().mockRejectedValueOnce(connectError);
    const client = { connect } as unknown as Client;
    const waitForAuthorizationCode = vi.fn(() => new Promise<string>(() => {}));
    const session = {
      provider: {
        waitForAuthorizationCode,
        hasAuthorizationRedirectStarted: () => false,
      },
      waitForAuthorizationCode,
      hasAuthorizationRedirectStarted: () => false,
      close: vi.fn(async () => {}),
    } as unknown as OAuthSession;
    const transport = new MockTransport();
    const logger = createLogger();

    await expect(
      connectWithAuth(client, transport, session, logger, {
        serverName: 'figma',
        maxAttempts: 1,
        oauthTimeoutMs: 5000,
      })
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof OAuthAuthorizationNotStartedError && isOAuthFlowError(error)
    );

    expect(waitForAuthorizationCode).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('Waiting for browser approval'));
    expect(logger.error).toHaveBeenCalledWith(
      'OAuth authorization could not start.',
      expect.any(OAuthAuthorizationNotStartedError)
    );
  });

  it('truncates oversized OAuth startup error details', () => {
    const hugeHtml = `<html>${'x'.repeat(5000)}</html>`;
    const error = new OAuthAuthorizationNotStartedError('shadcn', new Error(`HTTP 404 raw body: ${hugeHtml}`));

    expect(error.message.length).toBeLessThan(1800);
    expect(error.message).toContain('[truncated ');
    expect(error.message).not.toContain(hugeHtml);
  });
});
