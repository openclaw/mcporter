/**
 * mcporter search - Search for tools across all MCP servers
 * 
 * Returns compact results: server.tool - first line of description
 * Designed to minimize context window usage for AI agents.
 */

import type { ServerToolInfo } from '../runtime.js';
import { dimText, boldText } from './terminal.js';
import { LIST_TIMEOUT_MS, withTimeout } from './timeouts.js';

interface SearchResult {
  server: string;
  tool: string;
  description: string;
}

function getFirstLine(text: string | undefined): string {
  if (!text) return '';
  // Trim leading/trailing whitespace first
  const trimmed = text.trim();
  if (!trimmed) return '';
  // Get first sentence or first line, whichever is shorter
  const lines = trimmed.split('\n');
  const firstLine = (lines[0] ?? '').trim();
  const sentences = trimmed.split(/[.!?]/);
  const firstSentence = (sentences[0] ?? '').trim();
  const result = firstSentence.length < firstLine.length ? firstSentence : firstLine;
  // Truncate if still too long
  return result.length > 80 ? result.slice(0, 77) + '...' : result;
}

function matchesQuery(tool: ServerToolInfo, query: string): boolean {
  const lowerQuery = query.toLowerCase();
  const terms = lowerQuery.split(/\s+/);
  
  const searchText = [
    tool.name,
    tool.description ?? '',
  ].join(' ').toLowerCase();
  
  // All terms must match somewhere
  return terms.every(term => searchText.includes(term));
}

export function extractSearchFlags(args: string[]): {
  limit: number;
  json: boolean;
} {
  let limit = 20;
  let json = false;
  
  let i = 0;
  while (i < args.length) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1] ?? '20', 10) || 20;
      args.splice(i, 2);
      continue;
    }
    if (args[i] === '--json') {
      json = true;
      args.splice(i, 1);
      continue;
    }
    i++;
  }
  
  return { limit, json };
}

export async function handleSearch(
  runtime: Awaited<ReturnType<typeof import('../runtime.js')['createRuntime']>>,
  args: string[]
): Promise<void> {
  const flags = extractSearchFlags(args);
  const query = args.join(' ').trim();
  
  if (!query) {
    console.error('Usage: mcporter search <query> [--limit N] [--json]');
    console.error('');
    console.error('Search for tools across all configured MCP servers.');
    console.error('');
    console.error('Examples:');
    console.error('  mcporter search particle');
    console.error('  mcporter search "create material"');
    console.error('  mcporter search niagara --limit 50');
    process.exitCode = 1;
    return;
  }
  
  const definitions = runtime.getDefinitions();
  const results: SearchResult[] = [];
  const errors: string[] = [];
  const perServerTimeoutMs = LIST_TIMEOUT_MS;
  
  // Search each server
  for (const def of definitions) {
    try {
      const tools = await withTimeout(
        runtime.listTools(def.name, { autoAuthorize: false, allowCachedAuth: true, includeSchema: true }),
        perServerTimeoutMs
      );
      
      for (const tool of tools) {
        if (matchesQuery(tool, query)) {
          results.push({
            server: def.name,
            tool: tool.name,
            description: getFirstLine(tool.description),
          });
        }
      }
    } catch (err) {
      errors.push(`${def.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  
  // Sort by relevance (tools where query appears in name first)
  const lowerQuery = query.toLowerCase();
  results.sort((a, b) => {
    const aInName = a.tool.toLowerCase().includes(lowerQuery) ? 0 : 1;
    const bInName = b.tool.toLowerCase().includes(lowerQuery) ? 0 : 1;
    if (aInName !== bInName) return aInName - bInName;
    return `${a.server}.${a.tool}`.localeCompare(`${b.server}.${b.tool}`);
  });
  
  // Apply limit
  const limited = results.slice(0, flags.limit);
  
  if (flags.json) {
    console.log(JSON.stringify({
      query,
      total: results.length,
      returned: limited.length,
      results: limited,
      errors: errors.length > 0 ? errors : undefined,
    }, null, 2));
    return;
  }
  
  // Text output - compact format
  if (limited.length === 0) {
    console.log(`No tools found matching "${query}"`);
    if (errors.length > 0) {
      console.log('');
      console.log(dimText(`Errors (${errors.length} servers):`));
      for (const err of errors) {
        console.log(dimText(`  ${err}`));
      }
    }
    return;
  }
  
  console.log(`Found ${results.length} tools matching "${query}"${results.length > flags.limit ? ` (showing ${flags.limit})` : ''}:\n`);
  
  for (const r of limited) {
    const selector = `${r.server}.${r.tool}`;
    console.log(`${boldText(selector)}`);
    if (r.description) {
      console.log(`  ${dimText(r.description)}`);
    }
  }
  
  if (errors.length > 0) {
    console.log('');
    console.log(dimText(`(${errors.length} servers failed to connect)`));
  }
}

export function printSearchHelp(): void {
  console.log(`mcporter search - Search for tools across all MCP servers

Usage: mcporter search <query> [options]

Options:
  --limit <N>   Maximum results to return (default: 20)
  --json        Output as JSON

Examples:
  mcporter search particle
  mcporter search "create material" --limit 50
  mcporter search niagara --json

The search matches against tool names and descriptions.
All query terms must match (AND logic).
`);
}
