import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

const TOKEN_GENERATION_FIELD = '__mcporter_generation';
const CLIENT_GENERATION_FIELD = '__mcporter_client_generation';

type GeneratedOAuthTokens = OAuthTokens & {
  [TOKEN_GENERATION_FIELD]?: string;
};

type GeneratedOAuthClientInformation = OAuthClientInformationMixed & {
  [CLIENT_GENERATION_FIELD]?: string;
};

function tokenGenerationOf(tokens: OAuthTokens): string | undefined {
  const generation = (tokens as GeneratedOAuthTokens)[TOKEN_GENERATION_FIELD];
  return typeof generation === 'string' && generation.length > 0 ? generation : undefined;
}

function clientGenerationOf(info: OAuthClientInformationMixed): string | undefined {
  const generation = (info as GeneratedOAuthClientInformation)[CLIENT_GENERATION_FIELD];
  return typeof generation === 'string' && generation.length > 0 ? generation : undefined;
}

function withoutTokenGeneration(tokens: OAuthTokens): OAuthTokens {
  const copy = { ...tokens } as GeneratedOAuthTokens;
  delete copy[TOKEN_GENERATION_FIELD];
  return copy;
}

function withoutClientGeneration(info: OAuthClientInformationMixed): OAuthClientInformationMixed {
  const copy = { ...info } as GeneratedOAuthClientInformation;
  delete copy[CLIENT_GENERATION_FIELD];
  return copy;
}

/** Adds one opaque generation shared by every backing store for this save. */
export function withOAuthTokenGeneration(tokens: OAuthTokens): OAuthTokens {
  const generation = tokenGenerationOf(tokens) ?? randomUUID();
  return { ...withoutTokenGeneration(tokens), [TOKEN_GENERATION_FIELD]: generation } as OAuthTokens;
}

/** Keeps the marker available to recovery without exposing it in API values. */
export function withHiddenOAuthTokenGeneration(tokens: OAuthTokens): OAuthTokens {
  const generation = tokenGenerationOf(tokens);
  if (!generation) {
    return tokens;
  }
  const copy = withoutTokenGeneration(tokens) as GeneratedOAuthTokens;
  Object.defineProperty(copy, TOKEN_GENERATION_FIELD, { value: generation, enumerable: false });
  return copy;
}

/** Adds one opaque generation shared by every backing store for this registration save. */
export function withOAuthClientGeneration(info: OAuthClientInformationMixed): OAuthClientInformationMixed {
  const generation = clientGenerationOf(info) ?? randomUUID();
  const copy = { ...withoutClientGeneration(info) } as GeneratedOAuthClientInformation;
  copy[CLIENT_GENERATION_FIELD] = generation;
  return copy;
}

/** Keeps the client marker available to recovery without exposing it to the OAuth SDK. */
export function withHiddenOAuthClientGeneration(info: OAuthClientInformationMixed): OAuthClientInformationMixed {
  const generation = clientGenerationOf(info);
  if (!generation) {
    return info;
  }
  const copy = withoutClientGeneration(info) as GeneratedOAuthClientInformation;
  Object.defineProperty(copy, CLIENT_GENERATION_FIELD, { value: generation, enumerable: false });
  return copy;
}

/**
 * New writes compare their explicit generation plus complete public value. Legacy values
 * compare as complete per-store snapshots, so a later metadata-only write is
 * still a distinct winner while mixed stores can clear their own old shapes.
 */
export function sameOAuthTokenGeneration(current: OAuthTokens | undefined, expected: OAuthTokens): boolean {
  if (!current) {
    return false;
  }
  const currentGeneration = tokenGenerationOf(current);
  const expectedGeneration = tokenGenerationOf(expected);
  if (currentGeneration || expectedGeneration) {
    return (
      currentGeneration !== undefined &&
      currentGeneration === expectedGeneration &&
      sameOAuthTokenValue(current, expected)
    );
  }
  return isDeepStrictEqual(current, expected);
}

/** Compares complete public token values while ignoring only the internal generation. */
export function sameOAuthTokenValue(left: OAuthTokens, right: OAuthTokens): boolean {
  return isDeepStrictEqual(withoutTokenGeneration(left), withoutTokenGeneration(right));
}

/** Compares the complete registration save, including its hidden generation. */
export function sameOAuthClientGeneration(
  current: OAuthClientInformationMixed | undefined,
  expected: OAuthClientInformationMixed
): boolean {
  if (!current) {
    return false;
  }
  const currentGeneration = clientGenerationOf(current);
  const expectedGeneration = clientGenerationOf(expected);
  if (currentGeneration || expectedGeneration) {
    return (
      currentGeneration !== undefined &&
      currentGeneration === expectedGeneration &&
      sameOAuthClientValue(current, expected)
    );
  }
  return isDeepStrictEqual(current, expected);
}

/** Compares only public registration fields, excluding the internal generation. */
export function sameOAuthClientValue(left: OAuthClientInformationMixed, right: OAuthClientInformationMixed): boolean {
  return isDeepStrictEqual(withoutClientGeneration(left), withoutClientGeneration(right));
}
