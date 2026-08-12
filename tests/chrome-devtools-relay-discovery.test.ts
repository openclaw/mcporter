import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  BROWSER_RELAY_AUTH_CHALLENGE_PATH,
  BROWSER_RELAY_AUTH_COMPLETE_PATH,
  BROWSER_RELAY_AUTH_LABEL,
  BROWSER_RELAY_AUTH_VERSION,
  deriveBrowserRelayKeyId,
} from '../src/browser-relay-auth-v2.js';
import {
  discoverOpenClawRelayUrl,
  normalizeOpenClawProfile,
  OPENCLAW_RELAY_DISCOVERY_MAX_OUTPUT_BYTES,
  resolveOpenClawRelayDiscoveryCommandPlan,
  runOpenClawRelayDiscovery,
  type OpenClawRelayDiscoveryCommandOptions,
  type OpenClawRelayDiscoveryCommandResult,
  type OpenClawRelayDiscoveryRuntime,
  type OpenClawRelayDiscoveryRunner,
} from '../src/chrome-devtools-relay-discovery.js';
import {
  rewriteChromeDevtoolsArgsForRelay,
  type ChromeDevtoolsRelayProbeOptions,
} from '../src/chrome-devtools-relay.js';

const RELAY_KEY_HEX = Buffer.alloc(32, 0x61).toString('hex');
const RELAY_KEY_ID = deriveBrowserRelayKeyId(Buffer.from(RELAY_KEY_HEX, 'hex'));
const AUTO_ARGS = ['-y', 'chrome-devtools-mcp@latest', '--autoConnect'];
const WINDOWS_ROOT = String.raw`C:\Windows`;
const WINDOWS_CMD = String.raw`C:\Windows\System32\cmd.exe`;
const WINDOWS_TASKKILL = String.raw`C:\Windows\System32\taskkill.exe`;
const WINDOWS_SHIM_DIR = String.raw`C:\Program Files\OpenClaw\bin`;
const WINDOWS_SHIM = String.raw`C:\Program Files\OpenClaw\bin\openclaw.CMD`;
const TEST_DISCOVERY = { platform: 'linux' as const };

