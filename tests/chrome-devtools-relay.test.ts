import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rewriteChromeDevtoolsArgsForRelay, shouldAttemptChromeDevtoolsRelay } from '../src/chrome-devtools-relay.js';

const TOKEN = 'a'.repeat(64);
const AUTO_ARGS = ['-y', 'chrome-devtools-mcp@latest', '--autoConnect'];

describe('chrome-devtools OpenClaw relay rewrite', () => {
  afterEach(() => {
    delete process.env.MCPORTER_DISABLE_CHROME_DEVTOOLS_RELAY;
    delete process.env.MCPORTER_CHROME_DEVTOOLS_RELAY_URL;
    vi.unstubAllGlobals();
  });

  it('only considers autoConnect chrome-devtools commands', () => {
    expect(shouldAttemptChromeDevtoolsRelay('npx', AUTO_ARGS)).toBe(true);
    expect(shouldAttemptChromeDevtoolsRelay('npx', ['-y', 'chrome-devtools-mcp@latest'])).toBe(false);
    expect(shouldAttemptChromeDevtoolsRelay('npx', ['-y', 'other-mcp', '--autoConnect'])).toBe(false);
  });

  it('allows opting out via env', () => {
    expect(shouldAttemptChromeDevtoolsRelay('npx', AUTO_ARGS, { MCPORTER_DISABLE_CHROME_DEVTOOLS_RELAY: '1' })).toBe(
      false
    );
  });

  it('rewrites autoConnect to wsEndpoint against a live paired relay', async () => {
    const probed: string[] = [];
    const result = await rewriteChromeDevtoolsArgsForRelay(
      'npx',
      AUTO_ARGS,
      {},
      {
        readToken: () => TOKEN,
        probe: async (url, token) => {
          probed.push(url, token);
          return true;
        },
      }
    );

    expect(result.applied).toBe(true);
    expect(probed).toEqual(['http://127.0.0.1:18799/json/version', TOKEN]);
    expect(result.args).toEqual([
      '-y',
      'chrome-devtools-mcp@latest',
      '--wsEndpoint',
      'ws://127.0.0.1:18799/cdp',
      '--wsHeaders',
      JSON.stringify({ Authorization: `Bearer ${TOKEN}` }),
    ]);
    expect(result.endpoint).toBe('ws://127.0.0.1:18799/cdp');
  });

  it('honors a custom loopback relay URL', async () => {
    const result = await rewriteChromeDevtoolsArgsForRelay(
      'npx',
      AUTO_ARGS,
      { MCPORTER_CHROME_DEVTOOLS_RELAY_URL: 'http://localhost:18798' },
      { readToken: () => TOKEN, probe: async () => true }
    );

    expect(result.applied).toBe(true);
    expect(result.args).toContain('ws://localhost:18798/cdp');
  });

  it('rejects non-loopback relay URLs', async () => {
    const result = await rewriteChromeDevtoolsArgsForRelay(
      'npx',
      AUTO_ARGS,
      { MCPORTER_CHROME_DEVTOOLS_RELAY_URL: 'http://relay.example.com:18799' },
      { readToken: () => TOKEN, probe: async () => true }
    );

    expect(result).toEqual({ args: AUTO_ARGS, applied: false });
  });

  it('rejects malformed relay URLs', async () => {
    await expect(
      rewriteChromeDevtoolsArgsForRelay(
        'npx',
        AUTO_ARGS,
        { MCPORTER_CHROME_DEVTOOLS_RELAY_URL: 'not a url' },
        { readToken: () => TOKEN, probe: async () => true }
      )
    ).resolves.toEqual({ args: AUTO_ARGS, applied: false });
  });

  it('reads and validates the default relay secret from OpenClaw state', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-relay-secret-'));
    const credentials = path.join(stateDir, 'credentials');
    await fs.mkdir(credentials);
    const secretPath = path.join(credentials, 'browser-extension-relay.secret');
    try {
      await fs.writeFile(secretPath, 'invalid');
      await expect(
        rewriteChromeDevtoolsArgsForRelay(
          'npx',
          AUTO_ARGS,
          { OPENCLAW_STATE_DIR: stateDir },
          { probe: async () => true }
        )
      ).resolves.toEqual({ args: AUTO_ARGS, applied: false });

      await fs.writeFile(secretPath, ` ${TOKEN}\n`);
      const result = await rewriteChromeDevtoolsArgsForRelay(
        'npx',
        AUTO_ARGS,
        { OPENCLAW_STATE_DIR: stateDir },
        { probe: async () => true }
      );
      expect(result.applied).toBe(true);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it('uses the default authenticated probe and handles network failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      rewriteChromeDevtoolsArgsForRelay('npx', AUTO_ARGS, {}, { readToken: () => TOKEN })
    ).resolves.toMatchObject({ applied: true });
    await expect(rewriteChromeDevtoolsArgsForRelay('npx', AUTO_ARGS, {}, { readToken: () => TOKEN })).resolves.toEqual({
      args: AUTO_ARGS,
      applied: false,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:18799/json/version',
      expect.objectContaining({ headers: { Authorization: `Bearer ${TOKEN}` }, signal: expect.any(AbortSignal) })
    );
  });

  it('keeps autoConnect when the relay secret is missing', async () => {
    const result = await rewriteChromeDevtoolsArgsForRelay(
      'npx',
      AUTO_ARGS,
      {},
      {
        readToken: () => undefined,
        probe: async () => true,
      }
    );

    expect(result).toEqual({ args: AUTO_ARGS, applied: false });
  });

  it('keeps autoConnect when the relay is down or unpaired', async () => {
    const result = await rewriteChromeDevtoolsArgsForRelay(
      'npx',
      AUTO_ARGS,
      {},
      {
        readToken: () => TOKEN,
        probe: async () => false,
      }
    );

    expect(result).toEqual({ args: AUTO_ARGS, applied: false });
  });

  it('leaves unrelated commands untouched without probing', async () => {
    let probes = 0;
    const result = await rewriteChromeDevtoolsArgsForRelay(
      'npx',
      ['-y', 'some-mcp'],
      {},
      {
        readToken: () => TOKEN,
        probe: async () => {
          probes += 1;
          return true;
        },
      }
    );

    expect(result).toEqual({ args: ['-y', 'some-mcp'], applied: false });
    expect(probes).toBe(0);
  });
});
