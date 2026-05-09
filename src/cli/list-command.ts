import ora from 'ora';
import type { ServerDefinition } from '../config.js';
import { MCPORTER_VERSION } from '../runtime.js';
import { setStdioLogMode } from '../sdk-patches.js';
import { persistPreparedEphemeralServer, prepareEphemeralServerTarget } from './ephemeral-target.js';
import { splitHttpToolSelector } from './http-utils.js';
import { chooseClosestIdentifier, renderIdentifierResolutionMessages } from './identifier-helpers.js';
import { formatExampleBlock } from './list-detail-helpers.js';
import type { ListSummaryResult, StatusCategory } from './list-format.js';
import { classifyListError, formatSourceSuffix, renderServerListRow } from './list-format.js';
import { extractListFlags } from './list-flags.js';
import type { ToolMetadata } from './generate/tools.js';
import {
  buildAuthCommandHint,
  buildJsonListEntry,
  createEmptyStatusCounts,
  createUnknownResult,
  type ListJsonServerEntry,
  printBriefTool,
  printSingleServerHeader,
  printToolDetail,
  summarizeStatusCounts,
} from './list-output.js';
import { dimText, extraDimText, supportsSpinner, yellowText } from './terminal.js';
import { LIST_TIMEOUT_MS, withTimeout } from './timeouts.js';
import { loadToolMetadata } from './tool-cache.js';
import { formatTransportSummary } from './transport-utils.js';

