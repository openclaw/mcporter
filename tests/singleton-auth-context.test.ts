import { privateFixtureDirectory } from './helpers/private-directory.js';
import fs from 'node:fs/promises';
import { expect, it } from 'vitest';
import { withRuntimeEnvironment } from '../src/runtime/environment.js';
import { getOAuthVaultPath, loadVaultEntry, saveVaultEntry } from '../src/oauth-vault.js';
import { refreshLockPaths } from '../src/oauth-refresh-lock.js';
import { suppressBrowserLaunchFromEnv } from '../src/oauth-browser-suppression.js';
import { resolveOAuthTimeoutFromEnv } from '../src/runtime/oauth.js';
import type { ServerDefinition } from '../src/config.js';
import { singletonFixture, fixtureResult } from './helpers/singleton.js';

it('keeps concurrent credential vaults, refresh locks, browser suppression and timeouts disjoint', async () => {
  const root = await privateFixtureDirectory('mcp-auth-context-');
  const definition: ServerDefinition = {
    name: 'same-owner',
    command: { kind: 'http', url: new URL('https://synthetic.invalid/mcp') },
    auth: 'oauth',
  };
  try {
    const results = await Promise.all(
      ['a', 'b'].map((name, index) =>
        withRuntimeEnvironment(
          {
            HOME: `${root}/${name}`,
            XDG_DATA_HOME: `${root}/${name}/data`,
            MCPORTER_OAUTH_NO_BROWSER: index === 0 ? '1' : '0',
            MCPORTER_OAUTH_TIMEOUT_MS: String(1000 + index),
          },
          async () => {
            await saveVaultEntry(definition, { tokens: { access_token: `synthetic-${name}`, token_type: 'Bearer' } });
            await new Promise((r) => setTimeout(r, 20));
            return {
              path: getOAuthVaultPath(),
              tokens: (await loadVaultEntry(definition))?.tokens?.access_token,
              locks: await refreshLockPaths(definition),
              suppressed: suppressBrowserLaunchFromEnv(),
              timeout: resolveOAuthTimeoutFromEnv(),
            };
          }
        )
      )
    );
    expect(results[0]?.tokens).toBe('synthetic-a');
    expect(results[1]?.tokens).toBe('synthetic-b');
    expect(results[0]?.path).not.toBe(results[1]?.path);
    expect(results[0]?.locks).not.toEqual(results[1]?.locks);
    expect(results.map((r) => r.suppressed)).toEqual([true, false]);
    expect(results.map((r) => r.timeout)).toEqual([1000, 1001]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
it('uses each broker connection context for refreshable stdio credentials, retaining the declared owner', async () => {
  const f = await singletonFixture();
  try {
    const clients = await Promise.all(
      ['a', 'b'].map(async (name) => {
        const env = { ...process.env, HOME: `${f.root}/${name}`, XDG_DATA_HOME: `${f.root}/${name}/data` };
        const definition = {
          ...f.definition,
          auth: 'refreshable_bearer',
          refresh: { tokenEndpoint: 'https://synthetic.invalid/token', accessTokenEnv: 'VALUE' },
          env,
        };
        await withRuntimeEnvironment(env, () =>
          saveVaultEntry(definition, { tokens: { access_token: `synthetic-${name}`, token_type: 'Bearer' } })
        );
        return f.client(definition);
      })
    );
    const calls = await Promise.allSettled(
      clients.map((c) => c.callTool({ server: 'fixture', tool: 'identity' }).then(fixtureResult))
    );
    const values = calls.map((call) => {
      if (call.status === 'rejected') throw call.reason;
      return call.value;
    });
    expect(values.map((v) => v.value)).toEqual(['synthetic-a', 'synthetic-b']);
    expect(values[0]?.id).not.toBe(values[1]?.id);
  } finally {
    await f.close();
  }
});
