import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BROWSER_RELAY_AUTH_CHALLENGE_PATH,
  BROWSER_RELAY_AUTH_COMPLETE_PATH,
  BROWSER_RELAY_AUTH_LABEL,
  BROWSER_RELAY_AUTH_VERSION,
  deriveBrowserRelayKeyId,
} from '../src/browser-relay-auth-v2.js';
import {
  CHROME_DEVTOOLS_RELAY_RUNTIME_ENV_KEYS,
  chromeDevtoolsRelayEnvironmentKeys,
  hashChromeDevtoolsRelayEnvironment,
  resolveChromeDevtoolsRelayEnvironment,
  resolveChromeDevtoolsRelayPolicy,
  resolveChromeDevtoolsRelayProbeTimeoutMs,
  resolveChromeDevtoolsRelayRuntimeIdentity,
  rewriteChromeDevtoolsArgsForRelay,
  shouldAttemptChromeDevtoolsRelay,
  type ChromeDevtoolsRelayProbeOptions,
  type ChromeDevtoolsRelayProbeResult,
} from '../src/chrome-devtools-relay.js';
import type { ServerDefinition } from '../src/config.js';

const TOKEN = 'a'.repeat(64);
const TOKEN_KEY_ID = deriveBrowserRelayKeyId(Buffer.from(TOKEN, 'hex'));
const FAKE_PROXY_AUTHORIZATION = `Bearer ${'c'.repeat(43)}`;
const AUTO_ARGS = ['-y', 'chrome-devtools-mcp@latest', '--autoConnect'];
const TEST_DISCOVERY = { platform: 'linux' as const };

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    throw new Error('Relay tests must inject synthetic discovery');
  }),
}));

function fakeUpstream() {
  return { socket: new net.Socket(), head: Buffer.alloc(0) };
}

function successfulOptions(overrides: ChromeDevtoolsRelayProbeOptions = {}): ChromeDevtoolsRelayProbeOptions {
  return {
    readToken: () => TOKEN,
    discover: async () => ({ kind: 'success', stdout: relayMetadata(TOKEN_KEY_ID) }),
    discovery: TEST_DISCOVERY,
    connect: async () => ({ reason: 'success', durationMs: 12, status: 200, upstream: fakeUpstream() }),
    startProxy: async () => ({
      endpoint: 'ws://127.0.0.1:45678/cdp',
      consumeClientAuthorization: () => FAKE_PROXY_AUTHORIZATION,
      close: async () => {},
    }),
    ...overrides,
  };
}

function relayMetadata(keyId: string, port = 18_799): Buffer {
  const browserUrl = `http://127.0.0.1:${port}`;
  return Buffer.from(
    JSON.stringify({
      browserUrl,
      wsEndpoint: `ws://127.0.0.1:${port}/cdp`,
      auth: {
        label: BROWSER_RELAY_AUTH_LABEL,
        version: BROWSER_RELAY_AUTH_VERSION,
        keyId,
        challengeUrl: new URL(BROWSER_RELAY_AUTH_CHALLENGE_PATH, browserUrl).toString(),
        completeUrl: new URL(BROWSER_RELAY_AUTH_COMPLETE_PATH, browserUrl).toString(),
        role: 'cdp',
        transport: 'connection',
        method: 'SEQUENCE',
        resource: '/json/version -> /cdp',
        flow: 'cdp',
      },
    })
  );
}

