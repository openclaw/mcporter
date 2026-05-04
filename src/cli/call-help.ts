export const CALL_HELP_ARGUMENT_LINES = [
  '  key=value / key:value  Flag-style named arguments.',
  '  function-call syntax   \'server.tool(arg: "value", other: 1)\'.',
  '  --args <json>          Provide a JSON object payload.',
  '  positional values      Accepted when schema order is known.',
  '  --                     Treat remaining tokens as literal positional values.',
] as const;

export const CALL_HELP_RUNTIME_FLAG_LINES = [
  '  --timeout <ms>         Override the call timeout.',
  '  --output text|markdown|json|raw  Control formatting.',
  '  --save-images <dir>    Save image content blocks to a directory.',
  '  --raw-strings          Keep numeric-looking argument values as strings.',
  '  --no-coerce            Keep all key/value and positional arguments as raw strings.',
  '  --tail-log             Stream returned log handles.',
] as const;

export const CALL_HELP_ADHOC_SERVER_LINES = [
  '  --http-url <url>       Register an HTTP server for this run.',
  '  --allow-http           Permit plain http:// URLs with --http-url.',
  '  --header KEY=value     Attach HTTP headers (repeatable).',
  '  --stdio <command>      Run a stdio MCP server (repeat --stdio-arg for args).',
  '  --stdio-arg <value>    Append args to the stdio command (repeatable).',
  '  --env KEY=value        Inject env vars for stdio servers (repeatable).',
  '  --cwd <path>           Working directory for stdio servers.',
  '  --name <value>         Override the display name for ad-hoc servers.',
  '  --description <text>   Override the description for ad-hoc servers.',
  '  --persist <path>       Write the ad-hoc definition to config/mcporter.json.',
  '  --yes                  Skip confirmation prompts when persisting.',
] as const;

export const CALL_HELP_EXAMPLE_LINES = [
  '  mcporter call linear.list_issues team=ENG limit:5',
  '  mcporter call "linear.create_issue(title: \\"Bug\\", team: \\"ENG\\")"',
  '  mcporter call https://api.example.com/mcp.fetch url:https://example.com',
  '  mcporter call --stdio "bun run ./server.ts" scrape url=https://example.com',
] as const;

export function buildUnknownCallFlagMessage(token: string): string {
  const argumentName = token.startsWith('--') ? token.slice(2) : token;
  return [
    `Unknown flag '${token}' passed to call command.`,
    `If you intended to pass a tool argument, use '${argumentName}=<value>' or --args '{"${argumentName}": ...}'.`,
    "If you intended to pass a literal positional value, insert '--' before it.",
    "Run 'mcporter call --help' to see available flags.",
  ].join('\n');
}
