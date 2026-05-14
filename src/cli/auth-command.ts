import { spawn } from 'node:child_process';
import type { ServerDefinition } from '../config-schema.js';
import type { OAuthAuthorizationRequest, OAuthSessionOptions } from '../oauth.js';
import { analyzeConnectionError } from '../error-classifier.js';
import { clearOAuthCaches } from '../oauth-persistence.js';
import type { createRuntime } from '../runtime.js';
import { isOAuthFlowError } from '../runtime/oauth.js';
import type { EphemeralServerSpec } from './adhoc-server.js';
import { extractEphemeralServerFlags } from './ephemeral-flags.js';
import { persistPreparedEphemeralServer, prepareEphemeralServerTarget } from './ephemeral-target.js';
import { looksLikeHttpUrl } from './http-utils.js';
import { buildConnectionIssueEnvelope } from './json-output.js';
import { getActiveLogger, logInfo, logWarn } from './logger-context.js';
import { consumeOutputFormat } from './output-format.js';

type Runtime = Awaited<ReturnType<typeof createRuntime>>;

type BrowserSuppression = 'default' | 'no-browser';

const TRUE_VALUES = new Set(['1', 'true', 'yes']);
const FALSE_VALUES = new Set(['0', 'false', 'no']);

export async function handleAuth(runtime: Runtime, args: string[]): Promise<void> {
  const browserSuppression = consumeBrowserSuppression(args, process.env);
  const noBrowser = browserSuppression === 'no-browser';
  let authorizationOutputEmitted = false;
  const markAuthorizationOutputEmitted = () => {
    authorizationOutputEmitted = true;
  };
  const resetIndex = args.indexOf('--reset');
  const shouldReset = resetIndex !== -1;
  if (shouldReset) {
    args.splice(resetIndex, 1);
  }
  const format = consumeOutputFormat(args, {
    defaultFormat: 'text',
    allowed: ['text', 'json'],
    enableRawShortcut: false,
    jsonShortcutFlag: '--json',
  }) as 'text' | 'json';
  const ephemeralSpec: EphemeralServerSpec | undefined = extractEphemeralServerFlags(args);
  let target = args.shift();
  const nameHints: string[] = [];
  if (ephemeralSpec && target && !looksLikeHttpUrl(target)) {
    nameHints.push(target);
  }

  const prepared = await prepareEphemeralServerTarget({
    runtime,
    target,
    ephemeral: ephemeralSpec,
    nameHints,
    reuseFromSpec: true,
  });
  target = prepared.target;

  if (!target) {
    throw new Error('Usage: mcporter auth <server | url> [--http-url <url> | --stdio <command>]');
  }

  const definition = runtime.getDefinition(target);
  if (shouldReset) {
    await clearOAuthCaches(definition);
    if (!noBrowser) {
      logInfo(`Cleared cached credentials for '${target}'.`);
    }
  }

  if (definition.command.kind === 'stdio' && definition.oauthCommand) {
    logInfo(`Starting auth helper for '${target}' (stdio). Leave this running until the browser flow completes.`);
    try {
      await runStdioAuth(definition, { noBrowser });
      logInfo(`Auth helper for '${target}' finished. You can now call tools.`);
    } finally {
      await persistPreparedEphemeralServer(runtime, prepared);
    }
    return;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (!noBrowser) {
        logInfo(`Initiating OAuth flow for '${target}'...`);
      }
      const tools = await withInfoLogsSuppressed(noBrowser, () =>
        runtime.listTools(target, {
          autoAuthorize: true,
          ...(noBrowser
            ? {
                oauthSessionOptions: buildNoBrowserOAuthOptions(format, markAuthorizationOutputEmitted),
              }
            : {}),
        })
      );
      await persistPreparedEphemeralServer(runtime, prepared);
      if (!noBrowser) {
        logInfo(`Authorization complete. ${tools.length} tool${tools.length === 1 ? '' : 's'} available.`);
      }
      return;
    } catch (error) {
      await persistPreparedEphemeralServer(runtime, prepared);
      if (attempt === 0 && shouldRetryAuthError(error)) {
        logWarn('Server signaled OAuth after the initial attempt. Retrying with browser flow...');
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (format === 'json') {
        if (authorizationOutputEmitted) {
          console.error(`Failed to authorize '${target}': ${message}`);
        } else {
          const payload = buildConnectionIssueEnvelope({
            server: target,
            error,
            issue: analyzeConnectionError(error),
          });
          console.log(JSON.stringify(payload, null, 2));
        }
        process.exitCode = 1;
        return;
      }
      throw new Error(`Failed to authorize '${target}': ${message}`, { cause: error });
    }
  }
}

