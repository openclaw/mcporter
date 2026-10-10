import { loadServerDefinitions } from '../../config.js';
import type { ServerDefinition } from '../../config-schema.js';
import { CliUsageError } from '../errors.js';
import { dimText } from '../terminal.js';
import { printImportSummary, printServerSummary, serializeDefinition } from './render.js';
import { COLOR_ENABLED, logConfigLocations, resolveConfigLocations } from './shared.js';
import type { ConfigCliOptions } from './types.js';

export interface ListFlags {
  format: 'text' | 'json';
  source?: 'local' | 'import';
}

export async function handleListCommand(options: ConfigCliOptions, args: string[]): Promise<void> {
  const flags = extractListFlags(args);
  const filter = args.shift();
  const servers = await loadServerDefinitions(options.loadOptions);
  let filtered = servers;
  if (flags.source) {
    filtered = filtered.filter((server) => (server.source?.kind ?? 'local') === flags.source);
  }
  if (filter) {
    filtered = filtered.filter((server) => filterMatches(filter, server));
  }
  if (flags.format === 'json') {
    const payload = filtered.map((server) => serializeDefinition(server));
    console.log(JSON.stringify({ servers: payload }, null, 2));
    return;
  }
  const colorize = COLOR_ENABLED();
  if (filtered.length === 0) {
    console.log(
      colorize
        ? dimText('No local servers match the provided filters.')
        : 'No local servers match the provided filters.'
    );
  } else {
    for (const server of filtered) {
      printServerSummary(server);
    }
  }
  if ((!flags.source || flags.source === 'local') && flags.format === 'text') {
    printImportSummary(servers.filter((server) => server.source?.kind === 'import'));
  }
  if (flags.format === 'text') {
    const summary = await resolveConfigLocations(options.loadOptions);
    logConfigLocations(summary, { leadingNewline: true });
  }
}

function extractListFlags(args: string[]): ListFlags {
  const flags: ListFlags = { format: 'text', source: 'local' };
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === '--json') {
      flags.format = 'json';
      args.splice(index, 1);
      continue;
    }
    if (token === '--source') {
      const value = args[index + 1];
      if (value !== 'local' && value !== 'import') {
        throw new CliUsageError("--source must be either 'local' or 'import'.");
      }
      flags.source = value;
      args.splice(index, 2);
      continue;
    }
    index += 1;
  }
  return flags;
}

function filterMatches(filter: string, server: ServerDefinition): boolean {
  if (filter.startsWith('source:')) {
    const origin = server.source?.kind ?? 'local';
    const importKind = server.source?.importKind;
    return `source:${origin}` === filter || (importKind !== undefined && `source:${importKind}` === filter);
  }
  if (filter.includes('*') || filter.includes('?')) {
    const pattern = filter
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replaceAll('*', '.*')
      .replaceAll('?', '.');
    return new RegExp(pattern).test(server.name);
  }
  return server.name.includes(filter);
}
