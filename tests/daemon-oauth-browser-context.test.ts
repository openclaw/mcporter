import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createOAuthSession, __oauthInternals } from '../src/oauth.js';
import { authorizationBrowser } from '../src/oauth-browser-context.js';
import { privateFixtureDirectory } from './helpers/private-directory.js';
import type { ServerDefinition } from '../src/config.js';
let root: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  root = await privateFixtureDirectory('mcp-oauth-context-');
  vi.stubEnv('XDG_DATA_HOME', root);
  vi.stubEnv('MCPORTER_VAULT_PASSWORD', 'synthetic-random-vault-password-at-least-32');
  const definition = {
    name: 'synthetic',
    command: { kind: 'http', url: new URL('http://127.0.0.1:9/mcp') },
  } as ServerDefinition;
  return createOAuthSession(definition, { info() {}, warn() {}, error() {} });
}
it('opens through the caller context while the provider keeps the HTTP callback and encrypted vault', async () => {
  const session = await fixture();
  const opener = vi.spyOn(__oauthInternals, 'openExternal');
  try {
    const state = await session.provider.state!();
    let callback: URL | undefined;
    await authorizationBrowser.run(
      (request, open) => {
        expect(open).toBe(true);
        callback = new URL(request.redirectUrl);
        return true;
      },
      () => session.provider.redirectToAuthorization(new URL('https://example.test/auth'))
    );
    expect(opener).not.toHaveBeenCalled();
    callback!.searchParams.set('code', 'synthetic-code');
    callback!.searchParams.set('state', state);
    const pending = session.waitForAuthorizationCode();
    await fetch(callback!);
    await expect(pending).resolves.toBe('synthetic-code');
    const file = await fs.readFile(path.join(root!, 'mcporter', 'credentials.json'), 'utf8');
    expect(file).not.toContain(state);
    expect(file).toContain('encryption');
  } finally {
    await session.close();
  }
});
it('does not open a browser inside a daemon without a live request context', async () => {
  vi.stubEnv('MCPORTER_DAEMON_CHILD', '1');
  const session = await fixture(),
    opener = vi.spyOn(__oauthInternals, 'openExternal');
  try {
    await session.provider.redirectToAuthorization(new URL('https://example.test/auth'));
    await expect(session.waitForAuthorizationCode()).rejects.toThrow('browser launch is suppressed');
    expect(opener).not.toHaveBeenCalled();
  } finally {
    await session.close();
  }
});
it('fails promptly when the request consumer disconnected', async () => {
  const session = await fixture();
  try {
    await authorizationBrowser.run(
      () => false,
      () => session.provider.redirectToAuthorization(new URL('https://example.test/auth'))
    );
    await expect(session.waitForAuthorizationCode()).rejects.toThrow('browser launch is suppressed');
  } finally {
    await session.close();
  }
});
