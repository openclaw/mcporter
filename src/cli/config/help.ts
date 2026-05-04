import { boldText, dimText, extraDimText } from '../terminal.js';
import { printConfigUsageExamples } from './render.js';
import { COLOR_ENABLED } from './shared.js';

export type ConfigSubcommand = 'list' | 'get' | 'add' | 'remove' | 'import' | 'login' | 'logout' | 'doctor';

export type ConfigHelpEntry = {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly description: string;
  readonly flags?: Array<{ flag: string; description: string }>;
  readonly examples?: string[];
};

export const CONFIG_HELP_ENTRIES: Record<ConfigSubcommand, ConfigHelpEntry> = {
  list: {
    name: 'list [options] [filter]',
    summary: 'Show merged servers',
    usage: 'mcporter config list [options] [filter]',
    description: 'Lists configured servers. Defaults to local entries, but you can view imports and emit JSON.',
    flags: [
      { flag: '--json', description: 'Print JSON payloads instead of ANSI text.' },
      { flag: '--source <local|import>', description: 'Filter to local definitions or imported entries only.' },
      { flag: 'filter (positional)', description: 'Substring match applied to server names.' },
    ],
    examples: ['pnpm mcporter config list', 'pnpm mcporter config list --json --source import cursor'],
  },
  get: {
    name: 'get <name> [--json]',
    summary: 'Inspect a single server',
    usage: 'mcporter config get <name> [--json]',
    description: 'Shows one server definition, including transport, headers, and env overrides.',
    flags: [{ flag: '--json', description: 'Emit the server entry as JSON.' }],
    examples: ['pnpm mcporter config get linear', 'pnpm mcporter config get claude --json'],
  },
  add: {
    name: 'add [options] <name> [target]',
    summary: 'Persist a server definition',
    usage: 'mcporter config add [options] <name> [target]',
    description:
      'Adds HTTP or stdio servers to the local config. Accepts URLs, commands, env vars, and OAuth metadata.',
    flags: [
      { flag: '--url <https://host>', description: 'Set the HTTP/S base URL (implies http transport).' },
      { flag: '--command <binary>', description: 'Set the stdio executable (implies stdio transport).' },
      { flag: '--stdio <binary>', description: 'Alias for --command.' },
      { flag: '--transport <http|sse|stdio>', description: 'Force a specific transport (validates target).' },
      { flag: '--arg <value>', description: 'Pass through additional stdio arguments (repeatable).' },
      { flag: '--description <text>', description: 'Set a human-friendly summary.' },
      { flag: '--env KEY=value', description: 'Attach environment variables (repeatable).' },
      { flag: '--header KEY=value', description: 'Attach HTTP headers (repeatable).' },
      { flag: '--token-cache-dir <path>', description: 'Override where OAuth tokens are persisted.' },
      { flag: '--client-name <name>', description: 'Customize the OAuth client identifier.' },
      { flag: '--oauth-client-id <id>', description: 'Use a pre-registered OAuth client id.' },
      { flag: '--oauth-client-secret-env <env>', description: 'Read the OAuth client secret from an env var.' },
      {
        flag: '--oauth-token-endpoint-auth-method <method>',
        description: 'Set token auth, e.g. client_secret_post.',
      },
      { flag: '--oauth-redirect-url <url>', description: 'Set a custom OAuth redirect URL.' },
      { flag: '--auth <strategy>', description: 'Force the auth type (e.g., oauth).' },
      { flag: '--copy-from <import:name>', description: 'Start with an imported definition by name.' },
      { flag: '--persist <config-path>', description: 'Write to an alternate mcporter.json path.' },
      {
        flag: '--scope <home|project>',
        description: 'Choose whether to write to the home or project config (default: project).',
      },
      { flag: '--dry-run', description: 'Print the would-be entry without writing to disk.' },
      { flag: '--', description: 'Forward every subsequent token as a stdio arg.' },
    ],
    examples: [
      'pnpm mcporter config add linear https://mcp.linear.app/mcp',
      'pnpm mcporter config add cursor --command "npx -y cursor" --arg --stdio',
    ],
  },
  remove: {
    name: 'remove <name>',
    summary: 'Delete a local entry',
    usage: 'mcporter config remove <name>',
    description: 'Removes a server definition from the active mcporter.json file.',
    examples: ['pnpm mcporter config remove linear'],
  },
  import: {
    name: 'import <kind> [options]',
    summary: 'Inspect or copy imported servers',
    usage: 'mcporter config import <kind> [options]',
    description:
      'Shows entries from Cursor, Claude, Codex, and other supported imports. Optionally copies them locally.',
    flags: [
      { flag: '--path <file>', description: 'Manually point at a config file path.' },
      { flag: '--filter <substring>', description: 'Match server names by substring before listing/copying.' },
      { flag: '--copy', description: 'Write the filtered entries into the local config.' },
      { flag: '--json', description: 'Emit JSON instead of plain text listings.' },
    ],
    examples: ['pnpm mcporter config import cursor --copy', 'pnpm mcporter config import claude --filter notion'],
  },
  login: {
    name: 'login <name|url> [options]',
    summary: 'Run the OAuth/auth flow',
    usage: 'mcporter config login <name|url> [options]',
    description: 'Delegates to `mcporter auth`, so you can pass ephemeral flags like --http-url/--stdio/--reset.',
    examples: ['pnpm mcporter config login linear', 'pnpm mcporter config login https://example.com/mcp --reset'],
  },
  logout: {
    name: 'logout <name>',
    summary: 'Clear cached credentials',
    usage: 'mcporter config logout <name>',
    description: 'Deletes the token cache directory for an OAuth-enabled server.',
    examples: ['pnpm mcporter config logout linear'],
  },
  doctor: {
    name: 'doctor',
    summary: 'Validate config files',
    usage: 'mcporter config doctor',
    description: 'Validates config files, warns about missing token caches, and prints config locations.',
    examples: ['pnpm mcporter config doctor'],
  },
};