export async function handleList(
  runtime: Awaited<ReturnType<(typeof import('../runtime.js'))['createRuntime']>>,
  args: string[]
): Promise<void> {
  const flags = extractListFlags(args);
  let target = args.shift();
  let requestedTool: string | undefined;

  if (target) {
    const split = splitHttpToolSelector(target);
    if (split) {
      target = split.baseUrl;
      requestedTool = split.tool;
    }
  }

  const prepared = await prepareEphemeralServerTarget({
    runtime,
    target,
    ephemeral: flags.ephemeral,
  });
  target = prepared.target;

  if (!target) {
    if (flags.brief) {
      throw new Error('--brief requires a server target.');
    }
    const previousStdioLogMode = setStdioLogMode('silent');
    try {
      const servers = runtime.getDefinitions();
      const perServerTimeoutMs = flags.timeoutMs ?? LIST_TIMEOUT_MS;
      const perServerTimeoutSeconds = Math.round(perServerTimeoutMs / 1000);

      if (servers.length === 0) {
        if (flags.format === 'json') {
          const payload = {
            mode: 'list',
            counts: createEmptyStatusCounts(),
            servers: [] as ListJsonServerEntry[],
          };
          console.log(JSON.stringify(payload, null, 2));
        } else {
          console.log('No MCP servers configured.');
        }
        return;
      }

      if (flags.format === 'text') {
        console.log(
          `mcporter ${MCPORTER_VERSION} — Listing ${servers.length} server(s) (per-server timeout: ${perServerTimeoutSeconds}s)`
        );
      }
      const spinner =
        flags.format === 'text' && supportsSpinner
          ? ora(`Discovering ${servers.length} server(s)…`).start()
          : undefined;
      const renderedResults =
        flags.format === 'text'
          ? (Array.from({ length: servers.length }, () => undefined) as Array<
              ReturnType<typeof renderServerListRow> | undefined
            >)
          : undefined;
      const summaryResults: Array<ListSummaryResult | undefined> = Array.from(
        { length: servers.length },
        () => undefined
      );
      let completedCount = 0;

      const tasks = servers.map((server, index) =>
        (async (): Promise<ListSummaryResult> => {
          const startedAt = Date.now();
          try {
            const tools = await withTimeout(
              runtime.listTools(server.name, { autoAuthorize: false, allowCachedAuth: true }),
              perServerTimeoutMs
            );
            return {
              server,
              status: 'ok' as const,
              tools,
              durationMs: Date.now() - startedAt,
            };
          } catch (error) {
            return {
              server,
              status: 'error' as const,
              error,
              durationMs: Date.now() - startedAt,
            };
          }
        })().then((result) => {
          summaryResults[index] = result;
          if (renderedResults) {
            const rendered = renderServerListRow(result, perServerTimeoutMs, { verbose: flags.verbose });
            renderedResults[index] = rendered;
            completedCount += 1;
            if (spinner) {
              spinner.stop();
              console.log(rendered.line);
              const remaining = servers.length - completedCount;
              if (remaining > 0) {
                spinner.text = `Listing servers… ${completedCount}/${servers.length}`;
                spinner.start();
              }
            } else {
              console.log(rendered.line);
            }
          }
          return result;
        })
      );

      await Promise.all(tasks);

      if (flags.format === 'json') {
        const jsonEntries = summaryResults.map((entry, index) => {
          const serverDefinition = servers[index] ?? entry?.server ?? servers[0];
          if (!serverDefinition) {
            throw new Error('Unable to resolve server definition for JSON output.');
          }
          const normalizedEntry = entry ?? createUnknownResult(serverDefinition);
          return buildJsonListEntry(normalizedEntry, perServerTimeoutSeconds, {
            includeSchemas: Boolean(flags.schema),
            includeSources: Boolean(flags.verbose || flags.includeSources),
          });
        });
        const counts = summarizeStatusCounts(jsonEntries);
        console.log(JSON.stringify({ mode: 'list', counts, servers: jsonEntries }, null, 2));
        return;
      }

      if (spinner) {
        spinner.stop();
      }
      const errorCounts = createEmptyStatusCounts();
      renderedResults?.forEach((entry) => {
        if (!entry) {
          return;
        }
        const category = entry.category ?? 'error';
        errorCounts[category] = (errorCounts[category] ?? 0) + 1;
      });
      const okSummary = `${errorCounts.ok} healthy`;
      const parts = [
        okSummary,
        ...(errorCounts.auth > 0 ? [`${errorCounts.auth} auth required`] : []),
        ...(errorCounts.offline > 0 ? [`${errorCounts.offline} offline`] : []),
        ...(errorCounts.http > 0 ? [`${errorCounts.http} http errors`] : []),
        ...(errorCounts.error > 0 ? [`${errorCounts.error} errors`] : []),
      ];
      console.log(`✔ Listed ${servers.length} server${servers.length === 1 ? '' : 's'} (${parts.join('; ')}).`);
      return;
    } finally {
      setStdioLogMode(previousStdioLogMode);
    }
  }

  if (!requestedTool) {
    const selector = resolveConfiguredToolSelector(runtime, target);
    if (selector) {
      target = selector.server;
      requestedTool = selector.tool;
    }
  }

  const resolved = resolveServerDefinition(runtime, target);
  if (!resolved) {
    return;
  }
  target = resolved.name;
  const definition = resolved.definition;
  const timeoutMs = flags.timeoutMs ?? LIST_TIMEOUT_MS;
  const sourcePath =
    definition.sources?.length || definition.source
      ? formatSourceSuffix(definition.sources ?? definition.source, true, { verbose: flags.verbose })
      : undefined;
  const transportSummary = formatTransportSummary(definition);
  const startedAt = Date.now();
  if (flags.format === 'json') {
    try {
      const metadataEntries = filterToolMetadata(
        await withTimeout(loadToolMetadata(runtime, target, { includeSchema: true }), timeoutMs),
        requestedTool
      );
      await persistPreparedEphemeralServer(runtime, prepared);
      const durationMs = Date.now() - startedAt;
      if (requestedTool && metadataEntries.length === 0) {
        printMissingToolJson(definition, requestedTool, durationMs, transportSummary, flags);
        return;
      }
      const instructions = await loadServerInstructions(runtime, target);
      const payload = {
        mode: 'server',
        name: definition.name,
        status: 'ok' as StatusCategory,
        durationMs,
        description: definition.description,
        instructions,
        transport: transportSummary,
        source: definition.source,
        sources: flags.verbose || flags.includeSources ? definition.sources : undefined,
        tools: metadataEntries.map((entry) => ({
          name: entry.tool.name,
          description: entry.tool.description,
          inputSchema: entry.tool.inputSchema,
          outputSchema: entry.tool.outputSchema,
          options: entry.options,
        })),
      };
      console.log(JSON.stringify(payload, null, 2));
      return;
    } catch (error) {
      await persistPreparedEphemeralServer(runtime, prepared);
      const durationMs = Date.now() - startedAt;
      const authCommand = buildAuthCommandHint(definition);
      const advice = classifyListError(error, definition.name, timeoutMs, { authCommand });
      const payload = {
        mode: 'server',
        name: definition.name,
        status: advice.category,
        durationMs,
        description: definition.description,
        transport: transportSummary,
        source: definition.source,
        sources: flags.verbose || flags.includeSources ? definition.sources : undefined,
        issue: advice.issue,
        authCommand: advice.authCommand,
        error: advice.summary,
      };
      console.log(JSON.stringify(payload, null, 2));
      process.exitCode = 1;
      return;
    }
  }
  try {
    // Always request schemas so we can render CLI-style parameter hints without re-querying per tool.
    const metadataEntries = filterToolMetadata(
      await withTimeout(loadToolMetadata(runtime, target, { includeSchema: true }), timeoutMs),
      requestedTool
    );
    await persistPreparedEphemeralServer(runtime, prepared);
    const durationMs = Date.now() - startedAt;
    if (requestedTool && metadataEntries.length === 0) {
      printMissingToolText(definition, requestedTool, durationMs, transportSummary, sourcePath);
      return;
    }
    const instructions = await loadServerInstructions(runtime, target);
    const summaryLine = printSingleServerHeader(
      definition,
      metadataEntries.length,
      durationMs,
      transportSummary,
      sourcePath,
      {
        printSummaryNow: false,
        instructions,
      }
    );
    if (metadataEntries.length === 0) {
      console.log('  Tools: <none>');
      console.log(summaryLine);
      console.log('');
      return;
    }
    if (flags.brief) {
      let optionalOmitted = false;
      for (const entry of metadataEntries) {
        const detail = printBriefTool(definition, entry, flags.requiredOnly);
        optionalOmitted ||= detail.optionalOmitted;
      }
      if (flags.requiredOnly && optionalOmitted) {
        console.log(`  ${extraDimText('Optional parameters hidden; run with --all-parameters to view all fields.')}`);
        console.log('');
      }
      console.log(summaryLine);
      console.log('');
      return;
    }
    const examples: string[] = [];
    let optionalOmitted = false;
    for (const entry of metadataEntries) {
      const detail = printToolDetail(definition, entry, Boolean(flags.schema), flags.requiredOnly);
      examples.push(...detail.examples);
      optionalOmitted ||= detail.optionalOmitted;
    }
    const uniqueExamples = formatExampleBlock(examples);
    if (uniqueExamples.length > 0) {
      console.log(`  ${dimText('Examples:')}`);
      for (const example of uniqueExamples) {
        console.log(`    ${example}`);
      }
      console.log('');
    }
    if (flags.requiredOnly && optionalOmitted) {
      console.log(`  ${extraDimText('Optional parameters hidden; run with --all-parameters to view all fields.')}`);
      console.log('');
    }
    console.log(summaryLine);
    console.log('');
    return;
  } catch (error) {
    await persistPreparedEphemeralServer(runtime, prepared);
    const durationMs = Date.now() - startedAt;
    printSingleServerHeader(definition, undefined, durationMs, transportSummary, sourcePath);
    const message = error instanceof Error ? error.message : 'Failed to load tool list.';
    const authCommand = buildAuthCommandHint(definition);
    const advice = classifyListError(error, definition.name, timeoutMs, { authCommand });
    console.warn(`  Tools: <timed out after ${timeoutMs}ms>`);
    console.warn(`  Reason: ${message}`);
    if (advice.category === 'auth' && advice.authCommand) {
      console.warn(`  Next: run '${advice.authCommand}' to finish authentication.`);
    }
  }
}

