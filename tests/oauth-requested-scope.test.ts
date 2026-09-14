import fs from 'node:fs/promises';
import path from 'node:path';
import {
  auth as sdkAuth,
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { handleAddCommand } from '../src/cli/config/add.js';
import { serializeDefinition } from '../src/cli/config/render.js';
import { normalizeDefinition } from '../src/cli/generate/definition.js';
import { serializeDefinition as serializeMetadata } from '../src/cli-metadata.js';
import { RawEntrySchema } from '../src/config-schema.js';
import { loadServerDefinitions } from '../src/config.js';
import { createOAuthSession } from '../src/oauth.js';
import { createIsolatedTestHome, type IsolatedTestHome } from './helpers/isolated-test-home.js';
import { startOAuthFixture } from './helpers/oauth-fixture.js';

let isolated: IsolatedTestHome;
beforeEach(async () => {
  isolated = await createIsolatedTestHome('oauth-scopes');
});
afterEach(async () => {
  await isolated.cleanup();
  vi.restoreAllMocks();
});

it('starts a narrowed authorization after the first unauthenticated HTTP challenge', async () => {
  const fixture = await startOAuthFixture({ scopes: ['channels:read', 'chat:write'], challengeScope: 'chat:write' });
  const onAuthorizationUrl = vi.fn();
  const session = await createOAuthSession(
    {
      name: 'first-challenge',
      auth: 'oauth',
      command: { kind: 'http', url: new URL(fixture.serverUrl) },
      oauthClientId: 'synthetic-app',
      oauthRequestedScope: 'channels:read',
    },
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    { suppressBrowserLaunch: true, onAuthorizationUrl }
  );
  const client = new Client({ name: 'scope-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(fixture.serverUrl), { authProvider: session.provider });
  try {
    await expect(client.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(onAuthorizationUrl).toHaveBeenCalledTimes(1);
    expect(new URL(onAuthorizationUrl.mock.calls[0]![0].authorizationUrl).searchParams.get('scope')).toBe(
      'channels:read'
    );
  } finally {
    await client.close();
    await transport.close();
    const pending = session.waitForAuthorizationCode().catch(() => undefined);
    await session.close();
    await pending;
    await fixture.close();
  }
});

it('retries an unauthenticated challenge with credentials saved by another flow', async () => {
  const session = await createOAuthSession(
    { name: 'available-credentials', command: { kind: 'http', url: new URL('https://example.com/mcp') } },
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  );
  try {
    const tokens = {
      access_token: 'synthetic-current',
      token_type: 'Bearer',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    };
    await session.provider.saveTokens(tokens);
    const continueDefault = vi.fn();
    await session.provider.onOAuthUnauthorized!(
      { response: new Response(null, { status: 401 }), serverUrl: new URL('https://example.com/mcp'), fetchFn: fetch },
      continueDefault
    );
    expect(continueDefault).not.toHaveBeenCalled();
    expect(await session.provider.tokens()).toMatchObject(tokens);
  } finally {
    await session.close();
  }
});

it.each([
  { configured: 'channels:read users:read', challenge: undefined, expected: 'channels:read users:read' },
  { configured: 'channels:read', challenge: 'chat:write', expected: 'channels:read' },
  { configured: 'channels:read offline_access', challenge: 'chat:write', expected: 'channels:read offline_access' },
  { configured: undefined, challenge: undefined, expected: 'channels:read users:read chat:write offline_access' },
  { configured: undefined, challenge: 'channels:read', expected: 'channels:read offline_access' },
])(
  'requests $expected with configured=$configured and challenge=$challenge on every session',
  async ({ configured, challenge, expected }) => {
    const fixture = await startOAuthFixture({
      scopes: ['channels:read', 'users:read', 'chat:write', 'offline_access'],
    });
    const configPath = path.join(isolated.homeDir, 'mcporter.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        imports: [],
        mcpServers: {
          slack: {
            baseUrl: fixture.serverUrl,
            auth: 'oauth',
            oauthClientId: 'synthetic-readonly-app',
            oauthScope: 'fallback:scope',
            oauthRequestedScope: configured,
          },
        },
      })
    );
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const [definition] = await loadServerDefinitions({ configPath });
        const onAuthorizationUrl = vi.fn();
        const session = await createOAuthSession(
          definition!,
          { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          {
            suppressBrowserLaunch: true,
            onAuthorizationUrl,
          }
        );
        try {
          await expect(
            sdkAuth(session.provider, { serverUrl: fixture.serverUrl, scope: challenge, forceReauthorization: true })
          ).resolves.toBe('REDIRECT');
          const url = new URL(onAuthorizationUrl.mock.calls[0]![0].authorizationUrl);
          expect(url.searchParams.get('scope')).toBe(expected);
          expect(url.searchParams.get('client_id')).toBe('synthetic-readonly-app');
          expect(url.searchParams.get('redirect_uri')).toBe(String(session.provider.redirectUrl));
          expect(url.searchParams.get('code_challenge')).toBeTruthy();
        } finally {
          const pending = session.waitForAuthorizationCode().catch(() => undefined);
          await session.close();
          await pending;
        }
      }
    } finally {
      await fixture.close();
    }
  }
);

it('persists the CLI option and retains it through config and generated definition round trips', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const configPath = path.join(isolated.homeDir, 'mcporter.json');
  await handleAddCommand({ loadOptions: { configPath }, invokeAuth: vi.fn() }, [
    'slack',
    'https://mcp.slack.com/mcp',
    '--auth',
    'oauth',
    '--oauth-client-id',
    'synthetic-app',
    '--oauth-requested-scope',
    'channels:read users:read',
  ]);
  const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
  expect(raw.mcpServers.slack.oauthRequestedScope).toBe('channels:read users:read');
  const [definition] = await loadServerDefinitions({ configPath });
  expect(serializeDefinition(definition!)).toMatchObject({ oauthRequestedScope: 'channels:read users:read' });
  expect(normalizeDefinition({ ...definition! })).toMatchObject({ oauthRequestedScope: 'channels:read users:read' });
  expect(normalizeDefinition({ ...serializeMetadata(definition!) })).toMatchObject({
    oauthRequestedScope: 'channels:read users:read',
  });
});

