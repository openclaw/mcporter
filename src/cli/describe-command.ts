/**
 * mcporter describe - Get full schema for a single tool
 * 
 * Usage: mcporter describe server.tool
 * 
 * Returns the complete tool documentation including parameters,
 * types, and examples - but ONLY for that one tool.
 * 
 * This enables loading just one tool into AI context without
 * pulling the entire server's tool catalog.
 */

import { dimText, boldText } from './terminal.js';
import { LIST_TIMEOUT_MS, withTimeout } from './timeouts.js';

export function extractDescribeFlags(args: string[]): {
  json: boolean;
} {
  let json = false;
  
  let i = 0;
  while (i < args.length) {
    if (args[i] === '--json') {
      json = true;
      args.splice(i, 1);
      continue;
    }
    i++;
  }
  
  return { json };
}

function parseToolSelector(selector: string): { server: string; tool: string } | null {
  const match = selector.match(/^([^.]+)\.(.+)$/);
  if (!match) return null;
  return { server: match[1]!, tool: match[2]! };
}

export async function handleDescribe(
  runtime: Awaited<ReturnType<typeof import('../runtime.js')['createRuntime']>>,
  args: string[]
): Promise<void> {
  const flags = extractDescribeFlags(args);
  const selector = args[0];
  
  if (!selector) {
    printDescribeHelp();
    process.exitCode = 1;
    return;
  }
  
  const parsed = parseToolSelector(selector);
  if (!parsed) {
    console.error(`Invalid tool selector: "${selector}"`);
    console.error('Expected format: server.tool (e.g., niagaraMCP.create_niagara_system)');
    process.exitCode = 1;
    return;
  }
  
  const { server, tool: toolName } = parsed;
  
  try {
    const tools = await withTimeout(
      runtime.listTools(server, { autoAuthorize: false, allowCachedAuth: true, includeSchema: true }),
      LIST_TIMEOUT_MS
    );
    
    const tool = tools.find(t => t.name === toolName);
    
    if (!tool) {
      console.error(`Tool "${toolName}" not found in server "${server}"`);
      console.error('');
      console.error('Available tools:');
      for (const t of tools.slice(0, 10)) {
        console.error(`  ${server}.${t.name}`);
      }
      if (tools.length > 10) {
        console.error(`  ... and ${tools.length - 10} more`);
      }
      process.exitCode = 1;
      return;
    }
    
    if (flags.json) {
      console.log(JSON.stringify({
        server,
        tool: toolName,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
      }, null, 2));
      return;
    }
    
    // Text output - formatted like mcporter list --schema but for single tool
    console.log(boldText(`${server}.${toolName}`));
    console.log('');
    
    if (tool.description) {
      // Format as doc comment
      const lines = tool.description.trim().split('\n');
      console.log('/**');
      for (const line of lines) {
        console.log(` * ${line}`);
      }
      console.log(' */');
    }
    
    // Format the signature
    const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] } | undefined;
    if (schema?.properties) {
      const params: string[] = [];
      const required = new Set(schema.required ?? []);
      
      for (const [name, prop] of Object.entries(schema.properties)) {
        const propObj = prop as { type?: string; default?: unknown };
        const isOptional = !required.has(name);
        const type = propObj.type ?? 'unknown';
        params.push(`${name}${isOptional ? '?' : ''}: ${type}`);
      }
      
      console.log(`function ${toolName}(${params.join(', ')});`);
    } else {
      console.log(`function ${toolName}();`);
    }
    
    // Show JSON schema if available
    if (schema) {
      console.log('');
      console.log(dimText('Input Schema:'));
      console.log(dimText(JSON.stringify(schema, null, 2)));
    }
    
    // Show example call
    console.log('');
    console.log(dimText('Example:'));
    console.log(dimText(`  mcporter call ${server}.${toolName}(...)`));
    
  } catch (err) {
    console.error(`Error connecting to ${server}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

export function printDescribeHelp(): void {
  console.log(`mcporter describe - Get full schema for a single tool

Usage: mcporter describe <server.tool> [options]

Options:
  --json    Output as JSON

Examples:
  mcporter describe niagaraMCP.create_niagara_system
  mcporter describe materialMCP.create_material --json

Returns the complete tool documentation including description,
parameters, types, and input schema - for just that one tool.

Use this after 'mcporter search' to get full details without
loading the entire server's tool catalog into context.
`);
}
