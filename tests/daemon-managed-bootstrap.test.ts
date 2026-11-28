import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { rootCertificates } from 'node:tls';
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
    HTTPS_PROXY: 'http://user:secret@proxy.invalid',
    NODE_OPTIONS: '--require=secret-preload',
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

it('loads extra CAs at worker startup despite its different working directory', async () => {
  root = await fs.realpath(await privateFixtureDirectory('mcp-ca-'));
  const certificate = path.join(root, 'extra CA & certificate.pem');
  await fs.writeFile(certificate, rootCertificates[0]!);
  const cwd = path.join(root, 'worker');
  await fs.mkdir(cwd);
  const env = serviceEnvironment({
    ...process.env,
    NODE_EXTRA_CA_CERTS: path.relative(process.cwd(), certificate),
  });
  expect(path.isAbsolute(env.NODE_EXTRA_CA_CERTS!)).toBe(true);
  expect(await fs.realpath(env.NODE_EXTRA_CA_CERTS!)).toBe(certificate);
  const count = "import { getCACertificates } from 'node:tls'; console.log(getCACertificates('extra').length);";
  const run = (script: string, environment: NodeJS.ProcessEnv) =>
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd,
      env: { ...environment, SystemRoot: process.env.SystemRoot },
      encoding: 'utf8',
      timeout: 10000,
    }).trim();
  expect(run(count, env)).toBe('1');
  delete env.NODE_EXTRA_CA_CERTS;
  expect(run(`process.env.NODE_EXTRA_CA_CERTS=${JSON.stringify(certificate)};${count}`, env)).toBe('0');
});

it('preserves an explicitly empty extra CA setting', () => {
  expect(serviceEnvironment({ NODE_EXTRA_CA_CERTS: '' }).NODE_EXTRA_CA_CERTS).toBe('');
});

it.skipIf(process.platform === 'win32')('preserves symlink traversal in extra CA paths', async () => {
  root = await fs.realpath(await privateFixtureDirectory('mcp-ca-link-'));
  const store = path.join(root, 'store');
  const external = path.join(root, 'external');
  await fs.mkdir(store);
  await fs.mkdir(path.join(external, 'version'), { recursive: true });
  const certificate = path.join(external, 'ca.pem');
  await fs.writeFile(certificate, rootCertificates[0]!);
  await fs.symlink(path.join(external, 'version'), path.join(store, 'current'));
  for (const input of [`${store}/current/../ca.pem`, `${path.relative(process.cwd(), store)}/current/../ca.pem`]) {
    const result = serviceEnvironment({ NODE_EXTRA_CA_CERTS: input }).NODE_EXTRA_CA_CERTS!;
    expect(result.endsWith('/current/../ca.pem')).toBe(true);
    expect(await fs.realpath(result)).toBe(certificate);
    if (path.isAbsolute(input)) expect(result).toBe(input);
  }
});
