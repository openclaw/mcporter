import { randomUUID } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { createOAuthSession } from '../src/oauth.js';

const makeDefinition = (overrides: Partial<ServerDefinition> = {}): ServerDefinition => ({
  name: overrides.name ?? 'svc',
  description: 'test',
  command: { kind: 'http', url: new URL('https://example.com/mcp') },
  tokenCacheDir: overrides.tokenCacheDir ?? path.join(os.tmpdir(), 'mcporter-oauth-test', randomUUID()),
  auth: 'oauth',
  ...overrides,
});

const logger = { info: () => {}, warn: () => {}, error: () => {} };
type StatefulProvider = { redirectUrl: string | URL; state: () => Promise<string> };

const requestStatus = (target: URL): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        family: 4,
        method: 'GET',
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.resume();
        resolve(status);
      }
    );
    req.on('error', reject);
    req.end();
  });

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (cleanup) {
    await cleanup();
    cleanup = null;
  }
});

describe('oauth callback handling', () => {
  it('rejects callbacks when state does not match', async () => {
    const session = await createOAuthSession(makeDefinition(), logger);
    cleanup = () => session.close();
    const provider = session.provider as StatefulProvider;
    const redirect = new URL(String(provider.redirectUrl));
    redirect.hostname = '127.0.0.1';

    // Persist expected state then send a mismatched one.
    await provider.state();
    const wait = session.waitForAuthorizationCode();
    wait.catch(() => {});
    const badUrl = new URL(redirect);
    badUrl.searchParams.set('code', 'abc');
    badUrl.searchParams.set('state', 'wrong-state');

    const status = await requestStatus(badUrl);
    expect(status).toBeGreaterThanOrEqual(400);

    await expect(wait).rejects.toThrow(/state/i);
    await wait.catch(() => {});
  });

  it('honors custom callback paths in oauthRedirectUrl', async () => {
    const session = await createOAuthSession(
      makeDefinition({ oauthRedirectUrl: 'http://127.0.0.1:0/custom-cb' }),
      logger
    );
    cleanup = () => session.close();
    const provider = session.provider as StatefulProvider;
    const redirect = new URL(String(provider.redirectUrl));
    const state = await provider.state();

    const wait = session.waitForAuthorizationCode();
    const okUrl = new URL(redirect);
    okUrl.searchParams.set('code', 'xyz');
    okUrl.searchParams.set('state', state);

    const status = await requestStatus(okUrl);
    expect(status).toBe(200);
    await expect(wait).resolves.toBe('xyz');
  });

  it('rejects callbacks that omit state when expected state exists', async () => {
    const session = await createOAuthSession(makeDefinition(), logger);
    cleanup = () => session.close();
    const provider = session.provider as StatefulProvider;
    const redirect = new URL(String(provider.redirectUrl));
    redirect.hostname = '127.0.0.1';

    await provider.state();
    const wait = session.waitForAuthorizationCode();
    wait.catch(() => {});

    const badUrl = new URL(redirect);
    badUrl.searchParams.set('code', 'nostate');
    const status = await requestStatus(badUrl);
    expect(status).toBeGreaterThanOrEqual(400);
    await expect(wait).rejects.toThrow(/state/i);
    await wait.catch(() => {});
  });

  it('accepts callbacks that omit state when no expected state exists', async () => {
    const session = await createOAuthSession(makeDefinition({ name: `nostate-${randomUUID()}` }), logger);
    cleanup = () => session.close();
    const provider = session.provider as StatefulProvider;
    const redirect = new URL(String(provider.redirectUrl));
    redirect.hostname = '127.0.0.1';

    const wait = session.waitForAuthorizationCode();

    const okUrl = new URL(redirect);
    okUrl.searchParams.set('code', 'nostate');
    const status = await requestStatus(okUrl);
    expect(status).toBe(200);
    await expect(wait).resolves.toBe('nostate');
  });
});