it('loads the snake_case setting and preserves the legacy fallback without discovery scopes', async () => {
  const fixture = await startOAuthFixture();
  const configPath = path.join(isolated.homeDir, 'mcporter.json');
  try {
    for (const requested of ['channels:read', undefined]) {
      await fs.writeFile(
        configPath,
        JSON.stringify({
          imports: [],
          mcpServers: {
            example: {
              baseUrl: fixture.serverUrl,
              auth: 'oauth',
              oauthClientId: 'synthetic-app',
              oauthScope: 'fallback:scope',
              oauth_requested_scope: requested,
            },
          },
        })
      );
      const [definition] = await loadServerDefinitions({ configPath });
      expect(definition?.oauthRequestedScope).toBe(requested);
      const onAuthorizationUrl = vi.fn();
      const session = await createOAuthSession(
        definition!,
        { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        { suppressBrowserLaunch: true, onAuthorizationUrl }
      );
      try {
        await sdkAuth(session.provider, { serverUrl: fixture.serverUrl });
        expect(new URL(onAuthorizationUrl.mock.calls[0]![0].authorizationUrl).searchParams.get('scope')).toBe(
          requested ?? 'fallback:scope'
        );
      } finally {
        const pending = session.waitForAuthorizationCode().catch(() => undefined);
        await session.close();
        await pending;
      }
    }
  } finally {
    await fixture.close();
  }
});

it.each(['', ' ', 'read\twrite', 'read\nwrite', 'read"write', 'read\\write'])(
  'rejects invalid requested scope %j before writing or starting OAuth',
  async (scope) => {
    expect(RawEntrySchema.safeParse({ baseUrl: 'https://example.com/mcp', oauthRequestedScope: scope }).success).toBe(
      false
    );
    const configPath = path.join(isolated.homeDir, 'invalid.json');
    await expect(
      handleAddCommand({ loadOptions: { configPath }, invokeAuth: vi.fn() }, [
        'example',
        'https://example.com/mcp',
        '--oauth-requested-scope',
        scope,
      ])
    ).rejects.toThrow();
    await expect(fs.stat(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      createOAuthSession(
        {
          name: 'invalid',
          command: { kind: 'http', url: new URL('https://example.com/mcp') },
          oauthRequestedScope: scope,
        },
        { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
      )
    ).rejects.toThrow();
  }
);
