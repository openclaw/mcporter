import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { vi } from 'vitest';
import type { ServerDefinition } from '../../src/config.js';
import type { Logger } from '../../src/logging.js';
import type { OAuthSession } from '../../src/oauth.js';

export const clientInfo = { name: 'mcporter', version: '0.0.0-test' };

export interface LoggerSpy extends Logger {
  info: ReturnType<typeof vi.fn<(message: string) => void>>;
  warn: ReturnType<typeof vi.fn<(message: string) => void>>;
  error: ReturnType<typeof vi.fn<(message: string, error?: unknown) => void>>;
}

export function createLogger(): LoggerSpy {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

export function resetLogger(logger: LoggerSpy): void {
  logger.info.mockReset();
  logger.warn.mockReset();
  logger.error.mockReset();
}

export function stubHttpDefinition(url: string): ServerDefinition {
  return {
    name: 'http-server',
    command: { kind: 'http', url: new URL(url) },
    source: { kind: 'local', path: '<adhoc>' },
  };
}

export function stubOAuthHttpDefinition(url: string): ServerDefinition {
  return {
    ...stubHttpDefinition(url),
    auth: 'oauth',
  };
}

export function createPromotionRecorder() {
  const promotedDefinitions: ServerDefinition[] = [];
  return {
    promotedDefinitions,
    onDefinitionPromoted: (promoted: ServerDefinition) => {
      promotedDefinitions.push(promoted);
    },
  };
}

export function createMockOAuthSession(): OAuthSession {
  return {
    provider: {
      waitForAuthorizationCode: vi.fn(),
    } as unknown as OAuthSession['provider'],
    waitForAuthorizationCode: vi.fn(),
    close: vi.fn(async () => {}),
  };
}

export class MockTransport implements Transport {
  public readonly calls: string[] = [];
  public readonly close = vi.fn(async () => {});

  constructor(private readonly finishAuthImpl?: (code: string, iss?: string) => Promise<void>) {}

  async start(): Promise<void> {}

  async send(_message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {}

  async finishAuth(code: string, iss?: string): Promise<void> {
    this.calls.push(code);
    if (this.finishAuthImpl) {
      await this.finishAuthImpl(code, iss);
    }
  }
}

export function createPendingAuthorizationSession() {
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
  return {
    session,
    waitForAuthorizationCode,
    pendingResolvers,
    resolveNextCode: (code: string) => {
      const resolve = pendingResolvers.shift();
      if (!resolve) {
        throw new Error(`Missing pending authorization resolver for '${code}'.`);
      }
      resolve(code);
    },
  };
}

export async function flushAuthLoop(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
