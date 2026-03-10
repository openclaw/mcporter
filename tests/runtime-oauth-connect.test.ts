import type { Client } from '@modelcontextprotocol/sdk/client';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../src/logging.js';
import type { OAuthSession } from '../src/oauth.js';
import { connectWithAuth, isOAuthFlowError, isPostAuthConnectError } from '../src/runtime/oauth.js';

class MockTransport implements Transport {
  public readonly calls: string[] = [];
  public readonly close = vi.fn(async () => {});

  constructor(private readonly finishAuthImpl?: (code: string) => Promise<void>) {}
  async start(): Promise<void> {}
  async send(_message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {}
  async finishAuth(code: string): Promise<void> {
    this.calls.push(code);
    if (this.finishAuthImpl) {
      await this.finishAuthImpl(code);
    }
  }
}

describe('connectWithAuth', () => {
  it('waits for authorization code and retries connection', async () => {
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new UnauthorizedError('auth needed'))
      .mockResolvedValueOnce(undefined);
    const client = { connect } as unknown as Client;

    let resolveCode: (code: string) => void = () => {};
    const waitForAuthorizationCode = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveCode = resolve;
        })
    );
    const close = vi.fn(async () => {});
    const session: OAuthSession = {
      provider: { waitForAuthorizationCode } as unknown as OAuthSession['provider'],
      waitForAuthorizationCode,
      close,
    };

    const transport = new MockTransport();
    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const promise = connectWithAuth(client, transport, session, logger, {
      serverName: 'test-server',
      maxAttempts: 1,
      oauthTimeoutMs: 5000,
    });

    await new Promise((resolve) => setImmediate(resolve));
    resolveCode('oauth-code-123');

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

    let resolveCode: (code: string) => void = () => {};
    const waitForAuthorizationCode = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveCode = resolve;
        })
    );
    const session: OAuthSession = {
      provider: { waitForAuthorizationCode } as unknown as OAuthSession['provider'],
      waitForAuthorizationCode,
      close: vi.fn(async () => {}),
    };

    const transport = new MockTransport();
    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const promise = connectWithAuth(client, transport, session, logger, {
      serverName: 'test-server',
      maxAttempts: 1,
      oauthTimeoutMs: 5000,
    });

    await new Promise((resolve) => setImmediate(resolve));
    resolveCode('oauth-code-123');

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

    let resolveCode: (code: string) => void = () => {};
    const waitForAuthorizationCode = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveCode = resolve;
        })
    );
    const close = vi.fn(async () => {});
    const session: OAuthSession = {
      provider: { waitForAuthorizationCode } as unknown as OAuthSession['provider'],
      waitForAuthorizationCode,
      close,
    };

    const transport = new MockTransport();
    const replacement = new MockTransport();
    const recreateTransport = vi.fn(async () => replacement);
    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const promise = connectWithAuth(client, transport, session, logger, {
      serverName: 'test-server',
      maxAttempts: 1,
      oauthTimeoutMs: 5000,
      recreateTransport,
    });

    await new Promise((resolve) => setImmediate(resolve));
    resolveCode('oauth-code-123');

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

    let resolveCode: (code: string) => void = () => {};
    const waitForAuthorizationCode = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveCode = resolve;
        })
    );
    const session: OAuthSession = {
      provider: { waitForAuthorizationCode } as unknown as OAuthSession['provider'],
      waitForAuthorizationCode,
      close: vi.fn(async () => {}),
    };

    const transport = new MockTransport();
    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const promise = connectWithAuth(client, transport, session, logger, {
      serverName: 'test-server',
      maxAttempts: 1,
      oauthTimeoutMs: 5000,
    });

    await new Promise((resolve) => setImmediate(resolve));
    resolveCode('oauth-code-123');

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

    const pendingResolvers: Array<(code: string) => void> = [];
    const waitForAuthorizationCode = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          pendingResolvers.push(resolve);
        })
    );
    const session: OAuthSession = {
      provider: { waitForAuthorizationCode } as unknown as OAuthSession['provider'],
      waitForAuthorizationCode,
      close: vi.fn(async () => {}),
    };

    const transport = new MockTransport();
    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const promise = connectWithAuth(client, transport, session, logger, {
      serverName: 'test-server',
      maxAttempts: 2,
      oauthTimeoutMs: 5000,
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(pendingResolvers).toHaveLength(1);
    pendingResolvers.shift()?.('oauth-code-1');

    await new Promise((resolve) => setImmediate(resolve));
    expect(pendingResolvers).toHaveLength(1);
    pendingResolvers.shift()?.('oauth-code-2');

    const connectedTransport = await promise;

    expect(waitForAuthorizationCode).toHaveBeenCalledTimes(2);
    expect(transport.calls).toEqual(['oauth-code-1', 'oauth-code-2']);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(connectedTransport).toBe(transport);
  });

  it('marks finishAuth failures as oauth flow errors', async () => {
    const connect = vi.fn().mockRejectedValueOnce(new UnauthorizedError('auth needed'));
    const client = { connect } as unknown as Client;

    let resolveCode: (code: string) => void = () => {};
    const waitForAuthorizationCode = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveCode = resolve;
        })
    );
    const session: OAuthSession = {
      provider: { waitForAuthorizationCode } as unknown as OAuthSession['provider'],
      waitForAuthorizationCode,
      close: vi.fn(async () => {}),
    };

    const finishAuthError = new Error('token endpoint returned 405');
    const transport = new MockTransport(async () => {
      throw finishAuthError;
    });
    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const promise = connectWithAuth(client, transport, session, logger, {
      serverName: 'test-server',
      maxAttempts: 1,
      oauthTimeoutMs: 5000,
    });

    await new Promise((resolve) => setImmediate(resolve));
    resolveCode('oauth-code-123');

    await expect(promise).rejects.toSatisfy((error: unknown) => error === finishAuthError && isOAuthFlowError(error));
  });
});
