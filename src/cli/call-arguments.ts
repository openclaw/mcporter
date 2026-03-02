import type { EphemeralServerSpec } from './adhoc-server.js';
import { parseCallExpressionFragment } from './call-expression-parser.js';
import { extractEphemeralServerFlags } from './ephemeral-flags.js';
import { CliUsageError } from './errors.js';
import { splitHttpToolSelector } from './http-utils.js';
import { consumeOutputFormat } from './output-format.js';
import type { OutputFormat } from './output-utils.js';
import { consumeTimeoutFlag } from './timeouts.js';

export interface CallArgsParseResult {
  selector?: string;
  server?: string;
  tool?: string;
  args: Record<string, unknown>;
  positionalArgs?: unknown[];
  tailLog: boolean;
  output: OutputFormat;
  timeoutMs?: number;
  ephemeral?: EphemeralServerSpec;
  rawStrings?: boolean;
}

type CoercionMode = 'default' | 'raw-strings' | 'none';

export function parseCallArguments(args: string[]): CallArgsParseResult {
  const result: CallArgsParseResult = { args: {}, tailLog: false, output: 'auto' };
  let coercionMode: CoercionMode = 'default';
  const ephemeral = extractEphemeralServerFlags(args);
  result.ephemeral = ephemeral;
  result.output = consumeOutputFormat(args, {
    defaultFormat: 'auto',
  });
  const positional: string[] = [];
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (!token) {
      index += 1;
      continue;
    }
    if (token === '--server' || token === '--mcp') {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`Flag '${token}' requires a value.`);
      }
      result.server = value;
      index += 2;
      continue;
    }
    if (token === '--tool') {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`Flag '${token}' requires a value.`);
      }
      result.tool = value;
      index += 2;
      continue;
    }
    if (token === '--timeout') {
      result.timeoutMs = consumeTimeoutFlag(args, index, {
        flagName: '--timeout',
        missingValueMessage: '--timeout requires a value (milliseconds).',
      });
      continue;
    }
    if (token === '--tail-log') {
      result.tailLog = true;
      index += 1;
      continue;
    }
    if (token === '--yes') {
      index += 1;
      continue;
    }
    if (token === '--raw-strings') {
      coercionMode = 'raw-strings';
      result.rawStrings = true;
      index += 1;
      continue;
    }
    if (token === '--no-coerce') {
      coercionMode = 'none';
      result.rawStrings = true;
      index += 1;
      continue;
    }
    if (token === '--args') {
      const value = args[index + 1];
      if (!value) {
        throw new Error('--args requires a JSON value.');
      }
      try {
        const decoded = JSON.parse(value);
        if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
          throw new Error('--args must be a JSON object.');
        }
        Object.assign(result.args, decoded);
      } catch (error) {
        throw new Error(`Unable to parse --args: ${(error as Error).message}`);
      }
      index += 2;
      continue;
    }
    positional.push(token);
    index += 1;
  }

  let callExpressionProvidedServer = false;
  let callExpressionProvidedTool = false;

  if (positional.length > 0) {
    const rawToken = positional[0] ?? '';
    let callExpression: ReturnType<typeof parseCallExpressionFragment> | null = null;
    try {
      callExpression = extractHttpCallExpression(rawToken);
    } catch (error) {
      throw buildCallExpressionUsageError(error);
    }
    if (!callExpression) {
      try {
        callExpression = parseCallExpressionFragment(rawToken);
      } catch (error) {
        throw buildCallExpressionUsageError(error);
      }
    }
    if (callExpression) {
      positional.shift();
      callExpressionProvidedServer = Boolean(callExpression.server);
      callExpressionProvidedTool = Boolean(callExpression.tool);
      if (callExpression.server) {
        if (result.server && result.server !== callExpression.server) {
          throw new Error(
            `Conflicting server names: '${result.server}' from flags and '${callExpression.server}' from call expression.`
          );
        }
        result.server = result.server ?? callExpression.server;
      }
      if (result.tool && result.tool !== callExpression.tool) {
        throw new Error(
          `Conflicting tool names: '${result.tool}' from flags and '${callExpression.tool}' from call expression.`
        );
      }
      result.tool = callExpression.tool;
      Object.assign(result.args, callExpression.args);
      if (callExpression.positionalArgs && callExpression.positionalArgs.length > 0) {
        result.positionalArgs = [...(result.positionalArgs ?? []), ...callExpression.positionalArgs];
      }
    }
  }

  if (!result.selector && positional.length > 0 && !callExpressionProvidedServer && !result.server) {
    result.selector = positional.shift();
  }

  if (
    !result.server &&
    result.selector &&
    shouldPromoteSelectorToCommand(result.selector) &&
    !result.ephemeral?.stdioCommand
  ) {
    // Treat the first positional token as an ad-hoc stdio command when it looks like
    // `npx ...`/`./script`/etc., so users can skip `--stdio` entirely.
    result.ephemeral = { ...result.ephemeral, stdioCommand: result.selector };
    result.selector = undefined;
  }

  const nextPositional = positional[0];
  if (
    !result.tool &&
    nextPositional !== undefined &&
    !nextPositional.includes('=') &&
    !nextPositional.includes(':') &&
    !callExpressionProvidedTool
  ) {
    result.tool = positional.shift();
  }

  const trailingPositional: unknown[] = [];
  for (let index = 0; index < positional.length; ) {
    const token = positional[index];
    if (!token) {
      index += 1;
      continue;
    }
    const parsed = parseKeyValueToken(token, positional[index + 1]);
    if (!parsed) {
      trailingPositional.push(coerceValue(token, coercionMode));
      index += 1;
      continue;
    }
    index += parsed.consumed;
    const value = coerceValue(parsed.rawValue, coercionMode);
    if (parsed.key === 'tool' && !result.tool) {
      if (typeof value !== 'string') {
        throw new Error("Argument 'tool' must be a string value.");
      }
      result.tool = value as string;
      continue;
    }
    if (parsed.key === 'server' && !result.server) {
      if (typeof value !== 'string') {
        throw new Error("Argument 'server' must be a string value.");
      }
      result.server = value as string;
      continue;
    }
    result.args[parsed.key] = value;
  }
  if (trailingPositional.length > 0) {
    result.positionalArgs = [...(result.positionalArgs ?? []), ...trailingPositional];
  }
  return result;
}