async function withInfoLogsSuppressed<T>(enabled: boolean, task: () => Promise<T>): Promise<T> {
  if (!enabled) {
    return task();
  }
  const logger = getActiveLogger();
  const originalInfo = logger.info.bind(logger);
  logger.info = () => {};
  try {
    return await task();
  } finally {
    logger.info = originalInfo;
  }
}

async function runStdioAuth(definition: ServerDefinition, options: { noBrowser?: boolean } = {}): Promise<void> {
  const authArgs = [...(definition.command.kind === 'stdio' ? (definition.command.args ?? []) : [])];
  if (definition.oauthCommand) {
    authArgs.push(...definition.oauthCommand.args);
  }
  const env = options.noBrowser ? { ...process.env, MCPORTER_OAUTH_NO_BROWSER: '1' } : process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(definition.command.kind === 'stdio' ? definition.command.command : '', authArgs, {
      stdio: 'inherit',
      cwd: definition.command.kind === 'stdio' ? definition.command.cwd : process.cwd(),
      env,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Auth helper exited with code ${code ?? 'null'}`));
      }
    });
  });
}

function buildNoBrowserOAuthOptions(
  format: 'text' | 'json',
  markAuthorizationOutputEmitted: () => void
): OAuthSessionOptions {
  return {
    suppressBrowserLaunch: true,
    onAuthorizationUrl(request: OAuthAuthorizationRequest) {
      markAuthorizationOutputEmitted();
      if (format === 'json') {
        console.log(
          JSON.stringify(
            {
              authorizationUrl: request.authorizationUrl,
              redirectUrl: request.redirectUrl,
            },
            null,
            2
          )
        );
        return;
      }
      console.log(request.authorizationUrl);
    },
  };
}

function consumeBrowserSuppression(args: string[], env: NodeJS.ProcessEnv): BrowserSuppression {
  let mode = resolveBrowserSuppressionFromEnv(env.MCPORTER_OAUTH_NO_BROWSER);
  const noBrowserIndex = args.indexOf('--no-browser');
  if (noBrowserIndex !== -1) {
    args.splice(noBrowserIndex, 1);
    mode = 'no-browser';
  }
  const browserIndex = args.indexOf('--browser');
  if (browserIndex !== -1) {
    const value = args[browserIndex + 1];
    if (!value) {
      throw new Error("Flag '--browser' requires a value.");
    }
    if (value !== 'none') {
      throw new Error("--browser must be 'none' when provided to mcporter auth.");
    }
    args.splice(browserIndex, 2);
    mode = 'no-browser';
  }
  return mode;
}

function resolveBrowserSuppressionFromEnv(raw: string | undefined): BrowserSuppression {
  if (raw === undefined) {
    return 'default';
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized || FALSE_VALUES.has(normalized)) {
    return 'default';
  }
  if (TRUE_VALUES.has(normalized)) {
    return 'no-browser';
  }
  return 'default';
}

function shouldRetryAuthError(error: unknown): boolean {
  if (isOAuthFlowError(error)) {
    return false;
  }
  return analyzeConnectionError(error).kind === 'auth';
}

export function printAuthHelp(): void {
  const lines = [
    'Usage: mcporter auth <server | url> [flags]',
    '',
    'Purpose:',
    '  Run the authentication flow for a server without listing tools.',
    '',
    'Common flags:',
    '  --reset                 Clear cached credentials before re-authorizing.',
    '  --json                  Emit a JSON envelope on failure (and auth-start JSON with --no-browser).',
    '  --no-browser            Print the OAuth authorization URL without launching a browser.',
    '  --browser none          Alias for --no-browser (also supported by config login).',
    '  MCPORTER_OAUTH_NO_BROWSER=1|true|yes also enables --no-browser behavior.',
    '',
    'Ad-hoc targets:',
    '  --http-url <url>        Register an HTTP server for this run.',
    '  --allow-http            Permit plain http:// URLs with --http-url.',
    '  --header KEY=value      Attach HTTP headers (repeatable).',
    '  --stdio <command>       Run a stdio MCP server (repeat --stdio-arg for args).',
    '  --stdio-arg <value>     Append args to the stdio command (repeatable).',
    '  --env KEY=value         Inject env vars for stdio servers (repeatable).',
    '  --cwd <path>            Working directory for stdio servers.',
    '  --name <value>          Override the display name for ad-hoc servers.',
    '  --description <text>    Override the description for ad-hoc servers.',
    '  --persist <path>        Write the ad-hoc definition to config/mcporter.json.',
    '  --yes                   Skip confirmation prompts when persisting.',
    '',
    'Examples:',
    '  mcporter auth linear',
    '  mcporter auth linear --no-browser',
    '  mcporter auth https://mcp.example.com/mcp',
    '  mcporter auth --stdio "npx -y chrome-devtools-mcp@latest"',
    '  mcporter auth --http-url http://localhost:3000/mcp --allow-http',
  ];
  console.error(lines.join('\n'));
}