describe('OpenClaw relay metadata discovery', () => {
  it('requests only the canonical non-legacy OpenClaw command with bounded output and time', async () => {
    const env = { PATH: '/test/bin', OPENCLAW_STATE_DIR: '/test/state' };
    const sourceEnv = { ...env, MCPORTER_TEST_UNRELATED_VALUE: 'not-forwarded' };
    const run = vi.fn<OpenClawRelayDiscoveryRunner>(async () => ({ kind: 'success', stdout: metadata() }));
    await expect(
      discoverOpenClawRelayUrl({ env: sourceEnv, keyId: RELAY_KEY_ID, timeoutMs: 5_000, run, platform: 'linux' })
    ).resolves.toMatchObject({ reason: 'success' });
    expect(run).toHaveBeenCalledWith({
      executable: 'openclaw',
      args: ['browser', 'extension', 'cdp', '--json'],
      env,
      timeoutMs: 5_000,
      maxOutputBytes: OPENCLAW_RELAY_DISCOVERY_MAX_OUTPUT_BYTES,
      platform: 'linux',
      shell: false,
    });
    expect(run.mock.calls[0]?.[0].args).not.toContain('--legacy-bearer');
  });

  it('keeps an explicit nonempty URL authoritative without invoking discovery', async () => {
    const discoveryRunner = vi.fn<OpenClawRelayDiscoveryRunner>();
    const observed: string[] = [];
    const connect = vi.fn(async (url: URL) => {
      observed.push(url.toString());
      return { reason: 'network-error' as const, durationMs: 1 };
    });
    await rewriteChromeDevtoolsArgsForRelay(
      'npx',
      AUTO_ARGS,
      { MCPORTER_CHROME_DEVTOOLS_RELAY_URL: 'http://127.0.0.1:18888' },
      relayOptions({ discover: discoveryRunner, connect })
    );
    expect(discoveryRunner).not.toHaveBeenCalled();
    expect(observed).toEqual(['http://127.0.0.1:18888/']);
  });

  it('selects valid nondefault metadata and requires its matching local keyId', async () => {
    const observed: string[] = [];
    const connect = vi.fn(async (url: URL) => {
      observed.push(url.toString());
      return { reason: 'network-error' as const, durationMs: 1 };
    });
    await rewriteChromeDevtoolsArgsForRelay(
      'npx',
      AUTO_ARGS,
      {},
      relayOptions({ discover: runner(metadata()), connect })
    );
    expect(observed).toEqual(['http://127.0.0.1:19110/']);

    connect.mockClear();
    observed.length = 0;
    await rewriteChromeDevtoolsArgsForRelay(
      'npx',
      AUTO_ARGS,
      {},
      relayOptions({ discover: runner(metadata({ keyId: `${RELAY_KEY_ID}x` })), connect })
    );
    expect(observed).toEqual(['http://127.0.0.1:18799/']);
  });

  it('satisfies policy=require through a discovered nondefault relay', async () => {
    const result = await rewriteChromeDevtoolsArgsForRelay(
      'npx',
      AUTO_ARGS,
      { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'require' },
      relayOptions({
        discover: runner(metadata()),
        connect: async () => ({
          reason: 'success',
          durationMs: 1,
          status: 200,
          upstream: { socket: new net.Socket(), head: Buffer.alloc(0) },
        }),
        startProxy: async () => ({
          endpoint: 'ws://127.0.0.1:45678/cdp',
          consumeClientAuthorization: () => 'Bearer test-only-ephemeral-authorization',
          close: async () => {},
        }),
      })
    );
    expect(result.applied).toBe(true);
    expect(result.decision).toMatchObject({
      route: 'relay',
      policy: 'require',
      endpoint: 'ws://127.0.0.1:19110/cdp',
    });
  });

  it.each([
    ['nonloopback', metadata({ browserUrl: 'http://192.0.2.1:19110', wsEndpoint: 'ws://192.0.2.1:19110/cdp' })],
    ['https', metadata({ browserUrl: 'https://127.0.0.1:19110', wsEndpoint: 'wss://127.0.0.1:19110/cdp' })],
    ['credentials', metadata({ browserUrl: 'http://user@127.0.0.1:19110' })],
    ['port zero', metadata({ browserUrl: 'http://127.0.0.1:0', wsEndpoint: 'ws://127.0.0.1:0/cdp' })],
    ['browser path', metadata({ browserUrl: 'http://127.0.0.1:19110/json' })],
    ['browser query', metadata({ browserUrl: 'http://127.0.0.1:19110?profile=a' })],
    ['browser fragment', metadata({ browserUrl: 'http://127.0.0.1:19110#relay' })],
    ['websocket host mismatch', metadata({ wsEndpoint: 'ws://localhost:19110/cdp' })],
    ['websocket port mismatch', metadata({ wsEndpoint: 'ws://127.0.0.1:19111/cdp' })],
    ['websocket path', metadata({ wsEndpoint: 'ws://127.0.0.1:19110/json' })],
    ['websocket query', metadata({ wsEndpoint: 'ws://127.0.0.1:19110/cdp?profile=a' })],
    ['websocket fragment', metadata({ wsEndpoint: 'ws://127.0.0.1:19110/cdp#relay' })],
    ['websocket credentials', metadata({ wsEndpoint: 'ws://user@127.0.0.1:19110/cdp' })],
    ['nonloopback mapped IPv6', metadata({ host: '[::ffff:7f00]' })],
  ])('rejects unsafe %s metadata', async (_case, stdout) => {
    await expect(discover(stdout)).resolves.toEqual({ reason: 'unsafe' });
  });

  it.each([
    ['label', 'not-openclaw'],
    ['version', 1],
    ['role', 'extension'],
    ['transport', 'websocket'],
    ['method', 'GET'],
    ['resource', '/cdp'],
    ['flow', 'json-list'],
  ])('rejects an incompatible auth.%s contract', async (field, value) => {
    await expect(discover(metadata({ auth: { [field]: value } }))).resolves.toEqual({ reason: 'incompatible' });
  });

  it.each([
    ['challenge binding', metadata({ auth: { challengeUrl: 'http://127.0.0.1:19110/wrong' } })],
    ['complete binding', metadata({ auth: { completeUrl: 'http://127.0.0.1:19110/wrong' } })],
    ['legacy headers', metadata({ extra: { headers: { Authorization: 'forbidden' } } })],
    ['auth authorization', metadata({ auth: { Authorization: 'forbidden' } })],
  ])('rejects incompatible %s metadata', async (_case, stdout) => {
    await expect(discover(stdout)).resolves.toEqual({ reason: 'incompatible' });
  });

  it.each([
    ['malformed', Buffer.from('{')],
    ['prefixed', Buffer.from(`notice\n${metadata().toString('utf8')}`)],
    [
      'duplicate keys',
      Buffer.from(metadata().toString('utf8').replace('{"browserUrl":', '{"browserUrl":"ignored","browserUrl":')),
    ],
    ['oversized', Buffer.alloc(OPENCLAW_RELAY_DISCOVERY_MAX_OUTPUT_BYTES + 1, 0x20)],
  ])('rejects %s stdout', async (_case, stdout) => {
    const result = await discover(stdout);
    expect(result.url).toBeUndefined();
    expect(result.reason).not.toBe('success');
  });

  it.each([
    ['timeout', { kind: 'timeout' }],
    ['nonzero', { kind: 'nonzero' }],
    ['command-not-found', { kind: 'unavailable' }],
    ['overflow', { kind: 'overflow' }],
  ] as const)('falls back for a %s command result', async (_case, result) => {
    await expect(discoverCommand(result)).resolves.toEqual({ reason: result.kind });
  });

  it.each([
    ['127/8', '127.42.1.9'],
    ['localhost', 'localhost'],
    ['IPv6', '[::1]'],
    ['mapped IPv4', '[::ffff:127.0.0.1]'],
  ])('accepts %s loopback metadata', async (_case, host) => {
    const result = await discover(metadata({ host }));
    expect(result.reason).toBe('success');
    expect(result.url?.hostname).toBe(new URL(`http://${host}:19110`).hostname);
  });

  it('uses 18799 when discovery is unavailable and keeps require fail-closed when that relay is unavailable', async () => {
    const observed: string[] = [];
    const connect = vi.fn(async (url: URL) => {
      observed.push(url.toString());
      return { reason: 'network-error' as const, durationMs: 1 };
    });
    const options = relayOptions({ discover: async () => ({ kind: 'unavailable' }), connect });
    const preferred = await rewriteChromeDevtoolsArgsForRelay('npx', AUTO_ARGS, {}, options);
    expect(preferred.decision).toMatchObject({ route: 'legacy', endpoint: 'ws://127.0.0.1:18799/cdp' });
    expect(observed).toEqual(['http://127.0.0.1:18799/']);

    await expect(
      rewriteChromeDevtoolsArgsForRelay('npx', AUTO_ARGS, { MCPORTER_CHROME_DEVTOOLS_RELAY_POLICY: 'require' }, options)
    ).rejects.toMatchObject({
      decision: expect.objectContaining({ route: 'unavailable', reason: 'network-error', policy: 'require' }),
    });
  });
});

