import { describe, expect, it } from 'vitest';
import { isStoredOAuthClientInformation, isStoredOAuthTokens } from '../src/oauth-credential-validation.js';

function validTokens(overrides: Record<string, unknown> = {}): unknown {
  return { access_token: 'tok', token_type: 'bearer', ...overrides };
}

describe('isStoredOAuthTokens', () => {
  it('accepts the minimal required shape', () => {
    expect(isStoredOAuthTokens(validTokens())).toBe(true);
  });

  it('accepts every optional field at its valid type', () => {
    expect(
      isStoredOAuthTokens(
        validTokens({
          refresh_token: 'refresh',
          scope: 'read write',
          issuer: 'https://issuer.example',
          expires_in: 3600,
          expires_at: 1_700_000_000,
          expiresAt: 1_700_000_000,
        })
      )
    ).toBe(true);
  });

  it('rejects non-record inputs', () => {
    expect(isStoredOAuthTokens(null)).toBe(false);
    expect(isStoredOAuthTokens(undefined)).toBe(false);
    expect(isStoredOAuthTokens('bearer')).toBe(false);
    expect(isStoredOAuthTokens(42)).toBe(false);
    expect(isStoredOAuthTokens(['access_token'])).toBe(false);
  });

  it('rejects a missing, empty, or non-string access_token', () => {
    expect(isStoredOAuthTokens({ token_type: 'bearer' })).toBe(false);
    expect(isStoredOAuthTokens(validTokens({ access_token: '' }))).toBe(false);
    expect(isStoredOAuthTokens(validTokens({ access_token: 123 }))).toBe(false);
  });

  it('rejects a missing, empty, or non-string token_type', () => {
    expect(isStoredOAuthTokens({ access_token: 'tok' })).toBe(false);
    expect(isStoredOAuthTokens(validTokens({ token_type: '' }))).toBe(false);
    expect(isStoredOAuthTokens(validTokens({ token_type: 123 }))).toBe(false);
  });

  it('rejects an optional string field carrying a non-string value', () => {
    expect(isStoredOAuthTokens(validTokens({ refresh_token: 1 }))).toBe(false);
    expect(isStoredOAuthTokens(validTokens({ scope: 1 }))).toBe(false);
    expect(isStoredOAuthTokens(validTokens({ issuer: 1 }))).toBe(false);
  });

  it('rejects an optional numeric field carrying a non-finite or non-number value', () => {
    expect(isStoredOAuthTokens(validTokens({ expires_in: Number.NaN }))).toBe(false);
    expect(isStoredOAuthTokens(validTokens({ expires_in: Number.POSITIVE_INFINITY }))).toBe(false);
    expect(isStoredOAuthTokens(validTokens({ expires_in: '3600' }))).toBe(false);
    expect(isStoredOAuthTokens(validTokens({ expires_at: Number.NaN }))).toBe(false);
    expect(isStoredOAuthTokens(validTokens({ expiresAt: Number.NaN }))).toBe(false);
  });
});

describe('isStoredOAuthClientInformation', () => {
  it('rejects non-record inputs', () => {
    expect(isStoredOAuthClientInformation(null)).toBe(false);
    expect(isStoredOAuthClientInformation('issuer')).toBe(false);
    expect(isStoredOAuthClientInformation(['issuer'])).toBe(false);
  });

  it('accepts a record with no issuer or a string issuer', () => {
    expect(isStoredOAuthClientInformation({})).toBe(true);
    expect(isStoredOAuthClientInformation({ client_id: 'abc' })).toBe(true);
    expect(isStoredOAuthClientInformation({ issuer: 'https://issuer.example' })).toBe(true);
  });

  it('rejects a record whose issuer is present but not a string', () => {
    expect(isStoredOAuthClientInformation({ issuer: 42 })).toBe(false);
  });
});
