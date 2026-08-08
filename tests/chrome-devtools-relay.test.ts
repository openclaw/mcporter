import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hashChromeDevtoolsRelayEnvironment,
  resolveChromeDevtoolsRelayPolicy,
  resolveChromeDevtoolsRelayProbeTimeoutMs,
  rewriteChromeDevtoolsArgsForRelay,
  shouldAttemptChromeDevtoolsRelay,
  type ChromeDevtoolsRelayProbeOptions,
  type ChromeDevtoolsRelayProbeResult,
} from '../src/chrome-devtools-relay.js';
import type { ServerDefinition } from '../src/config.js';

const TOKEN = 'a'.repeat(64);
const FAKE_PROXY_AUTHORIZATION = `Bearer ${'c'.repeat(43)}`;
const AUTO_ARGS = ['-y', 'chrome-devtools-mcp@latest', '--autoConnect'];

function fakeUpstream() {
  return { socket: new net.Socket(), head: Buffer.alloc(0) };
}

function successfulOptions(overrides: ChromeDevtoolsRelayProbeOptions = {}): ChromeDevtoolsRelayProbeOptions {
  return {
    readToken: () => TOKEN,
    connect: async () => ({ reason: 'success', durationMs: 12, status: 200, upstream: fakeUpstream() }),
    startProxy: async () => ({
      endpoint: 'ws://127.0.0.1:45678/cdp',
      consumeClientAuthorization: () => FAKE_PROXY_AUTHORIZATION,
      close: async () => {},
    }),
    ...overrides,
  };
}

describe('chrome-devtools OpenClaw relay routing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
      { OPENCLAW_STATE_DIR: '/tmp/openclaw-state-a' },
      { OPENCLAW_OAUTH_DIR: '/tmp/openclaw-oauth-a' },
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
