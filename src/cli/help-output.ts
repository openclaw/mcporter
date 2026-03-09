import fsPromises from 'node:fs/promises';
import { MCPORTER_VERSION } from '../runtime.js';
import { boldText, dimText, extraDimText, supportsAnsiColor } from './terminal.js';

type HelpEntry = {
  name: string;
  summary: string;
  usage: string;
};

type HelpSection = {
  title: string;
  entries: HelpEntry[];
};

export function printHelp(message?: string): void {
  if (message) {
    console.error(message);
    console.error('');
  }
  const colorize = supportsAnsiColor;
  const sections = buildCommandSections(colorize);
  const globalFlags = formatGlobalFlags(colorize);
  const quickStart = formatQuickStart(colorize);
  const footer = formatHelpFooter(colorize);
  const title = colorize
    ? `${boldText('mcporter')} ${dimText('— Model Context Protocol CLI & generator')}`
    : 'mcporter — Model Context Protocol CLI & generator';
  const lines = [
    title,
    '',
    'Usage: mcporter <command> [options]',
    '',
    ...sections,
    '',
    globalFlags,
    '',
    quickStart,
    '',
    footer,
  ];
  console.error(lines.join('\n'));
}

function buildCommandSections(colorize: boolean): string[] {
  const sections: HelpSection[] = [
    {
      title: 'Core commands',
      entries: [
        {
          name: 'list',
          summary: 'List configured servers (add --schema for tool docs)',
          usage: 'mcporter list [name] [--schema] [--json]',
        },
        {
          name: 'call',
          summary: 'Call a tool by selector (server.tool) or HTTP URL; key=value flags supported',
          usage: 'mcporter call <selector> [key=value ...]',
        },
        {
          name: 'auth',
          summary: 'Complete OAuth for a server without listing tools',
          usage: 'mcporter auth <server | url> [--reset]',
        },
      ],
    },
    {
      title: 'Generator & tooling',
      entries: [
        {
          name: 'generate-cli',
          summary: 'Emit a standalone CLI (supports HTTP, stdio, and inline commands)',
          usage: 'mcporter generate-cli --server <name> | --command <ref> [options]',
        },
        {
          name: 'inspect-cli',
          summary: 'Show metadata and regen instructions for a generated CLI',
          usage: 'mcporter inspect-cli <path> [--json]',
        },
        {
          name: 'emit-ts',
          summary: 'Generate TypeScript client/types for a server',
          usage: 'mcporter emit-ts <server> --mode client|types [options]',
        },
      ],
    },
    {
      title: 'Configuration',
      entries: [
        {
          name: 'config',
          summary: 'Inspect or edit config files (list, get, add, remove, import, login, logout)',
          usage: 'mcporter config <command> [options]',
        },
      ],
    },
    {
      title: 'Daemon',
      entries: [
        {
          name: 'daemon',
          summary: 'Manage the keep-alive daemon (start | status | stop | restart)',
          usage: 'mcporter daemon <subcommand>',
        },
      ],
    },
  ];
  return sections.flatMap((section) => formatCommandSection(section, colorize));
}

function formatCommandSection(section: HelpSection, colorize: boolean): string[] {
  const maxNameLength = Math.max(...section.entries.map((entry) => entry.name.length));
  const header = colorize ? boldText(section.title) : section.title;
  const lines = [header];
  section.entries.forEach((entry) => {
    const paddedName = entry.name.padEnd(maxNameLength);
    const renderedName = colorize ? boldText(paddedName) : paddedName;
    const summary = colorize ? dimText(entry.summary) : entry.summary;
    lines.push(`  ${renderedName}  ${summary}`);
    lines.push(`    ${extraDimText('usage:')} ${entry.usage}`);
  });
  return [...lines, ''];
}

function formatGlobalFlags(colorize: boolean): string {
  const title = colorize ? boldText('Global flags') : 'Global flags';
  const entries = [
    {
      flag: '--config <path>',
      summary: 'Path to mcporter.json (defaults to ./config/mcporter.json)',
    },
    {
      flag: '--root <path>',
      summary: 'Working directory for stdio servers',
    },
    {
      flag: '--log-level <debug|info|warn|error>',
      summary: 'Adjust CLI logging (defaults to warn)',
    },
    {
      flag: '--oauth-timeout <ms>',
      summary: 'Time to wait for browser-based OAuth before giving up (default 60000)',
    },
  ];
  const formatted = entries.map((entry) => `  ${entry.flag.padEnd(34)}${entry.summary}`);
  return [title, ...formatted].join('\n');
}

function formatQuickStart(colorize: boolean): string {
  const title = colorize ? boldText('Quick start') : 'Quick start';
  const entries = [
    ['mcporter list', 'show configured servers'],
    ['mcporter list linear --schema', 'view Linear tool docs'],
    ['mcporter call linear.list_issues limit:5', 'invoke a tool with key=value arguments'],
    ['mcporter generate-cli --command https://host/mcp --compile ./my-cli', 'build a standalone CLI/binary'],
  ];
  const formatted = entries.map(([cmd, note]) => {
    const comment = colorize ? dimText(`# ${note}`) : `# ${note}`;
    return `  ${cmd}\n    ${comment}`;
  });
  return [title, ...formatted].join('\n');
}

function formatHelpFooter(colorize: boolean): string {
  const pointer = 'Run `mcporter <command> --help` for detailed flags.';
  const autoLoad =
    'mcporter auto-loads servers from ./config/mcporter.json and editor imports (Cursor, Claude, Codex, etc.).';
  if (!colorize) {
    return `${pointer}\n${autoLoad}`;
  }
  return `${dimText(pointer)}\n${extraDimText(autoLoad)}`;
}

export function isHelpToken(token: string): boolean {
  return token === '--help' || token === '-h' || token === 'help';
}

export function consumeHelpTokens(args: string[]): boolean {
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

export function isVersionToken(token: string): boolean {
  return token === '--version' || token === '-v' || token === '-V';
}

export async function printVersion(): Promise<void> {
  console.log(await resolveCliVersion());
}

async function resolveCliVersion(): Promise<string> {
  try {
    const packageJsonPath = new URL('../../package.json', import.meta.url);
    const buffer = await fsPromises.readFile(packageJsonPath, 'utf8');
    const pkg = JSON.parse(buffer) as { version?: string };
    return pkg.version ?? MCPORTER_VERSION;
  } catch {
    return MCPORTER_VERSION;
  }
}
