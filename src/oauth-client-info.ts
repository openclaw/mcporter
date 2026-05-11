import type { OAuthClientInformationMixed } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { ServerDefinition } from './config.js';

export function buildStaticClientInformation(
  definition: ServerDefinition,
  options: { redirectUrl?: URL | string } = {}
): OAuthClientInformationMixed | undefined {
  if (!definition.oauthClientId) {
    return undefined;
  }
  const clientSecret = resolveOAuthClientSecret(definition);
  return {
    client_id: definition.oauthClientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
    ...(options.redirectUrl ? { redirect_uris: [options.redirectUrl.toString()] } : {}),
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    ...(definition.oauthTokenEndpointAuthMethod
      ? { token_endpoint_auth_method: definition.oauthTokenEndpointAuthMethod }
      : {}),
  } as OAuthClientInformationMixed;
}

export function resolveOAuthClientSecret(definition: ServerDefinition): string | undefined {
  if (definition.oauthClientSecretEnv) {
    const value = process.env[definition.oauthClientSecretEnv];
    if (!value) {
      throw new Error(`Environment variable '${definition.oauthClientSecretEnv}' is required for OAuth client secret.`);
    }
    return value;
  }
  return definition.oauthClientSecret;
}
