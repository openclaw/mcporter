import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { describe, expect, it } from 'vitest';
import {
  sameOAuthClientGeneration,
  sameOAuthClientValue,
  sameOAuthTokenGeneration,
  sameOAuthTokenValue,
  withHiddenOAuthClientGeneration,
  withHiddenOAuthTokenGeneration,
  withOAuthClientGeneration,
  withOAuthTokenGeneration,
} from '../src/oauth-token-generation.js';

const baseTokens = { access_token: 'tok-abc', token_type: 'Bearer' } as OAuthTokens;
const baseClient = { client_id: 'client-xyz' } as OAuthClientInformationMixed;

describe('withOAuthTokenGeneration', () => {
  it('stamps a new enumerable generation on tokens that lack one, without mutating the input', () => {
    const stamped = withOAuthTokenGeneration(baseTokens);
    expect(sameOAuthTokenValue(stamped, baseTokens)).toBe(true);
    expect(Object.keys(stamped)).toHaveLength(Object.keys(baseTokens).length + 1);
    expect(Object.keys(baseTokens)).toEqual(['access_token', 'token_type']);
  });

  it('reuses an existing generation instead of minting a new one', () => {
    const stamped = withOAuthTokenGeneration(baseTokens);
    const restamped = withOAuthTokenGeneration(stamped);
    expect(sameOAuthTokenGeneration(restamped, stamped)).toBe(true);
  });

  it('mints distinct generations across independent stamps of the same value', () => {
    const a = withOAuthTokenGeneration(baseTokens);
    const b = withOAuthTokenGeneration(baseTokens);
    expect(sameOAuthTokenValue(a, b)).toBe(true);
    expect(sameOAuthTokenGeneration(a, b)).toBe(false);
  });
});

describe('withHiddenOAuthTokenGeneration', () => {
  it('hides the generation from enumeration/serialization while keeping it recoverable', () => {
    const stamped = withOAuthTokenGeneration(baseTokens);
    const hidden = withHiddenOAuthTokenGeneration(stamped);
    expect(Object.keys(hidden)).toHaveLength(Object.keys(baseTokens).length);
    expect(JSON.parse(JSON.stringify(hidden))).toEqual({ access_token: 'tok-abc', token_type: 'Bearer' });
    expect(sameOAuthTokenGeneration(hidden, stamped)).toBe(true);
  });

  it('returns the input unchanged when there is no generation to hide', () => {
    expect(withHiddenOAuthTokenGeneration(baseTokens)).toBe(baseTokens);
  });
});

describe('sameOAuthTokenValue', () => {
  it('compares public values, ignoring only the internal generation', () => {
    const stamped = withOAuthTokenGeneration(baseTokens);
    expect(sameOAuthTokenValue(stamped, baseTokens)).toBe(true);
    const other = { access_token: 'different', token_type: 'Bearer' } as OAuthTokens;
    expect(sameOAuthTokenValue(baseTokens, other)).toBe(false);
  });
});

describe('sameOAuthTokenGeneration', () => {
  it('returns false when there is no current value', () => {
    expect(sameOAuthTokenGeneration(undefined, baseTokens)).toBe(false);
  });

  it('requires matching generation AND public value when generations are present', () => {
    const stamped = withOAuthTokenGeneration(baseTokens);
    expect(sameOAuthTokenGeneration(stamped, stamped)).toBe(true);
    const mutatedValue = { ...stamped, access_token: 'changed' } as OAuthTokens;
    expect(sameOAuthTokenGeneration(mutatedValue, stamped)).toBe(false);
  });

  it('never matches a generationed value against a legacy one, even with equal public value', () => {
    const stamped = withOAuthTokenGeneration(baseTokens);
    const legacyEqual = { access_token: 'tok-abc', token_type: 'Bearer' } as OAuthTokens;
    expect(sameOAuthTokenGeneration(stamped, legacyEqual)).toBe(false);
  });

  it('falls back to deep equality for two legacy values without a generation', () => {
    const legacy = { access_token: 'tok-abc', token_type: 'Bearer' } as OAuthTokens;
    expect(sameOAuthTokenGeneration(legacy, baseTokens)).toBe(true);
    const legacyDiff = { access_token: 'tok-abc', token_type: 'Bearer', refresh_token: 'r' } as OAuthTokens;
    expect(sameOAuthTokenGeneration(legacyDiff, baseTokens)).toBe(false);
  });
});

describe('client-registration generation helpers', () => {
  it('stamps, ignores-in-value, and distinguishes distinct client generations', () => {
    const a = withOAuthClientGeneration(baseClient);
    const b = withOAuthClientGeneration(baseClient);
    expect(Object.keys(a)).toHaveLength(Object.keys(baseClient).length + 1);
    expect(sameOAuthClientValue(a, baseClient)).toBe(true);
    expect(sameOAuthClientGeneration(a, b)).toBe(false);
  });

  it('reuses an existing client generation instead of minting a new one', () => {
    const stamped = withOAuthClientGeneration(baseClient);
    const restamped = withOAuthClientGeneration(stamped);
    expect(sameOAuthClientGeneration(restamped, stamped)).toBe(true);
  });

  it('requires matching generation and public value for clients', () => {
    const stamped = withOAuthClientGeneration(baseClient);
    const changed = { ...stamped, client_id: 'changed' } as OAuthClientInformationMixed;
    expect(sameOAuthClientGeneration(changed, stamped)).toBe(false);
    expect(sameOAuthClientValue(changed, stamped)).toBe(false);
  });

  it('hides the client generation while keeping it recoverable, and is identity without one', () => {
    const stamped = withOAuthClientGeneration(baseClient);
    const hidden = withHiddenOAuthClientGeneration(stamped);
    expect(Object.keys(hidden)).toHaveLength(Object.keys(baseClient).length);
    expect(sameOAuthClientGeneration(hidden, stamped)).toBe(true);
    expect(withHiddenOAuthClientGeneration(baseClient)).toBe(baseClient);
  });

  it('returns false for an absent current and deep-equals legacy client values', () => {
    expect(sameOAuthClientGeneration(undefined, baseClient)).toBe(false);
    const legacy = { client_id: 'client-xyz' } as OAuthClientInformationMixed;
    expect(sameOAuthClientGeneration(legacy, baseClient)).toBe(true);
  });
});
