import type { ServerDefinition } from '../../config-schema.js';
import { boldText, dimText } from '../terminal.js';
import { COLOR_ENABLED } from './shared.js';

export type SerializedServerDefinition = {
  name: string;
  description?: string;
  source: NonNullable<ServerDefinition['source']> | { kind: 'local'; path: string };
  auth?: ServerDefinition['auth'];
  tokenCacheDir?: string;
  clientName?: string;
  oauthClientId?: string;
  oauthClientSecretEnv?: string;
  oauthTokenEndpointAuthMethod?: string;
  oauthRedirectUrl?: string;
  oauthScope?: string;
  refresh?: ServerDefinition['refresh'];
  httpFetch?: ServerDefinition['httpFetch'];
  allowedTools?: readonly string[];
  blockedTools?: readonly string[];
  env?: Record<string, string>;
  transport: 'http' | 'stdio';
  baseUrl?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  cwd?: string;
};

export function serializeDefinition(definition: ServerDefinition): SerializedServerDefinition {
  const origin = definition.source ?? { kind: 'local', path: '' };
  if (definition.command.kind === 'http') {
    return {
      name: definition.name,
      description: definition.description,
      source: origin,
      auth: definition.auth,
      tokenCacheDir: definition.tokenCacheDir,
      clientName: definition.clientName,
      oauthClientId: definition.oauthClientId,
      oauthClientSecretEnv: definition.oauthClientSecretEnv,
      oauthTokenEndpointAuthMethod: definition.oauthTokenEndpointAuthMethod,
      oauthRedirectUrl: definition.oauthRedirectUrl,
      oauthScope: definition.oauthScope,
      refresh: definition.refresh,
      httpFetch: definition.httpFetch,
      allowedTools: definition.allowedTools,
      blockedTools: definition.blockedTools,
      env: definition.env,
      transport: 'http',
      baseUrl: definition.command.url.href,
      headers: definition.command.headers,
    };
  }
  return {
    name: definition.name,
    description: definition.description,
    source: origin,
    auth: definition.auth,
    tokenCacheDir: definition.tokenCacheDir,
    clientName: definition.clientName,
    oauthClientId: definition.oauthClientId,
    oauthClientSecretEnv: definition.oauthClientSecretEnv,
    oauthTokenEndpointAuthMethod: definition.oauthTokenEndpointAuthMethod,
    oauthRedirectUrl: definition.oauthRedirectUrl,
    oauthScope: definition.oauthScope,
    refresh: definition.refresh,
    httpFetch: definition.httpFetch,
    allowedTools: definition.allowedTools,
    blockedTools: definition.blockedTools,
    env: definition.env,
    transport: 'stdio',
    command: definition.command.command,
    args: definition.command.args,
    cwd: definition.command.cwd,
  };
}

export function printServerSummary(definition: ServerDefinition): void {
  const colorize = COLOR_ENABLED();
  const origin = definition.source;
  const header = colorize ? boldText(definition.name) : definition.name;
  const label = (text: string): string => (colorize ? dimText(text) : text);
  console.log(header);
  if (origin) {
    console.log(`  ${label('Source')}: ${origin.kind}${origin.path ? ` (${origin.path})` : ''}`);
  } else {
    console.log(`  ${label('Source')}: local`);
  }
  if (definition.command.kind === 'http') {
    console.log(`  ${label('Transport')}: http (${definition.command.url.href})`);
  } else {
    const renderedArgs = definition.command.args.length > 0 ? ` ${definition.command.args.join(' ')}` : '';
    console.log(`  ${label('Transport')}: stdio (${definition.command.command}${renderedArgs})`);
    console.log(`  ${label('CWD')}: ${definition.command.cwd}`);
  }
  if (definition.description) {
    console.log(`  ${label('Description')}: ${definition.description}`);
  }
  if (definition.auth) {
    console.log(`  ${label('Auth')}: ${definition.auth}`);
  }
  if (definition.allowedTools !== undefined) {
    const rendered = definition.allowedTools.length > 0 ? definition.allowedTools.join(', ') : '<none>';
    console.log(`  ${label('Allowed tools')}: ${rendered}`);
  }
  if (definition.blockedTools !== undefined) {
    const rendered = definition.blockedTools.length > 0 ? definition.blockedTools.join(', ') : '<none>';
    console.log(`  ${label('Blocked tools')}: ${rendered}`);
  }
}

export function printImportSummary(importServers: ServerDefinition[]): void {
  if (importServers.length === 0) {
    return;
  }
  const colorize = COLOR_ENABLED();
  const grouped = new Map<string, string[]>();
  for (const server of importServers) {
    const sourcePath = server.source?.path ?? '<unknown>';
    const list = grouped.get(sourcePath) ?? [];
    list.push(server.name);
    grouped.set(sourcePath, list);
  }
  console.log('');
  const header = colorize
    ? boldText('Other sources available via --source import')
    : 'Other sources available via --source import';
  console.log(header);
  for (const [path, names] of grouped) {
    names.sort();
    const sample = names.slice(0, 3).join(', ');
    const suffix = names.length > 3 ? ', …' : '';
    const countLabel = `${names.length} server${names.length === 1 ? '' : 's'}`;
    const pathLabel = colorize ? dimText(path) : path;
    console.log(`  ${pathLabel} — ${countLabel} (${sample}${suffix})`);
  }
  const guidance = 'Use `mcporter config import <kind>` to copy them locally.';
  console.log(colorize ? dimText(guidance) : guidance);
}

export function printConfigUsageExamples(): string[] {
  return [
    'pnpm mcporter config list --json',
    'pnpm mcporter config add linear https://mcp.linear.app/mcp',
    'pnpm mcporter config import cursor --copy',
  ];
}
