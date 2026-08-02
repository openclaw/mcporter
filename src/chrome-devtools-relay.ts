import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * OpenClaw browser-extension relay rewrite for chrome-devtools-mcp.
 *
 * `--autoConnect` attaches through Chrome's M144+ remote-debugging handshake,
 * which pops a per-session "Allow remote debugging?" dialog. When the OpenClaw
 * Chrome extension relay is paired on this host, the same real profile is
 * reachable over a loopback CDP endpoint with no dialog at all, so mcporter
 * rewrites the server args to connect there instead. Everything is best-effort:
 * if the relay secret is missing, the relay is down, or the extension is not
 * paired, the original --autoConnect args are kept unchanged.
 */

const AUTO_CONNECT_FLAGS = new Set(['--autoConnect', '--auto-connect']);
const RELAY_PROBE_TIMEOUT_MS = 750;
const DEFAULT_RELAY_URL = 'http://127.0.0.1:18799';

export interface ChromeDevtoolsRelayRewrite {
  readonly args: readonly string[];
  readonly applied: boolean;
  readonly endpoint?: string;
}

export interface ChromeDevtoolsRelayProbeOptions {
  readonly readToken?: () => string | undefined;
  readonly probe?: (versionUrl: string, token: string) => Promise<boolean>;
}

function isChromeDevtoolsToken(token: string): boolean {
  return (
    token === 'chrome-devtools-mcp' ||
    token.startsWith('chrome-devtools-mcp@') ||
    token.includes('/chrome-devtools-mcp')
  );
}

function relayBaseUrl(env: NodeJS.ProcessEnv): URL | undefined {
  const raw = env.MCPORTER_CHROME_DEVTOOLS_RELAY_URL?.trim() || DEFAULT_RELAY_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  // The relay is loopback-only and the Bearer token rides plain HTTP headers.
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) {
    return undefined;
  }
  return url;
}

function defaultReadToken(env: NodeJS.ProcessEnv): string | undefined {
  const stateDir = env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), '.openclaw');
  const secretPath = path.join(stateDir, 'credentials', 'browser-extension-relay.secret');
  let raw: string;
  try {
    raw = fs.readFileSync(secretPath, 'utf8');
  } catch {
    return undefined;
  }
  const token = raw.trim();
  return /^[0-9a-f]{64}$/.test(token) ? token : undefined;
}

async function defaultProbe(versionUrl: string, token: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELAY_PROBE_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(versionUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    // 200 requires a paired, connected extension; 503 means relay up but
    // unpaired, where --autoConnect (with its dialog) still beats failing.
    return response.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function shouldAttemptChromeDevtoolsRelay(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (env.MCPORTER_DISABLE_CHROME_DEVTOOLS_RELAY === '1') {
    return false;
  }
  const tokens = [command, ...args];
  return tokens.some(isChromeDevtoolsToken) && args.some((arg) => AUTO_CONNECT_FLAGS.has(arg));
}

/**
 * Rewrite `--autoConnect` to `--wsEndpoint/--wsHeaders` against a live, paired
 * OpenClaw extension relay. Returns the original args when the relay is not
 * usable for any reason.
 */
export async function rewriteChromeDevtoolsArgsForRelay(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  options: ChromeDevtoolsRelayProbeOptions = {}
): Promise<ChromeDevtoolsRelayRewrite> {
  if (!shouldAttemptChromeDevtoolsRelay(command, args, env)) {
    return { args, applied: false };
  }
  const base = relayBaseUrl(env);
  if (!base) {
    return { args, applied: false };
  }
  const token = (options.readToken ?? (() => defaultReadToken(env)))();
  if (!token) {
    return { args, applied: false };
  }
  const versionUrl = new URL('/json/version', base).toString();
  const alive = await (options.probe ?? defaultProbe)(versionUrl, token);
  if (!alive) {
    return { args, applied: false };
  }
  const wsEndpoint = `ws://${base.host}/cdp`;
  const rewritten = args.filter((arg) => !AUTO_CONNECT_FLAGS.has(arg));
  rewritten.push('--wsEndpoint', wsEndpoint, '--wsHeaders', JSON.stringify({ Authorization: `Bearer ${token}` }));
  return { args: rewritten, applied: true, endpoint: wsEndpoint };
}
