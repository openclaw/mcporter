import { spawn } from 'node:child_process';
import type { ServerDefinition } from '../config-schema.js';
import { analyzeConnectionError } from '../error-classifier.js';
import { clearOAuthCaches } from '../oauth-persistence.js';
import type { createRuntime } from '../runtime.js';
import type { EphemeralServerSpec } from './adhoc-server.js';
import { extractEphemeralServerFlags } from './ephemeral-flags.js';
import { prepareEphemeralServerTarget } from './ephemeral-target.js';
import { looksLikeHttpUrl } from './http-utils.js';
import { buildConnectionIssueEnvelope } from './json-output.js';
import { logInfo, logWarn } from './logger-context.js';
import { consumeOutputFormat } from './output-format.js';

type Runtime = Awaited<ReturnType<typeof createRuntime>>;

export async function handleAuth(runtime: Runtime, args: string[]): Promise<void> {
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
    logInfo(`Cleared cached credentials for '${target}'.`);
  }

  if (definition.command.kind === 'stdio' && definition.oauthCommand) {
    logInfo(`Starting auth helper for '${target}' (stdio). Leave this running until the browser flow completes.`);
    await runStdioAuth(definition);
    logInfo(`Auth helper for '${target}' finished. You can now call tools.`);
    return;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      logInfo(`Initiating OAuth flow for '${target}'...`);
      const tools = await runtime.listTools(target, { autoAuthorize: true });
      logInfo(`Authorization complete. ${tools.length} tool${tools.length === 1 ? '' : 's'} available.`);
      return;
    } catch (error) {
      if (attempt === 0 && shouldRetryAuthError(error)) {
        logWarn('Server signaled OAuth after the initial attempt. Retrying with browser flow...');
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (format === 'json') {
        const payload = buildConnectionIssueEnvelope({
          server: target,
          error,
          issue: analyzeConnectionError(error),
        });
        console.log(JSON.stringify(payload, null, 2));
        process.exitCode = 1;
        return;
      }
      throw new Error(`Failed to authorize '${target}': ${message}`);
    }
  }
}

async function runStdioAuth(definition: ServerDefinition): Promise<void> {
  const authArgs = [...(definition.command.kind === 'stdio' ? (definition.command.args ?? []) : [])];
  if (definition.oauthCommand) {
    authArgs.push(...definition.oauthCommand.args);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(definition.command.kind === 'stdio' ? definition.command.command : '', authArgs, {
      stdio: 'inherit',
      cwd: definition.command.kind === 'stdio' ? definition.command.cwd : process.cwd(),
      env: process.env,
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

function shouldRetryAuthError(error: unknown): boolean {
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
    '  --json                  Emit a JSON envelope on failure.',
    '',
    'Ad-hoc targets:',
    '  --http-url <url>        Register an HTTP server for this run.',
    '  --allow-http            Permit plain http:// URLs with --http-url.',
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
    '  mcporter auth https://mcp.example.com/mcp',
    '  mcporter auth --stdio "npx -y chrome-devtools-mcp@latest"',
    '  mcporter auth --http-url http://localhost:3000/mcp --allow-http',
  ];
  console.error(lines.join('\n'));
}
