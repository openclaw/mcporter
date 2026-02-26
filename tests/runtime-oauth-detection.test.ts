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

  it('promotes configured HTTP servers on 401 (not just ad-hoc)', () => {
    const def: ServerDefinition = {
      name: 'configured-server',
      command: { kind: 'http', url: new URL('https://example.com') },
      source: { kind: 'local', path: '/tmp/config.json' },
    };
    const updated = maybeEnableOAuth(def, logger as never);
    expect(updated).toBeDefined();
    expect(updated?.auth).toBe('oauth');
  });

  it('promotes imported HTTP servers (e.g. from claude-code)', () => {
    const def: ServerDefinition = {
      name: 'datadog',
      command: { kind: 'http', url: new URL('https://mcp.datadoghq.eu/api/unstable/mcp-server/mcp') },
      source: { kind: 'import', path: '~/.claude/settings.json', importKind: 'claude-code' },
    };
    const updated = maybeEnableOAuth(def, logger as never);
    expect(updated).toBeDefined();
    expect(updated?.auth).toBe('oauth');
  });

  it('does not promote servers that already have auth: oauth', () => {
    const def: ServerDefinition = {
      ...baseDefinition,
      auth: 'oauth',
    };
    const updated = maybeEnableOAuth(def, logger as never);
    expect(updated).toBeUndefined();
  });

  it('does not promote stdio servers', () => {
    const def: ServerDefinition = {
      name: 'stdio-server',
      command: { kind: 'stdio', command: 'node', args: ['server.js'], cwd: '/tmp' },
    };
    const updated = maybeEnableOAuth(def, logger as never);
    expect(updated).toBeUndefined();
  });

  it('does not promote when autoOAuth is explicitly false', () => {
    const def: ServerDefinition = {
      name: 'no-auto-oauth',
      command: { kind: 'http', url: new URL('https://example.com') },
      autoOAuth: false,
    };
    const updated = maybeEnableOAuth(def, logger as never);
    expect(updated).toBeUndefined();
  });

  it('promotes when autoOAuth is explicitly true', () => {
    const def: ServerDefinition = {
      name: 'yes-auto-oauth',
      command: { kind: 'http', url: new URL('https://example.com') },
      autoOAuth: true,
    };
    const updated = maybeEnableOAuth(def, logger as never);
    expect(updated).toBeDefined();
    expect(updated?.auth).toBe('oauth');
  });

  it('includes source info in log message', () => {
    const infoSpy = vi.fn();
    const testLogger = { info: infoSpy, warn: vi.fn(), error: vi.fn() };
    const def: ServerDefinition = {
      name: 'imported-server',
      command: { kind: 'http', url: new URL('https://example.com') },
      source: { kind: 'import', path: '~/.claude/settings.json', importKind: 'claude-code' },
    };
    maybeEnableOAuth(def, testLogger as never);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('claude-code')
    );
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
