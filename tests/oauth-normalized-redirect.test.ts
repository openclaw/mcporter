import { auth as sdkAuth } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createOAuthSession, OAuthRedirectUriMismatchError } from '../src/oauth.js';
import type { ServerDefinition } from '../src/config.js';
import { buildOAuthPersistence } from '../src/oauth-persistence.js';
import { createIsolatedTestHome, type IsolatedTestHome } from './helpers/isolated-test-home.js';
import { startOAuthFixture } from './helpers/oauth-fixture.js';

let isolated: IsolatedTestHome;
beforeEach(async () => {
  isolated = await createIsolatedTestHome('oauth-normalized');
});

it.each([false, true])('replaces a cached normalized registration (issuer stamped: %s)', async (stamped) => {
  const fixture = await startOAuthFixture({ redirectUris: () => ['http://localhost/callback'] });
  const definition: ServerDefinition = {
    name: 'cached-normalization',
    command: { kind: 'http', url: new URL(fixture.serverUrl) },
    auth: 'oauth',
  };
  const persistence = await buildOAuthPersistence(definition);
  await persistence.saveClientInfo({
    client_id: 'old-client',
    redirect_uris: ['http://localhost/callback'],
    ...(stamped ? { issuer: new URL(fixture.serverUrl).origin } : {}),
  });
  const onAuthorizationUrl = vi.fn();
  const session = await createOAuthSession(
    definition,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    { suppressBrowserLaunch: true, onAuthorizationUrl }
  );
  try {
    await expect(sdkAuth(session.provider, { serverUrl: fixture.serverUrl })).rejects.toBeInstanceOf(
      OAuthRedirectUriMismatchError
    );
    expect(fixture.registrations).toHaveLength(0);
    expect(onAuthorizationUrl).not.toHaveBeenCalled();
    await expect(sdkAuth(session.provider, { serverUrl: fixture.serverUrl })).resolves.toBe('REDIRECT');
    expect(fixture.registrations).toHaveLength(1);
    expect(onAuthorizationUrl).toHaveBeenCalledTimes(1);
  } finally {
    const pending = session.waitForAuthorizationCode().catch(() => undefined);
    await session.close();
    await pending;
    await fixture.close();
  }
});

it('does not treat another writer’s identical registration as fresh in this session', async () => {
  const definition: ServerDefinition = {
    name: 'concurrent-normalization',
    command: { kind: 'http', url: new URL('https://example.com/mcp') },
    auth: 'oauth',
  };
  const session = await createOAuthSession(definition, { info: vi.fn(), warn: vi.fn(), error: vi.fn() });
  const info = { client_id: 'same-client', redirect_uris: ['http://localhost/callback'] };
  try {
    await session.provider.saveClientInformation!(info);
    const persistence = await buildOAuthPersistence(definition);
    await persistence.saveClientInfo(info);
    await expect(
      session.provider.redirectToAuthorization(new URL('https://example.com/authorize'))
    ).rejects.toBeInstanceOf(OAuthRedirectUriMismatchError);
  } finally {
    await session.close();
  }
});
afterEach(async () => {
  await isolated.cleanup();
  vi.restoreAllMocks();
});

it.each(['exact', 'port-stripped', 'localhost-normalized', 'second-redirect'])(
  'completes fresh DCR authorization with %s and keeps the actual callback',
  async (mode) => {
    const fixture = await startOAuthFixture({
      redirectUris: ([requested]) => {
        const url = new URL(requested!);
        if (mode !== 'exact') url.port = '';
        if (mode === 'localhost-normalized') url.hostname = 'localhost';
        return mode === 'second-redirect' ? ['https://unrelated.example/callback', url.href] : [url.href];
      },
    });
    const onAuthorizationUrl = vi.fn();
    const session = await createOAuthSession(
      {
        name: 'normalized-fixture',
        command: { kind: 'http', url: new URL(fixture.serverUrl) },
        auth: 'oauth',
      },
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      { suppressBrowserLaunch: true, onAuthorizationUrl }
    );
    try {
      await expect(sdkAuth(session.provider, { serverUrl: fixture.serverUrl })).resolves.toBe('REDIRECT');
      expect(fixture.registrations).toHaveLength(1);
      expect(fixture.registrations[0]).toMatchObject({ application_type: 'native' });
      const authorization = new URL(onAuthorizationUrl.mock.calls[0]![0].authorizationUrl);
      const redirect = String(session.provider.redirectUrl);
      expect(authorization.searchParams.get('redirect_uri')).toBe(redirect);
      expect(new URL(redirect).port).not.toBe('');
      const callback = new URL(redirect);
      callback.searchParams.set('code', 'synthetic-code');
      callback.searchParams.set('state', authorization.searchParams.get('state')!);
      const pendingCode = session.waitForAuthorizationCode();
      expect((await fetch(callback)).status).toBe(200);
      const code = await pendingCode;
      await expect(sdkAuth(session.provider, { serverUrl: fixture.serverUrl, authorizationCode: code })).resolves.toBe(
        'AUTHORIZED'
      );
      expect(fixture.tokenRequests[0]?.get('redirect_uri')).toBe(redirect);
      expect(fixture.tokenRequests[0]?.get('code_verifier')).toBeTruthy();
      expect(await session.provider.clientInformation()).toMatchObject({ client_id: 'synthetic-client-1' });
    } finally {
      const pending = session.waitForAuthorizationCode().catch(() => undefined);
      await session.close();
      await pending;
      await fixture.close();
    }
  }
);

it.each([
  'https://127.0.0.1/callback',
  'http://evil.example/callback',
  'http://127.0.0.2/callback',
  'http://[::1]/callback',
  'http://localhost/other',
  'http://localhost/callback?extra=1',
  'http://localhost/callback#fragment',
  'http://user@localhost/callback',
])('rejects unrelated fresh redirect %s', async (redirect) => {
  const fixture = await startOAuthFixture({ redirectUris: () => [redirect] });
  const onAuthorizationUrl = vi.fn();
  const session = await createOAuthSession(
    {
      name: 'invalid-normalization',
      command: { kind: 'http', url: new URL(fixture.serverUrl) },
      auth: 'oauth',
    },
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    { suppressBrowserLaunch: true, onAuthorizationUrl }
  );
  try {
    await expect(sdkAuth(session.provider, { serverUrl: fixture.serverUrl })).rejects.toBeInstanceOf(
      OAuthRedirectUriMismatchError
    );
    expect(onAuthorizationUrl).not.toHaveBeenCalled();
  } finally {
    await session.close();
    await fixture.close();
  }
});
