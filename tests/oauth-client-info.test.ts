import { afterEach, describe, expect, it } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { buildStaticClientInformation, resolveOAuthClientSecret } from '../src/oauth-client-info.js';

const SECRET_ENV = 'MCPORTER_TEST_CLIENT_INFO_SECRET';

function definition(overrides: Partial<ServerDefinition> = {}): ServerDefinition {
  return {
    name: 'test-server',
    command: { kind: 'http', url: new URL('https://example.com/mcp') },
    auth: 'oauth',
    ...overrides,
  };
}

afterEach(() => {
  delete process.env[SECRET_ENV];
});

describe('resolveOAuthClientSecret', () => {
  it('returns the referenced env var value', () => {
    process.env[SECRET_ENV] = 'from-env';
    expect(resolveOAuthClientSecret(definition({ oauthClientSecretEnv: SECRET_ENV }))).toBe('from-env');
  });

  it('throws when the referenced env var is unset', () => {
    expect(() => resolveOAuthClientSecret(definition({ oauthClientSecretEnv: SECRET_ENV }))).toThrow(SECRET_ENV);
  });

  it('throws on an empty-string env value regardless of rejectBlank', () => {
    process.env[SECRET_ENV] = '';
    expect(() => resolveOAuthClientSecret(definition({ oauthClientSecretEnv: SECRET_ENV }))).toThrow(SECRET_ENV);
  });

  it('returns a whitespace-only env value when rejectBlank is not set', () => {
    process.env[SECRET_ENV] = '   ';
    expect(resolveOAuthClientSecret(definition({ oauthClientSecretEnv: SECRET_ENV }))).toBe('   ');
  });

  it('throws on a whitespace-only env value when rejectBlank is set', () => {
    process.env[SECRET_ENV] = '   ';
    expect(() =>
      resolveOAuthClientSecret(definition({ oauthClientSecretEnv: SECRET_ENV }), { rejectBlank: true })
    ).toThrow(SECRET_ENV);
  });

  it('returns the inline secret when no env var is configured', () => {
    expect(resolveOAuthClientSecret(definition({ oauthClientSecret: 'inline' }))).toBe('inline');
  });

  it('returns undefined when neither env var nor inline secret is set', () => {
    expect(resolveOAuthClientSecret(definition())).toBeUndefined();
  });
});

describe('buildStaticClientInformation', () => {
  it('returns undefined when no client id is configured', () => {
    expect(buildStaticClientInformation(definition())).toBeUndefined();
  });

  it('emits the fixed grant and response types for a static client', () => {
    expect(buildStaticClientInformation(definition({ oauthClientId: 'client-1' }))).toMatchObject({
      client_id: 'client-1',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });

  it('includes the resolved client secret', () => {
    process.env[SECRET_ENV] = 'from-env';
    const info = buildStaticClientInformation(
      definition({ oauthClientId: 'client-1', oauthClientSecretEnv: SECRET_ENV })
    );
    expect(info).toMatchObject({ client_secret: 'from-env' });
  });

  it('omits the client secret when none is configured', () => {
    const info = buildStaticClientInformation(definition({ oauthClientId: 'client-1' }));
    expect(info).not.toHaveProperty('client_secret');
  });

  it('propagates the required-secret error when the configured env var is unset', () => {
    expect(() =>
      buildStaticClientInformation(definition({ oauthClientId: 'client-1', oauthClientSecretEnv: SECRET_ENV }))
    ).toThrow(SECRET_ENV);
  });

  it('includes redirect_uris derived from a URL redirect', () => {
    const info = buildStaticClientInformation(definition({ oauthClientId: 'client-1' }), {
      redirectUrl: new URL('http://127.0.0.1:8080/callback'),
    });
    expect(info).toMatchObject({ redirect_uris: ['http://127.0.0.1:8080/callback'] });
  });

  it('accepts a string redirect and omits redirect_uris when none is given', () => {
    const withRedirect = buildStaticClientInformation(definition({ oauthClientId: 'client-1' }), {
      redirectUrl: 'http://127.0.0.1:9090/cb',
    });
    expect(withRedirect).toMatchObject({ redirect_uris: ['http://127.0.0.1:9090/cb'] });
    expect(buildStaticClientInformation(definition({ oauthClientId: 'client-1' }))).not.toHaveProperty('redirect_uris');
  });

  it('includes token_endpoint_auth_method only when configured', () => {
    const withMethod = buildStaticClientInformation(
      definition({ oauthClientId: 'client-1', oauthTokenEndpointAuthMethod: 'client_secret_post' })
    );
    expect(withMethod).toMatchObject({ token_endpoint_auth_method: 'client_secret_post' });
    expect(buildStaticClientInformation(definition({ oauthClientId: 'client-1' }))).not.toHaveProperty(
      'token_endpoint_auth_method'
    );
  });
});
