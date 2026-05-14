import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const AUTO_CONNECT_FLAGS = new Set(['--autoConnect', '--auto-connect']);
const FALLBACK_PATCH_FILENAME = 'mcporter-chrome-devtools-auto-connect-patch.js';
const FALLBACK_PATCH_SOURCE = `import fs from 'node:fs';
import path from 'node:path';

const MARKER = 'MCPORTER_DEVTOOLS_TIMEOUT_PATCH';
const HELPER = \`// \${MARKER}
const MCPORTER_DEVTOOLS_DETECTION_TIMEOUT = 1_000;
async function mcporterWithTimeout(promise, fallback) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise(resolve => {
                timer = setTimeout(resolve, MCPORTER_DEVTOOLS_DETECTION_TIMEOUT, fallback);
                timer.unref?.();
            }),
        ]);
    }
    finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}
\`;

const DETECTION_BLOCK = \`if (await page.hasDevTools()) {
                    mcpPage.devToolsPage = await page.openDevTools();
                }\`;

const PATCHED_DETECTION_BLOCK = \`if (await mcporterWithTimeout(page.hasDevTools(), false)) {
                    mcpPage.devToolsPage = await mcporterWithTimeout(page.openDevTools(), undefined);
                }\`;

patchChromeDevtoolsMcp();

function patchChromeDevtoolsMcp(mainPath = process.argv[1]) {
  if (!mainPath || !mainPath.includes('chrome-devtools-mcp')) {
    return;
  }
  let resolvedMainPath;
  try {
    resolvedMainPath = fs.realpathSync(mainPath);
  } catch {
    return;
  }
  if (!resolvedMainPath.endsWith(path.join('bin', 'chrome-devtools-mcp.js'))) {
    return;
  }
  const contextPath = path.resolve(path.dirname(resolvedMainPath), '..', 'McpContext.js');
  let source;
  try {
    source = fs.readFileSync(contextPath, 'utf8');
  } catch {
    return;
  }
  if (source.includes(MARKER)) {
    return;
  }
  if (!source.includes(DETECTION_BLOCK)) {
    return;
  }
  const withHelper = source.replace(
    'const NAVIGATION_TIMEOUT = 10_000;\\n',
    \`const NAVIGATION_TIMEOUT = 10_000;\\n\${HELPER}\`
  );
  const patched = withHelper.replace(DETECTION_BLOCK, PATCHED_DETECTION_BLOCK);
  try {
    fs.writeFileSync(contextPath, patched);
  } catch {
    return;
  }
}
`;

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
    fs.writeFileSync(patchPath, FALLBACK_PATCH_SOURCE, { mode: 0o600 });
    return patchPath;
  } catch {
    return undefined;
  }
}