interface ParsedKeyValueToken {
  key: string;
  rawValue: string;
  consumed: number;
}

function parseKeyValueToken(token: string, nextToken: string | undefined): ParsedKeyValueToken | undefined {
  const eqIndex = token.indexOf('=');
  if (eqIndex !== -1) {
    const key = token.slice(0, eqIndex);
    const rawValue = token.slice(eqIndex + 1);
    if (!key) {
      return undefined;
    }
    return { key, rawValue, consumed: 1 };
  }

  const colonIndex = token.indexOf(':');
  if (colonIndex !== -1) {
    const key = token.slice(0, colonIndex);
    const remainder = token.slice(colonIndex + 1);
    if (!key) {
      return undefined;
    }
    if (remainder.length > 0) {
      return { key, rawValue: remainder, consumed: 1 };
    }
    if (nextToken !== undefined) {
      return { key, rawValue: nextToken, consumed: 2 };
    }
    warnMissingNamedArgumentValue(key);
    return { key, rawValue: '', consumed: 1 };
  }

  return undefined;
}

function warnMissingNamedArgumentValue(key: string): void {
  const hint =
    key === 'command' ? `Example: mcporter call iterm-mcp.write_to_terminal --args '{"command":"echo hi"}'` : undefined;
  const lines = [
    `[mcporter] Argument '${key}' was provided without a value.`,
    `Wrap the entire key/value pair in quotes (e.g., 'command: "echo hi"') or use --args with JSON.`,
  ];
  if (hint) {
    lines.push(hint);
  }
  console.warn(lines.join(' '));
}

function extractHttpCallExpression(raw: string): ReturnType<typeof parseCallExpressionFragment> | null {
  const trimmed = raw.trim();
  const openParen = trimmed.indexOf('(');
  const prefix = openParen === -1 ? trimmed : trimmed.slice(0, openParen);
  const split = splitHttpToolSelector(prefix);
  if (!split) {
    return null;
  }
  if (openParen === -1) {
    return { server: split.baseUrl, tool: split.tool, args: {} };
  }
  if (!trimmed.endsWith(')')) {
    throw new Error('Function-call syntax requires a closing ) character.');
  }
  const argsPortion = trimmed.slice(openParen);
  const parsed = parseCallExpressionFragment(`${split.tool}${argsPortion}`);
  if (!parsed) {
    return { server: split.baseUrl, tool: split.tool, args: {} };
  }
  return {
    server: split.baseUrl,
    tool: split.tool,
    args: parsed.args,
    positionalArgs: parsed.positionalArgs ?? [],
  };
}

function coerceValue(value: string, coercionMode: CoercionMode = 'default'): unknown {
  const trimmed = value.trim();
  if (trimmed === '') {
    return '';
  }
  if (coercionMode === 'none') {
    return trimmed;
  }
  if (trimmed === 'true' || trimmed === 'false') {
    return trimmed === 'true';
  }
  if (trimmed === 'null' || trimmed === 'none') {
    return null;
  }
  if (coercionMode === 'default' && !Number.isNaN(Number(trimmed)) && trimmed === `${Number(trimmed)}`) {
    return Number(trimmed);
  }
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function buildCallExpressionUsageError(error: unknown): CliUsageError {
  const reason =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : JSON.stringify(error ?? 'Unknown error');
  const lines = [
    'Unable to parse function-style call.',
    `Reason: ${reason}`,
    '',
    'Examples:',
    '  mcporter \'context7.resolve-library-id(libraryName: "react")\'',
    '  mcporter \'context7.resolve-library-id("react")\'',
    '  mcporter context7.resolve-library-id libraryName=react',
    '',
    'Tip: wrap the entire expression in single quotes so the shell preserves parentheses and commas.',
  ];
  return new CliUsageError(lines.join('\n'));
}

function shouldPromoteSelectorToCommand(selector: string): boolean {
  const trimmed = selector.trim();
  if (!trimmed) {
    return false;
  }
  if (/\s/.test(trimmed)) {
    return true;
  }
  if (/^(?:\.{1,2}\/|~\/|\/)/.test(trimmed)) {
    return true;
  }
  if (/^[A-Za-z]:\\/.test(trimmed) || trimmed.startsWith('\\\\')) {
    return true;
  }
  return false;
}