export const CONFIG_HELP_ORDER: ConfigSubcommand[] = [
  'list',
  'get',
  'add',
  'remove',
  'import',
  'login',
  'logout',
  'doctor',
];

export function isHelpToken(token: string): boolean {
  return token === '--help' || token === '-h';
}

export function consumeInlineHelpTokens(args: string[]): boolean {
  let found = false;
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const token = args[index];
    if (token && isHelpToken(token)) {
      args.splice(index, 1);
      found = true;
    }
  }
  return found;
}

export function printConfigHelp(subcommand?: string): void {
  const colorize = COLOR_ENABLED();
  if (!subcommand) {
    printConfigOverview(colorize);
    return;
  }
  const resolved = resolveHelpSubcommand(subcommand);
  if (!resolved) {
    console.log(`Unknown config subcommand '${subcommand}'. Available commands: ${CONFIG_HELP_ORDER.join(', ')}.`);
    return;
  }
  printSubcommandHelp(resolved, colorize);
}

function resolveHelpSubcommand(token: string | undefined): ConfigSubcommand | undefined {
  if (!token) {
    return undefined;
  }
  const normalized = token.toLowerCase() as ConfigSubcommand;
  return normalized in CONFIG_HELP_ENTRIES ? normalized : undefined;
}

function printConfigOverview(colorize: boolean): void {
  const title = colorize ? boldText('mcporter config') : 'mcporter config';
  const subtitle = colorize
    ? dimText('Manage configured MCP servers, imports, and ad-hoc discoveries.')
    : 'Manage configured MCP servers, imports, and ad-hoc discoveries.';
  const commandsHeader = colorize ? boldText('Commands') : 'Commands';
  const examplesHeader = colorize ? boldText('Examples') : 'Examples';
  const lines: string[] = [title, subtitle, '', commandsHeader];
  const maxName = Math.max(...CONFIG_HELP_ORDER.map((key) => CONFIG_HELP_ENTRIES[key].name.length));
  for (const key of CONFIG_HELP_ORDER) {
    const entry = CONFIG_HELP_ENTRIES[key];
    const padded = entry.name.padEnd(maxName);
    const renderedName = colorize ? boldText(padded) : padded;
    const renderedDesc = colorize ? dimText(entry.summary) : entry.summary;
    lines.push(`  ${renderedName}  ${renderedDesc}`);
  }
  lines.push('', examplesHeader);
  for (const example of printConfigUsageExamples()) {
    lines.push(`  ${colorize ? extraDimText(example) : example}`);
  }
  const pointer = "Run 'mcporter config <command> --help' for detailed flag info.";
  lines.push('', colorize ? extraDimText(pointer) : pointer);
  console.log(lines.join('\n'));
}

function printSubcommandHelp(subcommand: ConfigSubcommand, colorize: boolean): void {
  const entry = CONFIG_HELP_ENTRIES[subcommand];
  const title = colorize ? boldText(`mcporter config ${subcommand}`) : `mcporter config ${subcommand}`;
  const description = colorize ? dimText(entry.description) : entry.description;
  const usageHeader = colorize ? boldText('Usage') : 'Usage';
  const lines: string[] = [title, description, '', usageHeader, `  ${entry.usage}`];
  if (entry.flags && entry.flags.length > 0) {
    const flagsHeader = colorize ? boldText('Flags') : 'Flags';
    const maxFlag = Math.max(...entry.flags.map((flag) => flag.flag.length));
    lines.push('', flagsHeader);
    for (const flag of entry.flags) {
      const padded = flag.flag.padEnd(maxFlag);
      const renderedFlag = colorize ? boldText(padded) : padded;
      const renderedDesc = colorize ? dimText(flag.description) : flag.description;
      lines.push(`  ${renderedFlag}  ${renderedDesc}`);
    }
  }
  if (entry.examples && entry.examples.length > 0) {
    const examplesHeader = colorize ? boldText('Examples') : 'Examples';
    lines.push('', examplesHeader);
    for (const example of entry.examples) {
      lines.push(`  ${colorize ? extraDimText(example) : example}`);
    }
  }
  console.log(lines.join('\n'));
}
