import { afterEach, describe, expect, it } from 'vitest';
import { rewriteChromeDevtoolsArgsForRelay, shouldAttemptChromeDevtoolsRelay } from '../src/chrome-devtools-relay.js';

const TOKEN = 'a'.repeat(64);
const AUTO_ARGS = ['-y', 'chrome-devtools-mcp@latest', '--autoConnect'];

describe('chrome-devtools OpenClaw relay rewrite', () => {
  afterEach(() => {
    delete process.env.MCPORTER_DISABLE_CHROME_DEVTOOLS_RELAY;
    delete process.env.MCPORTER_CHROME_DEVTOOLS_RELAY_URL;
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
