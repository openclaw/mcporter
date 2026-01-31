import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { describe, expect, it, vi } from 'vitest';

import type { ServerDefinition } from '../src/config.js';
import { isUnauthorizedError, maybeEnableOAuth } from '../src/runtime-oauth-support.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('maybeEnableOAuth', () => {
  const baseDefinition: ServerDefinition = {
    name: 'adhoc-server',
    command: { kind: 'http', url: new URL('https://example.com/mcp') },
    source: { kind: 'local', path: '<adhoc>' },
  };

  it('returns an updated definition for ad-hoc HTTP servers', () => {
    const updated = maybeEnableOAuth(baseDefinition, logger as never);
    expect(updated).toBeDefined();
    expect(updated?.auth).toBe('oauth');
    expect(updated?.tokenCacheDir).toBeUndefined();
    expect(logger.info).toHaveBeenCalled();
  });

  it('enables OAuth for non-ad-hoc HTTP servers (issue #38)', () => {
    const def: ServerDefinition = {
      name: 'local-server',
      command: { kind: 'http', url: new URL('https://example.com') },
      source: { kind: 'local', path: '/tmp/config.json' },
    };
    const updated = maybeEnableOAuth(def, logger as never);
    expect(updated).toBeDefined();
    expect(updated?.auth).toBe('oauth');
  });
});

describe('isUnauthorizedError helper', () => {
  it('matches UnauthorizedError instances', () => {
    const err = new UnauthorizedError('Unauthorized');
    expect(isUnauthorizedError(err)).toBe(true);
  });

  it('matches generic errors with 401 codes', () => {
    expect(isUnauthorizedError(new Error('SSE error: Non-200 status code (401)'))).toBe(true);
  });

  it('ignores unrelated errors', () => {
    expect(isUnauthorizedError(new Error('network timeout'))).toBe(false);
  });
});
