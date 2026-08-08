import type { OAuthDiscoveryState } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import {
  assertOAuthDiscoveryIssuerPolicy,
  discoverOAuthServerInfoWithIssuerPolicy,
  OAuthIssuerPolicyError,
  oauthIssuerFromDiscovery,
} from '../src/oauth-issuer-policy.js';

const ORIGIN = 'https://auth.example.test';

function metadata(
  overrides: Record<string, unknown> = {}
): NonNullable<OAuthDiscoveryState['authorizationServerMetadata']> {
  return {
    issuer: ORIGIN,
    authorization_endpoint: `${ORIGIN}/authorize`,
    token_endpoint: `${ORIGIN}/oauth/token`,
    registration_endpoint: `${ORIGIN}/oauth/register`,
    jwks_uri: `${ORIGIN}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    ...overrides,
  } as NonNullable<OAuthDiscoveryState['authorizationServerMetadata']>;
}

function discoveryState(
  authorizationServerUrl = `${ORIGIN}/opaque-tenant`,
  overrides: Record<string, unknown> = {}
): OAuthDiscoveryState {
  return {
    authorizationServerUrl,
    authorizationServerMetadata: metadata(overrides),
  };
}

describe('OAuth discovery issuer policy', () => {
  it('discovers an origin issuer from an opaque authorization-server path', async () => {
    const fetchFn = async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.origin === 'https://resource.example.test') {
        return new Response(
          JSON.stringify({
            resource: 'https://resource.example.test/mcp',
            authorization_servers: [`${ORIGIN}/opaque-tenant`],
          }),
          { headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify(metadata()), { headers: { 'content-type': 'application/json' } });
    };

    await expect(
      discoverOAuthServerInfoWithIssuerPolicy('https://resource.example.test/mcp', { fetchFn })
    ).resolves.toMatchObject({
      authorizationServerUrl: `${ORIGIN}/opaque-tenant`,
      authorizationServerMetadata: { issuer: ORIGIN },
    });
  });

  it('accepts one opaque HTTPS path whose metadata canonicalizes to its exact origin', () => {
    expect(() => assertOAuthDiscoveryIssuerPolicy(discoveryState())).not.toThrow();
    expect(
      oauthIssuerFromDiscovery({
        authorizationServerUrl: `${ORIGIN}/opaque-tenant`,
        authorizationServerMetadata: metadata(),
      })
    ).toBe(ORIGIN);
  });

  it('preserves ordinary exact issuer matching, including a trailing slash', () => {
    expect(() =>
      assertOAuthDiscoveryIssuerPolicy(discoveryState(`${ORIGIN}/issuer-path`, { issuer: `${ORIGIN}/issuer-path/` }))
    ).not.toThrow();
  });

  it.each([
    ['unrelated host', `${ORIGIN}/opaque-tenant`, { issuer: 'https://other.example.test' }],
    ['unrelated scheme', `${ORIGIN}/opaque-tenant`, { issuer: 'http://auth.example.test' }],
    ['unrelated port', `${ORIGIN}/opaque-tenant`, { issuer: 'https://auth.example.test:444' }],
    ['inverse relationship', ORIGIN, { issuer: `${ORIGIN}/opaque-tenant` }],
    ['broader selected path', `${ORIGIN}/opaque/tenant`, {}],
    ['selected query', `${ORIGIN}/opaque-tenant?issuer=${encodeURIComponent(ORIGIN)}`, {}],
    ['selected fragment', `${ORIGIN}/opaque-tenant#issuer`, {}],
    ['issuer query', `${ORIGIN}/opaque-tenant`, { issuer: `${ORIGIN}?tenant=opaque` }],
    ['issuer fragment', `${ORIGIN}/opaque-tenant`, { issuer: `${ORIGIN}#opaque` }],
    ['encoded path ambiguity', `${ORIGIN}/opaque%2Ftenant`, {}],
  ])('rejects %s', (_name, authorizationServerUrl, overrides) => {
    expect(() => assertOAuthDiscoveryIssuerPolicy(discoveryState(authorizationServerUrl, overrides))).toThrow(
      OAuthIssuerPolicyError
    );
  });

  it.each([
    'authorization_endpoint',
    'token_endpoint',
    'registration_endpoint',
    'jwks_uri',
    'revocation_endpoint',
    'introspection_endpoint',
    'pushed_authorization_request_endpoint',
    'device_authorization_endpoint',
    'userinfo_endpoint',
  ])('rejects an off-origin %s', (field) => {
    expect(() =>
      assertOAuthDiscoveryIssuerPolicy(discoveryState(undefined, { [field]: `https://attacker.example/${field}` }))
    ).toThrow(/outside the trusted issuer origin/);
  });

  it('rejects off-origin mTLS endpoint aliases', () => {
    expect(() =>
      assertOAuthDiscoveryIssuerPolicy(
        discoveryState(undefined, {
          mtls_endpoint_aliases: { token_endpoint: 'https://attacker.example/oauth/token' },
        })
      )
    ).toThrow(/outside the trusted issuer origin/);
  });

  it('requires explicit authorization and token endpoints for an origin alias', () => {
    expect(() =>
      assertOAuthDiscoveryIssuerPolicy(discoveryState(undefined, { authorization_endpoint: undefined }))
    ).toThrow(/must declare authorization and token endpoints/);
    expect(() => assertOAuthDiscoveryIssuerPolicy(discoveryState(undefined, { token_endpoint: undefined }))).toThrow(
      /must declare authorization and token endpoints/
    );
  });

  it('rejects cached authorization-server metadata without an issuer', () => {
    expect(() =>
      assertOAuthDiscoveryIssuerPolicy({
        authorizationServerUrl: `${ORIGIN}/opaque-tenant`,
        authorizationServerMetadata: metadata({ issuer: undefined }),
      })
    ).toThrow(/missing its issuer/);
  });
});
