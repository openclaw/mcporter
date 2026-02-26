import type { Client } from '@modelcontextprotocol/sdk/client';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../src/logging.js';
import type { OAuthSession } from '../src/oauth.js';
import { connectWithAuth, OAuthCompletedError } from '../src/runtime/oauth.js';

// Minimal mock transport that records finishAuth calls.
class MockTransport implements Transport {
  public readonly calls: string[] = [];
  constructor(private readonly finishAuthImpl?: (code: string) => Promise<void>) {}
  async start(): Promise<void> {}
  async send(_message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {}
  async close(): Promise<void> {}
  async finishAuth(code: string): Promise<void> {
    this.calls.push(code);
    if (this.finishAuthImpl) {
      await this.finishAuthImpl(code);
    }
  }
}

describe('connectWithAuth', () => {
  it('waits for authorization code then throws OAuthCompletedError for fresh retry', async () => {
    // First connect throws Unauthorized; after finishAuth the function signals
    // the caller to create a fresh Client + Transport via OAuthCompletedError.
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

    // Simulate browser callback arrival.
    resolveCode('oauth-code-123');

    // After finishAuth() succeeds, connectWithAuth throws OAuthCompletedError
    // to signal the caller to create a fresh Client + Transport for retry.
    await expect(promise).rejects.toThrow(OAuthCompletedError);

    expect(waitForAuthorizationCode).toHaveBeenCalledTimes(1);
    expect(transport.calls).toEqual(['oauth-code-123']);
    // connect is called only once — the initial attempt that triggers 401.
    // The retry with a fresh transport is handled by the caller (createClientContext).
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('resolves normally when connect succeeds on first attempt', async () => {
    const connect = vi.fn().mockResolvedValueOnce(undefined);
    const client = { connect } as unknown as Client;
    const transport = new MockTransport();
    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    await connectWithAuth(client, transport, undefined, logger, {
      serverName: 'test-server',
      maxAttempts: 1,
    });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(transport.calls).toHaveLength(0);
  });
});