export function printListHelp(): void {
  const lines = [
    'Usage: mcporter list [server | url] [flags]',
    '',
    'Targets:',
    '  <name>                 Use a server from config/mcporter.json or editor imports.',
    '  https://host/mcp       List an HTTP server directly; mcporter infers the entry.',
    '',
    'Ad-hoc servers:',
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
    '',
    'Display flags:',
    '  --brief                Show compact signatures only for a single server.',
    '  --signatures           Alias for --brief.',
    '  --schema               Show tool schemas when listing servers.',
    '  --all-parameters       Include optional parameters in tool docs.',
    '  --json                 Emit a JSON summary instead of text.',
    '  --verbose              Show all config sources for matching servers.',
    '  --sources              Include source arrays in JSON output without other verbose details.',
    '  --timeout <ms>         Override the per-server discovery timeout.',
    '',
    'Examples:',
    '  mcporter list',
    '  mcporter list linear --schema',
    '  mcporter list linear --brief',
    '  mcporter list linear.list_issues --signatures',
    '  mcporter list https://mcp.example.com/mcp',
    '  mcporter list --http-url https://localhost:3333/mcp --schema',
  ];
  console.error(lines.join('\n'));
}

function resolveServerDefinition(
  runtime: Awaited<ReturnType<(typeof import('../runtime.js'))['createRuntime']>>,
  name: string
): { definition: ServerDefinition; name: string } | undefined {
  try {
    const definition = runtime.getDefinition(name);
    return { definition, name };
  } catch (error) {
    if (!(error instanceof Error) || !/Unknown MCP server/i.test(error.message)) {
      throw error;
    }
    const suggestion = suggestServerName(runtime, name);
    if (!suggestion) {
      console.error(error.message);
      return undefined;
    }
    const messages = renderIdentifierResolutionMessages({
      entity: 'server',
      attempted: name,
      resolution: suggestion,
    });
    if (suggestion.kind === 'auto' && messages.auto) {
      console.log(dimText(messages.auto));
      return resolveServerDefinition(runtime, suggestion.value);
    }
    if (messages.suggest) {
      console.error(yellowText(messages.suggest));
    }
    console.error(error.message);
    return undefined;
  }
}