describe('OpenClaw discovery command planning', () => {
  it('keeps the POSIX executable and argv exact', () => {
    expect(resolveOpenClawRelayDiscoveryCommandPlan({}, 'darwin')).toEqual({
      executable: 'openclaw',
      args: ['browser', 'extension', 'cdp', '--json'],
      platform: 'darwin',
    });
    expect(resolveOpenClawRelayDiscoveryCommandPlan({}, 'linux')).toEqual({
      executable: 'openclaw',
      args: ['browser', 'extension', 'cdp', '--json'],
      platform: 'linux',
    });
  });

  it('selects the first regular openclaw.cmd from safe absolute PATH entries', () => {
    const first = String.raw`C:\OpenClaw\openclaw.CMD`;
    const second = String.raw`D:\OpenClaw\openclaw.CMD`;
    const isFile = vi.fn((candidate: string) => candidate === first || candidate === second);
    expect(
      resolveOpenClawRelayDiscoveryCommandPlan(
        windowsEnv({ Path: String.raw`;.;relative;C:\OpenClaw;D:\OpenClaw`, PATHEXT: '.EXE;.CMD' }),
        'win32',
        isFile
      )
    ).toEqual({
      executable: WINDOWS_CMD,
      args: ['/d', '/s', '/c', String.raw`""C:\OpenClaw\openclaw.CMD" browser extension cdp --json"`],
      cwd: String.raw`C:\OpenClaw`,
      platform: 'win32',
      taskkillExecutable: WINDOWS_TASKKILL,
    });
    expect(isFile).toHaveBeenCalledTimes(1);
    expect(isFile).toHaveBeenCalledWith(first);
  });

  it('quotes a Program Files shim with exact constant command bytes', () => {
    expect(resolveWindowsPlan()).toEqual({
      executable: WINDOWS_CMD,
      args: ['/d', '/s', '/c', String.raw`""C:\Program Files\OpenClaw\bin\openclaw.CMD" browser extension cdp --json"`],
      cwd: WINDOWS_SHIM_DIR,
      platform: 'win32',
      taskkillExecutable: WINDOWS_TASKKILL,
    });
  });

  it('ignores cwd, empty, and relative PATH entries even when they contain a shim', () => {
    const isFile = vi.fn(() => true);
    const plan = resolveOpenClawRelayDiscoveryCommandPlan(
      windowsEnv({ Path: String.raw`;.;..;relative` }),
      'win32',
      isFile
    );
    expect(plan).toBeUndefined();
    expect(isFile).not.toHaveBeenCalled();
  });

  it('ignores an absolute PATH entry that is the current directory', () => {
    const cwd = String.raw`C:\repo`;
    const safeShim = String.raw`C:\safe\openclaw.CMD`;
    const isFile = vi.fn((candidate: string) => [String.raw`C:\repo\openclaw.CMD`, safeShim].includes(candidate));
    const plan = resolveOpenClawRelayDiscoveryCommandPlan(
      windowsEnv({ Path: String.raw`C:\repo\;C:\safe`, PATHEXT: '.CMD' }),
      'win32',
      isFile,
      cwd
    );
    expect(plan?.cwd).toBe(String.raw`C:\safe`);
    expect(isFile).toHaveBeenCalledOnce();
    expect(isFile).toHaveBeenCalledWith(safeShim);
  });

  it.each([
    String.raw`C:\Users\Peter\%TEMP%`,
    String.raw`C:\Users\Peter\bad&path`,
    String.raw`C:\Users\Peter\bad!path`,
    String.raw`C:\Users\Peter\bad^path`,
    `C:\\Users\\Peter\\bad\npath`,
  ])('rejects a command-expanding or metacharacter PATH entry %j', (unsafePath) => {
    const isFile = vi.fn(() => true);
    expect(resolveOpenClawRelayDiscoveryCommandPlan(windowsEnv({ Path: unsafePath }), 'win32', isFile)).toBeUndefined();
    expect(isFile).not.toHaveBeenCalled();
  });

  it('requires .CMD in PATHEXT and an existing regular shim', () => {
    expect(
      resolveOpenClawRelayDiscoveryCommandPlan(windowsEnv({ PATHEXT: '.EXE;.BAT' }), 'win32', () => true)
    ).toBeUndefined();
    expect(resolveOpenClawRelayDiscoveryCommandPlan(windowsEnv(), 'win32', () => false)).toBeUndefined();
  });

  it('returns unavailable without invoking a runner when no safe shim resolves', async () => {
    const run = vi.fn<OpenClawRelayDiscoveryRunner>();
    await expect(
      discoverOpenClawRelayUrl({
        env: windowsEnv(),
        keyId: RELAY_KEY_ID,
        timeoutMs: 5_000,
        platform: 'win32',
        isFile: () => false,
        cwd: String.raw`C:\repo`,
        run,
      })
    ).resolves.toEqual({ reason: 'unavailable' });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ['validated ComSpec', { ComSpec: WINDOWS_CMD, SystemRoot: WINDOWS_ROOT }, WINDOWS_CMD],
    [
      'uppercase COMSPEC',
      { COMSPEC: String.raw`D:\Windows\System32\CMD.EXE`, SYSTEMROOT: String.raw`D:\Windows` },
      String.raw`D:\Windows\System32\CMD.EXE`,
    ],
    [
      'unsafe ComSpec fallback',
      { ComSpec: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, SystemRoot: WINDOWS_ROOT },
      WINDOWS_CMD,
    ],
    ['untrusted cmd.exe fallback', { ComSpec: String.raw`C:\Tools\cmd.exe`, SystemRoot: WINDOWS_ROOT }, WINDOWS_CMD],
    [
      'traversal ComSpec fallback',
      { ComSpec: String.raw`C:\Windows\System32\..\cmd.exe`, SystemRoot: WINDOWS_ROOT },
      WINDOWS_CMD,
    ],
    ['missing ComSpec fallback', { SystemRoot: WINDOWS_ROOT }, WINDOWS_CMD],
    ['conventional ComSpec without SystemRoot', { ComSpec: WINDOWS_CMD }, WINDOWS_CMD],
  ] as const)('preserves validated system cmd selection with %s', (_case, systemEnv, executable) => {
    const shim = executable.startsWith('D:') ? String.raw`D:\OpenClaw\openclaw.CMD` : WINDOWS_SHIM;
    const env = { ...systemEnv, Path: path.win32.dirname(shim), PATHEXT: '.CMD' };
    expect(resolveOpenClawRelayDiscoveryCommandPlan(env, 'win32', (candidate) => candidate === shim)).toMatchObject({
      executable,
    });
  });

  it.each([
    { ComSpec: 'powershell.exe', SystemRoot: String.raw`..\Windows` },
    { ComSpec: String.raw`C:\attacker\System32\cmd.exe`, SystemRoot: String.raw`C:\attacker` },
    {},
  ])('fails closed without an absolute validated system cmd.exe: %j', (systemEnv) => {
    expect(
      resolveOpenClawRelayDiscoveryCommandPlan(
        { ...systemEnv, Path: WINDOWS_SHIM_DIR, PATHEXT: '.CMD' },
        'win32',
        (candidate) => candidate === WINDOWS_SHIM
      )
    ).toBeUndefined();
  });

  it('passes the exact Windows plan through the async runner seam with shell disabled', async () => {
    const env = windowsEnv({ OPENCLAW_PROFILE: ' Work ' });
    const asyncRun = vi.fn<OpenClawRelayDiscoveryRunner>(async () => ({ kind: 'success', stdout: metadata() }));
    await discoverOpenClawRelayUrl({
      env,
      keyId: RELAY_KEY_ID,
      timeoutMs: 5_000,
      platform: 'win32',
      isFile: windowsShimIsFile,
      cwd: String.raw`C:\repo`,
      run: asyncRun,
    });
    expect(asyncRun).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: WINDOWS_CMD,
        args: [
          '/d',
          '/s',
          '/c',
          String.raw`""C:\Program Files\OpenClaw\bin\openclaw.CMD" browser extension cdp --json"`,
        ],
        cwd: WINDOWS_SHIM_DIR,
        env: expect.objectContaining({ ComSpec: WINDOWS_CMD, Path: WINDOWS_SHIM_DIR, OPENCLAW_PROFILE: 'Work' }),
        platform: 'win32',
        taskkillExecutable: WINDOWS_TASKKILL,
        shell: false,
      })
    );
  });

  it('does not forward an unsafe ComSpec to the discovery child', async () => {
    const run = vi.fn<OpenClawRelayDiscoveryRunner>(async () => ({ kind: 'success', stdout: metadata() }));
    await discoverOpenClawRelayUrl({
      env: {
        ComSpec: String.raw`C:\Tools\powershell.exe`,
        SystemRoot: WINDOWS_ROOT,
        Path: WINDOWS_SHIM_DIR,
      },
      keyId: RELAY_KEY_ID,
      timeoutMs: 5_000,
      platform: 'win32',
      isFile: windowsShimIsFile,
      cwd: String.raw`C:\repo`,
      run,
    });
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      executable: WINDOWS_CMD,
      env: expect.objectContaining({ ComSpec: WINDOWS_CMD, SystemRoot: WINDOWS_ROOT, Path: WINDOWS_SHIM_DIR }),
    });
    expect(run.mock.calls[0]?.[0].env.COMSPEC).toBeUndefined();
  });

  it.each([
    ['command-not-found', { kind: 'unavailable' }],
    ['timeout', { kind: 'timeout' }],
    ['overflow', { kind: 'overflow' }],
    ['nonzero', { kind: 'nonzero' }],
  ] as const)('preserves Windows %s fallback classification', async (_case, commandResult) => {
    await expect(
      discoverOpenClawRelayUrl({
        env: windowsEnv(),
        keyId: RELAY_KEY_ID,
        timeoutMs: 5_000,
        platform: 'win32',
        isFile: windowsShimIsFile,
        cwd: String.raw`C:\repo`,
        run: async () => commandResult,
      })
    ).resolves.toEqual({ reason: commandResult.kind });
  });

  it.each([
    [undefined, undefined],
    ['', undefined],
    ['default', undefined],
    ['Default', undefined],
    ['work', 'work'],
    [' Work_2 ', 'Work_2'],
    ['../work', undefined],
    ['bad profile', undefined],
    ['Kelvin', undefined],
    [`x${'y'.repeat(64)}`, undefined],
  ])('normalizes profile %j without permitting path syntax', (raw, expected) => {
    expect(normalizeOpenClawProfile(raw)).toBe(expected);
  });
});

