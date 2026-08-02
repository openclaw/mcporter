import type { ServerDefinition, ServerSource } from '../config.js';
import type { ConnectionIssue } from '../error-classifier.js';
import { analyzeConnectionError } from '../error-classifier.js';
import type { ConnectionInfo, ServerToolInfo } from '../runtime.js';
import { formatPathForDisplay } from './path-utils.js';
import { dimText, extraDimText, redText, yellowText } from './terminal.js';

export type StatusCategory = 'ok' | 'auth' | 'offline' | 'http' | 'error';

export type ListSummaryResult =
  | {
      status: 'ok';
      server: ServerDefinition;
      tools: ServerToolInfo[];
      connectionInfo?: ConnectionInfo;
      durationMs: number;
    }
  | {
      status: 'error';
      server: ServerDefinition;
      error: unknown;
      durationMs: number;
    };

export function renderServerListRow(
  result: ListSummaryResult,
  timeoutMs: number,
  options: { verbose?: boolean } = {}
): {
  line: string;
  summary: string;
  category: StatusCategory;
  authCommand?: string;
  issue?: ConnectionIssue;
} {
  const description = result.server.description ? dimText(` — ${result.server.description}`) : '';
  const durationLabel = dimText(`${(result.durationMs / 1000).toFixed(1)}s`);
  const sourceSuffix = formatSourceSuffix(result.server.sources ?? result.server.source, false, {
    verbose: options.verbose,
  });
  const prefix = `- ${result.server.name}${description}`;

  if (result.status === 'ok') {
    const toolSuffix =
      result.tools.length === 0
        ? 'no tools reported'
        : `${result.tools.length === 1 ? '1 tool' : `${result.tools.length} tools`}`;
    return {
      line: `${prefix} (${toolSuffix}, ${durationLabel}${formatProtocolSuffix(result.connectionInfo, options.verbose)})${sourceSuffix}`,
      summary: toolSuffix,
      category: 'ok',
    };
  }

  const timeoutSeconds = Math.round(timeoutMs / 1000);
  const advice = classifyListError(result.error, result.server.name, timeoutSeconds);
  return {
    line: `${prefix} (${advice.colored}, ${durationLabel})${sourceSuffix}`,
    summary: advice.summary,
    category: advice.category,
    authCommand: advice.authCommand,
    issue: advice.issue,
  };
}

function formatProtocolSuffix(info: ConnectionInfo | undefined, verbose: boolean | undefined): string {
  if (!verbose || !info?.protocolVersion) return '';
  return `, ${info.protocolVersion}${info.era ? ` ${info.era}` : ''}`;
}

export function formatSourceSuffix(
  sourceOrSources: ServerSource | readonly ServerSource[] | undefined,
  inline = false,
  options: { verbose?: boolean } = {}
): string {
  const sources = Array.isArray(sourceOrSources) ? [...sourceOrSources] : sourceOrSources ? [sourceOrSources] : [];
  if (sources.length === 0) {
    return '';
  }
  const verbose = options.verbose ?? false;
  if (!verbose) {
    const primary = sources[0];
    if (primary.kind !== 'import') {
      return '';
    }
    const formatted = formatPathForDisplay(primary.path);
    const tinted = extraDimText(inline ? formatted : `[source: ${formatted}]`);
    return inline ? tinted : ` ${tinted}`;
  }
  // When verbose, show every contributing source (primary first) so duplicates are discoverable.
  const [primary, ...alternates] = sources;
  const primaryLabel = buildSourceLabel(primary, { primary: true });
  const altLabels = alternates.map((entry) => {
    const shadowedByLocal = primary.kind === 'local' && entry.kind !== 'local';
    return buildSourceLabel(entry, { shadowReason: shadowedByLocal ? 'shadowed by local' : 'shadowed' });
  });
  const label =
    altLabels.length === 0 ? `source: ${primaryLabel}` : `sources: ${[primaryLabel, ...altLabels].join(' · ')}`;
  const tinted = extraDimText(inline ? label : `[${label}]`);
  return inline ? tinted : ` ${tinted}`;
}

function buildSourceLabel(source: ServerSource, options: { primary?: boolean; shadowReason?: string }): string {
  const base = formatPathForDisplay(source.path);
  const tags: string[] = [];
  if (options.primary) {
    tags.push('primary');
  }
  if (options.shadowReason) {
    tags.push(options.shadowReason);
  }
  if (source.importKind) {
    tags.push(source.importKind);
  }
  return tags.length === 0 ? base : `${base} (${tags.join(', ')})`;
}

export function classifyListError(
  error: unknown,
  serverName: string,
  _timeoutSeconds: number,
  options?: { authCommand?: string }
): {
  colored: string;
  summary: string;
  category: StatusCategory;
  authCommand?: string;
  issue: ConnectionIssue;
} {
  const issue = analyzeConnectionError(error);
  if (issue.kind === 'auth') {
    const authCommand = options?.authCommand ?? `mcporter auth ${serverName}`;
    const note = yellowText(`auth required — run '${authCommand}'`);
    return { colored: note, summary: 'auth required', category: 'auth', authCommand, issue };
  }
  if (issue.kind === 'offline') {
    const note = redText('offline — unable to reach server');
    return { colored: note, summary: 'offline', category: 'offline', issue };
  }
  if (issue.kind === 'http') {
    const statusText = issue.statusCode ? `HTTP ${issue.statusCode}` : 'HTTP error';
    const detail = issue.rawMessage && issue.rawMessage !== String(issue.statusCode) ? ` — ${issue.rawMessage}` : '';
    const note = redText(`${statusText}${detail}`);
    return { colored: note, summary: statusText.toLowerCase(), category: 'http', issue };
  }
  const rawMessage = issue.rawMessage || 'unknown error';
  const note = redText(rawMessage);
  return { colored: note, summary: rawMessage, category: 'error', issue };
}
