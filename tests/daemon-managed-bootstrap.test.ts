import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolveDaemonExecArgs } from '../src/daemon/launch.js';
import { decodeBootstrapEnvironment, receiveBootstrap, sendBootstrap } from '../src/daemon/bootstrap.js';
import { secureDaemonDirectory, getDaemonMetadataPath, getDaemonSocketPath } from '../src/daemon/paths.js';
import { writeLifecycle } from '../src/daemon/lifecycle-state.js';
import { privateFixtureDirectory } from './helpers/private-directory.js';
import { launchdPlist, serviceEnvironment, serviceReference } from '../src/daemon/service-manager.js';
let root: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = undefined;
});
it('rejects malformed environment without reflecting secret values', () => {
  for (const value of [null, [], { PASSWORD: 123 }, { 'BAD=NAME': 'value' }, { PASSWORD: 'secret\0value' }])
    expect(() => decodeBootstrapEnvironment(value)).toThrow('Invalid daemon bootstrap');
  expect(decodeBootstrapEnvironment({ MCPORTER_VAULT_PASSWORD: 'secret' })).toEqual({
    MCPORTER_VAULT_PASSWORD: 'secret',
  });
});
it.skipIf(process.platform === 'win32')(
  'bootstraps the vault environment over the existing authenticated endpoint before readiness',
  async () => {
    root = await fs.realpath(await privateFixtureDirectory('mcp-init-'));
    vi.stubEnv('MCPORTER_DAEMON_DIR', root);
    vi.stubEnv('MCPORTER_VAULT_PASSWORD', 'synthetic-bootstrap-password-32-characters');
    await secureDaemonDirectory();
    const generation = randomUUID();
    await writeLifecycle({
      version: 1,
      attempts: [],
      active: { generation, kind: 'posix', phase: 'starting', startedAt: Date.now() },
    });
    const ready = receiveBootstrap({
      generation,
      socketPath: getDaemonSocketPath(),
      metadataPath: getDaemonMetadataPath(),
    });
    for (let i = 0; ; i++) {
      try {
        await fs.stat(getDaemonSocketPath());
        break;
      } catch {
        if (i > 100) throw new Error('bootstrap did not listen');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    await sendBootstrap(getDaemonSocketPath(), generation);
    await ready;
    expect(process.env.MCPORTER_VAULT_PASSWORD).toBe('synthetic-bootstrap-password-32-characters');
    const metadata = await fs.readFile(path.join(root, 'daemon', 'lifecycle.json'), 'utf8');
    expect(metadata).not.toContain('synthetic-bootstrap-password');
    expect(metadata).toContain('starting');
  }
);
it('does not persist passwords or caller tokens in service environment', () => {
  const env = serviceEnvironment({
    HOME: '/home/test',
    PATH: '/bin',
    MCPORTER_DAEMON_DIR: '/private/test',
    MCPORTER_DAEMON_GENERATION: randomUUID(),
    MCPORTER_VAULT_PASSWORD: 'secret',
    API_TOKEN: 'token',
  });
  const plist = launchdPlist(
    serviceReference(randomUUID(), 'darwin'),
    '/bin/node',
    ['a&b', '<literal>'],
    env,
    '/private/output'
  );
  expect(plist).toContain('a&amp;b');
  expect(plist).toContain('&lt;literal&gt;');
  expect(plist).not.toContain('secret');
  expect(plist).not.toContain('token');
  expect(plist).toContain('<key>AbandonProcessGroup</key><false/>');
});

it('keeps relative preloads bound to the initiating client directory', () => {
  expect(
    resolveDaemonExecArgs([
      '--require',
      './preload.cjs',
      '--import=./loader.mjs',
      '--import',
      'node:fs',
      '--no-warnings',
    ])
  ).toEqual([
    '--require',
    path.resolve('preload.cjs'),
    `--import=${path.resolve('loader.mjs')}`,
    '--import',
    'node:fs',
    '--no-warnings',
  ]);
});