describe('bounded Windows OpenClaw discovery process trees', () => {
  it('spawns cmd.exe with the exact verbatim absolute-shim command', async () => {
    const { child } = fakeChildProcess(32_109);
    const spawnProcess = vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;
    const result = runOpenClawRelayDiscovery(windowsCommandOptions(), { spawn: spawnProcess });
    child.emit('close', 0);
    await expect(result).resolves.toEqual({ kind: 'success', stdout: Buffer.alloc(0) });
    expect(spawnProcess).toHaveBeenCalledWith(
      WINDOWS_CMD,
      ['/d', '/s', '/c', String.raw`""C:\Program Files\OpenClaw\bin\openclaw.CMD" browser extension cdp --json"`],
      expect.objectContaining({
        cwd: WINDOWS_SHIM_DIR,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: true,
      })
    );
  });

  it.each([
    ['timeout', 'timeout'],
    ['overflow', 'overflow'],
  ] as const)('runs exact taskkill plan before resolving async %s', async (_case, trigger) => {
    const { child, unref } = fakeChildProcess(43_210);
    const terminateProcessTree = vi.fn<NonNullable<OpenClawRelayDiscoveryRuntime['terminateProcessTree']>>(
      async () => undefined
    );
    const result = runOpenClawRelayDiscovery(windowsCommandOptions({ timeoutMs: trigger === 'timeout' ? 5 : 5_000 }), {
      spawn: vi.fn(() => child) as unknown as typeof import('node:child_process').spawn,
      terminateProcessTree,
    });
    if (trigger === 'overflow') {
      child.stdout.write(Buffer.alloc(OPENCLAW_RELAY_DISCOVERY_MAX_OUTPUT_BYTES + 1));
    }
    await expect(result).resolves.toEqual({ kind: trigger });
    expect(terminateProcessTree).toHaveBeenCalledOnce();
    expect(terminateProcessTree.mock.calls[0]?.[0]).toEqual({
      kind: 'windows-taskkill',
      pid: 43_210,
      executable: WINDOWS_TASKKILL,
      args: ['/PID', '43210', '/T', '/F'],
      shell: false,
      windowsHide: true,
    });
    expect(unref).toHaveBeenCalledOnce();
  });

  it('keeps timeout classification when async tree termination fails', async () => {
    const asyncChild = fakeChildProcess(71_234).child;
    await expect(
      runOpenClawRelayDiscovery(windowsCommandOptions({ timeoutMs: 5 }), {
        spawn: vi.fn(() => asyncChild) as unknown as typeof import('node:child_process').spawn,
        terminateProcessTree: async () => {
          throw new Error('taskkill failed');
        },
      })
    ).resolves.toEqual({ kind: 'timeout' });
  });

  it.each([
    ['success', 'close', 0, { kind: 'success', stdout: Buffer.alloc(0) }],
    ['nonzero', 'close', 7, { kind: 'nonzero' }],
    ['ENOENT', 'error', Object.assign(new Error('missing'), { code: 'ENOENT' }), { kind: 'unavailable' }],
  ] as const)('does not tree-kill async %s', async (_case, event, value, expected) => {
    const { child } = fakeChildProcess(87_654);
    const terminateProcessTree = vi.fn<NonNullable<OpenClawRelayDiscoveryRuntime['terminateProcessTree']>>();
    const result = runOpenClawRelayDiscovery(windowsCommandOptions(), {
      spawn: vi.fn(() => child) as unknown as typeof import('node:child_process').spawn,
      terminateProcessTree,
    });
    child.emit(event, value);
    await expect(result).resolves.toEqual(expected);
    expect(terminateProcessTree).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === 'win32')('bounded OpenClaw discovery process', () => {
  it('discovers strict metadata through a built fake openclaw launcher', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-openclaw-success-'));
    try {
      const stdout = metadata().toString('utf8');
      await writeFakeOpenClaw(directory, `process.stdout.write(${JSON.stringify(stdout)});`);
      await expect(
        discoverOpenClawRelayUrl({
          env: { PATH: directory },
          keyId: RELAY_KEY_ID,
          timeoutMs: 5_000,
        })
      ).resolves.toMatchObject({ reason: 'success', url: new URL('http://127.0.0.1:19110') });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['timeout', `setInterval(() => {}, 1000);`, 100],
    ['overflow', `process.stdout.write('x'.repeat(${OPENCLAW_RELAY_DISCOVERY_MAX_OUTPUT_BYTES + 1}));`, 5_000],
    ['nonzero', `process.exitCode = 7;`, 5_000],
  ] as const)('classifies and terminates %s', async (expected, source, timeoutMs) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-openclaw-runner-'));
    try {
      await writeFakeOpenClaw(directory, source);
      await expect(
        runOpenClawRelayDiscovery({
          executable: 'openclaw',
          args: ['browser', 'extension', 'cdp', '--json'],
          env: { PATH: directory },
          timeoutMs,
          maxOutputBytes: OPENCLAW_RELAY_DISCOVERY_MAX_OUTPUT_BYTES,
          platform: process.platform,
          shell: false,
        })
      ).resolves.toEqual({ kind: expected });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('classifies command-not-found without shell fallback', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-openclaw-missing-'));
    try {
      await expect(
        runOpenClawRelayDiscovery({
          executable: 'openclaw',
          args: ['browser', 'extension', 'cdp', '--json'],
          env: { PATH: directory },
          timeoutMs: 5_000,
          maxOutputBytes: OPENCLAW_RELAY_DISCOVERY_MAX_OUTPUT_BYTES,
          platform: process.platform,
          shell: false,
        })
      ).resolves.toEqual({ kind: 'unavailable' });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

function windowsEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ComSpec: WINDOWS_CMD,
    SystemRoot: WINDOWS_ROOT,
    Path: WINDOWS_SHIM_DIR,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    ...overrides,
  };
}

function windowsShimIsFile(candidate: string): boolean {
  return candidate.toLowerCase() === WINDOWS_SHIM.toLowerCase();
}

function resolveWindowsPlan() {
  return resolveOpenClawRelayDiscoveryCommandPlan(windowsEnv(), 'win32', windowsShimIsFile, String.raw`C:\repo`);
}

function windowsCommandOptions(
  overrides: Partial<OpenClawRelayDiscoveryCommandOptions> = {}
): OpenClawRelayDiscoveryCommandOptions {
  const plan = resolveWindowsPlan();
  if (!plan) throw new Error('test Windows command plan did not resolve');
  return {
    ...plan,
    env: windowsEnv(),
    timeoutMs: 5_000,
    maxOutputBytes: OPENCLAW_RELAY_DISCOVERY_MAX_OUTPUT_BYTES,
    shell: false,
    ...overrides,
  };
}

function fakeChildProcess(pid: number): {
  child: ChildProcessWithoutNullStreams & { stdout: PassThrough; stderr: PassThrough };
  unref: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & {
    stdout: PassThrough;
    stderr: PassThrough;
  };
  const unref = vi.fn();
  Object.assign(child, {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
    unref,
  });
  return { child, unref };
}

function relayOptions(overrides: Partial<ChromeDevtoolsRelayProbeOptions>): ChromeDevtoolsRelayProbeOptions {
  return { readToken: () => RELAY_KEY_HEX, discovery: TEST_DISCOVERY, ...overrides };
}

function runner(stdout: Buffer): OpenClawRelayDiscoveryRunner {
  return async () => ({ kind: 'success', stdout });
}

async function discover(stdout: Buffer) {
  return discoverOpenClawRelayUrl({
    env: {},
    keyId: RELAY_KEY_ID,
    timeoutMs: 5_000,
    run: runner(stdout),
    platform: 'linux',
  });
}

async function discoverCommand(result: OpenClawRelayDiscoveryCommandResult) {
  return discoverOpenClawRelayUrl({
    env: {},
    keyId: RELAY_KEY_ID,
    timeoutMs: 5_000,
    run: async () => result,
    platform: 'linux',
  });
}

function metadata(
  overrides: {
    browserUrl?: string;
    wsEndpoint?: string;
    host?: string;
    keyId?: string;
    auth?: Record<string, unknown>;
    extra?: Record<string, unknown>;
  } = {}
): Buffer {
  const host = overrides.host ?? '127.0.0.1';
  const browserUrl = overrides.browserUrl ?? `http://${host}:19110`;
  const auth = {
    label: BROWSER_RELAY_AUTH_LABEL,
    version: BROWSER_RELAY_AUTH_VERSION,
    keyId: overrides.keyId ?? RELAY_KEY_ID,
    challengeUrl: new URL(BROWSER_RELAY_AUTH_CHALLENGE_PATH, browserUrl).toString(),
    completeUrl: new URL(BROWSER_RELAY_AUTH_COMPLETE_PATH, browserUrl).toString(),
    role: 'cdp',
    transport: 'connection',
    method: 'SEQUENCE',
    resource: '/json/version -> /cdp',
    flow: 'cdp',
    ...overrides.auth,
  };
  return Buffer.from(
    JSON.stringify({
      browserUrl,
      wsEndpoint: overrides.wsEndpoint ?? `ws://${host}:19110/cdp`,
      auth,
      ...overrides.extra,
    })
  );
}

async function writeFakeOpenClaw(directory: string, source: string): Promise<void> {
  const executable = path.join(directory, 'openclaw');
  await fs.writeFile(executable, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
}
