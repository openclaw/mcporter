import { parseCallExpressionFragment } from './call-expression-parser.js';
import { CliUsageError } from './errors.js';
import { splitHttpToolSelector } from './http-utils.js';

type ParsedCallExpression = NonNullable<ReturnType<typeof parseCallExpressionFragment>>;

export function parseLeadingCallExpression(rawToken: string): ParsedCallExpression | null {
  try {
    return extractHttpCallExpression(rawToken) ?? parseCallExpressionFragment(rawToken);
  } catch (error) {
    throw buildCallExpressionUsageError(error);
  }
}

function extractHttpCallExpression(raw: string): ParsedCallExpression | null {
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
