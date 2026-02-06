import type { ServerDefinition } from '../config.js';
import type { ToolMetadata } from './generate/tools.js';
import type { SerializedConnectionIssue } from './json-output.js';
import { formatErrorMessage, serializeConnectionIssue } from './json-output.js';
import { buildToolDoc } from './list-detail-helpers.js';
import type { ListSummaryResult, StatusCategory } from './list-format.js';
import { classifyListError } from './list-format.js';
import { formatFunctionSignature } from './list-signature.js';
import { boldText, extraDimText } from './terminal.js';
import { formatTransportSummary } from './transport-utils.js';

export interface ToolDetailResult {
  examples: string[];
  optionalOmitted: boolean;
}

export interface ListJsonServerEntry {
  name: string;
  status: StatusCategory;
  durationMs: number;
  description?: string;
  transport?: string;
  source?: ServerDefinition['source'];
  sources?: ServerDefinition['sources'];
  tools?: Array<{
    name: string;
    description?: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
  }>;
  issue?: SerializedConnectionIssue;
  authCommand?: string;
  error?: string;
}

export function printSingleServerHeader(
  definition: ReturnType<Awaited<ReturnType<typeof import('../runtime.js')['createRuntime']>>['getDefinition']>,
  toolCount: number | undefined,
  durationMs: number | undefined,
  transportSummary: string,
  sourcePath: string | undefined,
  options?: { printSummaryNow?: boolean }
): string {
  const prefix = boldText(definition.name);
  if (definition.description) {
    console.log(`${prefix} - ${extraDimText(definition.description)}`);
  } else {
    console.log(prefix);
  }
  const summaryParts: string[] = [];
  summaryParts.push(
    extraDimText(typeof toolCount === 'number' ? `${toolCount} tool${toolCount === 1 ? '' : 's'}` : 'tools unavailable')
  );
  if (typeof durationMs === 'number') {
    summaryParts.push(extraDimText(`${durationMs}ms`));
  }
  if (transportSummary) {
    summaryParts.push(extraDimText(transportSummary));
  }
  if (sourcePath) {
    summaryParts.push(sourcePath);
  }
  const summaryLine = `  ${summaryParts.join(extraDimText(' · '))}`;
  if (options?.printSummaryNow === false) {
    console.log('');
  } else {
    console.log(summaryLine);
    console.log('');
  }
  return summaryLine;
}

export function printToolDetail(
  definition: ReturnType<Awaited<ReturnType<typeof import('../runtime.js')['createRuntime']>>['getDefinition']>,
  metadata: ToolMetadata,
  includeSchema: boolean,
  requiredOnly: boolean
): ToolDetailResult {
  const exampleOptions = buildExampleOptions(definition);
  const doc = buildToolDoc({
    serverName: definition.name,
    toolName: metadata.tool.name,
    description: metadata.tool.description,
    outputSchema: metadata.tool.outputSchema,
    options: metadata.options,
    requiredOnly,
    colorize: true,
    callSelector: exampleOptions?.selector,
    wrapExampleExpression: exampleOptions?.wrapExpression,
  });
  if (doc.docLines) {
    for (const line of doc.docLines) {
      console.log(`  ${line}`);
    }
  }
  console.log(`  ${doc.signature}`);
  if (doc.optionalSummary && requiredOnly) {
    console.log(`  ${doc.optionalSummary}`);
  }
  if (includeSchema && metadata.tool.inputSchema) {
    console.log(indent(JSON.stringify(metadata.tool.inputSchema, null, 2), '      '));
  }
  console.log('');
  return {
    examples: doc.examples,
    optionalOmitted: doc.hiddenOptions.length > 0,
  };
}

