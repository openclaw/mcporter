export const ADHOC_SERVER_HELP_ENTRIES = [
  { flag: '--http-url <url>', description: 'Register an HTTP server for this run.' },
  { flag: '--allow-http', description: 'Permit plain http:// URLs with --http-url.' },
  { flag: '--header KEY=value', description: 'Attach HTTP headers (repeatable).' },
  { flag: '--stdio <command>', description: 'Run a stdio MCP server (repeat --stdio-arg for args).' },
  { flag: '--stdio-arg <value>', description: 'Append args to the stdio command (repeatable).' },
  { flag: '--env KEY=value', description: 'Inject env vars for stdio servers (repeatable).' },
  { flag: '--cwd <path>', description: 'Working directory for stdio servers.' },
  { flag: '--name <value>', description: 'Override the display name for ad-hoc servers.' },
  { flag: '--description <text>', description: 'Override the description for ad-hoc servers.' },
  { flag: '--persist <path>', description: 'Write the ad-hoc definition to config/mcporter.json.' },
  { flag: '--yes', description: 'Skip confirmation prompts when persisting.' },
] as const;

export function renderAdhocServerHelpLines(width = 23): string[] {
  return ADHOC_SERVER_HELP_ENTRIES.map((entry) => `  ${entry.flag.padEnd(width)}${entry.description}`);
}
