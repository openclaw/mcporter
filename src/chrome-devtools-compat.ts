import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderChromeDevtoolsAutoConnectPatchSource } from './chrome-devtools-auto-connect-patch.js';

const AUTO_CONNECT_FLAGS = new Set(['--autoConnect', '--auto-connect']);
const FALLBACK_PATCH_FILENAME = 'mcporter-chrome-devtools-auto-connect-patch.js';

export interface ChromeDevtoolsCompatResult {
  readonly env: Record<string, string>;
  readonly applied: boolean;
  readonly patchPath?: string;
}

export function applyChromeDevtoolsCompat(
  env: Record<string, string>,
  command: string,
  args: readonly string[]
): ChromeDevtoolsCompatResult {
  if (!shouldApplyChromeDevtoolsCompat(command, args, env)) {
    return { env, applied: false };
  }
  const patchPath = resolveChromeDevtoolsCompatPatchPath();
  if (!patchPath) {
    return { env, applied: false };
  }
  const importFlag = `--import=${pathToFileURL(patchPath).href}`;
  const existingOptions = env.NODE_OPTIONS?.trim();
  if (existingOptions?.includes(importFlag)) {
    return { env, applied: true, patchPath };
  }
  return {
    env: {
      ...env,
      NODE_OPTIONS: existingOptions ? `${existingOptions} ${importFlag}` : importFlag,
    },
    applied: true,
    patchPath,
  };
}

export function shouldApplyChromeDevtoolsCompat(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv | Record<string, string> = process.env
): boolean {
  if (env.MCPORTER_DISABLE_CHROME_DEVTOOLS_COMPAT === '1') {
    return false;
  }
  const tokens = [command, ...args];
  return tokens.some(isChromeDevtoolsToken) && args.some((arg) => AUTO_CONNECT_FLAGS.has(arg));
}

function isChromeDevtoolsToken(token: string): boolean {
  return (
    token === 'chrome-devtools-mcp' ||
    token.startsWith('chrome-devtools-mcp@') ||
    token.includes('/chrome-devtools-mcp')
  );
}

export function resolveChromeDevtoolsCompatPatchPath(
  candidates = defaultChromeDevtoolsPatchCandidates(),
  fallbackDir = os.tmpdir()
): string | undefined {
  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  if (existing) {
    return existing;
  }
  return writeFallbackPatch(fallbackDir);
}

function defaultChromeDevtoolsPatchCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.join(here, 'chrome-devtools-auto-connect-patch.js'),
    path.resolve(here, '..', 'dist', 'chrome-devtools-auto-connect-patch.js'),
  ];
}

function writeFallbackPatch(fallbackDir: string): string | undefined {
  const patchPath = path.join(fallbackDir, FALLBACK_PATCH_FILENAME);
  try {
    fs.writeFileSync(patchPath, renderChromeDevtoolsAutoConnectPatchSource(), { mode: 0o600 });
    return patchPath;
  } catch {
    return undefined;
  }
}