function buildExampleOptions(
  definition: ReturnType<Awaited<ReturnType<typeof import('../runtime.js')['createRuntime']>>['getDefinition']>
): { selector?: string; wrapExpression?: boolean } | undefined {
  if (definition.source?.kind !== 'local' || definition.source.path !== '<adhoc>') {
    return undefined;
  }
  if (definition.command.kind === 'http') {
    const url = definition.command.url instanceof URL ? definition.command.url.href : String(definition.command.url);
    return { selector: url, wrapExpression: true };
  }
  return undefined;
}

/**
 * Print tools as compact function signatures for --brief mode.
 */
export function printBriefToolList(metadataEntries: ToolMetadata[], options?: { colorize?: boolean }): void {
  for (const entry of metadataEntries) {
    const signature = formatFunctionSignature(entry.tool.name, entry.options, entry.tool.outputSchema, {
      colorize: options?.colorize,
    });
    console.log(signature);
  }
}

export function createEmptyStatusCounts(): Record<StatusCategory, number> {
  return {
    ok: 0,
    auth: 0,
    offline: 0,
    http: 0,
    error: 0,
  };
}

export function summarizeStatusCounts(entries: ListJsonServerEntry[]): Record<StatusCategory, number> {
  const counts = createEmptyStatusCounts();
  entries.forEach((entry) => {
    counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  });
  return counts;
}

export function buildJsonListEntry(
  result: ListSummaryResult,
  timeoutSeconds: number,
  options: { includeSchemas: boolean; includeSources?: boolean }
): ListJsonServerEntry {
  if (result.status === 'ok') {
    return {
      name: result.server.name,
      status: 'ok',
      durationMs: result.durationMs,
      description: result.server.description,
      transport: formatTransportSummary(
        result.server as ReturnType<
          Awaited<ReturnType<typeof import('../runtime.js')['createRuntime']>>['getDefinition']
        >
      ),
      source: result.server.source,
      sources: options.includeSources ? result.server.sources : undefined,
      tools: result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: options.includeSchemas ? tool.inputSchema : undefined,
        outputSchema: options.includeSchemas ? tool.outputSchema : undefined,
      })),
    };
  }
  const authCommand = buildAuthCommandHint(
    result.server as ReturnType<Awaited<ReturnType<typeof import('../runtime.js')['createRuntime']>>['getDefinition']>
  );
  const advice = classifyListError(result.error, result.server.name, timeoutSeconds, { authCommand });
  return {
    name: result.server.name,
    status: advice.category,
    durationMs: result.durationMs,
    description: result.server.description,
    transport: formatTransportSummary(
      result.server as ReturnType<Awaited<ReturnType<typeof import('../runtime.js')['createRuntime']>>['getDefinition']>
    ),
    source: result.server.source,
    sources: options.includeSources ? result.server.sources : undefined,
    issue: serializeConnectionIssue(advice.issue),
    authCommand: advice.authCommand,
    error: formatErrorMessage(result.error),
  };
}

export function createUnknownResult(server: ServerDefinition): ListSummaryResult {
  return {
    status: 'error',
    server,
    error: new Error('Unknown server result'),
    durationMs: 0,
  };
}

export function buildAuthCommandHint(
  definition: ReturnType<Awaited<ReturnType<typeof import('../runtime.js')['createRuntime']>>['getDefinition']>
): string {
  if (definition.source?.kind === 'local' && definition.source.path === '<adhoc>') {
    if (definition.command.kind === 'http') {
      const url = definition.command.url instanceof URL ? definition.command.url.href : String(definition.command.url);
      return `mcporter auth ${url}`;
    }
    if (definition.command.kind === 'stdio') {
      const parts = [definition.command.command, ...(definition.command.args ?? [])];
      const rendered = parts.map(quoteCommandSegment).join(' ').trim();
      return rendered.length > 0 ? `mcporter auth --stdio ${rendered}` : 'mcporter auth --stdio';
    }
  }
  return `mcporter auth ${definition.name}`;
}

function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map((line) => pad + line)
    .join('\n');
}

function quoteCommandSegment(segment: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(segment)) {
    return segment;
  }
  return JSON.stringify(segment);
}