describe('chrome-devtools OpenClaw relay routing', () => {
  beforeEach(() => {
    const home = os.homedir();
    for (const key of CHROME_DEVTOOLS_RELAY_RUNTIME_ENV_KEYS) vi.stubEnv(key, undefined);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    const fixtureDirectories = [home];
    const mkdtemp = fs.mkdtemp.bind(fs);
    vi.spyOn(fs, 'mkdtemp').mockImplementation(async (prefix, options) => {
      const directory = await mkdtemp(prefix, options);
      fixtureDirectories.push(directory.toString());
      return directory;
    });
    const openSync = syncFs.openSync.bind(syncFs);
    vi.spyOn(syncFs, 'openSync').mockImplementation((file, flags, mode) => {
      if (
        String(file).endsWith('/browser-extension-relay.secret') &&
        !fixtureDirectories.some((directory) => String(file).startsWith(`${directory}/`))
      ) {
        throw Object.assign(new Error('No synthetic credential at this path'), { code: 'ENOENT' });
      }
      return openSync(file, flags, mode);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('only considers autoConnect chrome-devtools commands', () => {
    expect(shouldAttemptChromeDevtoolsRelay('npx', AUTO_ARGS, {})).toBe(true);
    expect(shouldAttemptChromeDevtoolsRelay('npx', ['chrome-devtools-mcp', '--autoConnect=true'], {})).toBe(true);
    expect(shouldAttemptChromeDevtoolsRelay('npx', ['chrome-devtools-mcp', '--auto-connect=TRUE'], {})).toBe(false);
    expect(shouldAttemptChromeDevtoolsRelay('npx', ['chrome-devtools-mcp', '--autoConnect', 'true'], {})).toBe(true);
    expect(shouldAttemptChromeDevtoolsRelay('npx', ['chrome-devtools-mcp', '--autoConnect=false'], {})).toBe(false);
    expect(shouldAttemptChromeDevtoolsRelay('npx', ['chrome-devtools-mcp', '--autoConnect', 'false'], {})).toBe(false);
    expect(shouldAttemptChromeDevtoolsRelay('npx', ['chrome-devtools-mcp', '--no-autoConnect'], {})).toBe(false);
    expect(
      shouldAttemptChromeDevtoolsRelay('npm', ['exec', '--', 'chrome-devtools-mcp@latest', '--autoConnect'], {})
    ).toBe(false);
    expect(
      shouldAttemptChromeDevtoolsRelay('npm', ['exec', '--', 'chrome-devtools-mcp@latest', '--', '--autoConnect'], {})
    ).toBe(false);
    expect(shouldAttemptChromeDevtoolsRelay('npx', ['-y', 'chrome-devtools-mcp@latest'], {})).toBe(false);
    expect(shouldAttemptChromeDevtoolsRelay('npx', ['-y', 'other-mcp', '--autoConnect'], {})).toBe(false);
  });

  it('rewrites enabled boolean flag forms but leaves explicit false unrouted', async () => {
    const enabled = await rewriteChromeDevtoolsArgsForRelay(
      'npx',
      ['chrome-devtools-mcp', '--autoConnect=false', '--autoConnect', 'true'],
      {},
      successfulOptions()
    );
    expect(enabled.args).not.toContain('--autoConnect=true');
    expect(enabled.args).not.toContain('true');
    expect(enabled.args).not.toContain('--autoConnect=false');
    expect(enabled.args).toContain('--wsEndpoint');

    const disabledArgs = ['chrome-devtools-mcp', '--autoConnect=false'];
    const disabled = await rewriteChromeDevtoolsArgsForRelay(
      'npx',
      disabledArgs,
      { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'require' },
      successfulOptions()
    );
    expect(disabled.args).toBe(disabledArgs);
    expect(disabled.decision.reason).toBe('not-eligible');
  });

  it('fails closed for ambiguous launcher shapes under require', async () => {
    const args = ['exec', '--unknown-option', 'value', '--', 'chrome-devtools-mcp', '--autoConnect'];
    await expect(
      rewriteChromeDevtoolsArgsForRelay(
        'npm',
        args,
        { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'require' },
        successfulOptions()
      )
    ).rejects.toMatchObject({
      name: 'ChromeDevtoolsRelayRequiredError',
      decision: expect.objectContaining({ route: 'unavailable', reason: 'unsupported-command', policy: 'require' }),
    });

    const preferred = await rewriteChromeDevtoolsArgsForRelay('npm', args, {}, successfulOptions());
    expect(preferred.args).toBe(args);
    expect(preferred.decision).toEqual({ route: 'legacy', reason: 'not-eligible', policy: 'prefer' });
  });

  it('resolves prefer by default and supports config, env, and the legacy disable switch', () => {
    expect(resolveChromeDevtoolsRelayPolicy(undefined, {})).toBe('prefer');
    expect(resolveChromeDevtoolsRelayPolicy('require', {})).toBe('require');
    expect(resolveChromeDevtoolsRelayPolicy('require', { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'off' })).toBe('off');
    expect(
      resolveChromeDevtoolsRelayPolicy('require', {
        MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'prefer',
        MCPORTER_DISABLE_CHROME_DEVTOOLS_RELAY: '1',
      })
    ).toBe('off');
    expect(() =>
      resolveChromeDevtoolsRelayPolicy(undefined, { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'maybe' })
    ).toThrow('Expected off, prefer, or require');
  });

  it('uses a 5-second probe default, accepts custom values, clamps bounds, and rejects invalid values', () => {
    expect(resolveChromeDevtoolsRelayProbeTimeoutMs({})).toBe(5_000);
    expect(resolveChromeDevtoolsRelayProbeTimeoutMs({ MCPORTER_CHROME_DEVTOOLS_RELAY_TIMEOUT_MS: '2300' })).toBe(2_300);
    expect(resolveChromeDevtoolsRelayProbeTimeoutMs({ MCPORTER_CHROME_DEVTOOLS_RELAY_TIMEOUT_MS: '1' })).toBe(100);
    expect(resolveChromeDevtoolsRelayProbeTimeoutMs({ MCPORTER_CHROME_DEVTOOLS_RELAY_TIMEOUT_MS: '999999' })).toBe(
      30_000
    );
    for (const raw of ['', '0', '-1', '1.5', 'nope']) {
      expect(resolveChromeDevtoolsRelayProbeTimeoutMs({ MCPORTER_CHROME_DEVTOOLS_RELAY_TIMEOUT_MS: raw })).toBe(5_000);
    }
  });

  it.each([
    [{}, { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'prefer' }],
    [{}, { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: ' PREFER ' }],
    [{ MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'off' }, { MCPORTER_DISABLE_CHROME_DEVTOOLS_RELAY: '1' }],
    [{}, { MCPORTER_DISABLE_CHROME_DEVTOOLS_RELAY: '0' }],
    [{}, { MCPORTER_CHROME_DEVTOOLS_RELAY_TIMEOUT_MS: '05000' }],
    [{}, { MCPORTER_CHROME_DEVTOOLS_RELAY_TIMEOUT_MS: 'invalid' }],
    [{ MCPORTER_CHROME_DEVTOOLS_RELAY_TIMEOUT_MS: '1' }, { MCPORTER_CHROME_DEVTOOLS_RELAY_TIMEOUT_MS: '100' }],
    [{ MCPORTER_CHROME_DEVTOOLS_RELAY_TIMEOUT_MS: '30001' }, { MCPORTER_CHROME_DEVTOOLS_RELAY_TIMEOUT_MS: '30000' }],
    [{}, { MCPORTER_CHROME_DEVTOOLS_RELAY_URL: '  ' }],
    [{}, { MCPORTER_CHROME_DEVTOOLS_RELAY_URL: 'http://127.0.0.1:18799/' }],
    [{}, { OPENCLAW_PROFILE: ' DEFAULT ' }],
    [{}, { OPENCLAW_PROFILE: '../invalid' }],
  ] satisfies Array<[NodeJS.ProcessEnv, NodeJS.ProcessEnv]>)(
    'normalizes equivalent effective relay controls: %j and %j',
    async (before, after) => {
      const definition: ServerDefinition = {
        name: 'chrome',
        command: { kind: 'stdio', command: 'npx', args: AUTO_ARGS, cwd: '/tmp' },
      };
      const options = { discover: vi.fn(async () => ({ kind: 'unavailable' as const })), discovery: TEST_DISCOVERY };
      const keys = chromeDevtoolsRelayEnvironmentKeys([definition], before);
      const baseline = await resolveChromeDevtoolsRelayRuntimeIdentity(keys, before, options);
      expect(await resolveChromeDevtoolsRelayRuntimeIdentity(keys, after, options)).toBe(baseline);
      expect(
        await resolveChromeDevtoolsRelayRuntimeIdentity(
          chromeDevtoolsRelayEnvironmentKeys([definition], after),
          after,
          options
        )
      ).toBe(baseline);
    }
  );

  it('normalizes explicitly selected policy keys while retaining custom identity inputs', async () => {
    const keys = ['MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY', 'CUSTOM_IDENTITY'];
    const baseline = await resolveChromeDevtoolsRelayRuntimeIdentity(keys, {});
    expect(
      await resolveChromeDevtoolsRelayRuntimeIdentity(keys, { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'prefer' })
    ).toBe(baseline);
    expect(await resolveChromeDevtoolsRelayRuntimeIdentity(keys, { CUSTOM_IDENTITY: 'changed' })).not.toBe(baseline);
  });

  it('does not apply relay policy to a placeholder command that resolves to an unrelated server', async () => {
    const definition: ServerDefinition = {
      name: 'other',
      command: { kind: 'stdio', command: '$env:LAUNCHER', args: [], cwd: '/tmp' },
    };
    const env = { LAUNCHER: 'other-mcp', MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'invalid' };
    const keys = chromeDevtoolsRelayEnvironmentKeys([definition], env);
    expect(await resolveChromeDevtoolsRelayRuntimeIdentity(keys, env)).toBe(
      await resolveChromeDevtoolsRelayRuntimeIdentity(keys, { LAUNCHER: 'other-mcp' })
    );
  });

  it('ignores controls fully shadowed by all servers, but retains partially inherited controls', async () => {
    const definition: ServerDefinition = {
      name: 'chrome',
      command: { kind: 'stdio', command: 'npx', args: AUTO_ARGS, cwd: '/tmp' },
      env: {
        MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'require',
        MCPORTER_CHROME_DEVTOOLS_RELAY_URL: 'http://127.0.0.1:19110',
        MCPORTER_CHROME_DEVTOOLS_RELAY_TIMEOUT_MS: '5000',
        OPENCLAW_PROFILE: 'work',
        HOME: '/synthetic/home',
        USERPROFILE: '/synthetic/user-profile',
        OPENCLAW_HOME: '/synthetic/openclaw-home',
        OPENCLAW_STATE_DIR: '/synthetic/state',
        OPENCLAW_OAUTH_DIR: '/synthetic/credentials',
        OPENCLAW_CONFIG_PATH: '/synthetic/config.json',
        PATH: '/synthetic/bin',
      },
    };
    const options = { discover: vi.fn(async () => ({ kind: 'unavailable' as const })), discovery: TEST_DISCOVERY };
    const before = {};
    const after = {
      MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'off',
      MCPORTER_CHROME_DEVTOOLS_RELAY_URL: 'http://127.0.0.1:19999',
      MCPORTER_CHROME_DEVTOOLS_RELAY_TIMEOUT_MS: '9000',
      OPENCLAW_PROFILE: 'personal',
      HOME: '/synthetic/other-home',
      USERPROFILE: '/synthetic/other-user-profile',
      OPENCLAW_HOME: '/synthetic/other-openclaw-home',
      OPENCLAW_STATE_DIR: '/synthetic/other-state',
      OPENCLAW_OAUTH_DIR: '/synthetic/other-credentials',
      OPENCLAW_CONFIG_PATH: '/synthetic/other-config.json',
      PATH: '/synthetic/other-bin',
    };
    const keys = chromeDevtoolsRelayEnvironmentKeys([definition, { ...definition, name: 'second' }], before);
    expect(await resolveChromeDevtoolsRelayRuntimeIdentity(keys, after, options)).toBe(
      await resolveChromeDevtoolsRelayRuntimeIdentity(keys, before, options)
    );
    for (const command of [
      definition.command,
      { ...definition.command, command: 'npm', args: ['exec', '--', ...AUTO_ARGS] },
    ]) {
      const mixedKeys = chromeDevtoolsRelayEnvironmentKeys(
        [definition, { ...definition, name: 'inherited', command, env: {} }],
        before
      );
      const baseline = await resolveChromeDevtoolsRelayRuntimeIdentity(mixedKeys, before, options);
      for (const [key, value] of Object.entries(after)) {
        expect(await resolveChromeDevtoolsRelayRuntimeIdentity(mixedKeys, { [key]: value }, options), key).not.toBe(
          baseline
        );
      }
    }
    expect(
      await resolveChromeDevtoolsRelayRuntimeIdentity(keys, { MCPORTER_DISABLE_CHROME_DEVTOOLS_RELAY: '1' }, options)
    ).not.toBe(await resolveChromeDevtoolsRelayRuntimeIdentity(keys, before, options));
  });

  it('retains raw placeholder dependencies even when they are relay controls overridden by every server', () => {
    const definition: ServerDefinition = {
      name: 'chrome',
      command: {
        kind: 'stdio',
        command: 'npx',
        args: [...AUTO_ARGS, '${MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY}'],
        cwd: '/tmp',
      },
      env: { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'prefer' },
    };
    expect(
      hashChromeDevtoolsRelayEnvironment([definition], { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'prefer' })
    ).not.toBe(hashChromeDevtoolsRelayEnvironment([definition], { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: ' PREFER ' }));
    const indirect = {
      ...definition,
      command: { ...definition.command, args: AUTO_ARGS },
      env: {
        MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'prefer',
        OPENCLAW_PROFILE: '$env:MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY',
      },
    };
    expect(
      hashChromeDevtoolsRelayEnvironment([indirect], { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'prefer' })
    ).not.toBe(hashChromeDevtoolsRelayEnvironment([indirect], { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'require' }));
  });

  it('normalizes definition controls without losing empty-override fallback or configured require', async () => {
    const definition: ServerDefinition = {
      name: 'chrome',
      command: { kind: 'stdio', command: 'npx', args: AUTO_ARGS, cwd: '/tmp' },
    };
    const options = { discover: vi.fn(async () => ({ kind: 'unavailable' as const })), discovery: TEST_DISCOVERY };
    const identity = (server: ServerDefinition, env: NodeJS.ProcessEnv = {}) =>
      resolveChromeDevtoolsRelayRuntimeIdentity(chromeDevtoolsRelayEnvironmentKeys([server], env), env, options);
    const baseline = await identity(definition);
    const equivalentOverrides: Array<Record<string, string>> = [
      { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: ' PREFER ' },
      { MCPORTER_CHROME_DEVTOOLS_RELAY_TIMEOUT_MS: 'invalid' },
      { MCPORTER_CHROME_DEVTOOLS_RELAY_URL: '   ' },
      { OPENCLAW_PROFILE: 'default' },
    ];
    for (const env of equivalentOverrides) expect(await identity({ ...definition, env })).toBe(baseline);
    expect(await identity({ ...definition, chromeDevtoolsRelay: 'prefer' })).toBe(baseline);
    const required = { ...definition, chromeDevtoolsRelay: 'require' as const };
    expect(await identity(required)).not.toBe(baseline);
    expect(await identity(required, { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: ' PREFER ' })).toBe(baseline);
    expect(
      await identity(
        { ...definition, env: { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: '' } },
        {
          MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'require',
        }
      )
    ).toBe(await identity(required));
    expect(
      await identity(
        { ...definition, env: { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: '${MISSING_POLICY}' } },
        {
          MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'require',
        }
      )
    ).not.toBe(baseline);
  });

  it('keeps launcher substitutions and discovery inputs distinct even when discovery returns the same URL', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-relay-inputs-'));
    await fs.writeFile(path.join(directory, 'browser-extension-relay.secret'), TOKEN, { mode: 0o600 });
    const definition: ServerDefinition = {
      name: 'chrome',
      command: { kind: 'stdio', command: '$env:RELAY_LAUNCHER', args: AUTO_ARGS, cwd: '/tmp' },
      env: { OPENCLAW_OAUTH_DIR: directory },
    };
    const discover = vi.fn<NonNullable<ChromeDevtoolsRelayProbeOptions['discover']>>(async () => ({
      kind: 'success',
      stdout: relayMetadata(TOKEN_KEY_ID),
    }));
    const options = { discover, discovery: TEST_DISCOVERY };
    const env = { RELAY_LAUNCHER: 'npx', PATH: '/synthetic/bin' };
    const keys = chromeDevtoolsRelayEnvironmentKeys([definition], env);
    try {
      const baseline = await resolveChromeDevtoolsRelayRuntimeIdentity(keys, env, options);
      for (const change of [
        { RELAY_LAUNCHER: 'bunx' },
        { PATH: '/synthetic/other-bin' },
        { OPENCLAW_GATEWAY_PORT: '19999' },
        { LANG: 'de_AT.UTF-8' },
      ]) {
        expect(await resolveChromeDevtoolsRelayRuntimeIdentity(keys, { ...env, ...change }, options)).not.toBe(
          baseline
        );
      }
      expect(discover).toHaveBeenCalledTimes(5);
      expect(discover.mock.calls[0]?.[0]).toMatchObject({ executable: 'openclaw', env: { PATH: '/synthetic/bin' } });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('does not discover daemon identity while relay routing is off', async () => {
    const definition: ServerDefinition = {
      name: 'chrome',
      command: { kind: 'stdio', command: 'npx', args: AUTO_ARGS, cwd: '/tmp' },
      chromeDevtoolsRelay: 'off',
    };
    const discover = vi.fn(async () => ({ kind: 'unavailable' as const }));
    const keys = chromeDevtoolsRelayEnvironmentKeys([definition], {});
    await resolveChromeDevtoolsRelayRuntimeIdentity(keys, {}, { discover, discovery: TEST_DISCOVERY });
    expect(discover).not.toHaveBeenCalled();
  });

  it('changes daemon identity for policy, URL, timeout, state, credential directory, and referenced env inputs', () => {
    const definition: ServerDefinition = {
      name: 'chrome',
      command: { kind: 'stdio', command: 'npx', args: AUTO_ARGS, cwd: '/tmp' },
    };
    const baseline = hashChromeDevtoolsRelayEnvironment([definition], {});
    const variants: NodeJS.ProcessEnv[] = [
      { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'require' },
      { MCPORTER_CHROME_DEVTOOLS_RELAY_URL: 'http://127.0.0.1:18888' },
      { MCPORTER_CHROME_DEVTOOLS_RELAY_TIMEOUT_MS: '9000' },
      { HOME: '/tmp/openclaw-home-a' },
      { OPENCLAW_STATE_DIR: '/tmp/openclaw-state-a' },
      { OPENCLAW_OAUTH_DIR: '/tmp/openclaw-oauth-a' },
      { OPENCLAW_PROFILE: 'work' },
    ];
    for (const env of variants) expect(hashChromeDevtoolsRelayEnvironment([definition], env)).not.toBe(baseline);
    const indirect = {
      ...definition,
      env: { MCPORTER_CHROME_DEVTOOLS_RELAY_URL: '${CUSTOM_RELAY_URL}' },
    };
    expect(hashChromeDevtoolsRelayEnvironment([indirect], { CUSTOM_RELAY_URL: 'http://127.0.0.1:18888' })).not.toBe(
      hashChromeDevtoolsRelayEnvironment([indirect], { CUSTOM_RELAY_URL: 'http://127.0.0.1:19999' })
    );

    const cwd = vi.spyOn(process, 'cwd');
    const definitionRelative = { ...definition, env: { OPENCLAW_OAUTH_DIR: 'credentials' } };
    cwd.mockReturnValue('/tmp/relay-cwd-a');
    const relativeA = hashChromeDevtoolsRelayEnvironment([definition], { OPENCLAW_STATE_DIR: 'relative-state' });
    const definitionRelativeA = hashChromeDevtoolsRelayEnvironment([definitionRelative], {});
    const unrelatedA = hashChromeDevtoolsRelayEnvironment([], {});
    cwd.mockReturnValue('/tmp/relay-cwd-b');
    const relativeB = hashChromeDevtoolsRelayEnvironment([definition], { OPENCLAW_STATE_DIR: 'relative-state' });
    const definitionRelativeB = hashChromeDevtoolsRelayEnvironment([definitionRelative], {});
    const unrelatedB = hashChromeDevtoolsRelayEnvironment([], {});
    expect(relativeB).not.toBe(relativeA);
    expect(definitionRelativeB).not.toBe(definitionRelativeA);
    expect(unrelatedB).toBe(unrelatedA);
    cwd.mockRestore();

    const interpolated: ServerDefinition = {
      ...definition,
      command: { kind: 'stdio', command: 'npx', args: ['${CDP_PACKAGE}', '--autoConnect'], cwd: '/tmp' },
    };
    expect(hashChromeDevtoolsRelayEnvironment([interpolated], { CDP_PACKAGE: 'chrome-devtools-mcp' })).not.toBe(
      hashChromeDevtoolsRelayEnvironment([interpolated], { CDP_PACKAGE: 'other-mcp' })
    );
    expect(
      hashChromeDevtoolsRelayEnvironment([interpolated], {
        CDP_PACKAGE: 'chrome-devtools-mcp',
        MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'require',
      })
    ).not.toBe(hashChromeDevtoolsRelayEnvironment([interpolated], { CDP_PACKAGE: 'chrome-devtools-mcp' }));
  });

  it('changes daemon identity when the relay key rotates at the same credential path', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-relay-rotation-'));
    const secretPath = path.join(directory, 'browser-extension-relay.secret');
    const definition: ServerDefinition = {
      name: 'chrome',
      command: { kind: 'stdio', command: 'npx', args: AUTO_ARGS, cwd: '/tmp' },
    };
    try {
      await fs.writeFile(secretPath, TOKEN, { mode: 0o600 });
      const before = hashChromeDevtoolsRelayEnvironment([definition], { OPENCLAW_OAUTH_DIR: directory });
      await fs.writeFile(secretPath, 'b'.repeat(64), { mode: 0o600 });
      const after = hashChromeDevtoolsRelayEnvironment([definition], { OPENCLAW_OAUTH_DIR: directory });
      expect(after).not.toBe(before);
      expect(before).not.toContain(TOKEN);
      expect(after).not.toContain('b'.repeat(64));
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('uses the named-profile credential path in daemon identity', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-relay-profile-identity-'));
    const credentials = path.join(home, '.openclaw-work', 'credentials');
    const secretPath = path.join(credentials, 'browser-extension-relay.secret');
    const definition: ServerDefinition = {
      name: 'chrome',
      command: { kind: 'stdio', command: 'npx', args: AUTO_ARGS, cwd: '/tmp' },
    };
    const firstKey = Buffer.alloc(32, 0x66).toString('hex');
    const secondKey = Buffer.alloc(32, 0x67).toString('hex');
    try {
      await fs.mkdir(credentials, { recursive: true });
      await fs.writeFile(secretPath, firstKey, { mode: 0o600 });
      const firstKeyId = deriveBrowserRelayKeyId(Buffer.from(firstKey, 'hex'));
      const env = { OPENCLAW_HOME: home, OPENCLAW_PROFILE: 'work' };
      const keys = chromeDevtoolsRelayEnvironmentKeys([definition], env);
      const before = await resolveChromeDevtoolsRelayRuntimeIdentity(keys, env, {
        discover: async () => ({ kind: 'success', stdout: relayMetadata(firstKeyId, 19_110) }),
        discovery: TEST_DISCOVERY,
      });
      await fs.writeFile(secretPath, secondKey, { mode: 0o600 });
      const secondKeyId = deriveBrowserRelayKeyId(Buffer.from(secondKey, 'hex'));
      const after = await resolveChromeDevtoolsRelayRuntimeIdentity(keys, env, {
        discover: async () => ({ kind: 'success', stdout: relayMetadata(secondKeyId, 19_110) }),
        discovery: TEST_DISCOVERY,
      });
      expect(after).not.toBe(before);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('changes daemon identity when the discovered relay port changes', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-relay-port-'));
    const definition: ServerDefinition = {
      name: 'chrome',
      command: { kind: 'stdio', command: 'npx', args: AUTO_ARGS, cwd: '/tmp' },
    };
    try {
      await fs.writeFile(path.join(directory, 'browser-extension-relay.secret'), TOKEN, { mode: 0o600 });
      const env = { OPENCLAW_OAUTH_DIR: directory };
      const keys = chromeDevtoolsRelayEnvironmentKeys([definition], env);
      const at19110 = await resolveChromeDevtoolsRelayRuntimeIdentity(keys, env, {
        discover: async () => ({ kind: 'success', stdout: relayMetadata(TOKEN_KEY_ID, 19_110) }),
        discovery: TEST_DISCOVERY,
      });
      const at19111 = await resolveChromeDevtoolsRelayRuntimeIdentity(keys, env, {
        discover: async () => ({ kind: 'success', stdout: relayMetadata(TOKEN_KEY_ID, 19_111) }),
        discovery: TEST_DISCOVERY,
      });
      expect(at19111).not.toBe(at19110);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('skips discovery for an explicit URL and honors definition env precedence', async () => {
    const definition = (url: string): ServerDefinition => ({
      name: 'chrome',
      command: { kind: 'stdio', command: 'npx', args: AUTO_ARGS, cwd: '/tmp' },
      env: { MCPORTER_CHROME_DEVTOOLS_RELAY_URL: url, UNRELATED_SECRET: 'do-not-store' },
    });
    const discover = vi.fn(async () => ({ kind: 'unavailable' as const }));
    const identities: string[] = [];
    for (const baseEnv of [{}, { MCPORTER_CHROME_DEVTOOLS_RELAY_URL: 'http://127.0.0.1:19999' }]) {
      const first = definition('http://127.0.0.1:18888');
      const second = definition('http://127.0.0.1:18889');
      expect(resolveChromeDevtoolsRelayEnvironment(first.env, baseEnv).MCPORTER_CHROME_DEVTOOLS_RELAY_URL).toBe(
        'http://127.0.0.1:18888'
      );
      const firstKeys = chromeDevtoolsRelayEnvironmentKeys([first], baseEnv);
      const secondKeys = chromeDevtoolsRelayEnvironmentKeys([second], baseEnv);
      expect(firstKeys.join('\n')).not.toContain('do-not-store');
      identities.push(
        await resolveChromeDevtoolsRelayRuntimeIdentity(firstKeys, baseEnv, {
          discover,
          discovery: TEST_DISCOVERY,
        })
      );
      identities.push(
        await resolveChromeDevtoolsRelayRuntimeIdentity(secondKeys, baseEnv, {
          discover,
          discovery: TEST_DISCOVERY,
        })
      );
    }
    expect(identities[0]).not.toBe(identities[1]);
    expect(identities[2]).not.toBe(identities[3]);
    expect(identities[0]).toBe(identities[2]);
    expect(identities[1]).toBe(identities[3]);
    expect(discover).not.toHaveBeenCalled();
  });

  it('does not resolve unrelated server env while building relay identity', async () => {
    const definition: ServerDefinition = {
      name: 'chrome',
      command: { kind: 'stdio', command: 'npx', args: AUTO_ARGS, cwd: '/tmp' },
      env: {
        MCPORTER_CHROME_DEVTOOLS_RELAY_URL: 'http://127.0.0.1:18888',
        API_TOKEN: '$env:MISSING_API_TOKEN',
      },
    };
    const discover = vi.fn(async () => ({ kind: 'unavailable' as const }));
    const keys = chromeDevtoolsRelayEnvironmentKeys([definition], {});
    await resolveChromeDevtoolsRelayRuntimeIdentity(keys, {}, { discover, discovery: TEST_DISCOVERY });
    expect(discover).not.toHaveBeenCalled();
    expect(keys.join('\n')).not.toContain('API_TOKEN');
    expect(() => resolveChromeDevtoolsRelayEnvironment(definition.env, {})).toThrow('MISSING_API_TOKEN');
  });

  it.each([
    ['policy off', { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'off' }],
    ['disable flag', { MCPORTER_DISABLE_CHROME_DEVTOOLS_RELAY: '1' }],
  ])('skips discovery for definition-scoped %s', async (_case, definitionEnv) => {
    const definition: ServerDefinition = {
      name: 'chrome',
      command: { kind: 'stdio', command: 'npx', args: AUTO_ARGS, cwd: '/tmp' },
      env: definitionEnv,
    };
    const processEnv = { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'require' };
    const discover = vi.fn(async () => ({ kind: 'unavailable' as const }));
    const keys = chromeDevtoolsRelayEnvironmentKeys([definition], processEnv);
    await resolveChromeDevtoolsRelayRuntimeIdentity(keys, processEnv, { discover, discovery: TEST_DISCOVERY });
    expect(discover).not.toHaveBeenCalled();
  });

  it('passes a definition-scoped placeholder timeout to bounded discovery', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-relay-timeout-identity-'));
    const definition: ServerDefinition = {
      name: 'chrome',
      command: { kind: 'stdio', command: 'npx', args: AUTO_ARGS, cwd: '/tmp' },
      env: {
        OPENCLAW_OAUTH_DIR: directory,
        MCPORTER_CHROME_DEVTOOLS_RELAY_TIMEOUT_MS: '$env:SERVER_RELAY_TIMEOUT',
      },
    };
    try {
      await fs.writeFile(path.join(directory, 'browser-extension-relay.secret'), TOKEN, { mode: 0o600 });
      const processEnv = {
        SERVER_RELAY_TIMEOUT: '2300',
        MCPORTER_CHROME_DEVTOOLS_RELAY_TIMEOUT_MS: '9000',
      };
      const discover = vi.fn<NonNullable<ChromeDevtoolsRelayProbeOptions['discover']>>(async (options) => {
        expect(options.timeoutMs).toBe(2_300);
        return { kind: 'success', stdout: relayMetadata(TOKEN_KEY_ID, 19_110) };
      });
      const keys = chromeDevtoolsRelayEnvironmentKeys([definition], processEnv);
      await resolveChromeDevtoolsRelayRuntimeIdentity(keys, processEnv, { discover, discovery: TEST_DISCOVERY });
      expect(discover).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('matches runtime placeholder behavior for definition relay controls', async () => {
    const processEnv = { SERVER_RELAY_URL: 'http://127.0.0.1:18888' };
    const direct: ServerDefinition = {
      name: 'chrome',
      command: { kind: 'stdio', command: 'npx', args: AUTO_ARGS, cwd: '/tmp' },
      env: { MCPORTER_CHROME_DEVTOOLS_RELAY_URL: '$env:SERVER_RELAY_URL' },
    };
    const interpolated: ServerDefinition = {
      ...direct,
      env: { MCPORTER_CHROME_DEVTOOLS_RELAY_URL: '${SERVER_RELAY_URL}' },
    };
    const discover = vi.fn(async () => ({ kind: 'unavailable' as const }));
    for (const definition of [direct, interpolated]) {
      expect(resolveChromeDevtoolsRelayEnvironment(definition.env, processEnv).MCPORTER_CHROME_DEVTOOLS_RELAY_URL).toBe(
        processEnv.SERVER_RELAY_URL
      );
      const keys = chromeDevtoolsRelayEnvironmentKeys([definition], processEnv);
      await resolveChromeDevtoolsRelayRuntimeIdentity(keys, processEnv, { discover, discovery: TEST_DISCOVERY });
    }
    expect(discover).not.toHaveBeenCalled();
    expect(() =>
      chromeDevtoolsRelayEnvironmentKeys(
        [{ ...direct, env: { MCPORTER_CHROME_DEVTOOLS_RELAY_URL: '$env:MISSING_RELAY_URL' } }],
        {}
      )
    ).toThrow('MISSING_RELAY_URL');
    expect(
      resolveChromeDevtoolsRelayEnvironment({ MCPORTER_CHROME_DEVTOOLS_RELAY_URL: '${MISSING_RELAY_URL}' }, {})
        .MCPORTER_CHROME_DEVTOOLS_RELAY_URL
    ).toBeUndefined();
  });

  it('marks an invalid definition URL without discovering or storing its raw bytes', async () => {
    const definition: ServerDefinition = {
      name: 'chrome',
      command: { kind: 'stdio', command: 'npx', args: AUTO_ARGS, cwd: '/tmp' },
      env: { MCPORTER_CHROME_DEVTOOLS_RELAY_URL: 'https://127.0.0.1:18888/private' },
    };
    const discover = vi.fn(async () => ({ kind: 'unavailable' as const }));
    const keys = chromeDevtoolsRelayEnvironmentKeys([definition], {});
    expect(keys.join('\n')).not.toContain('/private');
    await resolveChromeDevtoolsRelayRuntimeIdentity(keys, {}, { discover, discovery: TEST_DISCOVERY });
    expect(discover).not.toHaveBeenCalled();
  });

  it('uses 18799 in runtime identity when async discovery is unavailable', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-relay-fallback-identity-'));
    const definition: ServerDefinition = {
      name: 'chrome',
      command: { kind: 'stdio', command: 'npx', args: AUTO_ARGS, cwd: '/tmp' },
    };
    try {
      await fs.writeFile(path.join(directory, 'browser-extension-relay.secret'), TOKEN, { mode: 0o600 });
      const env = { OPENCLAW_OAUTH_DIR: directory };
      const keys = chromeDevtoolsRelayEnvironmentKeys([definition], env);
      const unavailable = await resolveChromeDevtoolsRelayRuntimeIdentity(keys, env, {
        discover: async () => ({ kind: 'unavailable' }),
        discovery: TEST_DISCOVERY,
      });
      const failed = await resolveChromeDevtoolsRelayRuntimeIdentity(keys, env, {
        discover: async () => {
          throw new Error('discovery failed');
        },
        discovery: TEST_DISCOVERY,
      });
      const atLegacyPort = await resolveChromeDevtoolsRelayRuntimeIdentity(keys, env, {
        discover: async () => ({ kind: 'success', stdout: relayMetadata(TOKEN_KEY_ID, 18_799) }),
        discovery: TEST_DISCOVERY,
      });
      const atNondefaultPort = await resolveChromeDevtoolsRelayRuntimeIdentity(keys, env, {
        discover: async () => ({ kind: 'success', stdout: relayMetadata(TOKEN_KEY_ID, 19_110) }),
        discovery: TEST_DISCOVERY,
      });
      expect(unavailable).toBe(atLegacyPort);
      expect(failed).toBe(unavailable);
      expect(atNondefaultPort).not.toBe(unavailable);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('resolves credential-directory placeholders before hashing relay key rotation', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-relay-placeholder-'));
    const secretPath = path.join(directory, 'browser-extension-relay.secret');
    const definition: ServerDefinition = {
      name: 'chrome',
      command: { kind: 'stdio', command: 'npx', args: AUTO_ARGS, cwd: '/tmp' },
      env: { OPENCLAW_OAUTH_DIR: '${OPENCLAW_DIR}' },
    };
    try {
      await fs.writeFile(secretPath, TOKEN, { mode: 0o600 });
      const before = hashChromeDevtoolsRelayEnvironment([definition], { OPENCLAW_DIR: directory });
      await fs.writeFile(secretPath, 'b'.repeat(64), { mode: 0o600 });
      const after = hashChromeDevtoolsRelayEnvironment([definition], { OPENCLAW_DIR: directory });
      expect(after).not.toBe(before);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('uses the runtime environment merge contract without chaining definition overrides', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-relay-chained-placeholder-'));
    const secretPath = path.join(directory, 'browser-extension-relay.secret');
    const definition: ServerDefinition = {
      name: 'chrome',
      command: { kind: 'stdio', command: 'npx', args: AUTO_ARGS, cwd: '/tmp' },
      env: {
        OPENCLAW_DIR: directory,
        OPENCLAW_OAUTH_DIR: '${OPENCLAW_DIR}',
      },
    };
    await fs.writeFile(secretPath, TOKEN, { mode: 0o600 });
    const merged = resolveChromeDevtoolsRelayEnvironment(definition.env, {});
    expect(merged.OPENCLAW_DIR).toBe(directory);
    expect(merged.OPENCLAW_OAUTH_DIR).toBeUndefined();
    const before = hashChromeDevtoolsRelayEnvironment([definition], {});
    await fs.writeFile(secretPath, 'b'.repeat(64), { mode: 0o600 });
    expect(hashChromeDevtoolsRelayEnvironment([definition], {})).toBe(before);
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('routes through the protected local proxy without putting either bearer in child argv', async () => {
    const observed: unknown[] = [];
    const close = vi.fn(async () => {});
    const result = await rewriteChromeDevtoolsArgsForRelay(
      'npx',
      AUTO_ARGS,
      {},
      successfulOptions({
        connect: async (url, credential, timeoutMs) => {
          observed.push(url.toString(), credential.keyId, timeoutMs);
          return { reason: 'success', durationMs: 12, status: 200, upstream: fakeUpstream() };
        },
        startProxy: async (options) => {
          observed.push(options);
          return {
            endpoint: 'ws://127.0.0.1:45678/cdp',
            consumeClientAuthorization: () => FAKE_PROXY_AUTHORIZATION,
            close,
          };
        },
      })
    );

    expect(observed).toEqual([
      'http://127.0.0.1:18799/',
      '4Od6UHQSsSD27eYfYilbGn',
      5_000,
      { upstream: expect.objectContaining({ head: expect.any(Buffer), socket: expect.any(net.Socket) }) },
    ]);
    expect(result.args).toEqual(['-y', 'chrome-devtools-mcp@latest', '--wsEndpoint', 'ws://127.0.0.1:45678/cdp']);
    expect(JSON.stringify(result.args)).not.toContain(TOKEN);
    expect(JSON.stringify(result.args)).not.toContain(FAKE_PROXY_AUTHORIZATION);
    expect(result.args).not.toContain('--wsHeaders');
    expect(result.decision).toEqual({
      route: 'relay',
      reason: 'success',
      policy: 'prefer',
      endpoint: 'ws://127.0.0.1:18799/cdp',
      probeDurationMs: 12,
      probeStatus: 200,
    });
    await result.proxy?.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps real proxy authorization out of child args and logical diagnostics', async () => {
    const result = await rewriteChromeDevtoolsArgsForRelay(
      'npx',
      AUTO_ARGS,
      {},
      {
        readToken: () => TOKEN,
        discover: async () => ({ kind: 'unavailable' }),
        discovery: TEST_DISCOVERY,
        connect: async () => ({ reason: 'success', durationMs: 1, status: 200, upstream: fakeUpstream() }),
      }
    );
    try {
      const proxyAuthorization = result.proxy?.consumeClientAuthorization();
      const childEndpoint = result.args.at(-1);
      expect(childEndpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/cdp$/u);
      expect(JSON.stringify(result.args)).not.toContain(TOKEN);
      expect(JSON.stringify(result.args)).not.toContain(proxyAuthorization ?? 'missing');
      expect(result.args).not.toContain('--wsHeaders');
      expect(result.decision.endpoint).toBe('ws://127.0.0.1:18799/cdp');
      expect(JSON.stringify(result.decision)).not.toContain(proxyAuthorization ?? 'missing');
    } finally {
      await result.proxy?.close();
    }
  });

  it('honors a custom loopback relay URL and rejects remote, credential-bearing, or malformed URLs', async () => {
    const custom = await rewriteChromeDevtoolsArgsForRelay(
      'npx',
      AUTO_ARGS,
      { MCPORTER_CHROME_DEVTOOLS_RELAY_URL: 'http://localhost:18798' },
      successfulOptions()
    );
    expect(custom.decision.endpoint).toBe('ws://localhost:18798/cdp');

    for (const url of [
      'http://relay.example.com:18799',
      'https://127.0.0.1:18799',
      'not a url',
      'http://x:y@127.0.0.1:18799',
    ]) {
      const result = await rewriteChromeDevtoolsArgsForRelay(
        'npx',
        AUTO_ARGS,
        { MCPORTER_CHROME_DEVTOOLS_RELAY_URL: url },
        successfulOptions()
      );
      expect(result.decision).toMatchObject({ route: 'legacy', reason: 'invalid-endpoint', policy: 'prefer' });
    }
  });

  it('keeps prefer backward-compatible while classifying v2 authentication failures', async () => {
    const cases: Array<[ChromeDevtoolsRelayProbeResult['reason'], number | undefined]> = [
      ['unsupported-auth', 401],
      ['bad-server-proof', 200],
      ['server-auth-failed', 503],
      ['replay', 409],
      ['protocol', 400],
      ['freshness', 410],
      ['sequence', 412],
      ['extension-disconnected', 503],
      ['timeout', undefined],
      ['network-error', undefined],
    ];
    for (const [reason, status] of cases) {
      const result = await rewriteChromeDevtoolsArgsForRelay(
        'npx',
        AUTO_ARGS,
        {},
        successfulOptions({ connect: async () => ({ reason, durationMs: 8, status }) })
      );
      expect(result.args).toBe(AUTO_ARGS);
      expect(result.decision).toEqual({
        route: 'legacy',
        reason,
        policy: 'prefer',
        endpoint: 'ws://127.0.0.1:18799/cdp',
        probeDurationMs: 8,
        probeStatus: status,
      });
    }
  });

  it('classifies local proxy startup failure and keeps require fail-closed', async () => {
    const upstreams: net.Socket[] = [];
    const options = successfulOptions({
      connect: async () => {
        const upstream = fakeUpstream();
        upstreams.push(upstream.socket);
        return { reason: 'success', durationMs: 2, status: 200, upstream };
      },
      startProxy: async () => {
        throw new Error('bind failed');
      },
    });
    const preferred = await rewriteChromeDevtoolsArgsForRelay('npx', AUTO_ARGS, {}, options);
    expect(preferred.decision).toMatchObject({ route: 'legacy', reason: 'network-error', policy: 'prefer' });
    await expect(
      rewriteChromeDevtoolsArgsForRelay('npx', AUTO_ARGS, { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'require' }, options)
    ).rejects.toMatchObject({
      decision: expect.objectContaining({ route: 'unavailable', reason: 'network-error', policy: 'require' }),
    });
    expect(upstreams).toHaveLength(2);
    expect(upstreams.every((socket) => socket.destroyed)).toBe(true);
  });

  it('closes the proxy when decision reporting fails after startup', async () => {
    const close = vi.fn(async () => {});
    await expect(
      rewriteChromeDevtoolsArgsForRelay(
        'npx',
        AUTO_ARGS,
        {},
        successfulOptions({
          startProxy: async () => ({
            endpoint: 'ws://127.0.0.1:45678/cdp',
            consumeClientAuthorization: () => `Bearer ${'j'.repeat(43)}`,
            close,
          }),
          onDecision: () => {
            throw new Error('logger failed');
          },
        })
      )
    ).rejects.toThrow('logger failed');
    expect(close).toHaveBeenCalledOnce();
  });

  it('makes off explicit and never probes', async () => {
    const connect = vi.fn(async () => ({
      reason: 'success' as const,
      durationMs: 1,
      status: 200,
      upstream: fakeUpstream(),
    }));
    const result = await rewriteChromeDevtoolsArgsForRelay(
      'npx',
      AUTO_ARGS,
      { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'off' },
      successfulOptions({ connect })
    );
    expect(result.args).toBe(AUTO_ARGS);
    expect(result.decision).toEqual({ route: 'legacy', reason: 'disabled', policy: 'off' });
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([
    ['missing-credential', successfulOptions({ readToken: () => undefined })],
    [
      'unsupported-auth',
      successfulOptions({ connect: async () => ({ reason: 'unsupported-auth', durationMs: 3, status: 401 }) }),
    ],
    [
      'extension-disconnected',
      successfulOptions({ connect: async () => ({ reason: 'extension-disconnected', durationMs: 3, status: 503 }) }),
    ],
    ['timeout', successfulOptions({ connect: async () => ({ reason: 'timeout', durationMs: 100 }) })],
    ['network-error', successfulOptions({ connect: async () => ({ reason: 'network-error', durationMs: 2 }) })],
  ] as const)('require fails before legacy launch for %s', async (reason, options) => {
    const decisions: unknown[] = [];
    await expect(
      rewriteChromeDevtoolsArgsForRelay(
        'npx',
        AUTO_ARGS,
        { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'require' },
        { ...options, onDecision: (decision) => decisions.push(decision) }
      )
    ).rejects.toMatchObject({
      name: 'ChromeDevtoolsRelayRequiredError',
      decision: expect.objectContaining({ route: 'unavailable', reason, policy: 'require' }),
    });
    expect(decisions).toHaveLength(1);
  });

  it('matches OpenClaw credential directory precedence and rejects insecure or malformed secret files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-relay-secret-'));
    const stateCredentials = path.join(root, 'state', 'credentials');
    const oauthDir = path.join(root, 'oauth');
    await fs.mkdir(stateCredentials, { recursive: true });
    await fs.mkdir(oauthDir, { recursive: true });
    const stateSecret = path.join(stateCredentials, 'browser-extension-relay.secret');
    const oauthSecret = path.join(oauthDir, 'browser-extension-relay.secret');
    try {
      await fs.writeFile(stateSecret, `${TOKEN}\n`, { mode: 0o600 });
      const stateResult = await rewriteChromeDevtoolsArgsForRelay(
        'npx',
        AUTO_ARGS,
        { OPENCLAW_STATE_DIR: path.join(root, 'state') },
        successfulOptions({ readToken: undefined })
      );
      expect(stateResult.applied).toBe(true);

      await fs.writeFile(oauthSecret, `${TOKEN}\n`, { mode: 0o600 });
      const oauthResult = await rewriteChromeDevtoolsArgsForRelay(
        'npx',
        AUTO_ARGS,
        { OPENCLAW_STATE_DIR: path.join(root, 'missing'), OPENCLAW_OAUTH_DIR: oauthDir },
        successfulOptions({ readToken: undefined })
      );
      expect(oauthResult.applied).toBe(true);

      if (process.platform !== 'win32') {
        await fs.chmod(oauthSecret, 0o644);
        const insecure = await rewriteChromeDevtoolsArgsForRelay(
          'npx',
          AUTO_ARGS,
          { OPENCLAW_OAUTH_DIR: oauthDir },
          successfulOptions({ readToken: undefined })
        );
        expect(insecure.decision.reason).toBe('invalid-credential');
        await fs.chmod(oauthSecret, 0o600);
      }
      await fs.writeFile(oauthSecret, 'not-a-token', { mode: 0o600 });
      const malformed = await rewriteChromeDevtoolsArgsForRelay(
        'npx',
        AUTO_ARGS,
        { OPENCLAW_OAUTH_DIR: oauthDir },
        successfulOptions({ readToken: undefined })
      );
      expect(malformed.decision.reason).toBe('invalid-credential');

      if (process.platform !== 'win32') {
        const symlinkTarget = path.join(root, 'relay-secret-target');
        await fs.writeFile(symlinkTarget, TOKEN, { mode: 0o600 });
        await fs.rm(oauthSecret);
        await fs.symlink(symlinkTarget, oauthSecret);
        const symlinked = await rewriteChromeDevtoolsArgsForRelay(
          'npx',
          AUTO_ARGS,
          { OPENCLAW_OAUTH_DIR: oauthDir },
          successfulOptions({ readToken: undefined })
        );
        expect(symlinked.decision.reason).toBe('invalid-credential');
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('matches OpenClaw default, named-profile, home, state, and OAuth credential precedence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-relay-profile-'));
    const home = path.join(root, 'home');
    const state = path.join(root, 'state');
    const oauth = path.join(root, 'oauth');
    const keys = {
      default: Buffer.alloc(32, 0x61).toString('hex'),
      named: Buffer.alloc(32, 0x62).toString('hex'),
      state: Buffer.alloc(32, 0x63).toString('hex'),
      oauth: Buffer.alloc(32, 0x64).toString('hex'),
    };
    try {
      await writeRelayCredential(path.join(home, '.openclaw', 'credentials'), keys.default);
      await writeRelayCredential(path.join(home, '.openclaw-Work', 'credentials'), keys.named);
      await writeRelayCredential(path.join(state, 'credentials'), keys.state);
      await writeRelayCredential(oauth, keys.oauth);

      const cases: Array<{ name: string; env: NodeJS.ProcessEnv; key: string; forwardedProfile?: string }> = [
        { name: 'default', env: { OPENCLAW_HOME: home }, key: keys.default },
        {
          name: 'case-insensitive default profile',
          env: { OPENCLAW_HOME: home, OPENCLAW_PROFILE: 'Default' },
          key: keys.default,
        },
        {
          name: 'named profile',
          env: { OPENCLAW_HOME: home, OPENCLAW_PROFILE: ' Work ' },
          key: keys.named,
          forwardedProfile: 'Work',
        },
        {
          name: 'HOME-derived named profile',
          env: { HOME: home, OPENCLAW_PROFILE: 'Work' },
          key: keys.named,
          forwardedProfile: 'Work',
        },
        {
          name: 'invalid profile falls back safely',
          env: { OPENCLAW_HOME: home, OPENCLAW_PROFILE: '../Work' },
          key: keys.default,
        },
        {
          name: 'explicit state overrides profile',
          env: { OPENCLAW_HOME: home, OPENCLAW_PROFILE: 'Work', OPENCLAW_STATE_DIR: state },
          key: keys.state,
          forwardedProfile: 'Work',
        },
        {
          name: 'explicit OAuth directory overrides state',
          env: {
            OPENCLAW_HOME: home,
            OPENCLAW_PROFILE: 'Work',
            OPENCLAW_STATE_DIR: state,
            OPENCLAW_OAUTH_DIR: oauth,
          },
          key: keys.oauth,
          forwardedProfile: 'Work',
        },
      ];

      for (const testCase of cases) {
        const expectedKeyId = deriveBrowserRelayKeyId(Buffer.from(testCase.key, 'hex'));
        const observed: string[] = [];
        const result = await rewriteChromeDevtoolsArgsForRelay(
          'npx',
          AUTO_ARGS,
          testCase.env,
          successfulOptions({
            readToken: undefined,
            discover: async (options) => {
              expect(options.env.OPENCLAW_PROFILE, testCase.name).toBe(testCase.forwardedProfile);
              return { kind: 'success', stdout: relayMetadata(expectedKeyId, 19_110) };
            },
            connect: async (url, credential) => {
              observed.push(url.toString(), credential.keyId);
              return { reason: 'network-error', durationMs: 1 };
            },
          })
        );
        expect(observed, testCase.name).toEqual(['http://127.0.0.1:19110/', expectedKeyId]);
        expect(result.decision.endpoint, testCase.name).toBe('ws://127.0.0.1:19110/cdp');
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('satisfies require with a named-profile credential and discovered endpoint', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-relay-profile-require-'));
    const key = Buffer.alloc(32, 0x65).toString('hex');
    const keyId = deriveBrowserRelayKeyId(Buffer.from(key, 'hex'));
    try {
      await writeRelayCredential(path.join(root, '.openclaw-work', 'credentials'), key);
      const result = await rewriteChromeDevtoolsArgsForRelay(
        'npx',
        AUTO_ARGS,
        {
          OPENCLAW_HOME: root,
          OPENCLAW_PROFILE: 'work',
          MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'require',
        },
        successfulOptions({
          readToken: undefined,
          discover: async () => ({ kind: 'success', stdout: relayMetadata(keyId, 19_110) }),
          connect: async (url, credential) => {
            expect(url.toString()).toBe('http://127.0.0.1:19110/');
            expect(credential.keyId).toBe(keyId);
            return { reason: 'success', durationMs: 1, status: 200, upstream: fakeUpstream() };
          },
        })
      );
      expect(result.applied).toBe(true);
      expect(result.decision).toMatchObject({
        route: 'relay',
        policy: 'require',
        endpoint: 'ws://127.0.0.1:19110/cdp',
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('leaves unrelated commands untouched without credential discovery or probing', async () => {
    const readToken = vi.fn(() => TOKEN);
    const connect = vi.fn(async () => ({
      reason: 'success' as const,
      durationMs: 1,
      status: 200,
      upstream: fakeUpstream(),
    }));
    const args = ['-y', 'some-mcp'];
    const result = await rewriteChromeDevtoolsArgsForRelay(
      'npx',
      args,
      { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'invalid-for-unrelated-command' },
      { readToken, connect }
    );
    expect(result).toMatchObject({ args, applied: false, decision: { reason: 'not-eligible' } });
    expect(readToken).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
});

async function writeRelayCredential(directory: string, key: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'browser-extension-relay.secret'), key, { mode: 0o600 });
}