function suggestServerName(
  runtime: Awaited<ReturnType<(typeof import('../runtime.js'))['createRuntime']>>,
  attempted: string
) {
  const definitions = runtime.getDefinitions();
  const names = definitions.map((entry) => entry.name);
  return chooseClosestIdentifier(attempted, names);
}

function resolveConfiguredToolSelector(
  runtime: Awaited<ReturnType<(typeof import('../runtime.js'))['createRuntime']>>,
  target: string | undefined
): { server: string; tool: string } | undefined {
  if (!target || !target.includes('.')) {
    return undefined;
  }
  const definitions = runtime.getDefinitions();
  const match = definitions
    .map((definition) => definition.name)
    .filter((name) => target.startsWith(`${name}.`))
    .toSorted((a, b) => b.length - a.length)[0];
  if (!match) {
    return undefined;
  }
  const tool = target.slice(match.length + 1);
  if (!tool) {
    return undefined;
  }
  return { server: match, tool };
}

function filterToolMetadata(entries: ToolMetadata[], requestedTool: string | undefined): ToolMetadata[] {
  if (!requestedTool) {
    return entries;
  }
  return entries.filter((entry) => entry.tool.name === requestedTool);
}

function printMissingToolText(
  definition: ServerDefinition,
  tool: string,
  durationMs: number,
  transportSummary: string,
  sourcePath: string | undefined
): void {
  printSingleServerHeader(definition, 0, durationMs, transportSummary, sourcePath);
  console.warn(`  Tool '${tool}' not found on '${definition.name}'.`);
  process.exitCode = 1;
}

function printMissingToolJson(
  definition: ServerDefinition,
  tool: string,
  durationMs: number,
  transportSummary: string,
  flags: { verbose: boolean; includeSources: boolean }
): void {
  console.log(
    JSON.stringify(
      {
        mode: 'server',
        name: definition.name,
        status: 'error' as StatusCategory,
        durationMs,
        description: definition.description,
        transport: transportSummary,
        source: definition.source,
        sources: flags.verbose || flags.includeSources ? definition.sources : undefined,
        tools: [],
        error: `Tool '${tool}' not found on '${definition.name}'.`,
      },
      null,
      2
    )
  );
  process.exitCode = 1;
}

async function loadServerInstructions(
  runtime: Awaited<ReturnType<(typeof import('../runtime.js'))['createRuntime']>>,
  serverName: string
): Promise<string | undefined> {
  if (typeof runtime.getInstructions !== 'function') {
    return undefined;
  }
  return runtime.getInstructions(serverName);
}
