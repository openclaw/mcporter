import type { OAuthDiscoveryState } from '@modelcontextprotocol/client';
import { discoverOAuthServerInfo } from '@modelcontextprotocol/client';

const TRUSTED_ENDPOINT_FIELDS = [
  'authorization_endpoint',
  'token_endpoint',
  'registration_endpoint',
  'jwks_uri',
  'revocation_endpoint',
  'introspection_endpoint',
  'pushed_authorization_request_endpoint',
  'device_authorization_endpoint',
  'userinfo_endpoint',
  'end_session_endpoint',
  'backchannel_authentication_endpoint',
] as const;

// The SDK exposes only a boolean issuer-check opt-out. MCPorter enables it only
// while routing every fresh and cached discovery state through the replacement
// policy below before DCR, authorization, token exchange, or refresh can run.
export const OAUTH_ISSUER_POLICY_SDK_OPTIONS = { skipIssuerMetadataValidation: true } as const;

export class OAuthIssuerPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthIssuerPolicyError';
  }
}

function issuersMatchExactly(first: string, second: string): boolean {
  return (
    first === second ||
    (first.endsWith('/') && first.slice(0, -1) === second) ||
    (second.endsWith('/') && second.slice(0, -1) === first)
  );
}

function parsePolicyUrl(value: string, label: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new OAuthIssuerPolicyError(`Invalid ${label} URL in OAuth metadata.`);
  }
}

function assertTrustedEndpoint(value: unknown, field: string, trustedOrigin: string): void {
  if (value === undefined) return;
  if (typeof value !== 'string') {
    throw new OAuthIssuerPolicyError(`Invalid ${field} in OAuth metadata.`);
  }
  const endpoint = parsePolicyUrl(value, field);
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.origin !== trustedOrigin ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.hash !== ''
  ) {
    throw new OAuthIssuerPolicyError(`OAuth metadata ${field} is outside the trusted issuer origin.`);
  }
}

function assertOriginIssuerAlias(
  authorizationServerUrl: string,
  metadata: NonNullable<OAuthDiscoveryState['authorizationServerMetadata']>
): void {
  const selected = parsePolicyUrl(authorizationServerUrl, 'authorization server');
  const issuer = parsePolicyUrl(metadata.issuer, 'issuer');
  const opaqueSegments = selected.pathname.split('/').filter(Boolean);

  // Treat only one unambiguous path segment as an alias for the exact HTTPS
  // origin that served it. Same-origin endpoint checks below keep credentials
  // away from any other host, scheme, or port.
  if (
    selected.protocol !== 'https:' ||
    selected.username !== '' ||
    selected.password !== '' ||
    selected.search !== '' ||
    selected.hash !== '' ||
    opaqueSegments.length !== 1 ||
    !/^\/[A-Za-z0-9._~-]+$/.test(selected.pathname) ||
    issuer.protocol !== 'https:' ||
    issuer.origin !== selected.origin ||
    issuer.pathname !== '/' ||
    issuer.search !== '' ||
    issuer.hash !== '' ||
    issuer.username !== '' ||
    issuer.password !== ''
  ) {
    throw new OAuthIssuerPolicyError(
      `OAuth metadata issuer does not match the selected authorization server under the origin-alias policy.`
    );
  }

  if (typeof metadata.authorization_endpoint !== 'string' || typeof metadata.token_endpoint !== 'string') {
    throw new OAuthIssuerPolicyError('OAuth origin-alias metadata must declare authorization and token endpoints.');
  }
  for (const field of TRUSTED_ENDPOINT_FIELDS) {
    assertTrustedEndpoint((metadata as Record<string, unknown>)[field], field, issuer.origin);
  }
  const mtlsAliases = (metadata as Record<string, unknown>).mtls_endpoint_aliases;
  if (mtlsAliases !== undefined) {
    if (!mtlsAliases || typeof mtlsAliases !== 'object' || Array.isArray(mtlsAliases)) {
      throw new OAuthIssuerPolicyError('Invalid mtls_endpoint_aliases in OAuth metadata.');
    }
    for (const [field, value] of Object.entries(mtlsAliases)) {
      assertTrustedEndpoint(value, `mtls_endpoint_aliases.${field}`, issuer.origin);
    }
  }
}

export function assertOAuthDiscoveryIssuerPolicy(state: OAuthDiscoveryState): void {
  const metadata = state.authorizationServerMetadata;
  if (!metadata) return;
  if (typeof metadata.issuer !== 'string' || metadata.issuer.length === 0) {
    throw new OAuthIssuerPolicyError('OAuth authorization-server metadata is missing its issuer.');
  }
  if (issuersMatchExactly(state.authorizationServerUrl, metadata.issuer)) return;
  assertOriginIssuerAlias(state.authorizationServerUrl, metadata);
}

type OAuthDiscoveryOptions = NonNullable<Parameters<typeof discoverOAuthServerInfo>[1]>;

export async function discoverOAuthServerInfoWithIssuerPolicy(
  serverUrl: string | URL,
  options: Omit<OAuthDiscoveryOptions, 'skipIssuerMetadataValidation'> = {}
): Promise<Awaited<ReturnType<typeof discoverOAuthServerInfo>>> {
  const info = await discoverOAuthServerInfo(serverUrl, {
    ...options,
    ...OAUTH_ISSUER_POLICY_SDK_OPTIONS,
  });
  assertOAuthDiscoveryIssuerPolicy({
    authorizationServerUrl: info.authorizationServerUrl,
    authorizationServerMetadata: info.authorizationServerMetadata,
    resourceMetadata: info.resourceMetadata,
  });
  return info;
}

export function oauthIssuerFromDiscovery(info: Awaited<ReturnType<typeof discoverOAuthServerInfo>>): string {
  return info.authorizationServerMetadata?.issuer ?? info.authorizationServerUrl;
}
